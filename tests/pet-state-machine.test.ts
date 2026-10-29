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
    const state = run([{ type: 'WALK_START' }, { type: 'TURN_START' }, { type: 'TURN_END' }])
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
    const state = run([{ type: 'PAUSE' }, { type: 'WALK_START' }, { type: 'TURN_START' }])
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

describe('Task 11G：休息状态（sitting / lying）', () => {
  it('待机 → 坐下 / 趴卧（SIT_START / LIE_START 仅从 idle 进入）', () => {
    expect(run([{ type: 'SIT_START' }])).toEqual({ kind: 'sitting' })
    expect(run([{ type: 'LIE_START' }])).toEqual({ kind: 'lying' })
  })

  it('休息到期 → 待机（REST_END）', () => {
    expect(run([{ type: 'SIT_START' }, { type: 'REST_END' }])).toEqual({ kind: 'idle' })
    expect(run([{ type: 'LIE_START' }, { type: 'REST_END' }])).toEqual({ kind: 'idle' })
  })

  it('休息状态不可直接互切，也不可直接开始行走或转向', () => {
    const sitting: PetState = { kind: 'sitting' }
    expect(transition(sitting, { type: 'LIE_START' })).toEqual(sitting)
    expect(transition(sitting, { type: 'WALK_START' })).toEqual(sitting)
    expect(transition(sitting, { type: 'TURN_START' })).toEqual(sitting)
    const lying: PetState = { kind: 'lying' }
    expect(transition(lying, { type: 'SIT_START' })).toEqual(lying)
    expect(transition(lying, { type: 'WALK_START' })).toEqual(lying)
    // 行走/转向中也不可直接坐下或趴卧（必须先经 WALK_END 回 idle）
    expect(run([{ type: 'WALK_START' }, { type: 'SIT_START' }])).toEqual({ kind: 'walking' })
    expect(run([{ type: 'WALK_START' }, { type: 'LIE_START' }])).toEqual({ kind: 'walking' })
    expect(run([{ type: 'TURN_START' }, { type: 'SIT_START' }])).toEqual({ kind: 'turning' })
  })

  it('REST_END 对非休息状态为无操作', () => {
    expect(run([{ type: 'WALK_START' }, { type: 'REST_END' }])).toEqual({ kind: 'walking' })
    expect(run([{ type: 'REST_END' }])).toEqual({ kind: 'idle' })
    expect(run([{ type: 'PAUSE' }, { type: 'REST_END' }])).toEqual({
      kind: 'paused',
      restore: { kind: 'idle' }
    })
  })

  it('拖动中断休息：拖动结束后回到 idle，不自动恢复休息', () => {
    expect(run([{ type: 'SIT_START' }, { type: 'DRAG_START' }, { type: 'DRAG_END' }])).toEqual({
      kind: 'idle'
    })
    expect(run([{ type: 'LIE_START' }, { type: 'DRAG_START' }, { type: 'DRAG_END' }])).toEqual({
      kind: 'idle'
    })
  })

  it('拖动期间（休息来源）忽略自动行为事件，不残留恢复意图', () => {
    // 拖动中收到的 WALK_START / SIT_START 均无效；结束时仍回 idle
    expect(
      run([
        { type: 'SIT_START' },
        { type: 'DRAG_START' },
        { type: 'WALK_START' },
        { type: 'SIT_START' },
        { type: 'DRAG_END' }
      ])
    ).toEqual({ kind: 'idle' })
  })

  it('暂停冻结休息：PAUSE → paused(restore)，RESUME 恢复原休息状态', () => {
    const pausedFromSitting = run([{ type: 'SIT_START' }, { type: 'PAUSE' }])
    expect(pausedFromSitting).toEqual({
      kind: 'paused',
      restore: { kind: 'sitting' }
    })
    expect(run([{ type: 'SIT_START' }, { type: 'PAUSE' }, { type: 'RESUME' }])).toEqual({
      kind: 'sitting'
    })
    expect(run([{ type: 'LIE_START' }, { type: 'PAUSE' }, { type: 'RESUME' }])).toEqual({
      kind: 'lying'
    })
  })

  it('休息中暂停期间 REST_END 无效（暂停优先于休息结束）', () => {
    expect(run([{ type: 'SIT_START' }, { type: 'PAUSE' }, { type: 'REST_END' }])).toEqual({
      kind: 'paused',
      restore: { kind: 'sitting' }
    })
  })

  it('isAutoActive 覆盖休息状态', () => {
    expect(isAutoActive({ kind: 'sitting' })).toBe(true)
    expect(isAutoActive({ kind: 'lying' })).toBe(true)
    expect(isAutoActive({ kind: 'idle' })).toBe(false)
  })

  it('休息 → 到期 → 待机 → 再休息的完整循环', () => {
    const state = run([
      { type: 'SIT_START' },
      { type: 'REST_END' },
      { type: 'LIE_START' },
      { type: 'REST_END' },
      { type: 'WALK_START' }
    ])
    expect(state).toEqual({ kind: 'walking' })
  })
})

describe('Task 11H：跑步状态转换', () => {
  it('行走 → 跑步（RUN_START 提速）', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'RUN_START' }])
    expect(state).toEqual({ kind: 'running' })
    expect(isAutoActive(state)).toBe(true)
  })

  it('待机 → 跑步（RUN_START 允许从 idle 直接进入）', () => {
    const state = run([{ type: 'RUN_START' }])
    expect(state).toEqual({ kind: 'running' })
  })

  it('跑步 → 待机（RUN_END）', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'RUN_START' }, { type: 'RUN_END' }])
    expect(state).toEqual({ kind: 'idle' })
  })

  it.each(['sitting', 'lying', 'turning', 'paused', 'dragging'] as const)(
    '%s 状态下 RUN_START 被忽略（不绕过休息退出保护，不与转向/暂停/拖动叠加）',
    (kind) => {
      const state: PetState =
        kind === 'paused'
          ? { kind: 'paused', restore: { kind: 'idle' } }
          : kind === 'dragging'
            ? { kind: 'dragging', restore: { kind: 'walking' } }
            : ({ kind } as PetState)
      expect(transition(state, { type: 'RUN_START' })).toBe(state)
    }
  )

  it('跑步 → 转向（触界仍可转向）', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'RUN_START' }, { type: 'TURN_START' }])
    expect(state).toEqual({ kind: 'turning' })
  })

  it('非 running 状态下 RUN_END 被忽略', () => {
    expect(transition({ kind: 'walking' }, { type: 'RUN_END' })).toEqual({ kind: 'walking' })
    expect(transition({ kind: 'idle' }, { type: 'RUN_END' })).toEqual({ kind: 'idle' })
  })

  it('跑步期间拖动：结束后取消跑步回到 idle（不自动恢复）', () => {
    const state = run([
      { type: 'WALK_START' },
      { type: 'RUN_START' },
      { type: 'DRAG_START' },
      { type: 'DRAG_END' }
    ])
    expect(state).toEqual({ kind: 'idle' })
  })

  it('跑步期间暂停：记录 running，恢复后继续跑步', () => {
    const state = run([{ type: 'WALK_START' }, { type: 'RUN_START' }, { type: 'PAUSE' }])
    expect(state).toEqual({ kind: 'paused', restore: { kind: 'running' } })
    expect(isPaused(state)).toBe(true)
    expect(transition(state, { type: 'RESUME' })).toEqual({ kind: 'running' })
  })

  it('isAutoActive 覆盖跑步状态', () => {
    expect(isAutoActive({ kind: 'running' })).toBe(true)
  })

  it('休息结束后不得直接跑步：REST_END → RUN_START 序列合法路径需经 idle', () => {
    // REST_END 回 idle 后才允许 RUN_START（不允许 sitting → running 直跳）
    const state = run([{ type: 'SIT_START' }, { type: 'REST_END' }])
    expect(transition(state, { type: 'RUN_START' })).toEqual({ kind: 'running' })
    const direct = transition({ kind: 'sitting' }, { type: 'RUN_START' })
    expect(direct).toEqual({ kind: 'sitting' })
  })
})
