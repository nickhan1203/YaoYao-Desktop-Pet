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
 * 用户拖动不受限，松开后的窗口 Y 成为新的水平行走轨道。
 *
 * Task 11H-B（边界立即掉头）：walking / running 触及左右边界时在移动层
 * 即时反转水平方向并保持原状态（不进入 turning、不产生等待停顿、
 * 不重置行为计时与跑步冷却）；位置由 computeMovement 钳制在边界内。
 * 决策器不再接收触界信息（hitBounds 恒为 null），其 startTurning
 * 分支与状态机 turning 状态保留（API 兼容，运行时不再触达）。
 *
 * Task 11G（自主休息）：idle 到期时决策器可按概率与冷却选择坐下/趴卧
 *（sitting / lying 状态，窗口静止）；休息到期经 REST_END 回 idle，
 * 随后的待机时长受 REST_EXIT_GUARD_SEC 下限保护，保证 renderer 的
 * 起身动画完成后才可能恢复行走（显式退出延迟，无双向确认协议）；
 * 拖动开始立即取消休息（拖动结束回 idle，不自动恢复休息）；
 * 暂停冻结休息计时与冷却，恢复后按原计划继续。
 *
 * Task 11H（自主跑步）：行走到期时决策器可按概率与冷却选择提速跑步
 *（running 状态，沿用当前水平方向，速度 runSpeedPxPerSec）；
 * 跑步到期经 RUN_END 回 idle；跑步触界仍走转向；跑步冷却从 RUN_START
 * 起计时（覆盖转向/拖动等全部退出路径，两次跑步开始间隔 ≥ 冷却时长）；
 * 拖动取消跑步（同休息取消语义）；暂停冻结跑步计时与冷却。
 *
 * Task 11H-C（调试控制接口）：debugForceBehavior / debugResumeAutoBehavior
 * 仅供开发构建经窄 IPC 调用——通过合成决策走既有 applyDecision 路径强制
 * 目标行为（窗口真实移动），调试模式下跳过自动决策；dragging/paused
 * 优先于调试控制（不锁死用户操作）。
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
import { isAutoActive } from '../shared/pet-state-machine'
import { PET_RUN_SPEED_PX_PER_SEC, PET_WALK_SPEED_PX_PER_SEC } from '../shared/pet-config'
import { toPetFacing, type PetVisualState } from '../shared/pet-visual-state'
import type { DebugBehaviorTarget } from '../shared/dev-debug'

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
  runSpeedPxPerSec?: number
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

/**
 * Task 11G 起身退出保护时长（秒）：
 * REST_END（广播给 renderer 播放起身动画）之后，紧跟的待机目标时长
 * 至少保持该值，保证行走最早在起身动画完成之后才开始。
 * renderer 的 sit/lie 退出动画为 5 帧 × 7fps ≈ 0.72s，此处取 1.5s
 * 留出广播延迟与渲染余量（显式退出延迟方案，无需双向确认协议）。
 */
export const REST_EXIT_GUARD_SEC = 1.5

/**
 * Task 11J 落地保护时长（秒）：
 * 拖动结束后（DRAG_END 恢复拖动前状态），若恢复的是移动状态
 *（walking / running），窗口位置推进延迟该时长，覆盖 renderer 的
 * 放下过渡动画（07→08→01，140+180+160 = 480ms），保证"放下尚未
 * 完成时主进程不提前移动窗口"。超时自动恢复移动（renderer 出错也
 * 不会永久停住）；新拖动开始（DRAG_START）立即清零（放下途中再次
 * 抓取不受保护拖延）。
 */
export const LANDING_GUARD_SEC = 0.48

function defaultScheduler(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs)
  return () => clearInterval(timer)
}

function anyHit(hit: BoundsHit): boolean {
  return hit.left || hit.right || hit.top || hit.bottom
}

/** 正有限数判定（速度等运行时参数防御） */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** 自动行为状态 → 安全回到 idle 的状态机事件（其他状态返回 null） */
function autoActivityEndEvent(state: PetState): PetEvent | null {
  switch (state.kind) {
    case 'walking':
      return { type: 'WALK_END' }
    case 'turning':
      return { type: 'TURN_END' }
    case 'running':
      return { type: 'RUN_END' }
    case 'sitting':
    case 'lying':
      return { type: 'REST_END' }
    default:
      return null
  }
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
    case 'startSitting':
      return { type: 'SIT_START' }
    case 'startLying':
      return { type: 'LIE_START' }
    case 'startRunning':
      return { type: 'RUN_START' }
    case 'startIdle':
      if (state.kind === 'turning') {
        return { type: 'TURN_END' }
      }
      if (state.kind === 'sitting' || state.kind === 'lying') {
        return { type: 'REST_END' }
      }
      if (state.kind === 'running') {
        return { type: 'RUN_END' }
      }
      return { type: 'WALK_END' }
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
  /** 行为决策配置（Task 12B 起可经 applyRuntimeConfig 动态更新） */
  private deciderConfig: BehaviorDeciderConfig
  /** 行走速度（Task 12B 起可动态更新，立即作用于后续 movement tick） */
  private walkSpeedPxPerSec: number
  /** 跑步速度（Task 12B 起与行走速度按 1.6 倍率派生更新） */
  private runSpeedPxPerSec: number
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
  /**
   * 休息冷却剩余秒数（Task 11G）：REST_END 时重置为配置冷却时长，
   * 之后随 tick 递减；仅 ≤ 0 时决策器才可能选择休息。
   * paused / dragging 期间冻结（不随真实时间流逝，确定性可测）。
   */
  private restCooldownRemainingSec = 0
  /**
   * 跑步冷却剩余秒数（Task 11H）：RUN_START 时重置为配置冷却时长，
   * 之后随 tick 递减；仅 ≤ 0 时决策器才可能在行走到期时选择跑步。
   * 从跑步开始（而非结束）计时：无论跑步经 RUN_END、边界转向还是
   * 拖动结束退出，两次跑步开始之间的间隔都 ≥ 冷却时长。
   * paused / dragging 期间冻结（与休息冷却一致，确定性可测）。
   */
  private runCooldownRemainingSec = 0
  /**
   * 落地保护剩余秒数（Task 11J）：DRAG_END 时重置为 LANDING_GUARD_SEC，
   * 随 tick 递减；> 0 期间 walking / running 不推进窗口位置（放下动画
   * 完成前窗口静止）。DRAG_START 清零（新拖动中断保护）。
   * 与冷却计时一致：dragging / paused 期间冻结（确定性可测）。
   */
  private landingGuardRemainingSec = 0
  /**
   * 调试控制模式（Task 11H-C，仅开发构建经窄 IPC 触发）：
   * true 时跳过自动决策（行为时长到期不触发阶段转换），但窗口仍按
   * 当前状态真实移动（walking/running 以真实速度推进坐标）。
   * debugResumeAutoBehavior() 释放并重采样当前状态目标时长。
   */
  private debugMode = false
  /**
   * 自动活动总开关（Task 12B 用户设置，持久化偏好）：
   * false 时无自主移动与随机行为决策——当前自动行为状态经状态机
   * 事件安全回到 idle（tick 自愈任何恢复路径：拖动结束/继续活动等
   * 恢复的自动状态会被立即结束），鼠标交互（点击/拖动/拎起/放下）
   * 不受影响。与 12A 用户暂停（paused）完全独立：
   * "继续活动"不会绕过该偏好，隐藏/调试暂停也不会改变它。
   */
  private autoActivityEnabled = true
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
    this.runSpeedPxPerSec = config.runSpeedPxPerSec ?? PET_RUN_SPEED_PX_PER_SEC
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
    // Task 11G：启动即进入完整冷却，首次休息至少在冷却时长之后，
    // 避免刚启动就坐下/趴卧（同时保证旧测试的时间窗内不触发休息）。
    this.restCooldownRemainingSec = this.deciderConfig.restCooldownSec
    // Task 11H：跑步冷却同理，首次跑步至少在冷却时长之后。
    this.runCooldownRemainingSec = this.deciderConfig.runCooldownSec
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
    // Task 11J：新拖动中断落地保护（放下途中再次抓取不受保护拖延）。
    this.landingGuardRemainingSec = 0
    this.broadcastVisualState()
  }

  /**
   * Task 12A：外部（重置位置/显示边界修正）移动窗口后同步内部位置基准。
   * 运行时的行走计算基于内部 position（浮点），外部 setPosition 若不同步，
   * 下一个行走 tick 会把窗口拉回旧位置。同步后新 Y 即新的水平行走轨道。
   */
  handleExternalPositionChange(): void {
    this.syncPositionFromWindow()
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
    // Task 11J：落地保护——放下过渡动画（480ms）完成前，恢复的
    // walking / running 不推进窗口位置（超时自动恢复，见 tick）。
    this.landingGuardRemainingSec = LANDING_GUARD_SEC
    // Task 11H-B：松手位置贴近左右边界（或被拖出边界）且恢复的方向
    // 指向不可移动一侧时，预先反转朝向，保证恢复自动行走的第一个
    // tick 即向可移动方向移动（位置越界由行走钳制纠正）。
    if (this.state.kind === 'walking' || this.state.kind === 'running') {
      this.alignDirectionToBounds()
    }
    this.broadcastVisualState()
  }

  /**
   * Task 11H-B：反转水平行走方向（左右互换）并广播新朝向。
   * 仅在存在可移动空间时反转：退化边界（workArea 宽度 ≤ 窗口宽度，
   * maxX === minX）下保持原方向，避免每个 tick 反复反转造成抖动；
   * 此时位置被钳制在边界原点，窗口保持静止。
   */
  private reverseWalkDirection(bounds: MovementBounds): void {
    if (bounds.width - this.win.width <= 0) {
      return
    }
    this.walkDirection = normalizeHorizontalDirection(
      { x: -this.walkDirection.x, y: 0 },
      { x: 1, y: 0 }
    )
    // 状态不变、朝向变化 → renderer 收到新视觉状态后立即镜像角色。
    this.broadcastVisualState()
  }

  /**
   * Task 11H-B：校准朝向到可移动方向（拖动结束时调用）。
   * 位置贴近/越过边界且方向指向不可移动一侧时立即反转，
   * 保证恢复行走的第一个 tick 即向界内移动；其余情况不改变方向。
   */
  private alignDirectionToBounds(): void {
    const bounds = this.getBounds()
    const spanX = bounds.width - this.win.width
    if (spanX <= 0) {
      return
    }
    const minX = bounds.x
    const maxX = bounds.x + spanX
    if (this.walkDirection.x > 0 && this.position.x >= maxX) {
      this.reverseWalkDirection(bounds)
    } else if (this.walkDirection.x < 0 && this.position.x <= minX) {
      this.reverseWalkDirection(bounds)
    }
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

    // Task 12B：自动活动关闭时，任何路径恢复出的自动行为状态（拖动结束、
    // 继续活动、暂停恢复等）在 tick 自愈回到 idle——不产生自主移动；
    // 决策在本轮 tick 末尾一并跳过（见 autoActivityEnabled 检查）。
    if (!this.autoActivityEnabled && isAutoActive(this.state)) {
      this.endAutoActivity()
    }

    this.behaviorElapsedSec += dtSec
    // Task 11G：休息冷却随行为时间递减（paused/dragging 冻结在上方早退）。
    if (this.restCooldownRemainingSec > 0) {
      this.restCooldownRemainingSec = Math.max(0, this.restCooldownRemainingSec - dtSec)
    }
    // Task 11H：跑步冷却同步递减（同一冻结语义）。
    if (this.runCooldownRemainingSec > 0) {
      this.runCooldownRemainingSec = Math.max(0, this.runCooldownRemainingSec - dtSec)
    }
    if (this.landingGuardRemainingSec > 0) {
      // Task 11J：落地保护随真实时间递减（超时自动恢复移动；
      // dragging / paused 期间与其他计时一致冻结——见 freeze 语义注释）。
      this.landingGuardRemainingSec = Math.max(0, this.landingGuardRemainingSec - dtSec)
    }

    // Task 11J：落地保护期内不推进窗口位置——renderer 的放下过渡动画
    //（480ms）完成前保持静止；行为状态与决策计时不受影响（状态机照常）。
    const landingHold = this.landingGuardRemainingSec > 0

    // Task 11G/11H：仅 walking / running 推进窗口位置；
    // sitting / lying 保持静止（不产生任何 setPosition）。
    if ((this.state.kind === 'walking' || this.state.kind === 'running') && !landingHold) {
      const bounds = this.getBounds()
      const speedPxPerSec =
        this.state.kind === 'running' ? this.runSpeedPxPerSec : this.walkSpeedPxPerSec
      const result = computeMovement({
        position: this.position,
        direction: this.walkDirection,
        speedPxPerSec,
        deltaTimeSec: dtSec,
        size: { width: this.win.width, height: this.win.height },
        bounds
      })
      this.position = result.position
      this.currentHit = directionalHit(result.hitBounds, this.walkDirection)

      // Task 11H-B：左右边界立即掉头。位置已被 computeMovement 钳制在
      // 边界内；此处仅反转水平方向并保持 walking / running（不进入
      // turning、不重置 behaviorElapsedSec / 冷却）。反转后下一 tick
      // 即向可移动方向移动；directionalHit 已过滤"方向指向且被截断"，
      // 贴边反向行走不会再次触发（无抖动）。
      if (this.currentHit !== null && (this.currentHit.left || this.currentHit.right)) {
        this.reverseWalkDirection(bounds)
      }

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

    // Task 11H-C：调试控制模式下不做自动决策（窗口仍按当前状态真实移动），
    // 行为时长到期不触发阶段转换；恢复自动行为时重置计时与目标。
    // Task 12B：自动活动关闭时同样跳过决策（用户持久化偏好）。
    if (this.debugMode || !this.autoActivityEnabled) {
      return
    }

    const decision = decideBehavior({
      state: this.state,
      elapsedSec: this.behaviorElapsedSec,
      targetDurationSec: this.targetDurationSec,
      // Task 11H-B：左右边界在移动层即时反转（保持原状态），决策器
      // 不再接收触界信息；startTurning 分支保留为纯函数 API 兼容。
      hitBounds: null,
      restCooldownRemainingSec: this.restCooldownRemainingSec,
      runCooldownRemainingSec: this.runCooldownRemainingSec,
      config: this.deciderConfig,
      random: this.random
    })
    if (decision.type !== 'noAction') {
      this.applyDecision(decision)
    }
  }

  /**
   * Task 11H-C：调试强制行为（仅开发构建经窄 IPC 触发）。
   *
   * 语义与约束：
   * - 通过合成决策走既有 applyDecision 路径（状态机仍是唯一状态修改入口，
   *   不绕过状态机直接改内部状态）；
   * - 非 idle 状态先经合法事件回到待机（WALK_END/RUN_END/TURN_END/REST_END
   *   由 startIdle 按当前状态映射），再进入目标状态；
   * - walking / running 沿用当前水平方向与真实速度（窗口真实移动）；
   *   Task 11I：walking 可显式指定朝向（面板左/右向行走预览），方向仍经
   *   applyDecision 的水平规范化落位，不绕过状态机；
   * - dragging / paused 优先于调试（直接忽略，不锁死用户操作）；
   * - 进入调试控制模式（跳过自动决策）；重复调用幂等（每次重新落位
   *   目标状态，不产生多重计时器或订阅）。
   */
  debugForceBehavior(target: DebugBehaviorTarget, facing?: 'left' | 'right'): void {
    if (this.state.kind === 'dragging' || this.state.kind === 'paused') {
      return
    }
    if (!this.running) {
      this.start()
    }
    this.debugMode = true
    if (this.state.kind !== 'idle') {
      this.applyDecision({
        type: 'startIdle',
        durationSec: sampleDurationSec(this.deciderConfig.idleDurationSec, this.random)
      })
    }
    if (target === 'walking') {
      const direction =
        facing === 'left'
          ? { x: -1, y: 0 }
          : facing === 'right'
            ? { x: 1, y: 0 }
            : this.walkDirection
      this.applyDecision({
        type: 'startWalking',
        direction,
        durationSec: sampleDurationSec(this.deciderConfig.walkDurationSec, this.random)
      })
    } else if (target === 'running') {
      this.applyDecision({
        type: 'startRunning',
        durationSec: sampleDurationSec(this.deciderConfig.runDurationSec, this.random)
      })
    } else if (target === 'sitting') {
      this.applyDecision({
        type: 'startSitting',
        durationSec: sampleDurationSec(this.deciderConfig.restSitDurationSec, this.random)
      })
    } else if (target === 'lying') {
      this.applyDecision({
        type: 'startLying',
        durationSec: sampleDurationSec(this.deciderConfig.restLieDurationSec, this.random)
      })
    }
    // target === 'idle'：已回到待机，无后续转换。
  }

  /**
   * Task 11H-C：释放调试控制，恢复自动决策。
   * 重置已持续时间并按当前状态重新采样目标时长（避免调试期间累积的
   * elapsed 立即触发阶段转换）；幂等（未处于调试模式时为无操作）。
   */
  debugResumeAutoBehavior(): void {
    if (!this.debugMode) {
      return
    }
    this.debugMode = false
    this.behaviorElapsedSec = 0
    this.targetDurationSec = this.sampleTargetFor(this.state)
    this.broadcastVisualState()
  }

  /** 当前是否处于调试控制模式（自动决策已挂起） */
  get isDebugControlled(): boolean {
    return this.debugMode
  }

  /**
   * Task 12B：动态应用运行时配置（用户设置）。
   * - 速度立即作用于后续 movement tick（正在行走时下一个 tick 即用新值），
   *   不重置当前行为状态与计时（更新不产生意外移动）；
   * - 决策配置更新时剩余冷却立即收紧到新上限（min 策略：不延长剩余
   *   冷却；调低频率立即可感知，调高频率按新冷却正常生效）；
   * - 正在拖动、暂停或休息时调用同样安全：只改参数，行为由状态机照常。
   */
  applyRuntimeConfig(config: {
    walkSpeedPxPerSec?: number
    runSpeedPxPerSec?: number
    decider?: BehaviorDeciderConfig
  }): void {
    if (isPositiveFinite(config.walkSpeedPxPerSec)) {
      this.walkSpeedPxPerSec = config.walkSpeedPxPerSec
    }
    if (isPositiveFinite(config.runSpeedPxPerSec)) {
      this.runSpeedPxPerSec = config.runSpeedPxPerSec
    }
    if (config.decider !== undefined) {
      this.deciderConfig = config.decider
      // 冷却收紧：剩余值不超过新配置上限（立即收紧，不延长）。
      this.runCooldownRemainingSec = Math.min(
        this.runCooldownRemainingSec,
        this.deciderConfig.runCooldownSec
      )
      this.restCooldownRemainingSec = Math.min(
        this.restCooldownRemainingSec,
        this.deciderConfig.restCooldownSec
      )
    }
  }

  /**
   * Task 12B：自动活动总开关（用户持久化偏好，与 12A 用户暂停独立）。
   * - 关闭：当前自动行为状态经状态机事件安全回到 idle（walking→WALK_END
   *   等），决策与自主移动停止；鼠标交互不受影响；paused / dragging 期间
   *   仅记录标志（恢复路径由 tick 自愈收口）；
   * - 开启：重新采样当前状态目标时长（避免禁用期间累积的 elapsed 立即
   *   触发转换），自动决策从当前状态继续。
   */
  setAutoActivityEnabled(enabled: boolean): void {
    if (this.autoActivityEnabled === enabled) {
      return
    }
    this.autoActivityEnabled = enabled
    if (!enabled) {
      if (this.state.kind === 'paused' || this.state.kind === 'dragging') {
        return
      }
      this.endAutoActivity()
      return
    }
    // 重新开启：重置计时并重采样目标（从当前状态自然继续）。
    this.behaviorElapsedSec = 0
    this.targetDurationSec = this.sampleTargetFor(this.state)
  }

  /** 当前自动活动开关状态（设置查询用） */
  get isAutoActivityEnabled(): boolean {
    return this.autoActivityEnabled
  }

  /**
   * 结束当前自动行为状态回到 idle（自动活动关闭路径专用）。
   * 经状态机合法事件转换（不绕过状态机）；重置计时并广播视觉状态。
   */
  private endAutoActivity(): void {
    const event = autoActivityEndEvent(this.state)
    if (event === null) {
      return
    }
    const next = transition(this.state, event)
    if (next === this.state) {
      return
    }
    this.state = next
    this.behaviorElapsedSec = 0
    this.targetDurationSec = this.sampleTargetFor(this.state)
    this.currentHit = null
    this.broadcastVisualState()
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
    } else if (decision.type === 'startSitting' || decision.type === 'startLying') {
      // Task 11G：进入休息。窗口即刻静止（非 walking 不移动），
      // 视觉状态广播触发 renderer 播放对应进入动画。
      this.targetDurationSec = decision.durationSec
    } else if (decision.type === 'startRunning') {
      // Task 11H：行走提速为跑步。方向沿用当前水平行走方向
      //（不重新选向，保证视觉与位移方向连续），速度差异由 tick 的
      // 速度选择体现；目标时长为决策器采样的跑步时长。
      // 冷却从跑步开始计时：跑步可能经 RUN_END、边界转向或拖动结束，
      // 统一在起点重置保证两次跑步开始间隔 ≥ 冷却时长。
      this.runCooldownRemainingSec = this.deciderConfig.runCooldownSec
      this.targetDurationSec = decision.durationSec
    } else if (decision.type === 'startIdle') {
      // startIdle：边界转向序列被待机打断，待恢复方向不再有效。
      this.pendingTurnDirection = null
      if (event.type === 'REST_END') {
        // Task 11G：休息结束——重置冷却，并对待机时长施加起身退出保护，
        // 保证 renderer 起身动画（约 0.72s）完成后才可能恢复行走。
        this.restCooldownRemainingSec = this.deciderConfig.restCooldownSec
        this.targetDurationSec = Math.max(decision.durationSec, REST_EXIT_GUARD_SEC)
      } else {
        this.targetDurationSec = decision.durationSec
      }
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
      case 'running':
        return sampleDurationSec(this.deciderConfig.runDurationSec, this.random)
      case 'turning':
        return sampleDurationSec(this.deciderConfig.turnDurationSec, this.random)
      case 'sitting':
        return sampleDurationSec(this.deciderConfig.restSitDurationSec, this.random)
      case 'lying':
        return sampleDurationSec(this.deciderConfig.restLieDurationSec, this.random)
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
