import { describe, expect, it, vi } from 'vitest'
import {
  createVisualStateSubscription,
  isPetVisualState,
  toPetFacing,
  type PetFacing,
  type PetVisualState,
  type VisualStateIpc
} from '../src/shared/pet-visual-state'
import { PetBehaviorRuntime, type RuntimeWindow } from '../src/main/pet-behavior-runtime'
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

class FakeWindow implements RuntimeWindow {
  readonly width = 240
  readonly height = 240
  private pos: Vec2
  setPositionCalls: Array<{ x: number; y: number }> = []

  constructor(x = 100, y = 100) {
    this.pos = { x, y }
  }

  getPosition(): Vec2 {
    return { ...this.pos }
  }

  setPosition(x: number, y: number): void {
    this.pos = { x, y }
    this.setPositionCalls.push({ x, y })
  }

  isDestroyed(): boolean {
    return false
  }

  teleport(x: number, y: number): void {
    this.pos = { x, y }
  }
}

function scriptedRandom(values: number[]): RandomSource {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}

/** 构造带广播记录的运行时 harness（手动时钟） */
function makeRuntime(options?: { window?: FakeWindow; random?: RandomSource }): {
  win: FakeWindow
  runtime: PetBehaviorRuntime
  broadcasts: PetVisualState[]
  tick: (n: number) => void
} {
  const win = options?.window ?? new FakeWindow()
  const broadcasts: PetVisualState[] = []
  let now = 0
  const runtime = new PetBehaviorRuntime({
    window: win,
    getBounds: (): MovementBounds => BOUNDS,
    clock: (): number => now,
    random: options?.random ?? scriptedRandom([0]),
    scheduler: (): (() => void) => () => undefined,
    config: FAST_CONFIG,
    onVisualStateChange: (state): void => {
      broadcasts.push(state)
    }
  })
  return {
    win,
    runtime,
    broadcasts,
    tick: (nowMs: number): void => {
      now = nowMs
      runtime.tick(nowMs)
    }
  }
}

describe('pet-visual-state 协议校验', () => {
  it('合法载荷通过校验（全部 kind 与 facing 组合）', () => {
    const kinds = ['idle', 'walking', 'turning', 'paused', 'dragging'] as const
    const facings = ['left', 'right', 'up', 'down'] as const
    for (const kind of kinds) {
      for (const facing of facings) {
        expect(isPetVisualState({ kind, facing })).toBe(true)
      }
    }
  })

  it('非法载荷被拒绝：非对象、缺字段、非法字面量', () => {
    expect(isPetVisualState(null)).toBe(false)
    expect(isPetVisualState(undefined)).toBe(false)
    expect(isPetVisualState('walking')).toBe(false)
    expect(isPetVisualState(42)).toBe(false)
    expect(isPetVisualState([])).toBe(false)
    expect(isPetVisualState({})).toBe(false)
    expect(isPetVisualState({ kind: 'walking' })).toBe(false)
    expect(isPetVisualState({ facing: 'left' })).toBe(false)
    expect(isPetVisualState({ kind: 'flying', facing: 'left' })).toBe(false)
    expect(isPetVisualState({ kind: 'walking', facing: 'sideways' })).toBe(false)
    expect(isPetVisualState({ kind: 1, facing: 'left' })).toBe(false)
    expect(isPetVisualState({ kind: 'walking', facing: null })).toBe(false)
  })

  it('额外字段不导致拒绝（向前兼容）', () => {
    expect(isPetVisualState({ kind: 'idle', facing: 'right', extra: 1 })).toBe(true)
  })
})

describe('toPetFacing 方向推导', () => {
  it('四向单位向量映射正确', () => {
    expect(toPetFacing({ x: 1, y: 0 })).toBe<PetFacing>('right')
    expect(toPetFacing({ x: -1, y: 0 })).toBe<PetFacing>('left')
    expect(toPetFacing({ x: 0, y: -1 })).toBe<PetFacing>('up')
    expect(toPetFacing({ x: 0, y: 1 })).toBe<PetFacing>('down')
  })

  it('非轴向向量按 x 优先判定；零/非法向量保守回退 right', () => {
    expect(toPetFacing({ x: -0.5, y: 0.5 })).toBe<PetFacing>('left')
    expect(toPetFacing({ x: 0.5, y: -0.5 })).toBe<PetFacing>('right')
    expect(toPetFacing({ x: 0, y: 0 })).toBe<PetFacing>('right')
    expect(toPetFacing({ x: Number.NaN, y: 1 })).toBe<PetFacing>('right')
  })
})

describe('PetBehaviorRuntime 视觉状态广播', () => {
  it('启动时广播初始状态（idle + 初始朝向）', () => {
    const h = makeRuntime()
    h.runtime.start()
    expect(h.broadcasts).toEqual([{ kind: 'idle', facing: 'right' }])
  })

  it('待机切换到行走时广播 walking 与正确朝向', () => {
    // Task 11D 后方向候选仅水平双向：random 0.5 → index 1 → 向左
    const h = makeRuntime({ random: scriptedRandom([0.5]) })
    h.runtime.start()
    // 待机 1s 到期（浮点累加下 1.1s 触发）
    for (let t = 100; t <= 1100; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'walking', facing: 'left' })
  })

  it('行走方向切换时朝向正确更新', () => {
    // 1. 待机到期选向右（random 0）→ 2. 触界转向 → 3. 恢复行走选向左（random 0.25 → index 1）
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win, random: scriptedRandom([0, 0, 0.25]) })
    h.runtime.start()
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'idle', facing: 'right' })
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    // 向右行走触界 → turning（朝向保持 right）
    expect(h.runtime.currentState.kind).toBe('turning')
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'turning', facing: 'right' })
    // 转向 0.5s 到期后恢复行走，方向向左
    for (let t = 1400; t <= 1900; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'walking', facing: 'left' })
  })

  it('触边转向时状态与朝向一致（转向期保持行走朝向）', () => {
    const win = new FakeWindow(1670, 100)
    const h = makeRuntime({ window: win })
    h.runtime.start()
    for (let t = 100; t <= 1300; t += 100) {
      h.tick(t)
    }
    const last = h.broadcasts[h.broadcasts.length - 1]
    expect(last.kind).toBe('turning')
    expect(last.facing).toBe('right')
  })

  it('拖动开始广播 dragging；松手后广播恢复的状态', () => {
    const h = makeRuntime()
    h.runtime.start()
    for (let t = 100; t <= 1100; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentState.kind).toBe('walking')
    h.runtime.handleDragStart()
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'dragging', facing: 'right' })
    h.win.teleport(600, 400)
    h.runtime.handleDragEnd()
    // 拖动前为 walking → 松手恢复 walking（状态机 DRAG_END 恢复语义）
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'walking', facing: 'right' })
  })

  it('暂停广播 paused；恢复广播原行为状态', () => {
    const h = makeRuntime()
    h.runtime.start()
    for (let t = 100; t <= 1100; t += 100) {
      h.tick(t)
    }
    h.runtime.pause()
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'paused', facing: 'right' })
    h.runtime.resume()
    expect(h.broadcasts[h.broadcasts.length - 1]).toEqual({ kind: 'walking', facing: 'right' })
  })

  it('状态不变时不重复广播（每个 tick 至多一次变化通知）', () => {
    const h = makeRuntime()
    h.runtime.start()
    expect(h.broadcasts).toHaveLength(1)
    // 待机期间多个 tick：状态不变 → 无广播
    for (let t = 100; t <= 900; t += 100) {
      h.tick(t)
    }
    expect(h.broadcasts).toHaveLength(1)
    // 转换一次后，行走期间多个 tick 也无重复广播
    for (let t = 1000; t <= 2000; t += 100) {
      h.tick(t)
    }
    expect(h.broadcasts).toHaveLength(2)
    expect(h.broadcasts[1]).toEqual({ kind: 'walking', facing: 'right' })
  })

  it('未注入回调时不广播也不影响行为（可选依赖）', () => {
    const win = new FakeWindow()
    const runtime = new PetBehaviorRuntime({
      window: win,
      getBounds: (): MovementBounds => BOUNDS,
      clock: (): number => 0,
      random: scriptedRandom([0]),
      scheduler: (): (() => void) => () => undefined,
      config: FAST_CONFIG
    })
    expect(() => runtime.start()).not.toThrow()
    expect(runtime.currentVisualState).toEqual({ kind: 'idle', facing: 'right' })
  })

  it('currentVisualState 始终可查询（不依赖广播）', () => {
    const h = makeRuntime()
    expect(h.runtime.currentVisualState).toEqual({ kind: 'idle', facing: 'right' })
    h.runtime.start()
    for (let t = 100; t <= 1100; t += 100) {
      h.tick(t)
    }
    expect(h.runtime.currentVisualState).toEqual({ kind: 'walking', facing: 'right' })
  })
})

/** 可编程假 IPC：记录监听器与移除调用，可控制 invoke 时序与结果 */
class FakeIpc implements VisualStateIpc {
  listeners = new Map<string, Array<(event: unknown, payload: unknown) => void>>()
  removed: Array<{ channel: string }> = []
  invokeCalls: string[] = []
  invokeResult: unknown = null
  invokeDelayMs = 0
  invokeRejects = false

  on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    const list = this.listeners.get(channel) ?? []
    list.push(listener)
    this.listeners.set(channel, list)
  }

  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    this.removed.push({ channel })
    const list = this.listeners.get(channel)
    if (list) {
      const index = list.indexOf(listener)
      if (index >= 0) {
        list.splice(index, 1)
      }
    }
  }

  invoke(channel: string): Promise<unknown> {
    this.invokeCalls.push(channel)
    if (this.invokeRejects) {
      return Promise.reject(new Error('no handler'))
    }
    return new Promise((resolve) => {
      setTimeout((): void => resolve(this.invokeResult), this.invokeDelayMs)
    })
  }

  broadcast(channel: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      listener({}, payload)
    }
  }
}

const BROADCAST_CHANNEL = 'pet:visual-state-changed'
const QUERY_CHANNEL = 'pet:get-visual-state'

describe('createVisualStateSubscription 订阅工厂', () => {
  it('订阅即查询当前状态并回调一次', async () => {
    const ipc = new FakeIpc()
    ipc.invokeResult = { kind: 'idle', facing: 'right' }
    const received: PetVisualState[] = []
    createVisualStateSubscription(ipc, BROADCAST_CHANNEL, QUERY_CHANNEL, (s) => received.push(s))
    await vi.waitFor((): void => {
      expect(received).toEqual([{ kind: 'idle', facing: 'right' }])
    })
    expect(ipc.invokeCalls).toEqual([QUERY_CHANNEL])
  })

  it('后续广播到达时回调；非法载荷被丢弃', async () => {
    const ipc = new FakeIpc()
    ipc.invokeResult = { kind: 'idle', facing: 'right' }
    const received: PetVisualState[] = []
    createVisualStateSubscription(ipc, BROADCAST_CHANNEL, QUERY_CHANNEL, (s) => received.push(s))
    await vi.waitFor((): void => {
      expect(received).toHaveLength(1)
    })
    ipc.broadcast(BROADCAST_CHANNEL, { kind: 'walking', facing: 'left' })
    expect(received[1]).toEqual({ kind: 'walking', facing: 'left' })
    ipc.broadcast(BROADCAST_CHANNEL, { kind: 'flying' })
    ipc.broadcast(BROADCAST_CHANNEL, null)
    expect(received).toHaveLength(2)
  })

  it('竞态：广播先于查询响应到达时，旧快照不覆盖新状态', async () => {
    const ipc = new FakeIpc()
    ipc.invokeDelayMs = 50
    ipc.invokeResult = { kind: 'idle', facing: 'right' } // 旧快照
    const received: PetVisualState[] = []
    createVisualStateSubscription(ipc, BROADCAST_CHANNEL, QUERY_CHANNEL, (s) => received.push(s))
    // 查询仍在途时收到更新广播
    ipc.broadcast(BROADCAST_CHANNEL, { kind: 'walking', facing: 'down' })
    expect(received).toEqual([{ kind: 'walking', facing: 'down' }])
    await new Promise((r) => setTimeout(r, 80))
    // 迟到的旧快照不得覆盖 walking
    expect(received).toEqual([{ kind: 'walking', facing: 'down' }])
  })

  it('取消订阅后：不再接收广播，迟到的查询响应也不触发回调', async () => {
    const ipc = new FakeIpc()
    ipc.invokeDelayMs = 50
    ipc.invokeResult = { kind: 'idle', facing: 'right' }
    const received: PetVisualState[] = []
    const unsubscribe = createVisualStateSubscription(ipc, BROADCAST_CHANNEL, QUERY_CHANNEL, (s) =>
      received.push(s)
    )
    unsubscribe()
    expect(ipc.removed).toEqual([{ channel: BROADCAST_CHANNEL }])
    ipc.broadcast(BROADCAST_CHANNEL, { kind: 'walking', facing: 'left' })
    await new Promise((r) => setTimeout(r, 80))
    expect(received).toEqual([])
  })

  it('取消订阅幂等：多次调用只移除一次监听器', () => {
    const ipc = new FakeIpc()
    const unsubscribe = createVisualStateSubscription(ipc, BROADCAST_CHANNEL, QUERY_CHANNEL, () => {
      /* 空回调 */
    })
    unsubscribe()
    unsubscribe()
    unsubscribe()
    expect(ipc.removed).toHaveLength(1)
  })

  it('查询失败（如主进程未注册 handler）不产生未处理 rejection，也不回调', async () => {
    const ipc = new FakeIpc()
    ipc.invokeRejects = true
    const received: PetVisualState[] = []
    createVisualStateSubscription(ipc, BROADCAST_CHANNEL, QUERY_CHANNEL, (s) => received.push(s))
    await new Promise((r) => setTimeout(r, 30))
    expect(received).toEqual([])
    // 广播仍可正常接收（查询失败不破坏订阅）
    ipc.broadcast(BROADCAST_CHANNEL, { kind: 'idle', facing: 'up' })
    expect(received).toEqual([{ kind: 'idle', facing: 'up' }])
  })

  it('查询返回非法载荷时不回调', async () => {
    const ipc = new FakeIpc()
    ipc.invokeResult = { kind: 42 }
    const received: PetVisualState[] = []
    createVisualStateSubscription(ipc, BROADCAST_CHANNEL, QUERY_CHANNEL, (s) => received.push(s))
    await new Promise((r) => setTimeout(r, 30))
    expect(received).toEqual([])
  })
})
