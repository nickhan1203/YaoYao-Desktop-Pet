/**
 * 幺幺桌宠自动行为运行时（主进程）。
 *
 * 职责：把已验证的纯逻辑模块连接成第一版自动行为运行时——
 * - pet-state-machine：状态转换（唯一的状态修改入口，不允许直接赋值绕过）；
 * - pet-behavior-decider：行为决策（只输出意图，本模块负责映射为状态机事件）；
 * - movement-controller：纯坐标计算（本模块负责把结果写入窗口）。
 *
 * 时间管理：单一运行循环（默认 50ms tick），单调时钟计算时间增量，
 * 增量与移动控制器共用 MAX_DELTA_TIME_SEC 上限（卡顿后舍弃超出部分而非补算）。
 *
 * 决策 → 状态机事件映射：
 * - startWalking → WALK_START
 * - startTurning → TURN_START
 * - startIdle（当前 walking）→ WALK_END
 * - startIdle（当前 turning）→ TURN_END
 * - startWalking（当前 turning）→ TURN_END + WALK_START（复合转换：
 *   状态机不允许 turning → walking 直接跳转，先结束转向回到待机再开始行走）
 * - 拖动开始/结束 → DRAG_START / DRAG_END（由 ipc-handlers 回调触发）
 *
 * Task 11D（水平行走）：自动行走只允许左右方向（决策器候选已收敛），
 * 行走方向进入运行时统一做水平规范化（防御历史 up/down 数据）；
 * 触达左右边界触发的转向会记录相反方向，恢复行走时覆盖随机选向；
 * 用户拖动不受限，松开后的窗口 Y 成为新的水平行走轨道。
 *
 * 活动范围：由 getBounds() 注入（实现使用 Electron screen 的 workArea，
 * 宠物中心所在显示器），与 display-clamp 的"窗口可见性"语义不同，
 * 不复用其 40px 可见约束。
 *
 * 可测试性：窗口适配器、时钟、随机源、调度器均可注入，
 * tick() 可手动调用，测试不依赖真实显示器与等待时间。
 */

import {
  INITIAL_PET_STATE,
  transition,
  type PetEvent,
  type PetState
} from '../shared/pet-state-machine'
import {
  MAX_DELTA_TIME_SEC,
  computeMovement,
  type BoundsHit,
  type MovementBounds,
  type Vec2
} from '../shared/movement-controller'
import {
  DEFAULT_BEHAVIOR_DECIDER_CONFIG,
  decideBehavior,
  sampleDurationSec,
  type BehaviorDecision,
  type BehaviorDeciderConfig,
  type RandomSource
} from '../shared/pet-behavior-decider'
import { PET_WALK_SPEED_PX_PER_SEC } from '../shared/pet-config'
import { toPetFacing, type PetVisualState } from '../shared/pet-visual-state'

/** 运行时需要的窗口能力（测试可注入假实现） */
export interface RuntimeWindow {
  readonly width: number
  readonly height: number
  getPosition(): Vec2
  setPosition(x: number, y: number): void
  isDestroyed(): boolean
}

/** 循环调度器：返回取消函数（默认基于 setInterval） */
export type Scheduler = (callback: () => void, intervalMs: number) => () => void

export interface RuntimeConfig {
  decider?: BehaviorDeciderConfig
  walkSpeedPxPerSec?: number
  tickIntervalMs?: number
}

export interface RuntimeDeps {
  window: RuntimeWindow
  /** 活动范围提供者（每次行走计算时读取） */
  getBounds: () => MovementBounds
  /** 单调时钟（毫秒），默认 performance.now */
  clock?: () => number
  /** 随机源，默认 Math.random（仅集成层允许，纯逻辑模块不使用） */
  random?: RandomSource
  scheduler?: Scheduler
  config?: RuntimeConfig
  /** 视觉状态变化回调（主进程接线层用于向 renderer 广播；可选） */
  onVisualStateChange?: (state: PetVisualState) => void
}

const DEFAULT_TICK_INTERVAL_MS = 50

function defaultScheduler(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs)
  return () => clearInterval(timer)
}

function anyHit(hit: BoundsHit): boolean {
  return hit.left || hit.right || hit.top || hit.bottom
}

/**
 * 仅保留与当前行走方向对应的触界。
 * movement-controller 的触界语义是"新位置位于边界上"（贴边即报告）：
 * 贴着边界沿边行走（如贴右边界向下走）时 x 恒等于 maxX 会被持续报告，
 * 若不过滤会在恢复行走的第一个 tick 立即再次触发转向。
 * 集成层只把"移动方向指向且被截断"的边界视为需要转向的触界。
 */
function directionalHit(hit: BoundsHit, direction: Vec2): BoundsHit | null {
  const length = Math.hypot(direction.x, direction.y)
  const unitX = length > 0 ? direction.x / length : 0
  const unitY = length > 0 ? direction.y / length : 0
  const filtered: BoundsHit = {
    left: hit.left && unitX < 0,
    right: hit.right && unitX > 0,
    top: hit.top && unitY < 0,
    bottom: hit.bottom && unitY > 0
  }
  return anyHit(filtered) ? filtered : null
}

/** 决策结果 → 状态机事件（未预期的决策返回 null，由调用方安全处理） */
function decisionToEvent(decision: BehaviorDecision, state: PetState): PetEvent | null {
  switch (decision.type) {
    case 'startWalking':
      return { type: 'WALK_START' }
    case 'startTurning':
      return { type: 'TURN_START' }
    case 'startIdle':
      return state.kind === 'turning' ? { type: 'TURN_END' } : { type: 'WALK_END' }
    default:
      return null
  }
}

/**
 * 把任意方向规范化为水平单位向量（左/右）。
 * x > 0 → 右；x < 0 → 左；垂直/零/非法向量 → 回退方向（同样规范化，
 * 回退自身非法时取右）。Task 11D：自动行走只允许水平移动，
 * 历史 up/down 方向不得引起垂直自动移动（防御性兼容）。
 */
export function normalizeHorizontalDirection(direction: Vec2, fallback: Vec2): Vec2 {
  if (Number.isFinite(direction.x) && direction.x > 0) {
    return { x: 1, y: 0 }
  }
  if (Number.isFinite(direction.x) && direction.x < 0) {
    return { x: -1, y: 0 }
  }
  if (Number.isFinite(fallback.x) && fallback.x < 0) {
    return { x: -1, y: 0 }
  }
  return { x: 1, y: 0 }
}

export class PetBehaviorRuntime {
  private readonly win: RuntimeWindow
  private readonly getBounds: () => MovementBounds
  private readonly clock: () => number
  private readonly random: RandomSource
  private readonly scheduler: Scheduler
  private readonly deciderConfig: BehaviorDeciderConfig
  private readonly walkSpeedPxPerSec: number
  private readonly tickIntervalMs: number

  private state: PetState = INITIAL_PET_STATE
  /** 当前行为已持续时间（秒）；paused/dragging 期间冻结不累积 */
  private behaviorElapsedSec = 0
  /** 当前行为目标时长（秒），仅在阶段转换或恢复时采样 */
  private targetDurationSec: number | null = null
  private walkDirection: Vec2 = { x: 1, y: 0 }
  /** 位置基准（内部保持浮点，避免取整误差累积） */
  private position: Vec2 = { x: 0, y: 0 }
  /** 上次实际发送给窗口的整数位置（变化检测，避免高频无效 setPosition） */
  private lastSentPosition: Vec2 = { x: 0, y: 0 }
  /** 当前行走触界信息：仅 walking 阶段有效，离开 walking 立即清除 */
  private currentHit: BoundsHit | null = null
  /**
   * 边界转向后的待恢复方向（Task 11D）：
   * 触达左右边界触发的 turning 记录相反水平方向，
   * 转向结束恢复行走时优先使用（覆盖随机选向），
   * 保证"到达边界 → 转向 → 反方向恢复行走"不被随机方向破坏。
   * 其他来源的 startWalking（待机后/拖动后）不受影响。
   */
  private pendingTurnDirection: Vec2 | null = null
  private cancelLoop: (() => void) | null = null
  private lastTickMs: number | null = null
  private running = false
  /** 视觉状态变化回调（可选注入；不改变行为逻辑，只做变化通知） */
  private readonly onVisualStateChange?: (state: PetVisualState) => void
  /** 上次已广播的视觉状态：仅 (kind, facing) 变化时才再次广播 */
  private lastBroadcastVisualState: PetVisualState | null = null

  constructor(deps: RuntimeDeps) {
    this.win = deps.window
    this.getBounds = deps.getBounds
    this.clock = deps.clock ?? ((): number => performance.now())
    this.random = deps.random ?? Math.random
    this.scheduler = deps.scheduler ?? defaultScheduler
    const config = deps.config ?? {}
    this.deciderConfig = config.decider ?? DEFAULT_BEHAVIOR_DECIDER_CONFIG
    this.walkSpeedPxPerSec = config.walkSpeedPxPerSec ?? PET_WALK_SPEED_PX_PER_SEC
    this.tickIntervalMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.onVisualStateChange = deps.onVisualStateChange
  }

  /** 启动运行循环（幂等：重复调用不会创建多个循环） */
  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    this.syncPositionFromWindow()
    this.behaviorElapsedSec = 0
    // 启动后进入合理的待机阶段：采样待机目标时长
    this.targetDurationSec = this.sampleTargetFor(this.state)
    this.lastTickMs = this.clock()
    // 广播初始视觉状态（renderer 可在任意时刻订阅并通过查询接口获取，
    // 不依赖恰好监听到启动后的第一条广播）。
    this.broadcastVisualState()
    this.cancelLoop = this.scheduler(() => this.tick(), this.tickIntervalMs)
  }

  /** 停止运行循环并清理资源（幂等；停止后不再移动窗口） */
  stop(): void {
    this.running = false
    if (this.cancelLoop) {
      this.cancelLoop()
      this.cancelLoop = null
    }
    this.lastTickMs = null
  }

  get isRunning(): boolean {
    return this.running
  }

  get currentState(): PetState {
    return this.state
  }

  /** 当前视觉状态（行为状态 + 朝向），供接线层响应查询请求 */
  get currentVisualState(): PetVisualState {
    return { kind: this.state.kind, facing: toPetFacing(this.walkDirection) }
  }

  /** 暂停自动行为（供后续托盘/菜单集成使用） */
  pause(): void {
    this.state = transition(this.state, { type: 'PAUSE' })
    this.broadcastVisualState()
  }

  /** 继续自动行为（从暂停前的行为恢复，已持续时间冻结保持） */
  resume(): void {
    this.state = transition(this.state, { type: 'RESUME' })
    this.broadcastVisualState()
  }

  /** 拖动开始：立即停止自动位置推进，清除触界标记与旧行为基准 */
  handleDragStart(): void {
    this.state = transition(this.state, { type: 'DRAG_START' })
    this.currentHit = null
    this.pendingTurnDirection = null
    this.broadcastVisualState()
  }

  /**
   * 拖动结束：以窗口真实位置为新基准（防止跳回拖动前位置），
   * 重置已持续时间并重新采样目标时长（防止过期时长立即触发连续转换）。
   * 拖动后的窗口 Y 成为新的水平行走轨道（不强制回到初始 Y），
   * 后续自动行走只改变 X；若 Y 越出边界，由行走计算的钳制逐步纠正。
   */
  handleDragEnd(): void {
    this.state = transition(this.state, { type: 'DRAG_END' })
    this.syncPositionFromWindow()
    this.behaviorElapsedSec = 0
    this.currentHit = null
    this.pendingTurnDirection = null
    this.targetDurationSec = this.sampleTargetFor(this.state)
    this.broadcastVisualState()
  }

  /**
   * 广播视觉状态：仅当 (kind, facing) 与上次不同（或首次）时回调一次，
   * 避免每个 tick 重复发送相同状态。
   */
  private broadcastVisualState(): void {
    const next = this.currentVisualState
    const last = this.lastBroadcastVisualState
    if (last && last.kind === next.kind && last.facing === next.facing) {
      return
    }
    this.lastBroadcastVisualState = next
    this.onVisualStateChange?.(next)
  }

  /**
   * 单次循环步进（默认由调度器驱动；测试可显式传入时钟值手动调用）。
   * 单次 tick 最多执行一次行为转换，不会连续跨越多个阶段。
   */
  tick(nowMs: number = this.clock()): void {
    if (!this.running || this.win.isDestroyed()) {
      this.stop()
      return
    }

    const lastMs = this.lastTickMs ?? nowMs
    const rawDtSec = (nowMs - lastMs) / 1000
    this.lastTickMs = nowMs
    const dtSec = Math.min(
      Math.max(Number.isFinite(rawDtSec) ? rawDtSec : 0, 0),
      MAX_DELTA_TIME_SEC
    )

    // 暂停与拖动优先级最高：不累积行为时间、不推进位置、不做决策。
    if (this.state.kind === 'paused' || this.state.kind === 'dragging') {
      return
    }

    this.behaviorElapsedSec += dtSec

    if (this.state.kind === 'walking') {
      const result = computeMovement({
        position: this.position,
        direction: this.walkDirection,
        speedPxPerSec: this.walkSpeedPxPerSec,
        deltaTimeSec: dtSec,
        size: { width: this.win.width, height: this.win.height },
        bounds: this.getBounds()
      })
      this.position = result.position
      this.currentHit = directionalHit(result.hitBounds, this.walkDirection)

      const roundedX = Math.round(result.position.x)
      const roundedY = Math.round(result.position.y)
      if (roundedX !== this.lastSentPosition.x || roundedY !== this.lastSentPosition.y) {
        this.win.setPosition(roundedX, roundedY)
        this.lastSentPosition = { x: roundedX, y: roundedY }
      }
    } else {
      // 触界信息只对当前有效行走计算使用，不跨行为阶段残留。
      this.currentHit = null
    }

    const decision = decideBehavior({
      state: this.state,
      elapsedSec: this.behaviorElapsedSec,
      targetDurationSec: this.targetDurationSec,
      hitBounds: this.state.kind === 'walking' ? this.currentHit : null,
      config: this.deciderConfig,
      random: this.random
    })
    if (decision.type !== 'noAction') {
      this.applyDecision(decision)
    }
  }

  private applyDecision(decision: BehaviorDecision): void {
    // 转向到期决定恢复行走：状态机不允许 turning → walking 直接转换，
    // 先 TURN_END 回到待机，再由 WALK_START 开始新的行走（复合转换）。
    if (decision.type === 'startWalking' && this.state.kind === 'turning') {
      const afterTurnEnd = transition(this.state, { type: 'TURN_END' })
      if (afterTurnEnd !== this.state) {
        this.state = afterTurnEnd
      }
    }
    const event = decisionToEvent(decision, this.state)
    if (event === null) {
      // 未预期的决策结果：停止运行并输出可读错误，不静默进入未知状态。
      console.error('[PetBehaviorRuntime] 未预期的决策结果，停止自动行为:', decision)
      this.stop()
      return
    }
    const next = transition(this.state, event)
    if (next === this.state) {
      // 事件在当前状态下不适用（如映射错误）：保守忽略本轮决策。
      return
    }
    this.state = next
    this.behaviorElapsedSec = 0
    if (decision.type === 'startWalking') {
      // Task 11D：边界转向后的恢复行走使用相反水平方向（覆盖随机选向），
      // 其余来源的行走方向做水平规范化（防御历史 up/down 决策数据）。
      if (this.pendingTurnDirection !== null) {
        this.walkDirection = this.pendingTurnDirection
        this.pendingTurnDirection = null
      } else {
        this.walkDirection = normalizeHorizontalDirection(decision.direction, this.walkDirection)
      }
      this.targetDurationSec = decision.durationSec
    } else if (decision.type === 'startTurning') {
      // 边界触发的转向（directionalHit 已过滤为方向一致的水平触界）：
      // 记录相反方向，供转向结束后恢复行走时使用。
      if (this.currentHit !== null && (this.currentHit.left || this.currentHit.right)) {
        this.pendingTurnDirection = normalizeHorizontalDirection(
          { x: -this.walkDirection.x, y: 0 },
          { x: 1, y: 0 }
        )
      }
      this.targetDurationSec = decision.durationSec
    } else if (decision.type === 'startIdle') {
      // startIdle：边界转向序列被待机打断，待恢复方向不再有效。
      this.pendingTurnDirection = null
      this.targetDurationSec = decision.durationSec
    }
    // 行为阶段（或行走方向）发生变化后广播视觉状态。
    this.broadcastVisualState()
  }

  /** 按当前状态采样目标时长（阶段转换/恢复时调用，不在每个 tick 重复采样） */
  private sampleTargetFor(state: PetState): number {
    switch (state.kind) {
      case 'idle':
        return sampleDurationSec(this.deciderConfig.idleDurationSec, this.random)
      case 'walking':
        return sampleDurationSec(this.deciderConfig.walkDurationSec, this.random)
      case 'turning':
        return sampleDurationSec(this.deciderConfig.turnDurationSec, this.random)
      default:
        // paused / dragging 不会被采样（调用方只在自动行为状态调用），防御性默认值。
        return 2
    }
  }

  private syncPositionFromWindow(): void {
    if (this.win.isDestroyed()) {
      return
    }
    const position = this.win.getPosition()
    this.position = { x: position.x, y: position.y }
    this.lastSentPosition = { x: position.x, y: position.y }
  }
}
