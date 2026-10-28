import { describe, expect, it } from 'vitest'
import {
  PetBehaviorRuntime,
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
    // 3. 恢复行走的方向（0.5 → 向下，避免再次触界）
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
    // 3. 恢复行走的方向（0.5 → 向下）
    // 若旧触界残留，转向结束后会立刻再次进入转向；
    // 正确行为是恢复后沿新方向持续向下行走。
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
    // 持续行走若干 tick：位置向下推进，不再触发转向
    for (let t = 2200; t <= 3000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.y).toBeGreaterThan(100)
    expect(last.x).toBe(1680)
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
