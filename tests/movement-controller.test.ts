import { describe, expect, it } from 'vitest'
import {
  MAX_DELTA_TIME_SEC,
  advancePet,
  computeMovement,
  type MovementInput
} from '../src/shared/movement-controller'

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 }
const SIZE = { width: 240, height: 240 }

/** 默认 deltaTime 取上限值 0.1s（不触发截断），速度 100px/s → 每步 10px */
function input(overrides: Partial<MovementInput> = {}): MovementInput {
  return {
    position: { x: 100, y: 100 },
    direction: { x: 1, y: 0 },
    speedPxPerSec: 100,
    deltaTimeSec: MAX_DELTA_TIME_SEC,
    size: SIZE,
    bounds: BOUNDS,
    ...overrides
  }
}

describe('computeMovement 基础移动', () => {
  it('时间为 0 时坐标不变', () => {
    const result = computeMovement(input({ deltaTimeSec: 0 }))
    expect(result.position).toEqual({ x: 100, y: 100 })
    expect(result.movedDistance).toBe(0)
    expect(result.hitBounds).toEqual({
      left: false,
      right: false,
      top: false,
      bottom: false
    })
  })

  it('水平正向移动：100px/s × 0.1s = 10px', () => {
    const result = computeMovement(input())
    expect(result.position).toEqual({ x: 110, y: 100 })
    expect(result.movedDistance).toBe(10)
  })

  it('水平反向移动', () => {
    const result = computeMovement(input({ direction: { x: -1, y: 0 } }))
    expect(result.position).toEqual({ x: 90, y: 100 })
    expect(result.movedDistance).toBe(10)
  })

  it('垂直向下移动', () => {
    const result = computeMovement(input({ direction: { x: 0, y: 1 } }))
    expect(result.position).toEqual({ x: 100, y: 110 })
  })

  it('垂直向上移动', () => {
    const result = computeMovement(input({ direction: { x: 0, y: -1 } }))
    expect(result.position).toEqual({ x: 100, y: 90 })
  })

  it('方向向量归一化：(3,4) 与单位向量结果一致', () => {
    const normalized = computeMovement(input({ direction: { x: 3, y: 4 } }))
    const unit = computeMovement(input({ direction: { x: 0.6, y: 0.8 } }))
    expect(normalized.position).toEqual(unit.position)
    expect(normalized.movedDistance).toBe(10)
  })

  it('速度单位为像素/秒，与 deltaTime 分离：240px/s × 0.05s = 12px', () => {
    const result = computeMovement(input({ speedPxPerSec: 240, deltaTimeSec: 0.05 }))
    expect(result.movedDistance).toBe(12)
  })
})

describe('帧率无关性', () => {
  it('不同 deltaTime 下总位移一致：0.05s 一步 = 0.01s 五步', () => {
    const oneStep = computeMovement(input({ deltaTimeSec: 0.05 }))
    let position = { x: 100, y: 100 }
    for (let i = 0; i < 5; i++) {
      const step = computeMovement(input({ position, deltaTimeSec: 0.01 }))
      position = step.position
    }
    expect(position).toEqual(oneStep.position)
    expect(oneStep.position).toEqual({ x: 105, y: 100 })
  })

  it('120Hz 与 60Hz 帧率下 1 秒总位移相同', () => {
    const speed = 100
    let at60 = { x: 0, y: 0 }
    for (let i = 0; i < 60; i++) {
      at60 = computeMovement(
        input({ position: at60, speedPxPerSec: speed, deltaTimeSec: 1 / 60 })
      ).position
    }
    let at120 = { x: 0, y: 0 }
    for (let i = 0; i < 120; i++) {
      at120 = computeMovement(
        input({ position: at120, speedPxPerSec: speed, deltaTimeSec: 1 / 120 })
      ).position
    }
    expect(at120.x).toBeCloseTo(at60.x, 5)
    expect(at60.x).toBeCloseTo(speed, 5)
  })
})

describe('时间增量上限与非法输入', () => {
  it('deltaTime 超过上限时截断：5s → 0.1s', () => {
    const result = computeMovement(input({ deltaTimeSec: 5 }))
    expect(result.position).toEqual({ x: 100 + 100 * MAX_DELTA_TIME_SEC, y: 100 })
    expect(MAX_DELTA_TIME_SEC).toBe(0.1)
  })

  it('负数、NaN、无穷 deltaTime 均按 0 处理，坐标不变', () => {
    for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = computeMovement(input({ deltaTimeSec: dt }))
      expect(result.position).toEqual({ x: 100, y: 100 })
      expect(result.movedDistance).toBe(0)
    }
  })

  it('非法速度（负数/NaN/无穷）按 0 处理，坐标不变', () => {
    for (const speed of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = computeMovement(input({ speedPxPerSec: speed }))
      expect(result.position).toEqual({ x: 100, y: 100 })
      expect(result.movedDistance).toBe(0)
    }
  })

  it('零向量或非法方向向量不移动', () => {
    for (const direction of [
      { x: 0, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 0, y: Number.POSITIVE_INFINITY }
    ]) {
      const result = computeMovement(input({ direction }))
      expect(result.position).toEqual({ x: 100, y: 100 })
    }
  })

  it('非法当前位置不推进，原样返回', () => {
    const result = computeMovement(input({ position: { x: Number.NaN, y: 100 } }))
    expect(result.movedDistance).toBe(0)
    expect(Number.isNaN(result.position.x)).toBe(true)
  })
})

describe('边界处理', () => {
  // maxX = 1920 - 240 = 1680, maxY = 1080 - 240 = 840
  it('到达右边界：钳制到 maxX 且 hitBounds.right', () => {
    const result = computeMovement(input({ position: { x: 1670, y: 100 } }))
    expect(result.position).toEqual({ x: 1680, y: 100 })
    expect(result.hitBounds.right).toBe(true)
    expect(result.movedDistance).toBe(10)
  })

  it('到达左边界：钳制到 x=0 且 hitBounds.left', () => {
    const result = computeMovement(input({ position: { x: 5, y: 100 }, direction: { x: -1, y: 0 } }))
    expect(result.position).toEqual({ x: 0, y: 100 })
    expect(result.hitBounds.left).toBe(true)
  })

  it('到达上边界：钳制到 y=0 且 hitBounds.top', () => {
    const result = computeMovement(input({ position: { x: 100, y: 5 }, direction: { x: 0, y: -1 } }))
    expect(result.position).toEqual({ x: 100, y: 0 })
    expect(result.hitBounds.top).toBe(true)
  })

  it('到达下边界：钳制到 maxY 且 hitBounds.bottom', () => {
    const result = computeMovement(input({ position: { x: 100, y: 830 }, direction: { x: 0, y: 1 } }))
    expect(result.position).toEqual({ x: 100, y: 840 })
    expect(result.hitBounds.bottom).toBe(true)
  })

  it('触及边界后不产生越界坐标（高速单步也不会越过）', () => {
    const result = computeMovement(
      input({
        position: { x: 1600, y: 800 },
        direction: { x: 1, y: 1 },
        speedPxPerSec: 2000
      })
    )
    expect(result.position.x).toBeLessThanOrEqual(1680)
    expect(result.position.y).toBeLessThanOrEqual(840)
    expect(result.hitBounds.right).toBe(true)
    expect(result.hitBounds.bottom).toBe(true)
  })

  it('窗口宽高影响活动范围：maxX = bounds.width - size.width', () => {
    // 小尺寸宠物：400 宽 → maxX = 1520
    const smallPet = computeMovement(
      input({ position: { x: 1515, y: 100 }, size: { width: 400, height: 400 } })
    )
    expect(smallPet.position).toEqual({ x: 1520, y: 100 })
    expect(smallPet.hitBounds.right).toBe(true)
  })
})

describe('非零原点与负坐标边界', () => {
  it('负坐标边界（左侧副屏）：活动范围为副屏工作区', () => {
    const negativeBounds = { x: -1920, y: 0, width: 1920, height: 1040 }
    // maxX = -1920 + (1920 - 240) = -240
    const hitRight = computeMovement(
      input({ position: { x: -250, y: 100 }, bounds: negativeBounds })
    )
    expect(hitRight.position).toEqual({ x: -240, y: 100 })
    expect(hitRight.hitBounds.right).toBe(true)

    const hitLeft = computeMovement(
      input({
        position: { x: -1910, y: 100 },
        direction: { x: -1, y: 0 },
        bounds: negativeBounds
      })
    )
    expect(hitLeft.position).toEqual({ x: -1920, y: 100 })
    expect(hitLeft.hitBounds.left).toBe(true)
  })

  it('非零正原点边界', () => {
    const offsetBounds = { x: 100, y: 50, width: 800, height: 600 }
    const hitLeft = computeMovement(
      input({ position: { x: 105, y: 100 }, direction: { x: -1, y: 0 }, bounds: offsetBounds })
    )
    expect(hitLeft.position).toEqual({ x: 100, y: 100 })
    expect(hitLeft.hitBounds.left).toBe(true)
  })

  it('退化边界（宽高非正）稳定钳制到边界原点', () => {
    const degenerate = { x: 10, y: 10, width: 0, height: 0 }
    const result = computeMovement(input({ bounds: degenerate }))
    expect(result.position).toEqual({ x: 10, y: 10 })
    expect(result.hitBounds).toEqual({ left: true, right: true, top: true, bottom: true })
  })
})

describe('advancePet 状态衔接', () => {
  it('walking 状态下推进位置', () => {
    const result = advancePet({ kind: 'walking' }, input())
    expect(result.position).toEqual({ x: 110, y: 100 })
    expect(result.movedDistance).toBe(10)
  })

  it('idle / turning / paused / dragging 状态不推进位置', () => {
    const states = [
      { kind: 'idle' },
      { kind: 'turning' },
      { kind: 'paused', restore: { kind: 'idle' } },
      { kind: 'dragging', restore: { kind: 'walking' } }
    ] as const
    for (const state of states) {
      const result = advancePet(state, input())
      expect(result.position).toEqual({ x: 100, y: 100 })
      expect(result.movedDistance).toBe(0)
      expect(result.hitBounds).toEqual({
        left: false,
        right: false,
        top: false,
        bottom: false
      })
    }
  })

  it('拖动后恢复 walking 可继续推进', () => {
    const dragging = { kind: 'dragging', restore: { kind: 'walking' } } as const
    const restored = { kind: 'walking' } as const
    expect(advancePet(dragging, input()).movedDistance).toBe(0)
    expect(advancePet(restored, input()).movedDistance).toBe(10)
  })
})
