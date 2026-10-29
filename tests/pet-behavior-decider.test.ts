import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BEHAVIOR_DECIDER_CONFIG,
  WALK_DIRECTIONS,
  decideBehavior,
  sanitizeRandom,
  type BehaviorDeciderConfig,
  type BehaviorDeciderInput,
  type RandomSource
} from '../src/shared/pet-behavior-decider'

const NO_HIT = { left: false, right: false, top: false, bottom: false }

/** 固定随机数序列：按顺序返回，耗尽后重复最后一个值 */
function sequence(values: number[]): RandomSource {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}

function input(overrides: Partial<BehaviorDeciderInput> = {}): BehaviorDeciderInput {
  return {
    state: { kind: 'idle' },
    elapsedSec: 0,
    targetDurationSec: 2,
    hitBounds: null,
    config: DEFAULT_BEHAVIOR_DECIDER_CONFIG,
    random: sequence([0.5]),
    ...overrides
  }
}

/** 非法配置：范围倒置 / NaN / 负数 / 非法概率 */
const INVALID_CONFIG: BehaviorDeciderConfig = {
  idleDurationSec: { minSec: 6, maxSec: 2 },
  turnDurationSec: { minSec: Number.NaN, maxSec: 1 },
  walkDurationSec: { minSec: -5, maxSec: 10 },
  resumeWalkAfterTurnRatio: 2,
  restSitDurationSec: { minSec: 15, maxSec: 8 },
  restLieDurationSec: { minSec: Number.NaN, maxSec: 20 },
  restCooldownSec: -10,
  restChance: 1.5,
  restSitShare: -0.1
}

describe('可复现性', () => {
  it('相同输入与随机序列产生完全相同的决策', () => {
    const base = input({
      state: { kind: 'turning' },
      elapsedSec: 1,
      targetDurationSec: 0.5,
      random: sequence([0.3, 0.25])
    })
    const first = decideBehavior(base)
    const second = decideBehavior(
      input({
        state: { kind: 'turning' },
        elapsedSec: 1,
        targetDurationSec: 0.5,
        random: sequence([0.3, 0.25])
      })
    )
    expect(second).toEqual(first)
  })
})

describe('待机行为', () => {
  it('待机时间未到阈值时不产生行为转换', () => {
    const decision = decideBehavior(
      input({ state: { kind: 'idle' }, elapsedSec: 1.9, targetDurationSec: 2 })
    )
    expect(decision).toEqual({ type: 'noAction' })
  })

  it('待机时间达到阈值时开始行走，方向为候选单位向量，携带行走时长', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'idle' },
        elapsedSec: 2,
        targetDurationSec: 2,
        random: sequence([0.9])
      })
    )
    expect(decision.type).toBe('startWalking')
    if (decision.type === 'startWalking') {
      // random 0.9 → index floor(0.9×2)=1 → 左（Task 11D：候选仅水平双向）
      expect(decision.direction).toEqual({ x: -1, y: 0 })
      expect(WALK_DIRECTIONS).toContainEqual(decision.direction)
      // 第二次消耗（序列重复 0.9）：行走时长 6 + 0.9×9 = 14.1
      expect(decision.durationSec).toBeCloseTo(14.1, 10)
    }
  })

  it('Task 11D：行走方向候选只包含水平方向，不产出垂直自动行走', () => {
    expect(WALK_DIRECTIONS).toHaveLength(2)
    for (const direction of WALK_DIRECTIONS) {
      expect(direction.y).toBe(0)
      expect(Math.abs(direction.x)).toBe(1)
    }
    // 全部随机值域内产出的方向均为水平单位向量
    for (const r of [0, 0.2, 0.5, 0.8, 0.99]) {
      const decision = decideBehavior(
        input({
          state: { kind: 'idle' },
          elapsedSec: 2,
          targetDurationSec: 2,
          random: sequence([r])
        })
      )
      if (decision.type === 'startWalking') {
        expect(decision.direction.y).toBe(0)
        expect(Math.abs(decision.direction.x)).toBe(1)
      }
    }
  })

  it('startIdle 携带的待机时长上下界符合配置', () => {
    // walking 达到活动上限 → startIdle，第一个随机数决定待机时长
    const min = decideBehavior(
      input({
        state: { kind: 'walking' },
        elapsedSec: 6,
        targetDurationSec: 6,
        random: sequence([0])
      })
    )
    expect(min.type).toBe('startIdle')
    if (min.type === 'startIdle') {
      expect(min.durationSec).toBe(2) // min 2 + 0×4
    }

    const mid = decideBehavior(
      input({
        state: { kind: 'walking' },
        elapsedSec: 6,
        targetDurationSec: 6,
        random: sequence([0.5])
      })
    )
    if (mid.type === 'startIdle') {
      expect(mid.durationSec).toBe(4) // 2 + 0.5×4
    }

    const nearMax = decideBehavior(
      input({
        state: { kind: 'walking' },
        elapsedSec: 6,
        targetDurationSec: 6,
        random: sequence([0.999])
      })
    )
    if (nearMax.type === 'startIdle') {
      expect(nearMax.durationSec).toBeLessThan(6)
      expect(nearMax.durationSec).toBeGreaterThan(5)
    }
  })
})

describe('行走行为', () => {
  it('行走且未触界时不产生转换', () => {
    const decision = decideBehavior(
      input({ state: { kind: 'walking' }, elapsedSec: 1, targetDurationSec: 10, hitBounds: NO_HIT })
    )
    expect(decision).toEqual({ type: 'noAction' })
  })

  it('行走且触及边界时产生转向决策，时长在配置范围内', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'walking' },
        elapsedSec: 1,
        targetDurationSec: 10,
        hitBounds: { left: true, right: false, top: false, bottom: false },
        random: sequence([0.5])
      })
    )
    expect(decision.type).toBe('startTurning')
    if (decision.type === 'startTurning') {
      expect(decision.durationSec).toBeCloseTo(0.6, 10) // 0.4 + 0.5×0.4
      expect(decision.durationSec).toBeGreaterThanOrEqual(0.4)
      expect(decision.durationSec).toBeLessThanOrEqual(0.8)
    }
  })

  it('行走达到活动上限进入待机（触界优先于时长）', () => {
    const withHit = decideBehavior(
      input({
        state: { kind: 'walking' },
        elapsedSec: 20,
        targetDurationSec: 6,
        hitBounds: { right: true, left: false, top: false, bottom: false }
      })
    )
    expect(withHit.type).toBe('startTurning')
  })
})

describe('转向行为', () => {
  it('转向持续时间未到时不结束转向', () => {
    const decision = decideBehavior(
      input({ state: { kind: 'turning' }, elapsedSec: 0.3, targetDurationSec: 0.6 })
    )
    expect(decision).toEqual({ type: 'noAction' })
  })

  it('转向结束后按概率恢复行走（random < 0.7）', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'turning' },
        elapsedSec: 0.6,
        targetDurationSec: 0.6,
        random: sequence([0.3, 0.25])
      })
    )
    expect(decision.type).toBe('startWalking')
    if (decision.type === 'startWalking') {
      // 第二个随机 0.25 → index floor(0.25×2)=0 → 右（Task 11D：候选仅水平双向）
      expect(decision.direction).toEqual({ x: 1, y: 0 })
      // 第三个消耗（序列重复 0.25）：行走时长 6 + 0.25×9 = 8.25
      expect(decision.durationSec).toBeCloseTo(8.25, 10)
    }
  })

  it('转向结束后按概率进入待机（random >= 0.7）', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'turning' },
        elapsedSec: 0.6,
        targetDurationSec: 0.6,
        random: sequence([0.9, 0])
      })
    )
    expect(decision.type).toBe('startIdle')
    if (decision.type === 'startIdle') {
      expect(decision.durationSec).toBe(2) // 第二个随机 0 → 待机下界
    }
  })
})

describe('暂停与拖动优先级', () => {
  it('paused 状态始终不产生自动行为（即使时长达到阈值）', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'paused', restore: { kind: 'idle' } },
        elapsedSec: 100,
        targetDurationSec: 1,
        hitBounds: { left: true, right: true, top: true, bottom: true }
      })
    )
    expect(decision).toEqual({ type: 'noAction' })
  })

  it('dragging 状态始终不产生自动行为', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'dragging', restore: { kind: 'walking' } },
        elapsedSec: 100,
        targetDurationSec: 1,
        hitBounds: { left: true, right: false, top: false, bottom: false }
      })
    )
    expect(decision).toEqual({ type: 'noAction' })
  })
})

describe('非法输入处理', () => {
  it('非法持续时间（负/NaN/∞）按 0 处理，不触发转换', () => {
    for (const elapsedSec of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = decideBehavior(input({ state: { kind: 'idle' }, elapsedSec }))
      expect(decision).toEqual({ type: 'noAction' })
    }
  })

  it('目标时长缺失或非法时保守返回 noAction', () => {
    for (const targetDurationSec of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = decideBehavior(
        input({ state: { kind: 'idle' }, elapsedSec: 100, targetDurationSec })
      )
      expect(decision).toEqual({ type: 'noAction' })
    }
  })

  it('非法随机数（NaN/1/5/负/∞）被稳定化，决策仍合法', () => {
    for (const bad of [Number.NaN, 1, 5, -0.5, Number.POSITIVE_INFINITY]) {
      const decision = decideBehavior(
        input({
          state: { kind: 'idle' },
          elapsedSec: 2,
          targetDurationSec: 2,
          random: () => bad
        })
      )
      expect(decision.type).toBe('startWalking')
      if (decision.type === 'startWalking') {
        expect(WALK_DIRECTIONS).toContainEqual(decision.direction)
        expect(decision.durationSec).toBeGreaterThanOrEqual(6)
        expect(decision.durationSec).toBeLessThanOrEqual(15)
      }
    }
  })

  it('sanitizeRandom 的边界行为', () => {
    expect(sanitizeRandom(Number.NaN)).toBe(0)
    expect(sanitizeRandom(-1)).toBe(0)
    expect(sanitizeRandom(0)).toBe(0)
    expect(sanitizeRandom(0.5)).toBe(0.5)
    expect(sanitizeRandom(1)).toBeLessThan(1)
    expect(sanitizeRandom(100)).toBeLessThan(1)
    expect(sanitizeRandom(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('非法配置回退默认值，决策稳定且参数在默认范围内', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'walking' },
        elapsedSec: 10,
        targetDurationSec: 5,
        config: INVALID_CONFIG,
        random: sequence([0.5])
      })
    )
    // walkDurationSec 非法 → 默认 6–15；elapsed 10 < ∞? target=5 → elapsed>=target → startIdle
    expect(decision.type).toBe('startIdle')
    if (decision.type === 'startIdle') {
      expect(decision.durationSec).toBe(4) // 默认 idle 2–6，0.5 → 4
    }
  })
})

describe('状态与触界信息匹配', () => {
  it('idle 状态携带触界信息不会触发转向决策', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'idle' },
        elapsedSec: 1,
        targetDurationSec: 10,
        hitBounds: { left: true, right: false, top: false, bottom: false }
      })
    )
    expect(decision).toEqual({ type: 'noAction' })
  })

  it('turning 状态携带触界信息不会触发转向决策', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'turning' },
        elapsedSec: 0.1,
        targetDurationSec: 0.6,
        hitBounds: { right: true, left: false, top: false, bottom: false }
      })
    )
    expect(decision).toEqual({ type: 'noAction' })
  })
})

describe('单次决策的阶段边界', () => {
  it('一次决策只输出一个行为阶段，不跨越多个阶段', () => {
    const decision = decideBehavior(
      input({
        state: { kind: 'idle' },
        elapsedSec: 10,
        targetDurationSec: 2,
        random: sequence([0.1])
      })
    )
    // 只包含 startWalking 及其方向与行走时长，不携带待机时长等后续阶段数据
    expect(decision.type).toBe('startWalking')
    if (decision.type === 'startWalking') {
      expect(decision.direction).toEqual({ x: 1, y: 0 })
      expect(decision.durationSec).toBeCloseTo(6.9, 10) // 6 + 0.1×9
      expect(Object.keys(decision).sort()).toEqual(['direction', 'durationSec', 'type'])
    }
  })
})

describe('随机差异与输出有效性', () => {
  it('不同合法随机值产生符合规则的行为差异', () => {
    // 转向结束分流：0.1 → 恢复行走；0.9 → 待机
    const walk = decideBehavior(
      input({
        state: { kind: 'turning' },
        elapsedSec: 1,
        targetDurationSec: 0.5,
        random: sequence([0.1, 0.1])
      })
    )
    const idle = decideBehavior(
      input({
        state: { kind: 'turning' },
        elapsedSec: 1,
        targetDurationSec: 0.5,
        random: sequence([0.9, 0.5])
      })
    )
    expect(walk.type).toBe('startWalking')
    expect(idle.type).toBe('startIdle')

    // 方向选择：0.1 → 右；0.5 → 左（Task 11D：候选仅水平双向）
    const right = decideBehavior(
      input({
        state: { kind: 'idle' },
        elapsedSec: 2,
        targetDurationSec: 2,
        random: sequence([0.1])
      })
    )
    const left = decideBehavior(
      input({
        state: { kind: 'idle' },
        elapsedSec: 2,
        targetDurationSec: 2,
        random: sequence([0.5])
      })
    )
    if (right.type === 'startWalking' && left.type === 'startWalking') {
      expect(right.direction).toEqual({ x: 1, y: 0 })
      expect(left.direction).toEqual({ x: -1, y: 0 })
    }
  })

  it('所有输出参数有效：时长在配置范围内，方向为单位向量', () => {
    const config = DEFAULT_BEHAVIOR_DECIDER_CONFIG
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const idleDecision = decideBehavior(
        input({
          state: { kind: 'walking' },
          elapsedSec: 6,
          targetDurationSec: 6,
          random: sequence([r])
        })
      )
      if (idleDecision.type === 'startIdle') {
        expect(idleDecision.durationSec).toBeGreaterThanOrEqual(config.idleDurationSec.minSec)
        expect(idleDecision.durationSec).toBeLessThanOrEqual(config.idleDurationSec.maxSec)
      }

      const walkDecision = decideBehavior(
        input({
          state: { kind: 'idle' },
          elapsedSec: 2,
          targetDurationSec: 2,
          random: sequence([r])
        })
      )
      if (walkDecision.type === 'startWalking') {
        const { direction } = walkDecision
        expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 10)
        expect(WALK_DIRECTIONS).toContainEqual(direction)
        expect(walkDecision.durationSec).toBeGreaterThanOrEqual(config.walkDurationSec.minSec)
        expect(walkDecision.durationSec).toBeLessThanOrEqual(config.walkDurationSec.maxSec)
      }

      const turnDecision = decideBehavior(
        input({
          state: { kind: 'walking' },
          elapsedSec: 1,
          targetDurationSec: 10,
          hitBounds: { bottom: true, left: false, right: false, top: false },
          random: sequence([r])
        })
      )
      if (turnDecision.type === 'startTurning') {
        expect(turnDecision.durationSec).toBeGreaterThanOrEqual(config.turnDurationSec.minSec)
        expect(turnDecision.durationSec).toBeLessThanOrEqual(config.turnDurationSec.maxSec)
      }
    }
  })
})

describe('Task 11G：休息决策', () => {
  /** 启用休息的测试配置：时长取确定值（min==max 不消耗采样随机数），概率 1 必休息 */
  const REST_CONFIG: BehaviorDeciderConfig = {
    ...DEFAULT_BEHAVIOR_DECIDER_CONFIG,
    walkDurationSec: { minSec: 6, maxSec: 6 },
    restSitDurationSec: { minSec: 8, maxSec: 8 },
    restLieDurationSec: { minSec: 15, maxSec: 15 },
    restCooldownSec: 45,
    restChance: 1,
    restSitShare: 1
  }

  it('冷却未归零时不产生休息决策（不消耗随机数，保持行走决策）', () => {
    let randomCalls = 0
    const random: RandomSource = () => {
      randomCalls += 1
      return 0
    }
    const decision = decideBehavior(
      input({
        config: REST_CONFIG,
        random,
        restCooldownRemainingSec: 10,
        elapsedSec: 2,
        targetDurationSec: 2
      })
    )
    expect(decision.type).toBe('startWalking')
    // 未命中休息分支：仅行走决策消耗 2 次（方向、行走时长，min==max 不消耗时长）
    expect(randomCalls).toBe(1)
  })

  it('未提供冷却字段（undefined）时不启用休息决策（旧调用方兼容）', () => {
    const decision = decideBehavior(
      input({ config: REST_CONFIG, random: sequence([0]), elapsedSec: 2, targetDurationSec: 2 })
    )
    expect(decision.type).toBe('startWalking')
  })

  it('冷却归零且概率命中：坐下（分流占比 1）', () => {
    const decision = decideBehavior(
      input({
        config: REST_CONFIG,
        random: sequence([0]),
        restCooldownRemainingSec: 0,
        elapsedSec: 2,
        targetDurationSec: 2
      })
    )
    expect(decision).toEqual({ type: 'startSitting', durationSec: 8 })
  })

  it('冷却归零且分流未命中坐下占比：趴卧', () => {
    const config: BehaviorDeciderConfig = { ...REST_CONFIG, restSitShare: 0 }
    const decision = decideBehavior(
      input({
        config,
        random: sequence([0]),
        restCooldownRemainingSec: 0,
        elapsedSec: 2,
        targetDurationSec: 2
      })
    )
    expect(decision).toEqual({ type: 'startLying', durationSec: 15 })
  })

  it('概率未命中（random ≥ restChance）时回退行走决策', () => {
    const config: BehaviorDeciderConfig = { ...REST_CONFIG, restChance: 0.5 }
    // 概率消耗 0.9（未命中）→ 行走方向 0.9（向左）
    const decision = decideBehavior(
      input({
        config,
        random: sequence([0.9]),
        restCooldownRemainingSec: 0,
        elapsedSec: 2,
        targetDurationSec: 2
      })
    )
    expect(decision.type).toBe('startWalking')
    if (decision.type === 'startWalking') {
      expect(decision.direction).toEqual({ x: -1, y: 0 })
    }
  })

  it('restChance 为 0 时完全禁用休息（不消耗随机数）', () => {
    let randomCalls = 0
    const random: RandomSource = () => {
      randomCalls += 1
      return 0
    }
    const config: BehaviorDeciderConfig = { ...REST_CONFIG, restChance: 0 }
    const decision = decideBehavior(
      input({
        config,
        random,
        restCooldownRemainingSec: 0,
        elapsedSec: 2,
        targetDurationSec: 2
      })
    )
    expect(decision.type).toBe('startWalking')
    expect(randomCalls).toBe(1)
  })

  it('休息时长范围采样（min < max 时消耗 1 次随机数）', () => {
    const config: BehaviorDeciderConfig = {
      ...REST_CONFIG,
      restSitDurationSec: { minSec: 8, maxSec: 15 }
    }
    // 概率 0 → 命中休息；分流 0 → 坐下；时长 8 + 0.5×7 = 11.5
    const decision = decideBehavior(
      input({
        config,
        random: sequence([0, 0, 0.5]),
        restCooldownRemainingSec: 0,
        elapsedSec: 2,
        targetDurationSec: 2
      })
    )
    expect(decision).toEqual({ type: 'startSitting', durationSec: 11.5 })
  })

  it('sitting / lying 到期 → startIdle（集成层映射 REST_END）', () => {
    for (const kind of ['sitting', 'lying'] as const) {
      const decision = decideBehavior(
        input({
          state: { kind },
          config: REST_CONFIG,
          random: sequence([0.5]),
          elapsedSec: 8,
          targetDurationSec: 8
        })
      )
      // 待机时长采样：2 + 0.5×4 = 4
      expect(decision).toEqual({ type: 'startIdle', durationSec: 4 })
    }
  })

  it('sitting / lying 未到期 → noAction（不会提前结束休息）', () => {
    for (const kind of ['sitting', 'lying'] as const) {
      const decision = decideBehavior(
        input({ state: { kind }, config: REST_CONFIG, elapsedSec: 7.9, targetDurationSec: 8 })
      )
      expect(decision).toEqual({ type: 'noAction' })
    }
  })

  it('休息决策确定性复现：相同输入与随机序列产生相同决策', () => {
    const make = (): BehaviorDeciderInput =>
      input({
        config: REST_CONFIG,
        random: sequence([0.3, 0.2, 0.7]),
        restCooldownRemainingSec: 0,
        elapsedSec: 2,
        targetDurationSec: 2
      })
    expect(decideBehavior(make())).toEqual(decideBehavior(make()))
  })
})
