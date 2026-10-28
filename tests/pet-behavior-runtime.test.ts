import { describe, expect, it } from 'vitest'
import {
  PetBehaviorRuntime,
  normalizeHorizontalDirection,
  type RuntimeWindow,
  type Scheduler
} from '../src/main/pet-behavior-runtime'
import type { RandomSource } from '../src/shared/pet-behavior-decider'
import type { MovementBounds, Vec2 } from '../src/shared/movement-controller'

const BOUNDS: MovementBounds = { x: 0, y: 0, width: 1920, height: 1080 }

/** 快节奏测试配置：所有时长取确定值，转向后必恢复行走 */
const FAST_CONFIG = {
  decider: {
    idleDurationSec: { minSec: 1, maxSec: 1 },
    turnDurationSec: { minSec: 0.5, maxSec: 0.5 },
    walkDurationSec: { minSec: 10, maxSec: 10 },
    resumeWalkAfterTurnRatio: 1
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
  config?: ReturnType<() => typeof FAST_CONFIG> | typeof TURN_TO_IDLE_CONFIG
  random?: RandomSource
  scheduler?: Scheduler
}): Harness {
  const win = options?.window ?? new FakeWindow()
  let now = 0
  const runtime = new PetBehaviorRuntime({
    window: win,
    getBounds: (): MovementBounds => BOUNDS,
    clock: (): number => now,
    random: options?.random ?? scriptedRandom([0]),
    scheduler: options?.scheduler,
    config: options?.config ?? FAST_CONFIG
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
          resumeWalkAfterTurnRatio: 1
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
