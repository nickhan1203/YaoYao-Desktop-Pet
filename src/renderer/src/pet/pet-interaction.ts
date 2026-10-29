/**
 * 幺幺桌宠交互动画播放器的纯逻辑层（Task 11J，可被 Vitest 直接测试）。
 *
 * 职责：
 * - 点击 / 拎起 / 悬空 / 放下的交互动画阶段模型：
 *   clickFeedback（01→02→01）→ normal；
 *   lifting（03→04→05）→ held（05→06→05 循环）；
 *   dropping（07→08→01）→ normal；
 * - 悬空位移（liftOffsetPx）的运行时计算——素材 PNG 内保持共同脚底
 *   参考点（v4 README：悬空位移由运行时驱动，不烘焙在图片中）；
 * - 抓取朝向锁定：进入 lifting 时锁定 orientation（front / side+mirrored），
 *   拖动期间不随旧方向广播切换图像，放下动画完成后恢复正常命令流。
 *
 * 素材（yaoyao-animation-v4 interaction，front + side-right 各 8 帧；
 * 左侧方向由角色容器镜像实现，不单独复制 side-left）：
 * - 01 待机；02 点击抬耳/歪头；03 受力预备；04 开始抬起；05 悬空；
 *   06 悬空轻摆；07 下降伸腿；08 落地缓冲；
 * - front interaction-01 与正面待机帧为同一文件（复用 FRONT_IDLE_FRAME_URL，
 *   URL 级去重、纹理共享、产物单份打包）；
 * - 帧时序来自 manifest interactions（click 70/200/120ms、pickup
 *   100/140/180ms、held 320ms×3 循环、release 140/180/160ms）。
 *
 * 与视觉状态的关系：本控制器是 renderer 交互动画阶段，不是主进程行为
 * 状态——真实拖动（窗口移动）仍由主进程 dragging 行为状态与锚点轮询
 * 控制（ipc-handlers）。最新交互事件优先：重复请求重置到最新阶段，
 * 过期动画回调不覆盖当前状态（由单一 update 时间推进，无异步回调）。
 *
 * 不持有 PixiJS 资源：PetCanvas 依据 snapshot 设置纹理、可见性与
 * 容器位移；可测性与 pet-posture 一致（时间驱动、无 DOM 依赖）。
 */

import frontIdle01 from '../assets/pet/v4/front-idle-01.png'
import frontInteraction02 from '../assets/pet/v4/front/interaction/interaction-02.png'
import frontInteraction03 from '../assets/pet/v4/front/interaction/interaction-03.png'
import frontInteraction04 from '../assets/pet/v4/front/interaction/interaction-04.png'
import frontInteraction05 from '../assets/pet/v4/front/interaction/interaction-05.png'
import frontInteraction06 from '../assets/pet/v4/front/interaction/interaction-06.png'
import frontInteraction07 from '../assets/pet/v4/front/interaction/interaction-07.png'
import frontInteraction08 from '../assets/pet/v4/front/interaction/interaction-08.png'
import sideInteraction01 from '../assets/pet/v4/side-right/interaction/interaction-01.png'
import sideInteraction02 from '../assets/pet/v4/side-right/interaction/interaction-02.png'
import sideInteraction03 from '../assets/pet/v4/side-right/interaction/interaction-03.png'
import sideInteraction04 from '../assets/pet/v4/side-right/interaction/interaction-04.png'
import sideInteraction05 from '../assets/pet/v4/side-right/interaction/interaction-05.png'
import sideInteraction06 from '../assets/pet/v4/side-right/interaction/interaction-06.png'
import sideInteraction07 from '../assets/pet/v4/side-right/interaction/interaction-07.png'
import sideInteraction08 from '../assets/pet/v4/side-right/interaction/interaction-08.png'

/** 交互素材朝向（Task 11J：抓取开始时锁定的显示朝向） */
export type InteractionOrientation = 'front' | 'side'

/** 交互帧 URL（按 manifest 帧序，完整 8 帧集；纹理索引 = 帧号 - 1） */
export const INTERACTION_FRAME_URLS: Readonly<Record<InteractionOrientation, readonly string[]>> = {
  // 帧 01 复用正面待机帧（同一文件，URL 级去重共享纹理）
  front: [
    frontIdle01,
    frontInteraction02,
    frontInteraction03,
    frontInteraction04,
    frontInteraction05,
    frontInteraction06,
    frontInteraction07,
    frontInteraction08
  ],
  side: [
    sideInteraction01,
    sideInteraction02,
    sideInteraction03,
    sideInteraction04,
    sideInteraction05,
    sideInteraction06,
    sideInteraction07,
    sideInteraction08
  ]
}

/** 交互动画阶段（renderer 视觉阶段，不是主进程行为状态） */
export type InteractionPhase = 'normal' | 'clickFeedback' | 'lifting' | 'held' | 'dropping'

/** 帧时长步进（索引 + 时长，等时长序列由 [indices, durations] 描述） */
interface SequenceStep {
  index: number
  durationMs: number
}

/** 点击反馈序列：01→02→01，70/200/120ms（manifest interactions.click） */
const CLICK_SEQUENCE: readonly SequenceStep[] = [
  { index: 0, durationMs: 70 },
  { index: 1, durationMs: 200 },
  { index: 0, durationMs: 120 }
]

/** 拎起序列：03→04→05，100/140/180ms（manifest interactions.pickup） */
const PICKUP_SEQUENCE: readonly SequenceStep[] = [
  { index: 2, durationMs: 100 },
  { index: 3, durationMs: 140 },
  { index: 4, durationMs: 180 }
]

/** 悬空保持循环：05→06→05，320ms×3（manifest interactions.held） */
const HELD_CYCLE: readonly SequenceStep[] = [
  { index: 4, durationMs: 320 },
  { index: 5, durationMs: 320 },
  { index: 4, durationMs: 320 }
]

/** 放下过渡序列：07→08→01，140/180/160ms（manifest interactions.release） */
const RELEASE_SEQUENCE: readonly SequenceStep[] = [
  { index: 6, durationMs: 140 },
  { index: 7, durationMs: 180 },
  { index: 0, durationMs: 160 }
]

/** 拎起总时长（lifting 位移渐变完成时间） */
const PICKUP_TOTAL_MS = PICKUP_SEQUENCE.reduce((sum, s) => sum + s.durationMs, 0)
/** 放下总时长（dropping 位移回落完成时间） */
const RELEASE_TOTAL_MS = RELEASE_SEQUENCE.reduce((sum, s) => sum + s.durationMs, 0)

/**
 * 悬空位移上限（显示画布坐标，240×240）。
 *
 * 计算依据（512 画布 alpha 实测，脚底锚点 (256,464)）：
 * - front 最紧帧 interaction-05 topGap=17px：0.467 缩放下显示顶部余量
 *   227.5 − 0.467×(464−17) ≈ 18.8px → 上移后顶部 = 18.8 − offset ≥ 0；
 * - side-right 最紧帧 interaction-04 topGap=132px：0.625 缩放下顶部余量
 *   ≈ 20px → 上移 12px 后 ≈ 8px；
 * - 取 12px：两方向均不出画布，front 留 6.8px 余量（抗锯齿边缘与
 *   低 alpha 毛边安全余量）。视觉限制：正面悬空帧顶部空间有限
 *   （约 19px），上移量保守取 12px 而非更大值。
 */
export const INTERACTION_LIFT_OFFSET_PX = 12

/** 控制器输出的当前显示快照 */
export interface InteractionSnapshot {
  /** 当前阶段；normal 时无交互动画 */
  phase: InteractionPhase
  /** 当前帧索引（纹理数组下标）；normal 时为 null */
  frameIndex: number | null
  /** 锁定的素材朝向；normal 时为 null（沿用权威显示命令） */
  orientation: InteractionOrientation | null
  /** 悬空位移（显示画布坐标，正值向上）；仅 lifting/held/dropping 有效 */
  liftOffsetPx: number
}

/** 悬空位移（由阶段与时间派生，纯函数便于测试） */
function liftOffsetFor(phase: InteractionPhase, progressMs: number): number {
  if (phase === 'held') {
    return INTERACTION_LIFT_OFFSET_PX
  }
  if (phase === 'lifting') {
    const t = Math.min(1, Math.max(0, progressMs / PICKUP_TOTAL_MS))
    return INTERACTION_LIFT_OFFSET_PX * t
  }
  if (phase === 'dropping') {
    const t = Math.min(1, Math.max(0, progressMs / RELEASE_TOTAL_MS))
    return INTERACTION_LIFT_OFFSET_PX * (1 - t)
  }
  return 0
}

/**
 * 交互动画状态机（时间驱动，无 DOM/PixiJS/时钟依赖）。
 * update(deltaMs) 由渲染层 ticker 提供单调时间增量（单一时间源，
 * 不重复创建计时器；pointermove 不重置动画）。
 *
 * 阶段推进规则（最新交互事件优先）：
 * - requestClick：normal → clickFeedback（重入重播）；
 * - requestPickup：任意 → lifting（打断 dropping / held / clickFeedback，
 *   重新从头播放拎起序列），锁定传入朝向；
 * - requestDrop：lifting/held → dropping；normal/clickFeedback 时无操作
 *  （未拎起不产生放下动画）；
 * - interrupt：任意 → normal（真实视觉状态接管 / 卸载 / 素材不可用）。
 */
export class PetInteractionController {
  private phase: InteractionPhase = 'normal'
  private orientation: InteractionOrientation | null = null
  private step = 0
  private stepElapsedMs = 0
  /** lifting/dropping 位移渐变的阶段累计时间 */
  private phaseElapsedMs = 0

  /** 当前应显示的帧索引（由阶段与步进派生） */
  private get frameIndex(): number {
    if (this.phase === 'clickFeedback') {
      return CLICK_SEQUENCE[this.step].index
    }
    if (this.phase === 'lifting') {
      return PICKUP_SEQUENCE[this.step].index
    }
    if (this.phase === 'held') {
      return HELD_CYCLE[this.step].index
    }
    if (this.phase === 'dropping') {
      return RELEASE_SEQUENCE[this.step].index
    }
    return 0
  }

  get snapshot(): InteractionSnapshot {
    return {
      phase: this.phase,
      frameIndex: this.phase === 'normal' ? null : this.frameIndex,
      orientation: this.phase === 'normal' ? null : this.orientation,
      liftOffsetPx: liftOffsetFor(this.phase, this.phaseElapsedMs)
    }
  }

  /** 当前是否有交互动画在播放（渲染层据此锁定容器 transform） */
  get isActive(): boolean {
    return this.phase !== 'normal'
  }

  /** 推进时间（毫秒）。支持大步长：单次调用内可跨越多帧。 */
  update(deltaMs: number): void {
    if (this.phase === 'normal' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
      return
    }
    let remaining = deltaMs
    // 上限防御：单次 update 最多消耗约 10s，避免异常输入导致死循环。
    let guard = 1000
    while (remaining > 0 && guard-- > 0 && this.isActive) {
      const consumed = this.advanceStep(remaining)
      remaining -= consumed
    }
  }

  /**
   * 短点击反馈（normal 或重播；拎起流程中忽略——见方法内注释）。
   * @param orientation 点击时的实际显示朝向（决定反馈帧素材组）
   */
  requestClick(orientation: InteractionOrientation): void {
    if (this.phase === 'lifting' || this.phase === 'held' || this.phase === 'dropping') {
      // 拎起流程中收到点击（如放下途中再次短按）：不产生点击反馈，
      // 交由意图层决定是否重新抓取（requestPickup 处理最新事件）。
      return
    }
    this.phase = 'clickFeedback'
    this.orientation = orientation
    this.step = 0
    this.stepElapsedMs = 0
    this.phaseElapsedMs = 0
  }

  /** 拎起（任意阶段可重入：打断 dropping/held/clickFeedback 重新开始） */
  requestPickup(orientation: InteractionOrientation): void {
    this.phase = 'lifting'
    this.orientation = orientation
    this.step = 0
    this.stepElapsedMs = 0
    this.phaseElapsedMs = 0
  }

  /** 放下（仅拎起流程有效：lifting 中松手 → 直接进入下降序列） */
  requestDrop(): void {
    if (this.phase !== 'lifting' && this.phase !== 'held') {
      return
    }
    this.phase = 'dropping'
    this.step = 0
    this.stepElapsedMs = 0
    this.phaseElapsedMs = 0
    // 保留 orientation：dropping 期间仍显示锁定朝向的 07→08→01。
  }

  /**
   * 立即复位（无过渡）：真实视觉状态接管、组件卸载或素材不可用时。
   * 复位后渲染层恢复正常命令流（PetCanvas 应用 pendingCommand）。
   */
  interrupt(): void {
    this.phase = 'normal'
    this.orientation = null
    this.step = 0
    this.stepElapsedMs = 0
    this.phaseElapsedMs = 0
  }

  /** 推进当前阶段一步，返回实际消耗的毫秒数 */
  private advanceStep(remainingMs: number): number {
    const sequence = this.activeSequence()
    if (sequence === null) {
      return remainingMs
    }
    const step = sequence[this.step]
    const consumed = Math.min(remainingMs, step.durationMs - this.stepElapsedMs)
    this.stepElapsedMs += consumed
    this.phaseElapsedMs += consumed
    if (this.stepElapsedMs >= step.durationMs) {
      this.stepElapsedMs = 0
      this.advanceSequence(sequence)
    }
    return consumed
  }

  private activeSequence(): readonly SequenceStep[] | null {
    switch (this.phase) {
      case 'clickFeedback':
        return CLICK_SEQUENCE
      case 'lifting':
        return PICKUP_SEQUENCE
      case 'held':
        return HELD_CYCLE
      case 'dropping':
        return RELEASE_SEQUENCE
      default:
        return null
    }
  }

  /** 序列推进一位，并处理序列结束的阶段转换 */
  private advanceSequence(sequence: readonly SequenceStep[]): void {
    this.step += 1
    if (this.step < sequence.length) {
      return
    }
    if (this.phase === 'clickFeedback') {
      // 点击反馈完成 → 回到正常显示。
      this.interrupt()
      return
    }
    if (this.phase === 'lifting') {
      // 拎起完成 → 悬空保持循环。
      this.phase = 'held'
      this.step = 0
      this.stepElapsedMs = 0
      this.phaseElapsedMs = 0
      return
    }
    if (this.phase === 'held') {
      // 保持循环：回绕到第一步。
      this.step = 0
      return
    }
    if (this.phase === 'dropping') {
      // 放下完成 → 恢复正常显示（渲染层应用最新权威命令）。
      this.interrupt()
    }
  }
}
