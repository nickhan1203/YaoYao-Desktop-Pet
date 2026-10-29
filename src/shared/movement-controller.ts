/**
 * 幺幺桌宠移动控制器（纯逻辑，无 Electron/React/PixiJS/DOM/计时器依赖）。
 *
 * 职责：根据当前位置、方向、速度（像素/秒）与时间增量（秒）计算新位置，
 * 并将结果约束在活动边界内、报告触及的边界。不做方向决策、不随机、
 * 不操作窗口、不驱动动画。
 *
 * 两层接口：
 * - computeMovement：纯坐标计算，供已确认处于移动状态（walking / running）的上层使用；
 * - advancePet：接收状态机状态，仅 walking / running 状态推进位置，
 *   idle/turning/paused/dragging 一律返回原位置与零位移，
 *   从类型与行为上双重保证非移动状态不会自行移动。
 *
 * 与 display-clamp.ts 的语义区别：
 * - display-clamp（主进程）约束"窗口可见性"：拖动时至少保留 40px 可见，
 *   防止桌宠被拖丢，允许窗口大部分移出屏幕；
 * - 本模块约束"活动范围"：自动行走时宠物整体保持在边界内，
 *   供后续行为层决定是否转向。两者互补而非替代。
 */

import type { PetState } from './pet-state-machine'

export interface Vec2 {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** 活动边界（如显示器工作区），支持非零原点与负坐标 */
export interface MovementBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 触及边界标记：新位置位于对应活动边界上 */
export interface BoundsHit {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

export interface MovementInput {
  /** 当前宠物窗口左上角坐标（CSS px） */
  position: Vec2
  /** 移动方向向量（任意长度，内部归一化；零向量或非法向量表示不移动） */
  direction: Vec2
  /** 移动速度（像素/秒），非法（负数/NaN/无穷）视为 0 */
  speedPxPerSec: number
  /** 帧时间增量（秒），见 MAX_DELTA_TIME_SEC 与下方安全策略 */
  deltaTimeSec: number
  /** 宠物窗口尺寸（CSS px） */
  size: Size
  /** 活动边界 */
  bounds: MovementBounds
}

export interface MovementResult {
  /** 新坐标（始终位于活动边界允许范围内） */
  position: Vec2
  /** 实际移动的欧氏距离（像素；被边界截断时小于 speed × deltaTime） */
  movedDistance: number
  /** 新位置触及的边界 */
  hitBounds: BoundsHit
}

/**
 * 时间增量上限（秒）。60fps 约为 16.7ms，上限取 100ms（约 6 帧）：
 * 覆盖偶发帧抖动，同时防止调试暂停、标签页恢复或卡顿后出现瞬间大幅移动。
 */
export const MAX_DELTA_TIME_SEC = 0.1

const NO_HIT: BoundsHit = { left: false, right: false, top: false, bottom: false }

/**
 * 计算一步移动（纯函数）。
 *
 * 公式：newPosition = position + normalize(direction) × speed × deltaTime
 *
 * 非法输入安全策略（全部产生合法坐标、规则稳定）：
 * - deltaTime：负数或非法值（NaN/±∞）按 0 处理；超过上限截断为上限；
 * - speed：负数或非法值按 0 处理；
 * - direction：零向量或含非法分量时不移动；
 * - position：非法值（NaN/±∞）时原样返回，不推进（位置校验属上层职责）。
 */
export function computeMovement(input: MovementInput): MovementResult {
  const { position, direction, speedPxPerSec, deltaTimeSec, size, bounds } = input

  if (!isFiniteVec2(position)) {
    return { position: { x: position.x, y: position.y }, movedDistance: 0, hitBounds: NO_HIT }
  }

  // 时间增量安全策略
  let dt: number
  if (!Number.isFinite(deltaTimeSec) || deltaTimeSec < 0) {
    dt = 0
  } else {
    dt = Math.min(deltaTimeSec, MAX_DELTA_TIME_SEC)
  }

  // 速度安全策略
  const speed = Number.isFinite(speedPxPerSec) && speedPxPerSec > 0 ? speedPxPerSec : 0

  // 方向归一化
  const dirLength = Math.hypot(direction.x, direction.y)
  const hasDirection = Number.isFinite(dirLength) && dirLength > 0
  const unitX = hasDirection ? direction.x / dirLength : 0
  const unitY = hasDirection ? direction.y / dirLength : 0

  const distance = speed * dt
  const targetX = position.x + unitX * distance
  const targetY = position.y + unitY * distance

  return clampToActivityRange(targetX, targetY, position, size, bounds)
}

/**
 * 状态感知的一步推进：仅 walking / running 状态计算移动（Task 11H 起跑步
 * 同为自动水平移动，速度差异由调用方通过 speedPxPerSec 传入），
 * 其余状态（idle/turning/paused/dragging）返回原位置与零位移。
 */
export function advancePet(state: PetState, input: MovementInput): MovementResult {
  if (state.kind !== 'walking' && state.kind !== 'running') {
    return {
      position: { x: input.position.x, y: input.position.y },
      movedDistance: 0,
      hitBounds: NO_HIT
    }
  }
  return computeMovement(input)
}

/** 宠物窗口左上角允许的活动范围：使宠物整体位于边界内。 */
function activityRange(
  size: Size,
  bounds: MovementBounds
): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  // 退化边界（宽高非正）或宠物大于边界时，钳制到边界原点边（稳定、可测）。
  const spanX = bounds.width - size.width
  const spanY = bounds.height - size.height
  return {
    minX: bounds.x,
    maxX: spanX >= 0 ? bounds.x + spanX : bounds.x,
    minY: bounds.y,
    maxY: spanY >= 0 ? bounds.y + spanY : bounds.y
  }
}

function clampToActivityRange(
  targetX: number,
  targetY: number,
  originalPosition: Vec2,
  size: Size,
  bounds: MovementBounds
): MovementResult {
  const { minX, maxX, minY, maxY } = activityRange(size, bounds)
  const x = Math.min(Math.max(targetX, minX), maxX)
  const y = Math.min(Math.max(targetY, minY), maxY)
  const movedDistance = Math.hypot(x - originalPosition.x, y - originalPosition.y)
  return {
    position: { x, y },
    movedDistance,
    hitBounds: {
      left: x === minX,
      right: x === maxX,
      top: y === minY,
      bottom: y === maxY
    }
  }
}

function isFiniteVec2(v: Vec2): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y)
}
