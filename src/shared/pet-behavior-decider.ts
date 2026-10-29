/**
 * 幺幺桌宠自动行为决策器（纯逻辑，无 Electron/React/PixiJS/DOM/计时器依赖，
 * 不读取系统时间，不直接调用 Math.random）。
 *
 * 职责：回答"根据当前情况，下一步应该执行什么行为？"，只输出行为意图
 * 与必要参数，不修改状态、不移动窗口、不播放动画。由后续集成层把决策
 * 映射为状态机事件并驱动各模块。
 *
 * 与现有模块的关系：
 * - 复用 pet-state-machine 的 PetState 类型；
 * - 复用 movement-controller 的 Vec2 / BoundsHit 几何类型；
 * - 不调用 movement-controller 计算坐标，边界信息由调用方提供。
 *
 * 决策结果 → 状态机事件映射约定（由集成层执行）：
 * - startWalking → WALK_START
 * - startTurning → TURN_START
 * - startIdle（当前为 walking）→ WALK_END
 * - startIdle（当前为 turning）→ TURN_END
 * - startIdle（当前为 sitting / lying）→ REST_END（Task 11G）
 * - startSitting → SIT_START（Task 11G）
 * - startLying → LIE_START（Task 11G）
 *
 * 可复现性：相同输入、配置与随机数序列产生完全相同的决策。
 * 随机消耗顺序固定：每次决策按分支顺序消耗，详见各分支注释。
 */

import type { PetState } from './pet-state-machine'
import type { BoundsHit, Vec2 } from './movement-controller'

/** 随机数来源：约定返回 [0, 1)；非法值会被 sanitizeRandom 稳定化 */
export type RandomSource = () => number

/** 时长范围（秒），min <= max 且均为正数 */
export interface DurationRange {
  minSec: number
  maxSec: number
}

export interface BehaviorDeciderConfig {
  /** 单次待机的目标时长范围 */
  idleDurationSec: DurationRange
  /** 单次转向的目标时长范围 */
  turnDurationSec: DurationRange
  /** 连续行走的目标时长范围，达到后进入待机（短暂休息） */
  walkDurationSec: DurationRange
  /** 转向结束后恢复行走的概率 [0, 1]，其余概率进入待机 */
  resumeWalkAfterTurnRatio: number
  /** 单次坐下休息的目标时长范围（Task 11G） */
  restSitDurationSec: DurationRange
  /** 单次趴卧休息的目标时长范围（Task 11G） */
  restLieDurationSec: DurationRange
  /** 两次休息之间的冷却时间（秒，Task 11G；运行时从 REST_END 起计时） */
  restCooldownSec: number
  /** 待机到期时进入休息的概率 [0, 1]（Task 11G；0 表示禁用休息） */
  restChance: number
  /** 休息分流中坐下的占比 [0, 1]（其余为趴卧，Task 11G） */
  restSitShare: number
}

/**
 * 默认行为参数。文档未定义具体数值，按"低干扰、节奏自然"选择：
 * 待机 2–6 秒（停留可感知但不僵住）、连续行走 6–15 秒（活动一段即休息）、
 * 转向 0.4–0.8 秒（一次自然的转身时长）、70% 转向后继续行走。
 * Task 11G 休息初始参数（调试值，非最终频率）：坐下 8–15 秒、
 * 趴卧 15–30 秒、冷却 45 秒、待机到期 40% 概率休息（其中 60% 坐下）。
 */
export const DEFAULT_BEHAVIOR_DECIDER_CONFIG: BehaviorDeciderConfig = {
  idleDurationSec: { minSec: 2, maxSec: 6 },
  turnDurationSec: { minSec: 0.4, maxSec: 0.8 },
  walkDurationSec: { minSec: 6, maxSec: 15 },
  resumeWalkAfterTurnRatio: 0.7,
  restSitDurationSec: { minSec: 8, maxSec: 15 },
  restLieDurationSec: { minSec: 15, maxSec: 30 },
  restCooldownSec: 45,
  restChance: 0.4,
  restSitShare: 0.6
}

/**
 * 行走方向候选（单位向量：右、左）。
 * Task 11D：自动行走仅允许水平方向（用户要求桌宠只左右移动），
 * 不产生 up/down 自动行走决策；垂直移动只来自用户拖动。
 * PetVisualState 协议中的 up/down facing 仍保留（向前兼容），但本决策器不再产出。
 */
export const WALK_DIRECTIONS: readonly Vec2[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 }
]

/** 决策器输入：当前情况快照，由调用方（集成层）组装 */
export interface BehaviorDeciderInput {
  state: PetState
  /** 当前行为已持续时间（秒）；负数/NaN/∞ 按 0 处理 */
  elapsedSec: number
  /**
   * 当前行为的目标时长（秒），来自上一次决策输出或初始采样。
   * null 或非法值（负/NaN/∞）按"阈值未确定"处理：保守返回 noAction，
   * 避免在缺失计划的情况下贸然转换行为。
   */
  targetDurationSec: number | null
  /** 行走触界信息；仅 walking 状态使用，其他状态下被忽略 */
  hitBounds: BoundsHit | null
  /**
   * 休息冷却剩余秒数（Task 11G）。undefined 表示调用方未启用休息决策
   * （不消耗随机数、行为与旧版本完全一致）；> 0 表示冷却中（同样不
   * 消耗随机数）；≤ 0 表示可以休息。
   */
  restCooldownRemainingSec?: number
  config: BehaviorDeciderConfig
  random: RandomSource
}

/** 决策输出：行为意图判别联合，携带该行为执行所需的参数 */
export type BehaviorDecision =
  | { type: 'noAction' }
  | { type: 'startWalking'; direction: Vec2; durationSec: number }
  | { type: 'startTurning'; durationSec: number }
  | { type: 'startIdle'; durationSec: number }
  | { type: 'startSitting'; durationSec: number }
  | { type: 'startLying'; durationSec: number }

const NO_ACTION: BehaviorDecision = { type: 'noAction' }

/** 随机数合法上界（小于 1 的最大可用常量），保证 floor 索引不越界 */
const MAX_RANDOM = 0.9999999999999999

/**
 * 将任意随机值稳定化为 [0, 1)：
 * 非有限值（NaN/±∞）与负数归 0；大于等于 1 截断为 MAX_RANDOM。
 */
export function sanitizeRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(Math.max(value, 0), MAX_RANDOM)
}

/** 持续时间安全化：非法或负值按 0 处理 */
function sanitizeElapsed(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 目标时长有效性：必须为正的有限数 */
function isValidTarget(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** 配置字段级校验：非法字段回退默认值（明确的安全默认值策略） */
function resolveConfig(config: BehaviorDeciderConfig): BehaviorDeciderConfig {
  const fallback = DEFAULT_BEHAVIOR_DECIDER_CONFIG
  const range = (value: DurationRange, def: DurationRange): DurationRange => {
    if (
      !Number.isFinite(value?.minSec) ||
      !Number.isFinite(value?.maxSec) ||
      value.minSec < 0 ||
      value.maxSec < value.minSec
    ) {
      return def
    }
    return value
  }
  const ratio = config?.resumeWalkAfterTurnRatio
  const restChance = config?.restChance
  const restSitShare = config?.restSitShare
  const restCooldownSec = config?.restCooldownSec
  return {
    idleDurationSec: range(config?.idleDurationSec, fallback.idleDurationSec),
    turnDurationSec: range(config?.turnDurationSec, fallback.turnDurationSec),
    walkDurationSec: range(config?.walkDurationSec, fallback.walkDurationSec),
    resumeWalkAfterTurnRatio:
      Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
        ? ratio
        : fallback.resumeWalkAfterTurnRatio,
    restSitDurationSec: range(config?.restSitDurationSec, fallback.restSitDurationSec),
    restLieDurationSec: range(config?.restLieDurationSec, fallback.restLieDurationSec),
    restCooldownSec:
      Number.isFinite(restCooldownSec) && restCooldownSec >= 0
        ? restCooldownSec
        : fallback.restCooldownSec,
    restChance:
      Number.isFinite(restChance) && restChance >= 0 && restChance <= 1
        ? restChance
        : fallback.restChance,
    restSitShare:
      Number.isFinite(restSitShare) && restSitShare >= 0 && restSitShare <= 1
        ? restSitShare
        : fallback.restSitShare
  }
}

function hasHit(hit: BoundsHit | null): boolean {
  return hit !== null && (hit.left || hit.right || hit.top || hit.bottom)
}

/**
 * 在时长范围内采样一个目标时长（供决策输出与集成层初始/恢复采样使用）。
 * 随机值在内部稳定化为 [0, 1)。
 */
export function sampleDurationSec(range: DurationRange, random: RandomSource): number {
  const span = range.maxSec - range.minSec
  if (span <= 0) {
    return range.minSec
  }
  return range.minSec + sanitizeRandom(random()) * span
}

/** 从 WALK_DIRECTIONS 中按随机值选一个单位方向向量 */
function pickDirection(nextRandom: () => number): Vec2 {
  const index = Math.floor(nextRandom() * WALK_DIRECTIONS.length)
  return WALK_DIRECTIONS[Math.min(index, WALK_DIRECTIONS.length - 1)]
}

/**
 * 核心决策（纯函数）。
 *
 * 随机数消耗顺序（保证可复现）：
 * - idle 达到阈值：先判定休息（冷却归零且 restChance > 0 时消耗
 *   1 次概率 + 1 次坐/趴分流；命中休息且时长范围 min < max 时再消耗
 *   1 次采样时长）；未命中或未启用则按行走决策消耗 2 次（方向、行走时长）。
 * - walking 触界：1 次（转向时长）
 * - walking 达到活动上限：1 次（待机时长）
 * - turning 达到阈值：1 次（分流）+ 2 次（行走方向与行走时长，或待机时长）
 * - sitting / lying 达到阈值：1 次（待机时长；Task 11G 的 REST_END）
 *
 * 优先级：paused / dragging 一律 noAction（决策器不擅自结束暂停或拖动）。
 */
export function decideBehavior(input: BehaviorDeciderInput): BehaviorDecision {
  const { state } = input

  // 暂停与拖动具有最高优先级：不生成任何自动行为决策。
  if (state.kind === 'paused' || state.kind === 'dragging') {
    return NO_ACTION
  }

  const config = resolveConfig(input.config)
  const nextRandom = (): number => sanitizeRandom(input.random())
  const elapsed = sanitizeElapsed(input.elapsedSec)
  const target = isValidTarget(input.targetDurationSec)
    ? input.targetDurationSec
    : Number.POSITIVE_INFINITY

  switch (state.kind) {
    case 'idle': {
      if (elapsed < target) {
        return NO_ACTION
      }
      // Task 11G 休息判定：仅在调用方提供冷却值且已归零、
      // 且 restChance > 0 时才消耗随机数（未启用时行为与旧版本一致）。
      const cooldown = input.restCooldownRemainingSec
      const restAllowed =
        cooldown !== undefined &&
        Number.isFinite(cooldown) &&
        cooldown <= 0 &&
        config.restChance > 0
      if (restAllowed && nextRandom() < config.restChance) {
        if (nextRandom() < config.restSitShare) {
          return {
            type: 'startSitting',
            durationSec: sampleDurationSec(config.restSitDurationSec, nextRandom)
          }
        }
        return {
          type: 'startLying',
          durationSec: sampleDurationSec(config.restLieDurationSec, nextRandom)
        }
      }
      return {
        type: 'startWalking',
        direction: pickDirection(nextRandom),
        durationSec: sampleDurationSec(config.walkDurationSec, nextRandom)
      }
    }

    case 'walking': {
      // 触及活动边界：请求转向（优先于活动时长判断）。
      if (hasHit(input.hitBounds)) {
        return {
          type: 'startTurning',
          durationSec: sampleDurationSec(config.turnDurationSec, nextRandom)
        }
      }
      // 连续活动达到目标时长：进入短暂待机。
      if (elapsed >= target) {
        return {
          type: 'startIdle',
          durationSec: sampleDurationSec(config.idleDurationSec, nextRandom)
        }
      }
      return NO_ACTION
    }

    case 'turning': {
      if (elapsed < target) {
        return NO_ACTION
      }
      // 转向结束：按概率恢复行走，否则进入待机。
      if (nextRandom() < config.resumeWalkAfterTurnRatio) {
        return {
          type: 'startWalking',
          direction: pickDirection(nextRandom),
          durationSec: sampleDurationSec(config.walkDurationSec, nextRandom)
        }
      }
      return {
        type: 'startIdle',
        durationSec: sampleDurationSec(config.idleDurationSec, nextRandom)
      }
    }

    case 'sitting':
    case 'lying': {
      // Task 11G：休息到期 → 结束休息回到待机（集成层映射为 REST_END，
      // 并在恢复行走前保证起身动画完成的退出保护时长）。
      if (elapsed < target) {
        return NO_ACTION
      }
      return {
        type: 'startIdle',
        durationSec: sampleDurationSec(config.idleDurationSec, nextRandom)
      }
    }
  }
}
