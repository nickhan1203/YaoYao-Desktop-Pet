/**
 * 幺幺桌宠姿态动画播放器的纯逻辑层（Task 11F，可被 Vitest 直接测试）。
 *
 * 职责：
 * - sit / lie 的三阶段播放模型：entering（进入）→ holding（保持）→ exiting
 *   （反向退出）→ 回到站立；
 * - 中断与切换的过渡规则（进入中退出、退出中再进入、sit/lie 互切、
 *   立即中断），保证快速切换不闪烁、不重置到错误帧；
 * - 帧时序由素材包 manifest.json 驱动：sit/lie fps=7（loop=false）。
 *
 * 素材（Task 11I 起使用 yaoyao-animation-v3 的 front sit/lie，正面面向用户）：
 * - 坐/趴为无主动移动的静止动作，与正面待机一致面向用户；正面帧不随
 *   历史 facing 镜像（渲染层 sitting/lying 显示命令 orientation=front）；
 * - v3 已做尺寸归一（delivery-check: size_normalized / no_export_clipping），
 *   alpha 实测：front sit-01 可见高 438px（与正面待机 interaction-01 一致，
 *   同一 FRONT_IDLE_SCALE 下站立→坐姿衔接无大小跳变）、sit-05 高 394px、
 *   lie-01 高 388px、lie-05 高 296px，脚底 maxY 均为 459/460（统一锚点
 *   y=464 接地稳定）；0.467 缩放下全部帧在 240×240 画布内完整显示
 *   （顶部边距 ≥ 21px），无裁剪，不需要动作级缩放；
 * - 帧序列结构与 side-right 版本完全同构（transition 01..05 正向、
 *   hold [05,07,05] 眨眼、reverse 05→01），仅素材方向不同；
 * - sit 进入/退出使用完整序列 01..05；
 * - hold：sit/lie 均使用 [05,07,05] + [1800,110,1400]（含眨眼）。
 *   注：v3 manifest 中 lie hold 为单帧 [05]×2000（无眨眼），经用户验收
 *   确认保留 v2 的眨眼循环（有记录的 manifest 偏差）；
 * - 帧 06/08 为备用姿态，不使用（07 为 hold 眨眼帧）。
 *
 * 与视觉状态的关系：本控制器是 renderer 内部能力，真实主进程视觉状态
 * 优先级更高（walking/dragging 等非 idle 状态时由 PetCanvas 调用
 * interrupt() 立即复位）。不持有 PixiJS 资源：PetCanvas 依据 snapshot
 * 设置纹理与可见性。
 */

import sit01 from '../assets/pet/v3/front/sit/sit-01.png'
import sit02 from '../assets/pet/v3/front/sit/sit-02.png'
import sit03 from '../assets/pet/v3/front/sit/sit-03.png'
import sit04 from '../assets/pet/v3/front/sit/sit-04.png'
import sit05 from '../assets/pet/v3/front/sit/sit-05.png'
import sit06 from '../assets/pet/v3/front/sit/sit-06.png'
import sit07 from '../assets/pet/v3/front/sit/sit-07.png'
import sit08 from '../assets/pet/v3/front/sit/sit-08.png'
import lie01 from '../assets/pet/v3/front/lie/lie-01.png'
import lie02 from '../assets/pet/v3/front/lie/lie-02.png'
import lie03 from '../assets/pet/v3/front/lie/lie-03.png'
import lie04 from '../assets/pet/v3/front/lie/lie-04.png'
import lie05 from '../assets/pet/v3/front/lie/lie-05.png'
import lie06 from '../assets/pet/v3/front/lie/lie-06.png'
import lie07 from '../assets/pet/v3/front/lie/lie-07.png'
import lie08 from '../assets/pet/v3/front/lie/lie-08.png'

/** 姿态类型 */
export type PostureKind = 'sit' | 'lie'

/** 播放阶段：standing = 未处于姿态（显示基础 idle） */
export type PosturePhase = 'standing' | 'entering' | 'holding' | 'exiting'

/** 姿态帧 URL（按 manifest 帧序，完整 8 帧集；纹理索引 = 帧号 - 1） */
export const POSTURE_FRAME_URLS: Readonly<Record<PostureKind, readonly string[]>> = {
  sit: [sit01, sit02, sit03, sit04, sit05, sit06, sit07, sit08],
  lie: [lie01, lie02, lie03, lie04, lie05, lie06, lie07, lie08]
}

/** 保持阶段的眨眼循环步长（manifest hold + hold_duration_ms） */
export interface HoldStep {
  /** 帧索引（0 基；4 = 帧 05，6 = 帧 07） */
  index: number
  durationMs: number
}

/** 每种姿态的播放配置（源自素材包 manifest.json side-right/sit、side-right/lie） */
export interface PostureAssetConfig {
  frames: readonly string[]
  /** 进入序列（帧索引，正向播放一次） */
  enterIndices: readonly number[]
  /** 保持阶段循环（含眨眼：05→07→05） */
  holdCycle: readonly HoldStep[]
  /** 退出序列（帧索引，反向播放一次） */
  exitIndices: readonly number[]
  /** 进入/退出的帧率（manifest fps，7 FPS） */
  transitionFps: number
}

/** sit 保持循环（manifest hold [05,07,05] + hold_duration_ms [1800,110,1400]，含眨眼） */
const SIT_HOLD_CYCLE: readonly HoldStep[] = [
  { index: 4, durationMs: 1800 },
  { index: 6, durationMs: 110 },
  { index: 4, durationMs: 1400 }
]

/**
 * lie 保持循环：用户验收确认保留 v2 眨眼效果（05:1800 / 07:110 / 05:1400），
 * 偏离 v3 manifest 的单帧保持 [05]×2000（见模块注释）。
 */
const LIE_HOLD_CYCLE: readonly HoldStep[] = [
  { index: 4, durationMs: 1800 },
  { index: 6, durationMs: 110 },
  { index: 4, durationMs: 1400 }
]

export const POSTURE_ASSETS: Readonly<Record<PostureKind, PostureAssetConfig>> = {
  sit: {
    frames: POSTURE_FRAME_URLS.sit,
    enterIndices: [0, 1, 2, 3, 4],
    holdCycle: SIT_HOLD_CYCLE,
    exitIndices: [4, 3, 2, 1, 0],
    transitionFps: 7
  },
  lie: {
    frames: POSTURE_FRAME_URLS.lie,
    enterIndices: [0, 1, 2, 3, 4],
    holdCycle: LIE_HOLD_CYCLE,
    exitIndices: [4, 3, 2, 1, 0],
    transitionFps: 7
  }
}

/** 控制器输出的当前显示快照 */
export interface PostureSnapshot {
  /** 当前姿态；standing 时为 null（渲染层显示基础 idle） */
  kind: PostureKind | null
  phase: PosturePhase
  /** 当前帧索引（纹理数组下标）；standing 时为 null */
  frameIndex: number | null
}

/**
 * 姿态动画状态机（时间驱动，无 DOM/PixiJS/时钟依赖）。
 * update(deltaMs) 由渲染层 ticker 提供单调时间增量。
 *
 * 内部以"序列位置"（enterPos / exitPos / holdStep）追踪进度，
 * 帧索引由当前位置派生——这使"进入中退出""退出中再进入"可以从
 * 当前帧原位续播，而不是跳回序列首帧造成闪跳。
 */
export class PetPostureController {
  private kind: PostureKind | null = null
  private phase: PosturePhase = 'standing'
  private enterPos = 0
  private exitPos = 0
  private holdStep = 0
  private holdElapsedMs = 0
  private transitionElapsedMs = 0
  /** sit/lie 互切时暂存的目标姿态，退出完成后自动进入 */
  private pendingKind: PostureKind | null = null

  constructor(private readonly isAssetAvailable: (kind: PostureKind) => boolean) {}

  /** 当前应显示的帧索引（由阶段与序列位置派生） */
  private get frameIndex(): number {
    if (this.kind === null) {
      return 0
    }
    const config = POSTURE_ASSETS[this.kind]
    if (this.phase === 'entering') {
      return config.enterIndices[this.enterPos]
    }
    if (this.phase === 'exiting') {
      return config.exitIndices[this.exitPos]
    }
    if (this.phase === 'holding') {
      return config.holdCycle[this.holdStep].index
    }
    return 0
  }

  get snapshot(): PostureSnapshot {
    return {
      kind: this.phase === 'standing' ? null : this.kind,
      phase: this.phase,
      frameIndex: this.phase === 'standing' ? null : this.frameIndex
    }
  }

  /**
   * 请求进入姿态（kind）或恢复站立（null）。
   * 幂等：重复请求相同姿态不重置播放进度。
   */
  request(kind: PostureKind | null): void {
    if (kind !== null && !this.isAssetAvailable(kind)) {
      return
    }
    if (kind === null) {
      this.requestStand()
      return
    }
    if (this.phase === 'standing') {
      this.startEnter(kind)
      return
    }
    if (this.kind === kind) {
      if (this.phase === 'entering' || this.phase === 'holding') {
        return
      }
      // 退出途中重新进入相同姿态：从当前帧原位继续正向播放，不闪回站立。
      const config = POSTURE_ASSETS[kind]
      const position = config.enterIndices.indexOf(this.frameIndex)
      this.enterPos = position === -1 ? 0 : position + 1
      this.transitionElapsedMs = 0
      this.pendingKind = null
      if (this.enterPos >= config.enterIndices.length) {
        // 已在最后一个进入帧：直接进入保持。
        this.phase = 'holding'
        this.holdStep = 0
        this.holdElapsedMs = 0
        return
      }
      this.phase = 'entering'
      return
    }
    // sit/lie 互切：先退出当前姿态，退出完成后自动进入新姿态。
    this.pendingKind = kind
    if (this.phase !== 'exiting') {
      this.startExit()
    }
  }

  /** 请求恢复站立（保持/进入中会反向退出；退出中仅清除互切目标） */
  private requestStand(): void {
    if (this.phase === 'standing') {
      return
    }
    if (this.phase === 'exiting') {
      this.pendingKind = null
      return
    }
    this.pendingKind = null
    this.startExit()
  }

  /** 重播当前姿态的进入动画（开发预览用；未处于姿态时无效） */
  replayEnter(): void {
    if (this.kind === null || this.phase === 'standing') {
      return
    }
    this.phase = 'entering'
    this.enterPos = 0
    this.transitionElapsedMs = 0
    this.pendingKind = null
  }

  /**
   * 立即复位到站立（无反向动画）。
   * 真实视觉状态接管时使用：walking/dragging/卸载等场景，
   * 不允许姿态动画拖延真实状态的呈现。
   */
  interrupt(): void {
    this.kind = null
    this.phase = 'standing'
    this.enterPos = 0
    this.exitPos = 0
    this.holdStep = 0
    this.holdElapsedMs = 0
    this.transitionElapsedMs = 0
    this.pendingKind = null
  }

  /** 推进时间（毫秒）。支持大步长：单次调用内可跨越多帧。 */
  update(deltaMs: number): void {
    if (this.phase === 'standing' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
      return
    }
    let remaining = deltaMs
    // 上限防御：单次 update 最多消耗约 10s，避免异常输入导致死循环。
    let guard = 1000
    while (remaining > 0 && guard-- > 0) {
      const consumed = this.advanceStep(remaining)
      remaining -= consumed
    }
  }

  /** 推进当前阶段一步，返回实际消耗的毫秒数 */
  private advanceStep(remainingMs: number): number {
    if (this.kind === null) {
      return remainingMs
    }
    const config = POSTURE_ASSETS[this.kind]
    if (this.phase === 'holding') {
      const step = config.holdCycle[this.holdStep]
      const consumed = Math.min(remainingMs, step.durationMs - this.holdElapsedMs)
      this.holdElapsedMs += consumed
      if (this.holdElapsedMs >= step.durationMs) {
        this.holdElapsedMs = 0
        this.holdStep = (this.holdStep + 1) % config.holdCycle.length
      }
      return consumed
    }
    // entering / exiting：等时长帧序列（transitionFps）
    const frameDurationMs = 1000 / config.transitionFps
    const consumed = Math.min(remainingMs, frameDurationMs - this.transitionElapsedMs)
    this.transitionElapsedMs += consumed
    if (this.transitionElapsedMs >= frameDurationMs) {
      this.transitionElapsedMs = 0
      this.advanceSequence(config)
    }
    return consumed
  }

  /** 进入/退出序列推进一位，并处理序列结束的阶段转换 */
  private advanceSequence(config: PostureAssetConfig): void {
    if (this.phase === 'entering') {
      this.enterPos += 1
      if (this.enterPos >= config.enterIndices.length) {
        // 进入完成：进入保持（hold 循环第一步即保持帧）。
        this.phase = 'holding'
        this.holdStep = 0
        this.holdElapsedMs = 0
      }
      return
    }
    if (this.phase === 'exiting') {
      this.exitPos += 1
      if (this.exitPos >= config.exitIndices.length) {
        this.finishExit()
      }
    }
  }

  /** 退出完成：回到站立，或自动进入互切目标姿态 */
  private finishExit(): void {
    const next = this.pendingKind
    this.pendingKind = null
    if (next !== null && this.isAssetAvailable(next)) {
      this.startEnter(next)
      return
    }
    this.interrupt()
  }

  /** 从头开始进入指定姿态 */
  private startEnter(kind: PostureKind): void {
    this.kind = kind
    this.phase = 'entering'
    this.enterPos = 0
    this.exitPos = 0
    this.holdStep = 0
    this.holdElapsedMs = 0
    this.transitionElapsedMs = 0
  }

  /**
   * 开始反向退出：从当前帧在退出序列中的位置继续反向播放，
   * 不跳回保持帧（避免进入中退出时的帧闪跳）。
   * 当前帧不在退出序列中（如眨眼帧 07）时，先回到保持帧再退出。
   */
  private startExit(): void {
    if (this.kind === null) {
      return
    }
    const config = POSTURE_ASSETS[this.kind]
    const position = config.exitIndices.indexOf(this.frameIndex)
    this.phase = 'exiting'
    this.exitPos = position === -1 ? 0 : position + 1
    this.transitionElapsedMs = 0
    if (this.exitPos >= config.exitIndices.length) {
      // 已在退出序列末端（如站立近似帧）：无需再播放，直接完成。
      this.finishExit()
    }
  }
}
