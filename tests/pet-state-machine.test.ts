import { describe, expect, it } from 'vitest'
import {
  INITIAL_PET_STATE,
  isAutoActive,
  isDragging,
  isPaused,
  transition,
  type PetState
} from '../src/shared/pet-state-machine'

/** 依次应用事件序列，返回最终状态（便于测试事件顺序组合）。 */
function run(events: Parameters<typeof transition>[1][]): PetState {
  return events.reduce(transition, INITIAL_PET_STATE)
}

describe('初始状态', () => {
  it('初始为 idle，无任何自动行为/拖动/暂停', () => {
    expect(INITIAL_PET_STATE).toEqual({ kind: 'idle' })
    expect(isAutoActive(INITIAL_PET_STATE)).toBe(false)
    expect(isDragging(INITIAL_PET_STATE)).toBe(false)
    expect(isPaused(INITIAL_PET_STATE)).toBe(false)
  })
})

describe('自动行为转换', () => {
  it('待机 → 行走', () => {
    const state = run([{ type: 'WALK_START' }])
    expect(state).toEqual({ kind: 'walking' })
    expect(isAutoActive(state)).toBe(true)
  })

  it('行走 → 转向 → 待机', () => {
    const state = run([
      { type: 'WALK_START' },
      { type: 'TURN_START' },
      { type: 'TURN_END' }
    ])
    expect(state).toEqual({ kind: 'idle' })
  })

  it('待机 → 转向 → 待机（不经行走）', () => {
    const state = run([{ type: 'TURN_START' }, { type: 'TURN_END' }])
    expect(state).toEqual({ kind: 'idle' })
  })

  it('行走结束 → 待机', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'WALK_END' }])
    expect(state).toEqual({ kind: 'idle' })
  })
})

describe('拖动与自动行为的关系', () => {
  it('行走期间开始拖动：立即进入 dragging，自动行为停止', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'DRAG_START' }])
    expect(state.kind).toBe('dragging')
    expect(isAutoActive(state)).toBe(false)
    if (state.kind === 'dragging') {
      expect(state.restore).toEqual({ kind: 'walking' })
    }
  })

  it('转向期间开始拖动：进入 dragging 并记住转向前路径', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'TURN_START' }, { type: 'DRAG_START' }])
    expect(state.kind).toBe('dragging')
    expect(isAutoActive(state)).toBe(false)
  })

  it('拖动结束后恢复拖动前的状态（行走）', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'DRAG_START' }, { type: 'DRAG_END' }])
    expect(state).toEqual({ kind: 'walking' })
  })

  it('拖动结束后恢复拖动前的状态（待机），不会无条件进入 walking', () => {
    const state = run([{ type: 'DRAG_START' }, { type: 'DRAG_END' }])
    expect(state).toEqual({ kind: 'idle' })
  })

  it('拖动结束后恢复拖动前的状态（转向）', () => {
    const state = run([{ type: 'TURN_START' }, { type: 'DRAG_START' }, { type: 'DRAG_END' }])
    expect(state).toEqual({ kind: 'turning' })
  })

  it('拖动期间自动行为事件被忽略', () => {
    const state = run([
      { type: 'DRAG_START' },
      { type: 'WALK_START' },
      { type: 'TURN_START' },
      { type: 'WALK_END' },
      { type: 'TURN_END' }
    ])
    expect(state.kind).toBe('dragging')
    expect(isAutoActive(state)).toBe(false)
  })
})

describe('暂停与继续', () => {
  it('暂停时不能继续自动行为', () => {
    const state = run([
      { type: 'PAUSE' },
      { type: 'WALK_START' },
      { type: 'TURN_START' }
    ])
    expect(state).toEqual({ kind: 'paused', restore: { kind: 'idle' } })
    expect(isAutoActive(state)).toBe(false)
  })

  it('行走期间暂停：记住 walking，继续后恢复', () => {
    const paused = run([{ type: 'WALK_START' }, { type: 'PAUSE' }])
    expect(paused).toEqual({ kind: 'paused', restore: { kind: 'walking' } })
    const resumed = transition(paused, { type: 'RESUME' })
    expect(resumed).toEqual({ kind: 'walking' })
  })

  it('转向期间暂停：记住 turning，继续后恢复', () => {
    const paused = run([{ type: 'TURN_START' }, { type: 'PAUSE' }])
    expect(paused).toEqual({ kind: 'paused', restore: { kind: 'turning' } })
    expect(transition(paused, { type: 'RESUME' })).toEqual({ kind: 'turning' })
  })

  it('待机暂停后继续：回到 idle', () => {
    const state = run([{ type: 'PAUSE' }, { type: 'RESUME' }])
    expect(state).toEqual({ kind: 'idle' })
  })
})

describe('暂停期间的拖动', () => {
  it('暂停期间开始并结束拖动：回到 paused，不恢复自动行为', () => {
    const state = run([
      { type: 'WALK_START' },
      { type: 'PAUSE' },
      { type: 'DRAG_START' },
      { type: 'DRAG_END' }
    ])
    expect(state).toEqual({ kind: 'paused', restore: { kind: 'walking' } })
    expect(isPaused(state)).toBe(true)
  })

  it('拖动期间暂停：拖动结束后回到 paused 而非恢复自动行为', () => {
    const state = run([
      { type: 'WALK_START' },
      { type: 'DRAG_START' },
      { type: 'PAUSE' },
      { type: 'DRAG_END' }
    ])
    expect(state).toEqual({ kind: 'paused', restore: { kind: 'walking' } })
  })

  it('拖动期间暂停后再继续：保持 dragging，拖动结束后恢复自动行为', () => {
    const state = run([
      { type: 'WALK_START' },
      { type: 'DRAG_START' },
      { type: 'PAUSE' },
      { type: 'RESUME' },
      { type: 'DRAG_END' }
    ])
    expect(state).toEqual({ kind: 'walking' })
  })
})

describe('重复事件与非法转换', () => {
  it('重复暂停：保持 paused 不变', () => {
    const once = run([{ type: 'WALK_START' }, { type: 'PAUSE' }])
    const twice = transition(once, { type: 'PAUSE' })
    expect(twice).toEqual(once)
  })

  it('非暂停状态下继续：状态不变', () => {
    const idle = INITIAL_PET_STATE
    expect(transition(idle, { type: 'RESUME' })).toEqual(idle)
    const walking = run([{ type: 'WALK_START' }])
    expect(transition(walking, { type: 'RESUME' })).toEqual(walking)
  })

  it('重复拖动开始：保持 dragging 且 restore 不被覆盖', () => {
    const once = run([{ type: 'WALK_START' }, { type: 'DRAG_START' }])
    const twice = transition(once, { type: 'DRAG_START' })
    expect(twice).toEqual(once)
  })

  it('非拖动状态下的拖动结束：状态不变', () => {
    expect(transition(INITIAL_PET_STATE, { type: 'DRAG_END' })).toEqual(INITIAL_PET_STATE)
    const walking = run([{ type: 'WALK_START' }])
    expect(transition(walking, { type: 'DRAG_END' })).toEqual(walking)
  })

  it('重复行走/转向事件：状态不变', () => {
    const walking = run([{ type: 'WALK_START' }])
    expect(transition(walking, { type: 'WALK_START' })).toEqual(walking)
    const turning = run([{ type: 'TURN_START' }])
    expect(transition(turning, { type: 'TURN_START' })).toEqual(turning)
  })

  it('idle 下 WALK_END / TURN_END：状态不变', () => {
    expect(transition(INITIAL_PET_STATE, { type: 'WALK_END' })).toEqual(INITIAL_PET_STATE)
    expect(transition(INITIAL_PET_STATE, { type: 'TURN_END' })).toEqual(INITIAL_PET_STATE)
  })
})

describe('复杂顺序下的一致性', () => {
  it('任意时刻不会同时处于 dragging 与自动行为', () => {
    const sequences: Parameters<typeof transition>[1][][] = [
      [{ type: 'WALK_START' }, { type: 'DRAG_START' }],
      [{ type: 'TURN_START' }, { type: 'DRAG_START' }, { type: 'PAUSE' }],
      [{ type: 'PAUSE' }, { type: 'DRAG_START' }, { type: 'RESUME' }],
      [{ type: 'DRAG_START' }, { type: 'WALK_START' }, { type: 'PAUSE' }, { type: 'DRAG_END' }]
    ]
    for (const sequence of sequences) {
      const state = run(sequence)
      expect(isDragging(state) && isAutoActive(state)).toBe(false)
    }
  })

  it('paused 状态下自动行为事件不会改变状态', () => {
    const paused = run([{ type: 'WALK_START' }, { type: 'PAUSE' }])
    for (const event of [
      { type: 'WALK_START' },
      { type: 'TURN_START' },
      { type: 'WALK_END' },
      { type: 'TURN_END' }
    ] as const) {
      expect(transition(paused, event)).toEqual(paused)
    }
  })

  it('长时间事件流后状态仍是合法的判别联合', () => {
    const state = run([
      { type: 'WALK_START' },
      { type: 'PAUSE' },
      { type: 'DRAG_START' },
      { type: 'PAUSE' },
      { type: 'RESUME' },
      { type: 'DRAG_END' },
      { type: 'RESUME' },
      { type: 'TURN_START' },
      { type: 'DRAG_START' },
      { type: 'DRAG_END' },
      { type: 'TURN_END' }
    ])
    expect(state).toEqual({ kind: 'idle' })
  })
})
