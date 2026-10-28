/**
 * 幺幺桌宠行走动画的纯逻辑层（可被 Vitest 直接测试，无 PixiJS/DOM 依赖）。
 *
 * 职责：
 * - 状态映射：主进程视觉状态 → 显示命令（idle 静态 / walk 循环动画）；
 * - 朝向镜像：以素材脚底参考点为翻转轴，保证镜像前后脚底目标位置稳定；
 * - 帧序列与播放速度换算；
 * - 素材加载结果解析（部分失败的安全降级语义）；
 * - 幂等显示控制器：重复状态广播不重启动画、不重置帧序号。
 *
 * PixiJS 显示对象由 PetCanvas 通过注入的 applyCommand 回调驱动，
 * 本模块不持有任何渲染资源。
 */

import type { PetVisualState } from '../../../shared/pet-visual-state'
import idleAssetUrl from '../assets/pet/idle/idle-01.png'
import walk01 from '../assets/pet/walk/walk-01.png'
import walk02 from '../assets/pet/walk/walk-02.png'
import walk03 from '../assets/pet/walk/walk-03.png'
import walk04 from '../assets/pet/walk/walk-04.png'
import walk05 from '../assets/pet/walk/walk-05.png'
import walk06 from '../assets/pet/walk/walk-06.png'
import walk07 from '../assets/pet/walk/walk-07.png'
import walk08 from '../assets/pet/walk/walk-08.png'

/** 行走序列帧 URL（按播放顺序显式声明，静态导入保证打包完整性） */
export const WALK_FRAME_URLS: readonly string[] = [
  walk01,
  walk02,
  walk03,
  walk04,
  walk05,
  walk06,
  walk07,
  walk08
]

/** idle 静态帧 URL */
export const IDLE_FRAME_URL: string = idleAssetUrl

/** 行走动画目标帧率（帧/秒） */
export const WALK_FPS = 8

/** PixiJS Ticker 默认帧率（60fps 语义，用于换算 animationSpeed） */
export const TICKER_FPS = 60

/** 角色统一等比缩放（480 原始画布 → 240 显示画布） */
export const CHARACTER_SCALE = 0.5

/**
 * 脚底参考点（素材原始 480×480 画布坐标）。
 * 镜像翻转轴穿过该点：镜像前后该点在画布上的落点保持稳定。
 */
export const FOOT_REFERENCE = { x: 247.5, y: 455 } as const

/**
 * 脚底目标点（240×240 显示画布坐标）。
 * 与 Task 9B 已验收的静态角色视觉位置一致（等比缩放后的参考点位置）。
 */
export const FOOT_TARGET = { x: 123.75, y: 227.5 } as const

/**
 * 将目标帧率换算为 PixiJS AnimatedSprite.animationSpeed
 * （animationSpeed 语义：每个 ticker tick 前进的帧数）。
 */
export function toAnimationSpeed(fps: number, tickerFps: number): number {
  if (!Number.isFinite(fps) || !Number.isFinite(tickerFps) || tickerFps <= 0) {
    return 0
  }
  return Math.max(fps, 0) / tickerFps
}

/** 显示命令：角色容器的完整目标状态（由主进程视觉状态唯一决定） */
export interface DisplayCommand {
  /** true 显示行走动画；false 显示静态 idle */
  showWalk: boolean
  /** 行走动画是否播放（当前实现中与 showWalk 一致，保留语义位便于扩展） */
  walkPlaying: boolean
  /** 是否水平镜像（朝左） */
  mirrored: boolean
  /** 角色容器位置（显示画布坐标） */
  positionX: number
  positionY: number
  /** 容器水平缩放（含镜像符号；与垂直缩放绝对值一致，等比不变形） */
  scaleX: number
  /** 容器垂直缩放（恒为正） */
  scaleY: number
}

/**
 * 主进程视觉状态 → 显示命令。
 *
 * 状态映射（唯一行为依据）：
 * - walking → 循环播放 walk
 * - idle / turning / paused / dragging → 静态 idle
 *
 * 朝向：所有素材默认朝右；facing left 时水平镜像，
 * up/down 暂用原始朝向（本阶段不新增对应方向动画）。
 *
 * 镜像数学：翻转轴穿过脚底参考点，使参考点在画布上的落点
 * 与非镜像时完全一致（脚底目标位置稳定）：
 * - 非镜像：position = FOOT_TARGET - scale × FOOT_REFERENCE
 * - 镜像：  position.x = FOOT_TARGET.x + scale × FOOT_REFERENCE.x
 *           （scaleX 为负，参考点 x 映射到 FOOT_TARGET.x）
 */
export function resolveDisplayCommand(state: PetVisualState | null): DisplayCommand {
  const showWalk = state !== null && state.kind === 'walking'
  const mirrored = state !== null && state.facing === 'left'
  const positionX = mirrored
    ? FOOT_TARGET.x + CHARACTER_SCALE * FOOT_REFERENCE.x
    : FOOT_TARGET.x - CHARACTER_SCALE * FOOT_REFERENCE.x
  const positionY = FOOT_TARGET.y - CHARACTER_SCALE * FOOT_REFERENCE.y
  return {
    showWalk,
    walkPlaying: showWalk,
    mirrored,
    positionX,
    positionY,
    scaleX: mirrored ? -CHARACTER_SCALE : CHARACTER_SCALE,
    scaleY: CHARACTER_SCALE
  }
}

/** 两条显示命令是否完全一致（幂等判断） */
export function isSameCommand(a: DisplayCommand, b: DisplayCommand): boolean {
  return (
    a.showWalk === b.showWalk &&
    a.walkPlaying === b.walkPlaying &&
    a.mirrored === b.mirrored &&
    a.positionX === b.positionX &&
    a.positionY === b.positionY &&
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY
  )
}

/**
 * 幂等显示控制器：把视觉状态转换为显示命令并应用到注入的回调。
 * 重复状态广播（相同命令）不会再次应用——不重启动画、不重置帧序号。
 * 应用回调由 PetCanvas 提供（操作真实 Pixi 显示对象；测试注入假实现）。
 */
export class PetDisplayController {
  private last: DisplayCommand | null = null

  constructor(private readonly applyCommand: (command: DisplayCommand) => void) {}

  apply(state: PetVisualState | null): void {
    const command = resolveDisplayCommand(state)
    if (this.last !== null && isSameCommand(this.last, command)) {
      return
    }
    this.last = command
    this.applyCommand(command)
  }
}

/** 素材加载结果（泛型载体，避免对 DOM 类型的依赖；Node 测试环境可测） */
export interface AssetLoadOutcome<T> {
  /** idle 帧（加载成功才有；失败时 renderer 降级为占位圆形） */
  idle: T | null
  /** walk 全部帧（全部成功才有；任一帧失败则整组降级为静态 idle） */
  walk: readonly T[] | null
  /** 失败资源的序号描述（供日志输出） */
  failures: string[]
}

/**
 * 解析 Promise.allSettled 的素材加载结果：
 * - walk 任一帧失败 → walk 整组为 null（安全降级，不部分播放）；
 * - idle 失败 → idle 为 null（沿用占位圆形降级链）。
 */
export function resolveAssetLoadOutcome<T>(
  idleResult: PromiseSettledResult<T>,
  walkResults: readonly PromiseSettledResult<T>[]
): AssetLoadOutcome<T> {
  const failures: string[] = []
  const idle = idleResult.status === 'fulfilled' ? idleResult.value : null
  if (idle === null) {
    failures.push('idle/idle-01.png')
  }
  const walk: T[] = []
  let walkComplete = true
  walkResults.forEach((result, index): void => {
    if (result.status === 'fulfilled') {
      walk.push(result.value)
    } else {
      walkComplete = false
      failures.push(`walk/walk-0${index + 1}.png`)
    }
  })
  return {
    idle,
    walk: walkComplete ? walk : null,
    failures
  }
}
