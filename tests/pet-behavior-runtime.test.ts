import { describe, expect, it } from 'vitest'
import {
  PetBehaviorRuntime,
  REST_EXIT_GUARD_SEC,
  normalizeHorizontalDirection,
  type RuntimeConfig,
  type RuntimeWindow,
  type Scheduler
} from '../src/main/pet-behavior-runtime'
import {
  DEFAULT_BEHAVIOR_DECIDER_CONFIG,
  type RandomSource
} from '../src/shared/pet-behavior-decider'
import type { MovementBounds, Vec2 } from '../src/shared/movement-controller'
import type { PetVisualState } from '../src/shared/pet-visual-state'

const BOUNDS: MovementBounds = { x: 0, y: 0, width: 1920, height: 1080 }

/** 快节奏测试配置：所有时长取确定值，转向后必恢复行走；
 * restChance 0 禁用休息、runChance 0 禁用跑步（与旧版本行为完全一致，不消耗随机数）。 */
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
    restSitShare: 1,
    runDurationSec: { minSec: 2, maxSec: 2 },
    runCooldownSec: 45,
    runChance: 0
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

describe('边界与转向（Task 11H-B：左右边界立即掉头）', () => {
  it('行走触及右边界：立即反转为向左，不进入转向（无等待停顿）', () => {
    // maxX = 1920 - 240 = 1680；从 1670 向右走
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win })
    h.runtime.start()
    for (let t = 100; t <= 1200; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    h.tick(1300) // 1676 → 1682 → 钳制 1680，触界 → 立即反向
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.currentVisualState.facing).toBe('left')
    // 触边后的下一个 tick 立即向左移动（无静止等待）
    h.tick(1400) // 1680 → 1674
    h.tick(1500) // 1674 → 1668
    expect(win.getPosition().x).toBe(1668)
  })

  it('触边 tick 本身完成反向，位置被钳制在边界内不越界', () => {
    const win = new FakeWindow(1678, 100)
    const h = makeRuntime({ window: win })
    h.runtime.start()
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    // t=1200: 1684 → 钳制 1680 触界 → 反向；t=1300: 1680 → 1674
    expect(win.getPosition().x).toBe(1674)
    for (const call of win.setPositionCalls) {
      expect(call.x).toBeLessThanOrEqual(1680)
      expect(call.y).toBe(100)
    }
  })

  it('触边反转后持续向左行走，不反复触发掉头（无方向抖动）', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win })
    h.runtime.start()
    const xs: number[] = []
    for (let t = 100; t <= 3000; t += 100) {
      h.tick(t)
      if (h.runtime.currentState.kind === 'walking') {
        xs.push(win.getPosition().x)
      }
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.currentVisualState.facing).toBe('left')
    // xs 序列：1670（t=1100 进入 walking）→ 1676 → 1680（触边钳制）→ 1674 → …
    // 触边反转后（第 4 个元素起）位置单调向左推进，无方向抖动
    expect(xs[2]).toBe(1680)
    for (let i = 3; i < xs.length; i++) {
      expect(xs[i]).toBeLessThan(xs[i - 1])
    }
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.y).toBe(100)
    expect(last.x).toBeLessThan(1680)
  })

  it('触边反转不影响行为时长计时：行走到期正常进入待机', () => {
    // FAST_CONFIG：idle 1s → walking 10s 到期回 idle（resumeWalkAfterTurnRatio
    // 已不再影响边界路径，配置保留验证到期行为不受触边干扰）
    const win = new FakeWindow(1678, 100)
    const h = makeRuntime({ window: win, config: TURN_TO_IDLE_CONFIG })
    h.runtime.start()
    const kinds: string[] = []
    for (let t = 100; t <= 11200; t += 100) {
      h.tick(t)
      kinds.push(h.runtime.currentState.kind)
    }
    // 全程不进入 turning / paused / dragging
    expect(kinds).not.toContain('turning')
    // walking 10s（自 t=1100 起，浮点累加下 11100 到期）→ idle
    expect(kinds[kinds.length - 1]).toBe('idle')
    // 触边前后的行走阶段连续：进入 walking（索引 10）后长时间无中间等待状态
    const firstIdleAfterWalkIndex = kinds.indexOf('idle', 11)
    expect(firstIdleAfterWalkIndex).toBeGreaterThanOrEqual(100)
  })

  it('行走触及左边界：立即反转为向右', () => {
    // random 0.5 → 待机到期选向为向左
    const win = new FakeWindow(10, 100)
    const h = makeRuntime({ window: win, random: scriptedRandom([0.5]) })
    h.runtime.start()
    // t=1200: 10 → 4；t=1300: 4 → -2 → 钳制 0 触界 → 立即反向
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.currentVisualState.facing).toBe('right')
    h.tick(1400)
    expect(win.getPosition().x).toBe(6)
    expect(win.getPosition().y).toBe(100)
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
          restSitShare: 1,
          runDurationSec: { minSec: 2, maxSec: 2 },
          runCooldownSec: 45,
          runChance: 0
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

  it('到达右边界：立即以相反水平方向（向左）继续行走（Task 11H-B）', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win, random: scriptedRandom([0, 0, 0.99]) })
    h.runtime.start()
    for (let t = 100; t <= 1400; t += 100) {
      h.tick(t)
    }
    // 触界（t=1400 钳制 1680）后状态保持 walking、朝向立即反转
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.currentVisualState.facing).toBe('left')
    for (let t = 1500; t <= 3000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.x).toBeLessThan(1680)
    expect(last.y).toBe(100)
    expect(h.runtime.currentVisualState.facing).toBe('left')
  })

  it('到达左边界：立即以相反水平方向（向右）继续行走（Task 11H-B）', () => {
    const win = new FakeWindow(10, 100)
    // random 0.5 → 待机到期选向为向左
    const h = makeRuntime({ window: win, random: scriptedRandom([0.5, 0.5, 0]) })
    h.runtime.start()
    // 1.1s 开始向左行走：10 → 4（t=1200）→ 钳制 0 触界（t=1300）→ 立即反向
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.currentVisualState.facing).toBe('right')
    for (let t = 1400; t <= 2800; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    const last = h.win.setPositionCalls[h.win.setPositionCalls.length - 1]
    expect(last.x).toBeGreaterThan(0)
    expect(last.y).toBe(100)
    expect(h.runtime.currentVisualState.facing).toBe('right')
  })

  it('idle / paused 状态不产生位置漂移（turning 状态经状态机测试覆盖）', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win })
    // idle 阶段：无任何 setPosition
    h.runtime.start()
    for (let t = 100; t <= 1000; t += 100) {
      h.tick(t)
    }
    expect(h.win.setPositionCalls).toHaveLength(0)
    // 行走触界后不再进入 turning（Task 11H-B：立即反向保持 walking）
    for (let t = 1100; t <= 1400; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    // 暂停（在行走的任意时刻）也不推进位置
    const callsBeforePause = h.win.setPositionCalls.length
    h.runtime.pause()
    expect(h.runtime.currentState.kind).toBe('paused')
    for (let t = 1500; t <= 2000; t += 100) {
      h.tick(t)
    }
    expect(h.win.setPositionCalls.length).toBe(callsBeforePause)
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
    restSitShare: 1,
    runDurationSec: { minSec: 2, maxSec: 2 },
    runCooldownSec: 45,
    runChance: 0
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

describe('Task 11H：跑步行为与速度联动', () => {
  /**
   * 启用跑步的快节奏配置：idle 1s → walking 2s 到期必跑步
   *（runChance 1、冷却 0），跑步 3s 到期回 idle；restChance 0 禁用休息。
   * 时间线（0.1s 浮点累加实测：10 次和 <1、20 次和 ≥2、30 次和 ≥3）：
   *   t=1100 walking → t=3100 running → t=6100 RUN_END 回 idle。
   * 行走位移 6px/tick（60px/s），跑步位移 9.6px/tick（96px/s = 1.6×）。
   */
  const RUN_CONFIG = {
    decider: {
      idleDurationSec: { minSec: 1, maxSec: 1 },
      turnDurationSec: { minSec: 0.5, maxSec: 0.5 },
      walkDurationSec: { minSec: 2, maxSec: 2 },
      resumeWalkAfterTurnRatio: 1,
      restSitDurationSec: { minSec: 8, maxSec: 8 },
      restLieDurationSec: { minSec: 15, maxSec: 15 },
      restCooldownSec: 45,
      restChance: 0,
      restSitShare: 1,
      runDurationSec: { minSec: 3, maxSec: 3 },
      runCooldownSec: 0,
      runChance: 1
    }
  }

  /** 0.1s 步进推进到指定时刻 */
  function step(h: Harness, fromMs: number, toMs: number): void {
    for (let t = fromMs; t <= toMs; t += 100) {
      h.tick(t)
    }
  }

  /** 以指定步长推进直到满足条件（返回当前时刻；调用方负责 start） */
  function stepUntil(h: Harness, cond: () => boolean, stepMs: number, maxMs: number): number {
    let t = 0
    h.runtime.start()
    while (t < maxMs) {
      t += stepMs
      h.tick(t)
      if (cond()) {
        return t
      }
    }
    throw new Error(`stepUntil 条件在 ${maxMs}ms 内未满足`)
  }

  it('行走到期进入跑步，沿用当前方向（不重新选向）', () => {
    const h = makeRuntime({ config: RUN_CONFIG })
    h.runtime.start()
    step(h, 100, 3300)
    expect(h.runtime.currentState.kind).toBe('running')
    // 朝向沿用行走的 right（scriptedRandom 0 → 右）
    expect(h.runtime.currentVisualState.facing).toBe('right')
  })

  it('跑步位移速度为 96px/s（默认 1.6× 行走），Y 保持不变', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: RUN_CONFIG })
    h.runtime.start()
    step(h, 100, 3100)
    expect(h.runtime.currentState.kind).toBe('running')
    const xBefore = win.getPosition().x
    const callsBefore = win.setPositionCalls.length
    // 跑步整段：t=3200..6100 共 30 tick（3.0s）
    step(h, 3200, 6100)
    // 3.0s × 96px/s = 288px（内部浮点位置，取整仅发生在 setPosition 边界）
    const displacement = win.getPosition().x - xBefore
    expect(displacement).toBeGreaterThanOrEqual(287)
    expect(displacement).toBeLessThanOrEqual(289)
    // Y 不变量：跑步仅改变 X，所有写窗口的 y 恒为初始轨道
    for (const call of win.setPositionCalls.slice(callsBefore)) {
      expect(call.y).toBe(100)
    }
    expect(win.getPosition().y).toBe(100)
  })

  it('跑步速率严格高于行走（同一运行时内 96 vs 60，比例 ≈ 1.6）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: RUN_CONFIG })
    h.runtime.start()
    // 行走期：t=1200..3100 共 20 tick（2.0s），位移 120px → 60px/s
    step(h, 100, 3100)
    const xAfterWalk = win.getPosition().x
    expect(xAfterWalk).toBe(220)
    // 跑步期：t=3200..6100 共 30 tick（3.0s），位移 288px → 96px/s
    step(h, 3200, 6100)
    const xAfterRun = win.getPosition().x
    const walkRate = (xAfterWalk - 100) / 2.0
    const runRate = (xAfterRun - xAfterWalk) / 3.0
    expect(runRate).toBeGreaterThan(walkRate)
    expect(runRate / walkRate).toBeCloseTo(1.6, 1)
  })

  it('跑步速度可注入（runSpeedPxPerSec 200 → 3s 位移 600px）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({
      window: win,
      config: { ...RUN_CONFIG, runSpeedPxPerSec: 200 }
    })
    h.runtime.start()
    step(h, 100, 3100)
    const xBefore = win.getPosition().x
    step(h, 3200, 6100)
    const displacement = win.getPosition().x - xBefore
    expect(displacement).toBeGreaterThanOrEqual(599)
    expect(displacement).toBeLessThanOrEqual(601)
  })

  it('位移与 tick 间隔无关：50ms 与 100ms 步进相同跑步时长位移一致', () => {
    const displacements: number[] = []
    for (const stepMs of [100, 50]) {
      const win = new FakeWindow(100, 100)
      const h = makeRuntime({ window: win, config: RUN_CONFIG })
      const reachedAt = stepUntil(h, () => h.runtime.currentState.kind === 'running', stepMs, 10000)
      expect(h.runtime.currentState.kind).toBe('running')
      const xBefore = win.getPosition().x
      // 精确 3.0s 的跑步位移
      let t = reachedAt
      for (let i = 0; i < Math.round(3000 / stepMs); i++) {
        t += stepMs
        h.tick(t)
      }
      displacements.push(win.getPosition().x - xBefore)
    }
    // 两种 tick 频率下位移均为 96px/s × 3s = 288（±1 取整余量），彼此一致
    for (const displacement of displacements) {
      expect(displacement).toBeGreaterThanOrEqual(287)
      expect(displacement).toBeLessThanOrEqual(289)
    }
    expect(Math.abs(displacements[0] - displacements[1])).toBeLessThanOrEqual(1)
  })

  it('跑步触界：X 钳制在活动边界内（不越界）并立即反向保持 running（Task 11H-B）', () => {
    const win = new FakeWindow(1450, 100)
    const h = makeRuntime({ window: win, config: RUN_CONFIG })
    stepUntil(h, () => h.runtime.currentState.kind === 'running', 100, 10000)
    // 继续推进：跑步触界 → 立即反向，状态保持 running 直到 RUN_END
    let t = 3200
    while (h.runtime.currentState.kind === 'running' && t < 20000) {
      t += 100
      h.tick(t)
    }
    // 离开 running 的原因是 RUN_END（回 idle），而非转向
    expect(h.runtime.currentState.kind).toBe('idle')
    expect(h.runtime.currentVisualState.facing).toBe('left')
    // 活动边界：maxX = 1920 − 240 = 1680；所有位置不越界
    for (const call of win.setPositionCalls) {
      expect(call.x).toBeLessThanOrEqual(1680)
      expect(call.x).toBeGreaterThanOrEqual(0)
      expect(call.y).toBe(100)
    }
    expect(win.getPosition().x).toBeLessThanOrEqual(1680)
  })

  it('RUN_END 后可再次跑步（冷却 0 配置下循环成立）', () => {
    const h = makeRuntime({ config: RUN_CONFIG })
    h.runtime.start()
    step(h, 100, 6100)
    expect(h.runtime.currentState.kind).toBe('idle')
    // idle 1s → walking 2s → 再次 running
    step(h, 6200, 9300)
    expect(h.runtime.currentState.kind).toBe('running')
  })

  it('跑步开始即重置冷却：两次跑步开始间隔 ≥ 冷却时长（覆盖转向/正常结束全部退出路径）', () => {
    // 窗口远离边界（x=500），跑步经 RUN_END 正常结束
    const win = new FakeWindow(500, 100)
    const h = makeRuntime({
      window: win,
      config: { decider: { ...RUN_CONFIG.decider, runCooldownSec: 8 } }
    })
    h.runtime.start()
    const runStarts: number[] = []
    let lastKind = 'idle'
    for (let t = 100; t <= 40000; t += 100) {
      h.tick(t)
      const kind = h.runtime.currentState.kind
      if (kind === 'running' && lastKind !== 'running') {
        runStarts.push(t)
      }
      lastKind = kind
    }
    expect(runStarts.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < runStarts.length; i++) {
      expect(runStarts[i] - runStarts[i - 1]).toBeGreaterThanOrEqual(8000)
    }
  })

  it('跑步冷却期内的行走到期不触发跑步（进入待机）', () => {
    const cooldownConfig = {
      decider: { ...RUN_CONFIG.decider, runCooldownSec: 5 }
    }
    const h = makeRuntime({ config: cooldownConfig })
    h.runtime.start()
    // 第一段行走到期（t≈3200）：冷却剩余 5−3.2 ≈ 1.8 > 0 → 不跑步
    step(h, 100, 3300)
    expect(h.runtime.currentState.kind).toBe('idle')
    // 冷却归零后的下一次行走到期（t≈6500 之后）→ 跑步
    step(h, 3400, 6600)
    expect(h.runtime.currentState.kind).toBe('running')
  })

  it('拖动取消跑步：结束后回到 idle（不自动恢复）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: RUN_CONFIG })
    h.runtime.start()
    step(h, 100, 3300)
    expect(h.runtime.currentState.kind).toBe('running')
    h.runtime.handleDragStart()
    expect(h.runtime.currentState.kind).toBe('dragging')
    win.teleport(400, 400)
    h.runtime.handleDragEnd()
    expect(h.runtime.currentState.kind).toBe('idle')
    // 拖动后的位置成为新基准（不跳回拖动前位置）
    expect(win.getPosition()).toEqual({ x: 400, y: 400 })
  })

  it('暂停冻结跑步（位置与计时停止），恢复后继续跑步', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: RUN_CONFIG })
    h.runtime.start()
    step(h, 100, 3300)
    expect(h.runtime.currentState.kind).toBe('running')
    const xAtPause = win.getPosition().x
    const callsAtPause = win.setPositionCalls.length
    h.runtime.pause()
    expect(h.runtime.currentState.kind).toBe('paused')
    step(h, 3400, 5000)
    // 暂停期间无任何位置写入
    expect(win.setPositionCalls.length).toBe(callsAtPause)
    expect(win.getPosition().x).toBe(xAtPause)
    h.runtime.resume()
    expect(h.runtime.currentState.kind).toBe('running')
    step(h, 5100, 5200)
    // 恢复后仍以跑步速度（9.6px/tick）推进
    expect(win.getPosition().x - xAtPause).toBeGreaterThanOrEqual(9)
  })

  it('确定性：相同随机序列与配置产生一致的状态序列与位移', () => {
    const runOnce = (): { kinds: string[]; positions: Array<{ x: number; y: number }> } => {
      const win = new FakeWindow(100, 100)
      const h = makeRuntime({ window: win, config: RUN_CONFIG, random: scriptedRandom([0]) })
      h.runtime.start()
      const kinds: string[] = []
      const positions: Array<{ x: number; y: number }> = []
      for (let t = 100; t <= 10000; t += 100) {
        h.tick(t)
        kinds.push(h.runtime.currentState.kind)
        positions.push(win.getPosition())
      }
      return { kinds, positions }
    }
    const first = runOnce()
    const second = runOnce()
    expect(second.kinds).toEqual(first.kinds)
    expect(second.positions).toEqual(first.positions)
    // 序列确实经历了 walking → running → idle 的完整跑步循环
    expect(first.kinds).toContain('running')
  })
})

describe('Task 11H-B：边界立即掉头专项', () => {
  /** 长行走配置：避免行走到期干扰边界观察（idle 1s / walk 10s） */
  const LONG_WALK_CONFIG = {
    decider: {
      ...FAST_CONFIG.decider,
      walkDurationSec: { minSec: 10, maxSec: 10 }
    }
  }

  /** 跑步边界配置：idle 1s → walk 2s 到期必跑步（runChance 1、冷却 0、跑步 3s） */
  const BOUNDARY_RUN_CONFIG = {
    decider: {
      ...FAST_CONFIG.decider,
      walkDurationSec: { minSec: 2, maxSec: 2 },
      runDurationSec: { minSec: 3, maxSec: 3 },
      runCooldownSec: 0,
      runChance: 1
    }
  }

  /** 坐下边界配置：idle 1s 到期必坐下（sit 3s），跑步禁用 */
  const BOUNDARY_SIT_CONFIG = {
    decider: {
      ...FAST_CONFIG.decider,
      walkDurationSec: { minSec: 2, maxSec: 2 },
      restSitDurationSec: { minSec: 3, maxSec: 3 },
      restCooldownSec: 1,
      restChance: 1,
      restSitShare: 1,
      runChance: 0
    }
  }

  it('running 向左触边：立即反转为向右，保持 running（Task 11H-B）', () => {
    // random 0.5 → 向左行走；walking 2s（150 → 30）后提速跑步向左触边
    const win = new FakeWindow(150, 100)
    const h = makeRuntime({
      window: win,
      config: BOUNDARY_RUN_CONFIG,
      random: scriptedRandom([0.5])
    })
    h.runtime.start()
    // t=3100 进入 running（x=30）；跑步 9.6px/tick 向左：
    // t=3200: 20.4 → 3300: 10.8 → 3400: 1.2 → 3500: 钳制 0 触边 → 立即反向
    for (let t = 100; t <= 3500; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('running')
    expect(h.runtime.currentVisualState.facing).toBe('right')
    // 反向后继续 running 且位置向右推进；全程不越左边界
    h.tick(3600)
    expect(win.getPosition().x).toBe(10)
    for (const call of win.setPositionCalls) {
      expect(call.x).toBeGreaterThanOrEqual(0)
      expect(call.y).toBe(100)
    }
  })

  it('跑步剩余时间不被触边重置：RUN_END 仍按原目标时长发生', () => {
    const win = new FakeWindow(1450, 100)
    const h = makeRuntime({ window: win, config: BOUNDARY_RUN_CONFIG })
    h.runtime.start()
    // run start t=3100（时长 3s）；t≈4300 触右界反向；RUN_END 应仍在 t=6100
    let runEndAt = -1
    let lastKind = 'idle'
    for (let t = 100; t <= 7000; t += 100) {
      h.tick(t)
      const kind = h.runtime.currentState.kind
      if (lastKind === 'running' && kind !== 'running') {
        runEndAt = t
      }
      lastKind = kind
    }
    expect(runEndAt).toBe(6100)
    expect(h.runtime.currentState.kind).toBe('idle')
  })

  it('大 deltaTime（低帧率/卡顿恢复）不越界：钳制 + 立即反向', () => {
    // dt 上限 0.1s：一次 1s 的大跳只按 0.1s 计算位移（6px），并被钳制
    const win = new FakeWindow(1679, 100)
    const h = makeRuntime({ window: win, config: LONG_WALK_CONFIG })
    h.runtime.start()
    // 正常 0.1s 步进到进入 walking（t=1100 idle 到期）
    for (let t = 100; t <= 1100; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    // 一次 1s 的大跳：dt=1.0 → 截断 0.1：1679+6 → 钳制 1680，触界反向
    h.tick(2100)
    expect(win.getPosition().x).toBe(1680)
    expect(h.runtime.currentVisualState.facing).toBe('left')
    h.tick(2200)
    expect(win.getPosition().x).toBe(1674)
    for (const call of win.setPositionCalls) {
      expect(call.x).toBeLessThanOrEqual(1680)
      expect(call.y).toBe(100)
    }
  })

  it('起点恰在右边界且朝向右：触边 tick 反向后单调向左，无方向抖动', () => {
    const win = new FakeWindow(1680, 100)
    const h = makeRuntime({ window: win, config: LONG_WALK_CONFIG })
    h.runtime.start()
    const xs: number[] = []
    for (let t = 100; t <= 3000; t += 100) {
      h.tick(t)
      if (h.runtime.currentState.kind === 'walking') {
        xs.push(win.getPosition().x)
      }
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.currentVisualState.facing).toBe('left')
    // t=1100 进入 walking（1680）→ t=1200 触边钳制 1680 反向 → 此后单调向左
    expect(xs[0]).toBe(1680)
    expect(xs[1]).toBe(1680)
    for (let i = 2; i < xs.length; i++) {
      expect(xs[i]).toBeLessThan(xs[i - 1])
      expect(xs[i]).toBeLessThan(1680)
    }
    expect(h.win.setPositionCalls.length).toBeGreaterThan(10)
  })

  it('拖动结束恰好位于右边界：朝向预校准为 left，恢复行走即向界内移动', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: LONG_WALK_CONFIG })
    advanceToWalking(h)
    h.runtime.handleDragStart()
    win.teleport(1680, 100)
    h.runtime.handleDragEnd()
    // 拖动结束即校准朝向（恢复的 walking 原朝向 right 指向不可移动侧）
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.currentVisualState.facing).toBe('left')
    // 恢复行走的第一个 tick 就向界内移动
    h.tick(1400)
    expect(win.getPosition().x).toBe(1674)
    expect(win.getPosition().y).toBe(100)
  })

  it('sitting 状态贴近边界：窗口保持静止，不触发边界检测或朝向变化', () => {
    // idle 1s 到期必坐下（sit 3s）；窗口起始贴右界
    const win = new FakeWindow(1680, 100)
    const h = makeRuntime({ window: win, config: BOUNDARY_SIT_CONFIG })
    h.runtime.start()
    for (let t = 100; t <= 1200; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('sitting')
    const callsAtSit = win.setPositionCalls.length
    expect(callsAtSit).toBe(0)
    const facingAtSit = h.runtime.currentVisualState.facing
    for (let t = 1300; t <= 4000; t += 100) {
      h.tick(t)
    }
    // 坐下期间（3s，浮点累加下 4200 到期）无移动、无朝向变化
    expect(h.runtime.currentState.kind).toBe('sitting')
    expect(win.setPositionCalls.length).toBe(callsAtSit)
    expect(h.runtime.currentVisualState.facing).toBe(facingAtSit)
    expect(win.getPosition()).toEqual({ x: 1680, y: 100 })
  })

  it('退化边界（workArea 窄于窗口）：保持方向不抖动，位置钳制在边界原点', () => {
    // 直接构造 runtime 以注入窄边界（宽 200 < 窗口 240 → spanX = -40）
    const win = new FakeWindow(50, 100)
    const narrowBounds: MovementBounds = { x: 0, y: 0, width: 200, height: 1080 }
    let now = 0
    const runtime = new PetBehaviorRuntime({
      window: win,
      getBounds: (): MovementBounds => narrowBounds,
      clock: (): number => now,
      random: scriptedRandom([0]),
      scheduler: (): (() => void) => () => undefined,
      config: LONG_WALK_CONFIG
    })
    runtime.start()
    const facings: string[] = []
    for (let t = 100; t <= 3000; t += 100) {
      now = t
      runtime.tick(t)
      facings.push(runtime.currentVisualState.facing)
    }
    expect(runtime.currentState.kind).toBe('walking')
    // 无反向空间：方向保持 right（不反复反转），位置钳制在边界原点
    expect(new Set(facings).size).toBe(1)
    expect(facings[0]).toBe('right')
    expect(win.getPosition().x).toBe(0)
    expect(win.getPosition().y).toBe(100)
  })
})

describe('Task 11H-C：调试控制接口（开发面板按钮 → 主进程权威行为）', () => {
  /** 调试测试配置：短时长便于验证"调试模式下到期不转换" */
  const DEBUG_CONFIG = {
    decider: {
      ...FAST_CONFIG.decider,
      walkDurationSec: { minSec: 1, maxSec: 1 },
      runDurationSec: { minSec: 2, maxSec: 2 },
      restSitDurationSec: { minSec: 3, maxSec: 3 }
    }
  }

  it('debugForceBehavior 强制各目标状态（合成决策走状态机）', () => {
    const h = makeRuntime({ config: DEBUG_CONFIG })
    h.runtime.start()
    expect(h.runtime.currentState.kind).toBe('idle')

    h.runtime.debugForceBehavior('walking')
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.isDebugControlled).toBe(true)

    h.runtime.debugForceBehavior('running')
    expect(h.runtime.currentState.kind).toBe('running')

    h.runtime.debugForceBehavior('sitting')
    expect(h.runtime.currentState.kind).toBe('sitting')

    h.runtime.debugForceBehavior('lying')
    expect(h.runtime.currentState.kind).toBe('lying')

    h.runtime.debugForceBehavior('idle')
    expect(h.runtime.currentState.kind).toBe('idle')
    // idle 也是调试控制（自动决策保持挂起）
    expect(h.runtime.isDebugControlled).toBe(true)
  })

  it('调试控制期间窗口真实移动（walking 以 60px/s 推进，X 变化 Y 不变）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: DEBUG_CONFIG })
    h.runtime.start()
    h.runtime.debugForceBehavior('walking')
    expect(h.runtime.currentState.kind).toBe('walking')
    for (let t = 100; t <= 1100; t += 100) {
      h.tick(t)
    }
    // 1.1s × 60px/s ≈ 66px（浮点步进 11 tick × 6px = 66）
    expect(win.getPosition().x).toBe(166)
    expect(win.getPosition().y).toBe(100)
  })

  it('调试控制期间跑步真实移动（96px/s）且边界立即掉头仍生效', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win, config: DEBUG_CONFIG })
    h.runtime.start()
    h.runtime.debugForceBehavior('running')
    expect(h.runtime.currentState.kind).toBe('running')
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    // t=100: 1679.6；t=200: 1689.2 → 钳制 1680 触界 → 立即反向；
    // t=300..1300 共 11 tick × 9.6px：1680 − 105.6 = 1574.4 → 1574
    expect(win.getPosition().x).toBe(1574)
    expect(win.getPosition().y).toBe(100)
    expect(h.runtime.currentVisualState.facing).toBe('left')
    for (const call of win.setPositionCalls) {
      expect(call.x).toBeLessThanOrEqual(1680)
    }
  })

  it('调试模式下行为时长到期不触发自动转换（决策挂起）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: DEBUG_CONFIG })
    h.runtime.start()
    h.runtime.debugForceBehavior('walking')
    // walking 目标 1s：推进 5s 仍保持 walking
    for (let t = 100; t <= 5000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
  })

  it('debugResumeAutoBehavior 恢复自动决策（计时重置后按目标时长转换）', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: DEBUG_CONFIG })
    h.runtime.start()
    h.runtime.debugForceBehavior('walking')
    for (let t = 100; t <= 2000; t += 100) {
      h.tick(t)
    }
    h.runtime.debugResumeAutoBehavior()
    expect(h.runtime.isDebugControlled).toBe(false)
    // 恢复后 elapsed 清零：walking 1s（浮点累加 1.1s 到期）→ WALK_END
    for (let t = 2100; t <= 3400; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('idle')
    // 幂等：重复恢复为无操作
    h.runtime.debugResumeAutoBehavior()
    expect(h.runtime.isDebugControlled).toBe(false)
  })

  it('拖动优先于调试控制：调试期间可拖动且不被锁死', () => {
    const win = new FakeWindow(100, 100)
    const h = makeRuntime({ window: win, config: DEBUG_CONFIG })
    h.runtime.start()
    h.runtime.debugForceBehavior('walking')
    h.runtime.handleDragStart()
    expect(h.runtime.currentState.kind).toBe('dragging')
    const callsAtDrag = win.setPositionCalls.length
    for (let t = 100; t <= 500; t += 100) {
      h.tick(t)
    }
    expect(win.setPositionCalls.length).toBe(callsAtDrag)
    win.teleport(300, 300)
    h.runtime.handleDragEnd()
    // 调试模式仍生效：恢复 walking 继续真实移动（新轨道）
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.isDebugControlled).toBe(true)
    h.tick(600)
    expect(win.getPosition().x).toBe(306)
    expect(win.getPosition().y).toBe(300)
  })

  it('暂停优先于调试强制（paused 时 debugForceBehavior 被忽略）', () => {
    const h = makeRuntime({ config: DEBUG_CONFIG })
    h.runtime.start()
    h.runtime.pause()
    h.runtime.debugForceBehavior('walking')
    expect(h.runtime.currentState.kind).toBe('paused')
    expect(h.runtime.isDebugControlled).toBe(false)
    // 恢复后仍可正常进入调试控制
    h.runtime.resume()
    h.runtime.debugForceBehavior('walking')
    expect(h.runtime.currentState.kind).toBe('walking')
  })

  it('调试强制跑步重置跑步冷却（恢复自动后冷却仍约束下次跑步）', () => {
    // runChance 1 + 冷却 10s：调试强制跑步后冷却从强制时刻起计时
    const cooldownConfig = {
      decider: {
        ...DEBUG_CONFIG.decider,
        runChance: 1,
        runCooldownSec: 10
      }
    }
    const h = makeRuntime({ config: cooldownConfig })
    h.runtime.start()
    // t≈0 强制跑步：冷却重置 10s；调试期间推进 5s（冷却 5，决策挂起）
    h.runtime.debugForceBehavior('running')
    for (let t = 100; t <= 5000; t += 100) {
      h.tick(t)
    }
    h.runtime.debugResumeAutoBehavior()
    // running 2s 到期（t≈7100）→ idle；idle 1.1s → walking（t≈8200）；
    // 行走 1s 到期（t≈9200）：冷却 10−9.2 = 0.8 > 0 → 不跑步，回 idle
    for (let t = 5100; t <= 9300; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('idle')
    // 再一轮 idle 1.1s + 行走 1s（t≈11400 到期）：冷却已归零 → 跑步
    for (let t = 9400; t <= 11500; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('running')
  })

  it('重复点击语义：重复强制同一目标不产生多重计时器或异常', () => {
    const h = makeRuntime({ config: DEBUG_CONFIG })
    h.runtime.start()
    h.runtime.debugForceBehavior('walking')
    h.runtime.debugForceBehavior('walking')
    h.runtime.debugForceBehavior('walking')
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.runtime.isRunning).toBe(true)
    // 多次 tick 正常推进（单一循环）
    for (let t = 100; t <= 1000; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
  })

  it('调试期间的视觉状态广播与正常行为一致（facing 随掉头更新）', () => {
    const broadcasts: PetVisualState[] = []
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({
      window: win,
      config: DEBUG_CONFIG,
      onVisualStateChange: (state): void => {
        broadcasts.push(state)
      }
    })
    h.runtime.start()
    h.runtime.debugForceBehavior('running')
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    expect(broadcasts).toContainEqual({ kind: 'running', facing: 'right' })
    expect(broadcasts).toContainEqual({ kind: 'running', facing: 'left' })
  })

  it('Task 11H-C：默认参数下跑步频率显著提高（模拟统计，注入时钟与随机）', () => {
    // LCG 伪随机（确定性可复现），相同种子下对比新旧参数
    const makeRandom = (seed: number): RandomSource => {
      let state = seed
      return () => {
        state = (state * 1664525 + 1013904223) % 4294967296
        return state / 4294967296
      }
    }
    const simulate = (config: RuntimeConfig): number => {
      const win = new FakeWindow(600, 100)
      const h = makeRuntime({ window: win, config, random: makeRandom(20261029) })
      h.runtime.start()
      let runs = 0
      let lastKind = 'idle'
      for (let t = 100; t <= 600000; t += 100) {
        h.tick(t)
        const kind = h.runtime.currentState.kind
        if (kind === 'running' && lastKind !== 'running') {
          runs += 1
        }
        lastKind = kind
      }
      return runs
    }
    // 新默认参数（0.45 / 冷却 20s / 3–5s）
    const newCount = simulate({ decider: DEFAULT_BEHAVIOR_DECIDER_CONFIG })
    // 旧参数（0.25 / 冷却 45s / 2–4s）
    const oldCount = simulate({
      decider: {
        ...DEFAULT_BEHAVIOR_DECIDER_CONFIG,
        runChance: 0.25,
        runCooldownSec: 45,
        runDurationSec: { minSec: 2, maxSec: 4 }
      }
    })
    // 10 分钟模拟：新参数 ≥ 12 次且严格多于旧参数（确定性断言，可复现）
    expect(newCount).toBeGreaterThanOrEqual(12)
    expect(newCount).toBeGreaterThan(oldCount)
  })
})
