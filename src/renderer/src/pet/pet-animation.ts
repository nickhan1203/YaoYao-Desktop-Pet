/**
 * 幺幺桌宠行走动画的纯逻辑层（可被 Vitest 直接测试，无 PixiJS/DOM 依赖）。
 *
 * 职责：
 * - 状态映射：主进程视觉状态 → 显示命令（idle/paused 正面静态待机 /
 *   sitting/lying 正面姿态素材基底（Task 11I 坐/趴面向用户）/
 *   walk 循环动画 / run 循环动画，Task 11I / 11H）；
 * - 朝向分离：facing（行为方向）与 orientation（显示素材朝向 front/side）
 *   分离，正面素材组（idle/paused/sitting/lying）不随历史 facing 镜像
 *   （Task 11I）；
 * - 朝向镜像：以素材脚底参考点为翻转轴，保证镜像前后脚底目标位置稳定；
 * - 帧序列与播放速度换算；
 * - 素材加载结果解析（部分失败的安全降级语义）；
 * - 幂等显示控制器：重复状态广播不重启动画、不重置帧序号。
 *
 * PixiJS 显示对象由 PetCanvas 通过注入的 applyCommand 回调驱动，
 * 本模块不持有任何渲染资源。
 */

import type { PetVisualState } from '../../../shared/pet-visual-state'
import walk01 from '../assets/pet/v2/walk/walk-01.png'
import walk02 from '../assets/pet/v2/walk/walk-02.png'
import walk03 from '../assets/pet/v2/walk/walk-03.png'
import walk04 from '../assets/pet/v2/walk/walk-04.png'
import walk05 from '../assets/pet/v2/walk/walk-05.png'
import walk06 from '../assets/pet/v2/walk/walk-06.png'
import walk07 from '../assets/pet/v2/walk/walk-07.png'
import walk08 from '../assets/pet/v2/walk/walk-08.png'
import run01 from '../assets/pet/v2/run/run-01.png'
import run02 from '../assets/pet/v2/run/run-02.png'
import run03 from '../assets/pet/v2/run/run-03.png'
import run04 from '../assets/pet/v2/run/run-04.png'
import run05 from '../assets/pet/v2/run/run-05.png'
import run06 from '../assets/pet/v2/run/run-06.png'
import run07 from '../assets/pet/v2/run/run-07.png'
import run08 from '../assets/pet/v2/run/run-08.png'
import frontIdle01 from '../assets/pet/v4/front-idle-01.png'

/**
 * v2 行走序列帧 URL（Task 11E-v2）。
 * 帧序与素材包 manifest.json 的 side-right/walk 序列一致（walk-01..08）；
 * 仅接入 side-right 8 帧，朝左由渲染层容器镜像生成
 * （素材包 side-left 即 side-right 的逐像素镜像，无需重复引入）。
 * v1 旧素材保留在 ../idle 与 ../walk 目录但不再被引用。
 */
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

/**
 * v2 跑步序列帧 URL（Task 11H）。
 * 帧序与素材包 manifest.json 的 side-right/run 序列一致（run-01..08）；
 * 仅接入 side-right 8 帧，朝左由渲染层容器镜像生成（与 walk 同一容器，
 * 不额外创建第二套镜像逻辑）。
 */
export const RUN_FRAME_URLS: readonly string[] = [
  run01,
  run02,
  run03,
  run04,
  run05,
  run06,
  run07,
  run08
]

/**
 * 静止（idle/turning/paused/dragging）显示帧。
 * v2 素材包不含独立站立帧，walk-01 为近似站姿（仅前爪略前伸），
 * 与行走动画同风格同锚点，故兼作静止帧（与 walk 首帧共用同一 URL，
 * 渲染层经 URL 去重加载，纹理只创建一份）。
 */
export const IDLE_FRAME_URL: string = walk01

/**
 * 正面待机静态帧 URL（Task 11I）。
 * 来源：yaoyao-animation-v4 frames/front/interaction/interaction-01.png
 *（v4 素材包 interaction 序列的 01 帧即"待机"：正面面向用户、自然站立、
 * 四爪着地、不迈步不坐卧）。作为静态帧兼用，不作为独立 idle 动画接入。
 * 像素与素材包原帧完全一致（SHA256 校验），应用内仅做复制不改图。
 */
export const FRONT_IDLE_FRAME_URL: string = frontIdle01

/** 行走动画目标帧率（帧/秒）：与素材包 manifest.json 的 walk fps=8 一致 */
export const WALK_FPS = 8

/** 跑步动画目标帧率（帧/秒）：与素材包 manifest.json 的 run fps=12 一致（Task 11H） */
export const RUN_FPS = 12

/** PixiJS Ticker 默认帧率（60fps 语义，用于换算 animationSpeed） */
export const TICKER_FPS = 60

/**
 * 角色统一等比缩放（v2 512×512 画布 → 240×240 显示画布）。
 * 取 0.625（5/8）：v2 角色可见高度约 326px → 显示约 204px，
 * 与 v1 素材在 0.5 缩放下的视觉尺寸（约 206px）基本一致；
 * 横向最大跨度 ±190px×0.625=237.5px ≤ 240 画布（两侧各余 1.25px）。
 */
export const CHARACTER_SCALE = 0.625

/**
 * 正面素材组独立等比缩放（Task 11I；不改已验收的 walk/run 侧面缩放）。
 * 适用于正面待机帧与 v3 front sit/lie 姿态帧（同一 character 容器缩放）。
 *
 * 计算依据（512×512 画布 alpha 实测）：
 * - 正面待机 front/interaction-01：可见区 y 26..463，高 438px；沿用 0.625
 *   时显示高 273.75px，顶部越过 240 画布 46px（227.5 − 0.625×438）→ 必须
 *   独立缩放；
 * - 取 0.467：显示高 438×0.467 ≈ 204.5px，与侧面 walk-01 的显示高度
 *   （327×0.625 ≈ 204.4px）一致，切换 idle ⇄ 行走时整体大小无明显跳变；
 * - 坐姿进入起点 v3 front sit-01 同为 438px 高 → 待机 ⇄ 坐下衔接无跳变；
 *   sit-05（394px）/lie-01（388px）/lie-05（296px）更低，全部安全；
 * - 顶部边距：待机 227.5 − 0.467×438 ≈ 23.0px（walk-01 为 21.25px），
 *   sit-01 同为 ≈23px，其余姿态帧更大，均不溢出；
 * - 脚底 maxY：待机 463、sit 459/460、lie 460，与统一锚点 y=464 相差
 *   ≤ 1px（显示 ≈0.5px），接地高度稳定；
 * - 脚底带中心 x：待机 ≈257.5、sit-05 ≈257.5（≈画布中心 256，爪部
 *   水平居中），等比无拉伸。
 */
export const FRONT_IDLE_SCALE = 0.467

/**
 * 脚底参考点（v2 素材 512×512 画布坐标）。
 * 与素材包 manifest.json 的 anchor normalized [0.5, 0.90625] = (256, 464)
 * 一致：x 恰为画布中心（镜像天然对称），y 位于脚底（实测 feet maxY≈460）。
 */
export const FOOT_REFERENCE = { x: 256, y: 464 } as const

/**
 * 脚底目标点（240×240 显示画布坐标）。
 * x=120：v2 角色相对锚点水平对称，水平居中即脚底居中；
 * y=227.5：沿用 v1 已验收的脚底高度，窗口内垂直布局不变。
 */
export const FOOT_TARGET = { x: 120, y: 227.5 } as const

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

/** 显示素材朝向（Task 11I）：front = 正面待机帧（不镜像）；side = 侧面素材（随 facing 镜像） */
export type DisplayOrientation = 'front' | 'side'

/** 显示命令：角色容器的完整目标状态（由主进程视觉状态唯一决定） */
export interface DisplayCommand {
  /** true 显示行走动画；false 显示静态 idle 或跑步 */
  showWalk: boolean
  /** 行走动画是否播放（当前实现中与 showWalk 一致，保留语义位便于扩展） */
  walkPlaying: boolean
  /** true 显示跑步动画（Task 11H）；素材缺失时由渲染层回退 walk 视觉 */
  showRun: boolean
  /** 跑步动画是否播放（当前实现中与 showRun 一致，保留语义位便于扩展） */
  runPlaying: boolean
  /** 显示素材朝向（Task 11I）：正面待机 / 侧面行为素材 */
  orientation: DisplayOrientation
  /** 是否水平镜像（朝左；仅 side 朝向有意义，front 恒为 false） */
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
 * Task 12B：用户宠物倍率（petScale）叠加到显示命令。
 *
 * 数学：倍率乘以命令的等比缩放（side 0.625 / front 0.467 各自的基础值，
 * 不硬编码覆盖任何常量），并按脚底锚点公式重算容器位置——
 * - positionX = FOOT_TARGET.x − scaleX′ × FOOT_REFERENCE.x
 *   （scaleX 带镜像符号：镜像时为负，公式对镜像/非镜像统一成立）；
 * - positionY = FOOT_TARGET.y − scaleY′ × FOOT_REFERENCE.y。
 * 结果：脚底落点恒定、左右镜像稳定、正面/侧面切换无跳动；
 * 等比无拉伸；非法倍率（非有限/非正）原样返回命令（防御）。
 */
export function scaleDisplayCommand(command: DisplayCommand, petScale: number): DisplayCommand {
  if (typeof petScale !== 'number' || !Number.isFinite(petScale) || petScale <= 0) {
    return command
  }
  if (petScale === 1) {
    return command
  }
  const scaleX = command.scaleX * petScale
  const scaleY = command.scaleY * petScale
  return {
    ...command,
    scaleX,
    scaleY,
    positionX: FOOT_TARGET.x - scaleX * FOOT_REFERENCE.x,
    positionY: FOOT_TARGET.y - scaleY * FOOT_REFERENCE.y
  }
}

/**
 * 主进程视觉状态 → 显示命令。
 *
 * 状态映射（唯一行为依据）：
 * - walking → 循环播放 walk
 * - running → 循环播放 run（Task 11H；run 素材整组加载失败时由
 *   PetCanvas 回退播放 walk，本命令不感知素材可用性）
 * - idle / paused → 正面静态待机帧（Task 11I，不随历史 facing 镜像）
 * - sitting / lying → 正面姿态素材（Task 11I 坐/趴面向用户：v3 front
 *   sit/lie 帧由姿态层叠加播放，基底命令同样不镜像、使用正面缩放；
 *   姿态素材加载失败时由姿态层回退基础 idle 显示）
 * - turning / dragging → 侧面静态 idle 基底
 *   （turning 为行走过渡期，运行时边界掉头已即时化、不再触达，
 *   保守保持侧面避免闪烁；dragging 沿用已验收的拖动视觉）
 *
 * 朝向（Task 11I，facing 与显示素材朝向分离）：
 * - idle/paused/sitting/lying：orientation=front，恒不镜像（正面素材
 *   无方向语义，不随历史 left/right facing 镜像）；
 * - 其余状态：orientation=side，所有侧面素材默认朝右，facing left 时
 *   水平镜像，up/down 暂用原始朝向（不新增对应方向动画）。
 *
 * 镜像数学：翻转轴穿过脚底参考点，使参考点在画布上的落点
 * 与非镜像时完全一致（脚底目标位置稳定）：
 * - 非镜像：position = FOOT_TARGET - scale × FOOT_REFERENCE
 * - 镜像：  position.x = FOOT_TARGET.x + scale × FOOT_REFERENCE.x
 *           （scaleX 为负，参考点 x 映射到 FOOT_TARGET.x）
 *
 * front 与 side 使用同一脚底参考点锚定，仅缩放不同
 *（FRONT_IDLE_SCALE，见其注释）；front 组内的正面待机（438px 高）与
 * 坐姿进入起点 sit-01（438px 高）同高，同一缩放下衔接无大小跳变；
 * 切换时脚底落点不变、无上下跳动。
 */
export function resolveDisplayCommand(state: PetVisualState | null): DisplayCommand {
  const showWalk = state !== null && state.kind === 'walking'
  const showRun = state !== null && state.kind === 'running'
  const frontFacing =
    state === null ||
    state.kind === 'idle' ||
    state.kind === 'paused' ||
    state.kind === 'sitting' ||
    state.kind === 'lying'
  const mirrored = !frontFacing && state !== null && state.facing === 'left'
  const idleScale = frontFacing ? FRONT_IDLE_SCALE : CHARACTER_SCALE
  const positionX = mirrored
    ? FOOT_TARGET.x + idleScale * FOOT_REFERENCE.x
    : FOOT_TARGET.x - idleScale * FOOT_REFERENCE.x
  const positionY = FOOT_TARGET.y - idleScale * FOOT_REFERENCE.y
  return {
    showWalk,
    walkPlaying: showWalk,
    showRun,
    runPlaying: showRun,
    orientation: frontFacing ? 'front' : 'side',
    mirrored,
    positionX,
    positionY,
    scaleX: mirrored ? -idleScale : idleScale,
    scaleY: idleScale
  }
}

/** 两条显示命令是否完全一致（幂等判断） */
export function isSameCommand(a: DisplayCommand, b: DisplayCommand): boolean {
  return (
    a.showWalk === b.showWalk &&
    a.walkPlaying === b.walkPlaying &&
    a.showRun === b.showRun &&
    a.runPlaying === b.runPlaying &&
    a.orientation === b.orientation &&
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
  /** 正面待机帧（Task 11I；失败时 renderer 回退侧面 idle，不影响 walk/run/sit/lie） */
  frontIdle: T | null
  /** walk 全部帧（全部成功才有；任一帧失败则整组降级为静态 idle） */
  walk: readonly T[] | null
  /** run 全部帧（Task 11H；全部成功才有；任一帧失败则整组为 null，
   * 渲染层跑步状态回退播放 walk 动画） */
  run: readonly T[] | null
  /** 正面交互帧（Task 11J；任一帧失败整组为 null——点击/拎起/放下
   * 动画不可用，交互降级为既有拖动行为，不影响其他素材） */
  frontInteraction: readonly T[] | null
  /** 侧面交互帧（Task 11J，side-right；同 frontInteraction 整组降级语义） */
  sideInteraction: readonly T[] | null
  /** 失败资源的序号描述（供日志输出） */
  failures: string[]
}

/**
 * 解析 Promise.allSettled 的素材加载结果：
 * - walk 任一帧失败 → walk 整组为 null（安全降级，不部分播放）；
 * - run 任一帧失败 → run 整组为 null（Task 11H，同 walk 的整组降级语义；
 *   runResults 参数可省略，省略时 run 恒为 null——旧调用方兼容）；
 * - idle 失败 → idle 为 null（沿用占位圆形降级链）；
 * - frontIdle 失败 → frontIdle 为 null（Task 11I，正面待机回退侧面
 *   idle，不产生占位、不影响其余素材；frontResult 可省略——旧调用方兼容）；
 * - front/side interaction 任一帧失败 → 对应组为 null（Task 11J，
 *   交互动画不可用、真实拖动行为不受影响；参数可省略——旧调用方兼容）。
 */
export function resolveAssetLoadOutcome<T>(
  idleResult: PromiseSettledResult<T>,
  walkResults: readonly PromiseSettledResult<T>[],
  runResults?: readonly PromiseSettledResult<T>[],
  frontResult?: PromiseSettledResult<T>,
  frontInteractionResults?: readonly PromiseSettledResult<T>[],
  sideInteractionResults?: readonly PromiseSettledResult<T>[]
): AssetLoadOutcome<T> {
  const failures: string[] = []
  const idle = idleResult.status === 'fulfilled' ? idleResult.value : null
  if (idle === null) {
    failures.push('v2/walk/walk-01.png（idle 静止帧）')
  }
  const frontIdle =
    frontResult !== undefined && frontResult.status === 'fulfilled' ? frontResult.value : null
  if (frontResult !== undefined && frontIdle === null) {
    failures.push('v4/front-idle-01.png（正面待机帧）')
  }
  const walk: T[] = []
  let walkComplete = true
  walkResults.forEach((result, index): void => {
    if (result.status === 'fulfilled') {
      walk.push(result.value)
    } else {
      walkComplete = false
      failures.push(`v2/walk/walk-0${index + 1}.png`)
    }
  })
  const run: T[] = []
  let runComplete = true
  if (runResults !== undefined) {
    runResults.forEach((result, index): void => {
      if (result.status === 'fulfilled') {
        run.push(result.value)
      } else {
        runComplete = false
        failures.push(`v2/run/run-0${index + 1}.png`)
      }
    })
  } else {
    runComplete = false
  }
  const frontInteraction: T[] = []
  let frontInteractionComplete = true
  if (frontInteractionResults !== undefined) {
    frontInteractionResults.forEach((result, index): void => {
      if (result.status === 'fulfilled') {
        frontInteraction.push(result.value)
      } else {
        frontInteractionComplete = false
        failures.push(`v4/front/interaction/interaction-0${index + 1}.png`)
      }
    })
  } else {
    frontInteractionComplete = false
  }
  const sideInteraction: T[] = []
  let sideInteractionComplete = true
  if (sideInteractionResults !== undefined) {
    sideInteractionResults.forEach((result, index): void => {
      if (result.status === 'fulfilled') {
        sideInteraction.push(result.value)
      } else {
        sideInteractionComplete = false
        failures.push(`v4/side-right/interaction/interaction-0${index + 1}.png`)
      }
    })
  } else {
    sideInteractionComplete = false
  }
  return {
    idle,
    frontIdle,
    walk: walkComplete ? walk : null,
    run: runComplete && run.length > 0 ? run : null,
    frontInteraction: frontInteractionComplete ? frontInteraction : null,
    sideInteraction: sideInteractionComplete ? sideInteraction : null,
    failures
  }
}
