import { describe, expect, it } from 'vitest'
import {
  PetBehaviorRuntime,
  REST_EXIT_GUARD_SEC,
  normalizeHorizontalDirection,
  type RuntimeConfig,
  type RuntimeWindow,
  type Scheduler
} from '../src/main/pet-behavior-runtime'
import type { RandomSource } from '../src/shared/pet-behavior-decider'
import type { MovementBounds, Vec2 } from '../src/shared/movement-controller'
import type { PetVisualState } from '../src/shared/pet-visual-state'

const BOUNDS: MovementBounds = { x: 0, y: 0, width: 1920, height: 1080 }

/** 快节奏测试配置：所有时长取确定值，转向后必恢复行走；
 * restChance 0 禁用休息（与旧版本行为完全一致，不消耗随机数）。 */
const FAST_CONFIG = {
  decider: {
    idleDurationSec: { minSec: 1, maxSec: 1 },
    turnDurationSec: { minSec: 0.5, maxSec: 0.5 },
    walkDurationSec: { minSec: 10, maxSec: 10 },
    resumeWalkAfterTurnRatio: 1,
    restSitDurationSec: { minSec: 8, maxSec: 8 },
    restLieDurationSec: { minSec: 15, maxSec: 15 },
    restCooldownSec: 45,
    restChance: 0,
    restSitShare: 1
  }
}

/** 转向后必进入待机的配置 */
const TURN_TO_IDLE_CONFIG = {
  decider: {
    ...FAST_CONFIG.decider,
    resumeWalkAfterTurnRatio: 0
  }
}

/** 可编程假窗口：记录 setPosition 调用，可模拟拖动后的位移与销毁 */
class FakeWindow implements RuntimeWindow {
  readonly width = 240
  readonly height = 240
  private pos: Vec2
  destroyed = false
  setPositionCalls: Array<{ x: number; y: number }> = []

  constructor(x = 100, y = 100) {
    this.pos = { x, y }
  }

  getPosition(): Vec2 {
    return { ...this.pos }
  }

  setPosition(x: number, y: number): void {
    if (this.destroyed) {
      throw new Error('setPosition called on destroyed window')
    }
    this.pos = { x, y }
    this.setPositionCalls.push({ x, y })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
  }

  /** 模拟拖动轮询把窗口移到新位置（绕过 setPosition 记录语义） */
  teleport(x: number, y: number): void {
    this.pos = { x, y }
  }
}

/** 按脚本顺序返回随机值，耗尽后重复最后一个 */
function scriptedRandom(values: number[]): RandomSource {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}

interface Harness {
  win: FakeWindow
  runtime: PetBehaviorRuntime
  tick: (nowMs: number) => void
}

function makeRuntime(options?: {
  window?: FakeWindow
  config?: RuntimeConfig
  random?: RandomSource
  scheduler?: Scheduler
  onVisualStateChange?: (state: PetVisualState) => void
}): Harness {
  const win = options?.window ?? new FakeWindow()
  let now = 0
  const runtime = new PetBehaviorRuntime({
    window: win,
    getBounds: (): MovementBounds => BOUNDS,
    clock: (): number => now,
    random: options?.random ?? scriptedRandom([0]),
    scheduler: options?.scheduler,
    config: options?.config ?? FAST_CONFIG,
    onVisualStateChange: options?.onVisualStateChange
  })
  return {
    win,
    runtime,
    tick: (nowMs: number): void => {
      now = nowMs
      runtime.tick(nowMs)
    }
  }
}

/** 推进时间直到进入行走状态（默认配置：待机 1s 后开始行走，方向向右） */
function advanceToWalking(h: Harness): void {
  h.runtime.start()
  for (let t = 100; t <= 1200; t += 100) {
    h.tick(t)
  }
}

describe('PetBehaviorRuntime 生命周期', () => {
  it('初始状态为待机', () => {
    const h = makeRuntime()
    h.runtime.start()
    expect(h.runtime.currentState.kind).toBe('idle')
    expect(h.runtime.isRunning).toBe(true)
  })

  it('start() 重复调用不会创建重复循环', () => {
    let scheduled = 0
    const scheduler: Scheduler = (): (() => void) => {
      scheduled += 1
      return () => undefined
    }
    const h = makeRuntime({ scheduler })
    h.runtime.start()
    h.runtime.start()
    h.runtime.start()
    expect(scheduled).toBe(1)
  })

  it('stop() 后不再移动窗口', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    const callsBefore = h.win.setPositionCalls.length
    h.runtime.stop()
    h.tick(5000)
    h.tick(6000)
    expect(h.runtime.isRunning).toBe(false)
    expect(h.win.setPositionCalls.length).toBe(callsBefore)
  })

  it('窗口销毁后不再调用位置更新', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    h.win.destroy()
    expect(() => h.tick(2000)).not.toThrow()
    const calls = h.win.setPositionCalls.length
    h.tick(3000)
    expect(h.win.setPositionCalls.length).toBe(calls)
    expect(h.runtime.isRunning).toBe(false)
  })
})

describe('待机与行走', () => {
  it('待机未到期时不移动窗口', () => {
    const h = makeRuntime()
    h.runtime.start()
    h.tick(500)
    h.tick(900)
    expect(h.runtime.currentState.kind).toBe('idle')
    expect(h.win.setPositionCalls).toHaveLength(0)
  })

  it('待机到期后开始行走', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    expect(h.runtime.currentState.kind).toBe('walking')
  })

  it('行走状态推进窗口位置（60px/s × 0.1s = 6px）', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    const callsBefore = h.win.setPositionCalls.length
    h.tick(1300)
    expect(h.win.setPositionCalls.length).toBeGreaterThan(callsBefore)
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    // 待机阈值因 0.1s 浮点累加（0.1×10 = 0.999…）在 1.1s 才到期，
    // t=1200 与 t=1300 两次行走 tick 各推进 6px：100 + 6 + 6 = 112
    expect(last.x).toBe(112)
    expect(last.y).toBe(100)
  })

  it('待机/转向等非行走状态不会推进位置', () => {
    const h = makeRuntime()
    h.runtime.start()
    h.tick(500)
    expect(h.win.setPositionCalls).toHaveLength(0)
  })
})

describe('边界与转向', () => {
  it('行走触及边界后进入转向', () => {
    // maxX = 1920 - 240 = 1680；从 1670 向右走
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win })
    h.runtime.start()
    for (let t = 100; t <= 1200; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    h.tick(1300) // 1670 → 1676
    h.tick(1400) // 1676 → 1682 → 钳制 1680，触界
    expect(h.runtime.currentState.kind).toBe('turning')
  })

  it('转向期间窗口位置保持不变', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win })
    h.runtime.start()
    for (let t = 100; t <= 1400; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('turning')
    const calls = h.win.setPositionCalls.length
    // 转向时长 0.5s：推进 0.4s（避开 0.5s 到期边界）仍在转向期
    for (let t = 1500; t <= 1700; t += 100) {
      h.tick(t)
    }
    expect(h.win.setPositionCalls.length).toBe(calls)
    expect(h.runtime.currentState.kind).toBe('turning')
  })

  it('转向结束后按决策结果恢复行走（ratio=1）', () => {
    // 随机消耗顺序（时长范围 min==max 时不消耗随机数）：
    // 1. 待机到期选方向（0 → 向右，走到边界触发转向）
    // 2. 转向到期分流（0 < ratio=1 → 恢复行走）
    // 3. 恢复行走的随机选向（0.5 → 向左）会被 Task 11D 的边界反向覆盖（同为向左）
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win, random: scriptedRandom([0, 0, 0.5]) })
    h.runtime.start()
    for (let t = 100; t <= 1400; t += 100) {
      h.tick(t)
    }
    // 转向时长 0.5s：转向期间累积约 0.6s 后应恢复行走
    for (let t = 1500; t <= 2000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
  })

  it('转向结束后按决策结果进入待机（ratio=0）', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({
      window: win,
      config: TURN_TO_IDLE_CONFIG,
      random: scriptedRandom([0, 0, 0, 0, 0.9])
    })
    h.runtime.start()
    for (let t = 100; t <= 1400; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('turning')
    for (let t = 1500; t <= 2100; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('idle')
  })

  it('触界信息不会跨行为阶段残留', () => {
    // 随机消耗顺序（时长范围 min==max 时不消耗随机数）：
    // 1. 待机到期选方向（0 → 向右，走到边界触发转向）
    // 2. 转向到期分流（0 < ratio=1 → 恢复行走）
    // 3. 恢复行走的随机选向（0.5 → 向左）与 Task 11D 边界反向（向左）一致。
    // 若旧触界残留，转向结束后会立刻再次进入转向；
    // 正确行为是恢复后沿反方向（向左）持续水平行走。
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win, random: scriptedRandom([0, 0, 0.5]) })
    h.runtime.start()
    for (let t = 100; t <= 1400; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('turning')
    for (let t = 1500; t <= 2100; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    // 持续行走若干 tick：位置向左推进（X 离开右边界），Y 不变，不再触发转向
    for (let t = 2200; t <= 3000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.y).toBe(100)
    expect(last.x).toBeLessThan(1680)
  })
})

describe('暂停与拖动', () => {
  it('paused 状态不推进窗口', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    h.tick(1300)
    const calls = h.win.setPositionCalls.length
    h.runtime.pause()
    expect(h.runtime.currentState.kind).toBe('paused')
    for (let t = 1400; t <= 2000; t += 100) {
      h.tick(t)
    }
    expect(h.win.setPositionCalls.length).toBe(calls)
    // 继续后恢复行走
    h.runtime.resume()
    expect(h.runtime.currentState.kind).toBe('walking')
    h.tick(2100)
    expect(h.win.setPositionCalls.length).toBeGreaterThan(calls)
  })

  it('dragging 状态不推进窗口', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    h.runtime.handleDragStart()
    expect(h.runtime.currentState.kind).toBe('dragging')
    const calls = h.win.setPositionCalls.length
    for (let t = 1400; t <= 2000; t += 100) {
      h.tick(t)
    }
    expect(h.win.setPositionCalls.length).toBe(calls)
  })

  it('拖动开始时立即停止自动移动', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    h.tick(1300)
    expect(h.win.setPositionCalls.length).toBeGreaterThan(0)
    const calls = h.win.setPositionCalls.length
    h.runtime.handleDragStart()
    h.tick(1400)
    h.tick(1500)
    expect(h.win.setPositionCalls.length).toBe(calls)
  })

  it('拖动结束后位置基准与真实窗口位置同步，不会跳回旧位置', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    h.tick(1300) // 行走中：位置约 (106, 100)
    h.runtime.handleDragStart()
    // 模拟拖动轮询把窗口移到新位置
    h.win.teleport(600, 400)
    h.runtime.handleDragEnd()
    expect(h.runtime.currentState.kind).toBe('walking')
    h.tick(1400)
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    // 从 (600, 400) 继续向右走 6px，而不是跳回 (106, 100) 附近
    expect(last.x).toBe(606)
    expect(last.y).toBe(400)
  })

  it('拖动后不会因过期时长立即连续转换', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    // 行走目标 10s；累计 9.9s（差 0.1s 到期）
    for (let t = 1400; t <= 11200; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    h.runtime.handleDragStart()
    h.win.teleport(300, 300)
    h.runtime.handleDragEnd()
    // 拖动结束重置计时：短 tick 后应仍在行走，不会立即转待机
    h.tick(11300)
    expect(h.runtime.currentState.kind).toBe('walking')
  })
})

describe('时间与采样稳定性', () => {
  it('时钟回退（负 dt）不会产生非法坐标', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    h.tick(1300)
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    // 时钟回退：dt 为负 → 按 0 处理，位置不变
    h.tick(500)
    const after = h.win.getPosition()
    expect(Number.isFinite(after.x)).toBe(true)
    expect(Number.isFinite(after.y)).toBe(true)
    expect(after).toEqual(last)
  })

  it('时钟大跳变被 dt 上限截断，不会瞬移', () => {
    const h = makeRuntime()
    advanceToWalking(h)
    h.tick(1300)
    const before = h.win.getPosition()
    // 跳变 100 秒 → 截断为 0.1s → 最多移动 6px
    h.tick(100_000 + 1300)
    const after = h.win.getPosition()
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(6)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(6)
  })

  it('行为时长不会在每个 tick 中重复采样', () => {
    let randomCalls = 0
    const random: RandomSource = () => {
      randomCalls += 1
      return 0
    }
    // 使用 min < max 的时长范围：采样会真实消耗随机数，
    // FAST_CONFIG 的 min==max 会短路不消耗，无法验证采样语义。
    const h = makeRuntime({
      random,
      config: {
        decider: {
          idleDurationSec: { minSec: 1, maxSec: 1.5 },
          turnDurationSec: { minSec: 0.4, maxSec: 0.5 },
          walkDurationSec: { minSec: 10, maxSec: 10.5 },
          resumeWalkAfterTurnRatio: 1,
          restSitDurationSec: { minSec: 8, maxSec: 8 },
          restLieDurationSec: { minSec: 15, maxSec: 15 },
          restCooldownSec: 45,
          restChance: 0,
          restSitShare: 1
        }
      }
    })
    h.runtime.start()
    // start() 采样一次待机时长
    expect(randomCalls).toBe(1)
    // 待机期间多次 tick，无阶段转换 → 不再消耗随机数
    for (let t = 100; t <= 1000; t += 100) {
      h.tick(t)
    }
    expect(randomCalls).toBe(1)
    // 到期转换时才再次采样（方向 + 行走时长）；
    // 浮点累加 0.1×10 = 0.999…，实际在 1.1s 到期
    h.tick(1100)
    expect(randomCalls).toBe(3)
  })
})

describe('Task 11D：水平行走', () => {
  it('向右自动行走：X 增加，Y 保持不变（facing=right）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win })
    advanceToWalking(h)
    expect(h.runtime.currentVisualState.facing).toBe('right')
    for (let t = 1300; t <= 3000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.x).toBeGreaterThan(100)
    expect(last.y).toBe(100)
  })

  it('向左自动行走：X 减少，Y 保持不变（facing=left）', () => {
    const win = new FakeWindow(1000, 200)
    // random 0.5 → 方向索引 1 → 向左
    const h = makeRuntime({ window: win, random: scriptedRandom([0.5]) })
    advanceToWalking(h)
    expect(h.runtime.currentVisualState.facing).toBe('left')
    for (let t = 1300; t <= 3000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.x).toBeLessThan(1000)
    expect(last.y).toBe(200)
  })

  it('连续多次自动行走 tick，Y 始终不变', () => {
    const win = new FakeWindow(100, 333)
    const h = makeRuntime({ window: win })
    advanceToWalking(h)
    for (let t = 1300; t <= 8000; t += 100) {
      h.tick(t)
    }
    // 全部 setPosition 调用（含行走期间所有 tick）Y 均为初始轨道
    for (const call of h.win.setPositionCalls) {
      expect(call.y).toBe(333)
    }
    expect(h.win.setPositionCalls.length).toBeGreaterThan(10)
  })

  it('到达右边界：转向后以相反水平方向（向左）恢复行走', () => {
    const win = new FakeWindow(1670, 100)
    // 第 3 个随机值 0.99 → 随机选向为向左，与边界反向一致（覆盖验证）；
    // 即便随机选向不同也会被边界反向覆盖。
    const h = makeRuntime({ window: win, random: scriptedRandom([0, 0, 0.99]) })
    h.runtime.start()
    for (let t = 100; t <= 1400; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('turning')
    for (let t = 1500; t <= 2000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    for (let t = 2100; t <= 3000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.x).toBeLessThan(1680)
    expect(last.y).toBe(100)
    expect(h.runtime.currentVisualState.facing).toBe('left')
  })

  it('到达左边界：转向后以相反水平方向（向右）恢复行走', () => {
    const win = new FakeWindow(10, 100)
    // random 0.5 → 待机到期选向为向左；触左边界转向后按反向（向右）恢复
    const h = makeRuntime({ window: win, random: scriptedRandom([0.5, 0.5, 0]) })
    h.runtime.start()
    // 1.1s 开始向左行走：10 → 4（t=1200）→ 钳制 0 触界（t=1300）
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('turning')
    // 转向 0.5s（浮点累加下 1.9s 到期）后恢复行走
    for (let t = 1400; t <= 1900; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    for (let t = 2000; t <= 2800; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.x).toBeGreaterThan(0)
    expect(last.y).toBe(100)
    expect(h.runtime.currentVisualState.facing).toBe('right')
  })

  it('idle / turning / paused 状态不产生位置漂移', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win })
    // idle 阶段：无任何 setPosition
    h.runtime.start()
    for (let t = 100; t <= 1000; t += 100) {
      h.tick(t)
    }
    expect(h.win.setPositionCalls).toHaveLength(0)
    // 行走触界进入 turning
    for (let t = 1100; t <= 1400; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('turning')
    const callsDuringTurnStart = h.win.setPositionCalls.length
    for (let t = 1500; t <= 1700; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('turning')
    expect(h.win.setPositionCalls.length).toBe(callsDuringTurnStart)
    // 暂停（在待机恢复前的任意时刻）也不推进位置
    const h2 = makeRuntime()
    advanceToWalking(h2)
    h2.tick(1300)
    const callsBeforePause = h2.win.setPositionCalls.length
    h2.runtime.pause()
    for (let t = 1400; t <= 2000; t += 100) {
      h2.tick(t)
    }
    expect(h2.win.setPositionCalls.length).toBe(callsBeforePause)
  })

  it('dragging 期间自动移动停止', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win })
    advanceToWalking(h)
    h.tick(1300)
    expect(h.win.setPositionCalls.length).toBeGreaterThan(0)
    const calls = h.win.setPositionCalls.length
    h.runtime.handleDragStart()
    for (let t = 1400; t <= 2200; t += 100) {
      h.tick(t)
    }
    expect(h.win.setPositionCalls.length).toBe(calls)
  })

  it('拖动改变 Y 后，后续自动行走保持新的 Y（水平轨道更新，不回旧轨道）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win })
    advanceToWalking(h)
    h.tick(1300)
    h.runtime.handleDragStart()
    // 用户拖动到新高度（垂直位移不受限）
    h.win.teleport(600, 500)
    h.runtime.handleDragEnd()
    for (let t = 1400; t <= 3000; t += 100) {
      h.tick(t)
    }
    for (const call of h.win.setPositionCalls.filter((c) => c.y !== 100)) {
      expect(call.y).toBe(500)
    }
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.y).toBe(500)
    expect(last.x).toBeGreaterThan(600)
  })

  it('历史 up/down 方向被规范化为水平方向，不会引起垂直自动移动', () => {
    // 决策器候选已无垂直方向；运行时对任意决策方向做防御性水平规范化
    expect(normalizeHorizontalDirection({ x: 0, y: 1 }, { x: -1, y: 0 })).toEqual({ x: -1, y: 0 })
    expect(normalizeHorizontalDirection({ x: 0, y: -1 }, { x: 1, y: 0 })).toEqual({ x: 1, y: 0 })
    expect(normalizeHorizontalDirection({ x: 0.3, y: 0.9 }, { x: -1, y: 0 })).toEqual({
      x: 1,
      y: 0
    })
    expect(normalizeHorizontalDirection({ x: -2, y: 5 }, { x: 1, y: 0 })).toEqual({ x: -1, y: 0 })
    // 零向量 / 非法分量：回退方向；回退也非法时取右
    expect(normalizeHorizontalDirection({ x: 0, y: 0 }, { x: -3, y: 0 })).toEqual({ x: -1, y: 0 })
    expect(normalizeHorizontalDirection({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 1, y: 0 })
    expect(normalizeHorizontalDirection({ x: Number.NaN, y: 1 }, { x: Number.NaN, y: 0 })).toEqual({
      x: 1,
      y: 0
    })
    // 规范化输出恒为水平单位向量（y 分量恒 0）
    for (const d of [
      { x: 0, y: 1 },
      { x: 0, y: -1 },
      { x: 1, y: 1 },
      { x: -0.5, y: -0.5 }
    ]) {
      const normalized = normalizeHorizontalDirection(d, { x: 1, y: 0 })
      expect(normalized.y).toBe(0)
      expect(Math.abs(normalized.x)).toBe(1)
    }
  })

  it('Y 越出 workArea 时首个行走 tick 修正到边界内（系统位置纠正，非自动行走）', () => {
    // bounds 1920×1080，窗口高 240 → maxY = 840；初始 Y=2000 越界
    const win = new FakeWindow(100, 2000)
    const h = makeRuntime({ window: win })
    advanceToWalking(h)
    for (let t = 1300; t <= 3000; t += 100) {
      h.tick(t)
    }
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.y).toBe(840)
    // 修正后 Y 稳定在边界轨道上，X 正常推进
    expect(last.x).toBeGreaterThan(100)
    for (const call of h.win.setPositionCalls) {
      expect(call.y).toBe(840)
    }
  })

  it('随机待机与行走节奏无回归：行走到期进待机，待机到期再行走', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win })
    advanceToWalking(h)
    // FAST_CONFIG 行走目标 10s：约 1.1s 开始行走，11.1s 到期进待机
    for (let t = 1300; t <= 11200; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('idle')
    // 待机 1s 后恢复行走
    for (let t = 11300; t <= 12300; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
  })
})

describe('Task 11G：自主坐下与趴卧行为', () => {
  /**
   * 休息测试配置（所有时长确定值，0.1s 步进）：
   * - idle 1s / walk 2s / sit 3s / lie 5s / 冷却按测试需要调整；
   * - restChance 1 + restSitShare 1 → 冷却归零后的首个 idle 到期必坐下；
   * - 时间线（0.1s 浮点累加，到期约延后 0.1s）：
   *   idle 1s →（冷却 1s 已归零）sitting 3s → REST_END →
   *   idle max(1s, REST_EXIT_GUARD_SEC=1.5s) → walking。
   */
  const REST_BASE = {
    idleDurationSec: { minSec: 1, maxSec: 1 },
    turnDurationSec: { minSec: 0.5, maxSec: 0.5 },
    walkDurationSec: { minSec: 2, maxSec: 2 },
    resumeWalkAfterTurnRatio: 1,
    restSitDurationSec: { minSec: 3, maxSec: 3 },
    restLieDurationSec: { minSec: 5, maxSec: 5 },
    restCooldownSec: 1,
    restChance: 1,
    restSitShare: 1
  }
  const SIT_CONFIG = { decider: { ...REST_BASE } }
  const LIE_CONFIG = { decider: { ...REST_BASE, restSitShare: 0 } }

  /** 0.1s 步进推进到指定时刻 */
  function advance(h: Harness, fromMs: number, toMs: number): void {
    for (let t = fromMs; t <= toMs; t += 100) {
      h.tick(t)
    }
  }

  it('idle 可以进入 sitting（冷却归零后首个 idle 到期触发）', () => {
    const h = makeRuntime({ config: SIT_CONFIG })
    h.runtime.start()
    advance(h, 100, 1200)
    expect(h.runtime.currentState.kind).toBe('sitting')
    expect(h.runtime.currentVisualState.kind).toBe('sitting')
  })

  it('idle 可以进入 lying（分流占比 0）', () => {
    const h = makeRuntime({ config: LIE_CONFIG })
    h.runtime.start()
    advance(h, 100, 1200)
    expect(h.runtime.currentState.kind).toBe('lying')
    expect(h.runtime.currentVisualState.kind).toBe('lying')
  })

  it('sitting 期间窗口 X/Y 不变（真实 setPosition 记录验证）', () => {
    const h = makeRuntime({ config: SIT_CONFIG })
    h.runtime.start()
    advance(h, 100, 1500)
    expect(h.runtime.currentState.kind).toBe('sitting')
    expect(h.win.setPositionCalls).toHaveLength(0)
    advance(h, 1600, 4000)
    expect(h.runtime.currentState.kind).toBe('sitting')
    expect(h.win.setPositionCalls).toHaveLength(0)
  })

  it('lying 期间窗口 X/Y 不变', () => {
    const h = makeRuntime({ config: LIE_CONFIG })
    h.runtime.start()
    advance(h, 100, 1500)
    expect(h.runtime.currentState.kind).toBe('lying')
    expect(h.win.setPositionCalls).toHaveLength(0)
    advance(h, 1600, 6000)
    // lie 5s：约 6.2s 到期，6s 前仍应保持趴卧
    expect(h.runtime.currentState.kind).toBe('lying')
    expect(h.win.setPositionCalls).toHaveLength(0)
  })

  it('walking 先结束再休息：进入休息前移动已停止（位置冻结跨越 idle→sitting）', () => {
    // 冷却 2s > 首个 idle 窗口 1s → 首个 idle 到期走行走；行走 2s 结束
    // 后冷却已归零 → 第二个 idle 到期进入休息。
    const config = { decider: { ...REST_BASE, restCooldownSec: 2 } }
    const h = makeRuntime({ config })
    h.runtime.start()
    advance(h, 100, 3200)
    expect(h.runtime.currentState.kind).toBe('idle') // 行走 2s 已结束
    expect(h.win.setPositionCalls.length).toBeGreaterThan(0)
    const callsAtWalkEnd = h.win.setPositionCalls.length
    const frozen = h.win.getPosition()
    // idle → sitting 全程无新 setPosition；sitting 保持期亦冻结
    advance(h, 3300, 7000)
    expect(h.runtime.currentState.kind).toBe('sitting')
    expect(h.win.setPositionCalls.length).toBe(callsAtWalkEnd)
    expect(h.win.getPosition()).toEqual(frozen)
  })

  it('sitting 正确执行进入 → 保持 → 退出（REST_END 回 idle，广播序列正确）', () => {
    const states: PetVisualState[] = []
    const h = makeRuntime({ config: SIT_CONFIG, onVisualStateChange: (s) => states.push(s) })
    h.runtime.start()
    advance(h, 100, 4500)
    const kinds = states.map((s) => s.kind)
    expect(kinds).toContain('sitting')
    expect(kinds[kinds.length - 1]).toBe('idle') // 约 4.2s REST_END
    expect(h.runtime.currentState.kind).toBe('idle')
  })

  it('lying 正确执行进入 → 保持 → 退出（REST_END 回 idle）', () => {
    const h = makeRuntime({ config: LIE_CONFIG })
    h.runtime.start()
    advance(h, 100, 1500)
    expect(h.runtime.currentState.kind).toBe('lying')
    advance(h, 1600, 6500)
    expect(h.runtime.currentState.kind).toBe('idle') // 5s 休息 + 浮点余量
  })

  it('起身完成前不恢复 walking 移动（REST_EXIT_GUARD_SEC 下限保护）', () => {
    // 退出动画实际时长：5 帧 × 7fps ≈ 0.72s < REST_EXIT_GUARD_SEC
    expect(REST_EXIT_GUARD_SEC).toBeGreaterThanOrEqual(5 / 7)
    // 冷却 3s：先行走（约 1.1–3.1s）→ 首次休息（约 4.2–7.2s）→
    // REST_END 后冷却未归零，恢复行走而不是连续休息。
    const config = { decider: { ...REST_BASE, restCooldownSec: 3 } }
    const h = makeRuntime({ config })
    h.runtime.start()
    advance(h, 100, 7500)
    expect(h.runtime.currentState.kind).toBe('idle') // REST_END 约 7.2s
    const callsAtRestEnd = h.win.setPositionCalls.length
    expect(callsAtRestEnd).toBeGreaterThan(0) // 休息前确有行走移动
    // REST_END + 1.2s（退出动画 0.72s 已含）：仍在 idle 且窗口未移动
    advance(h, 7600, 8400)
    expect(h.runtime.currentState.kind).toBe('idle')
    expect(h.win.setPositionCalls.length).toBe(callsAtRestEnd)
    // 保护期（1.5s）过后恢复行走，窗口重新移动
    advance(h, 8500, 9600)
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.win.setPositionCalls.length).toBeGreaterThan(callsAtRestEnd)
  })

  it('sitting 不直接跳变 lying：到期回 idle，绝不直接互切', () => {
    const h = makeRuntime({ config: SIT_CONFIG })
    h.runtime.start()
    advance(h, 100, 1200)
    expect(h.runtime.currentState.kind).toBe('sitting')
    // sitting 全程保持 sitting，绝不直接进入 lying
    advance(h, 1300, 4000)
    expect(h.runtime.currentState.kind).not.toBe('lying')
  })

  it('lying 不直接跳变 sitting', () => {
    const h = makeRuntime({ config: LIE_CONFIG })
    h.runtime.start()
    advance(h, 100, 1200)
    expect(h.runtime.currentState.kind).toBe('lying')
    advance(h, 1300, 6000)
    // lying 到期回 idle；期间任何时刻不直接进入 sitting
    expect(['lying', 'idle']).toContain(h.runtime.currentState.kind)
  })

  it('休息冷却时间生效：REST_END 后的 idle 到期不立即再休息', () => {
    // 冷却 6s：初始冷却使首次休息延后到约 7.3s；REST_END（约 10.3s）后
    // 冷却重置，首个 idle 到期（约 11.8s）走行走而不是再休息；
    // 第二次休息要等到冷却再次归零（约 18s）。
    const config = { decider: { ...REST_BASE, restCooldownSec: 6 } }
    const h = makeRuntime({ config })
    h.runtime.start()
    advance(h, 100, 7500)
    expect(h.runtime.currentState.kind).toBe('sitting') // 首次休息约 7.3s
    advance(h, 7600, 12500)
    expect(h.runtime.currentState.kind).toBe('walking') // REST_END 后恢复行走
    // 冷却期内（REST_END 后 6s 内）不再休息
    advance(h, 12600, 17000)
    expect(h.runtime.currentState.kind).not.toBe('sitting')
    expect(h.runtime.currentState.kind).not.toBe('lying')
    // 冷却归零后（约 18s）允许第二次休息
    advance(h, 17100, 19500)
    expect(h.runtime.currentState.kind).toBe('sitting')
  })

  it('随机触发可确定性复现（相同时钟与随机序列产生相同状态轨迹与坐标）', () => {
    const runOnce = (): { states: string[]; positions: Array<{ x: number; y: number }> } => {
      const win = new FakeWindow(100, 100)
      const states: string[] = []
      const h = makeRuntime({ window: win, config: SIT_CONFIG, random: scriptedRandom([0]) })
      h.runtime.start()
      for (let t = 100; t <= 9000; t += 100) {
        h.tick(t)
        states.push(h.runtime.currentState.kind)
      }
      return { states, positions: [...win.setPositionCalls] }
    }
    const first = runOnce()
    const second = runOnce()
    expect(second.states).toEqual(first.states)
    expect(second.positions).toEqual(first.positions)
    // 轨迹确实包含完整休息循环
    expect(first.states).toContain('sitting')
    expect(first.states).toContain('idle')
  })

  it('dragging 中断 sitting：立即停止休息，结束后回 idle 不自动恢复', () => {
    const h = makeRuntime({ config: SIT_CONFIG })
    h.runtime.start()
    advance(h, 100, 1500)
    expect(h.runtime.currentState.kind).toBe('sitting')
    h.runtime.handleDragStart()
    expect(h.runtime.currentState.kind).toBe('dragging')
    advance(h, 1600, 3000)
    expect(h.runtime.currentState.kind).toBe('dragging') // 不被旧休息计时拉回
    h.win.teleport(600, 400)
    h.runtime.handleDragEnd()
    expect(h.runtime.currentState.kind).toBe('idle') // 不恢复 sitting
    const calls = h.win.setPositionCalls.length
    advance(h, 3100, 3300)
    expect(h.win.setPositionCalls.length).toBe(calls) // 新轨道下短暂 idle 无移动
  })

  it('dragging 中断 lying：结束后回 idle 不自动恢复', () => {
    const h = makeRuntime({ config: LIE_CONFIG })
    h.runtime.start()
    advance(h, 100, 1500)
    expect(h.runtime.currentState.kind).toBe('lying')
    h.runtime.handleDragStart()
    h.win.teleport(300, 300)
    h.runtime.handleDragEnd()
    expect(h.runtime.currentState.kind).toBe('idle')
    advance(h, 1600, 2500)
    expect(['idle', 'walking']).toContain(h.runtime.currentState.kind)
    expect(h.runtime.currentState.kind).not.toBe('lying')
  })

  it('休息到期瞬间的拖动不被旧决策污染（DRAG_START 先于到期 tick）', () => {
    // sitting 目标 3s，累计约 2.4s（差 0.6s 到期）时开始拖动：
    // 后续 tick 在 dragging 下不产生 REST_END，结束后从 idle 重新开始。
    const h = makeRuntime({ config: SIT_CONFIG })
    h.runtime.start()
    advance(h, 100, 1500)
    expect(h.runtime.currentState.kind).toBe('sitting')
    advance(h, 1600, 3900)
    expect(h.runtime.currentState.kind).toBe('sitting')
    h.runtime.handleDragStart()
    advance(h, 4000, 5000) // 跨过原到期时刻
    expect(h.runtime.currentState.kind).toBe('dragging')
    h.runtime.handleDragEnd()
    expect(h.runtime.currentState.kind).toBe('idle')
  })

  it('paused 不错误推进休息计时（暂停期间时长冻结，恢复后按原计划到期）', () => {
    const h = makeRuntime({ config: SIT_CONFIG })
    h.runtime.start()
    advance(h, 100, 1500)
    expect(h.runtime.currentState.kind).toBe('sitting')
    h.runtime.pause()
    expect(h.runtime.currentState.kind).toBe('paused')
    advance(h, 1600, 12000) // 暂停 10s+
    expect(h.runtime.currentState.kind).toBe('paused')
    h.runtime.resume()
    expect(h.runtime.currentState.kind).toBe('sitting') // 恢复原休息状态
    // 休息从暂停前进度继续（约 0.4s 已累计）：3s 到期约需再 2.7s
    advance(h, 12100, 15500)
    expect(h.runtime.currentState.kind).toBe('idle')
  })

  it('paused 同时冻结休息冷却（恢复后冷却不随暂停时间流逝）', () => {
    // 冷却 6s：首次休息约 7.3s 起；休息中暂停 30s 后恢复，
    // REST_END 后的保护期 idle 到期时冷却未归零 → 恢复行走而非再休息。
    const config = { decider: { ...REST_BASE, restCooldownSec: 6 } }
    const h = makeRuntime({ config })
    h.runtime.start()
    advance(h, 100, 7500)
    expect(h.runtime.currentState.kind).toBe('sitting')
    h.runtime.pause()
    advance(h, 7600, 40000)
    expect(h.runtime.currentState.kind).toBe('paused')
    h.runtime.resume()
    expect(h.runtime.currentState.kind).toBe('sitting')
    advance(h, 40100, 43500)
    expect(h.runtime.currentState.kind).toBe('idle') // REST_END（暂停冻结后按原计划到期）
    advance(h, 43600, 44500)
    expect(['idle', 'walking']).toContain(h.runtime.currentState.kind) // 保护期内
    advance(h, 44600, 45600)
    expect(h.runtime.currentState.kind).toBe('walking') // 保护期过后恢复行走（约 44.3s）
    advance(h, 45700, 50000)
    expect(h.runtime.currentState.kind).not.toBe('sitting') // 冷却未随暂停流逝
  })

  it('renderer 重建后状态可查询：sitting 期间 currentVisualState 保持权威快照', () => {
    const h = makeRuntime({ config: SIT_CONFIG })
    h.runtime.start()
    advance(h, 100, 2000)
    expect(h.runtime.currentVisualState).toEqual({ kind: 'sitting', facing: 'right' })
    // 朝向沿用最近行走方向（镜像由 renderer 容器机制处理）
    advance(h, 2100, 4500)
    expect(h.runtime.currentVisualState.kind).toBe('idle')
  })

  it('Task 11D 水平行走不回归：休息周期前后的行走仍仅水平移动', () => {
    // 冷却 3s：行走（1.1–3.1s）→ 休息（4.2–7.2s）→ 起身保护 →
    // 恢复行走（约 8.7s 起），全程 Y 恒为初始轨道。
    const win = new FakeWindow(100, 333)
    const config = { decider: { ...REST_BASE, restCooldownSec: 3 } }
    const h = makeRuntime({ window: win, config })
    h.runtime.start()
    advance(h, 100, 5000)
    expect(h.runtime.currentState.kind).toBe('sitting')
    advance(h, 5100, 8000)
    expect(h.runtime.currentState.kind).toBe('idle') // REST_END 后
    advance(h, 8100, 9600)
    expect(h.runtime.currentState.kind).toBe('walking') // 保护期后恢复行走
    for (const call of win.setPositionCalls) {
      expect(call.y).toBe(333)
    }
    const last = win.setPositionCalls[win.setPositionCalls.length - 1]
    expect(last.x).toBeGreaterThan(100)
  })
})
