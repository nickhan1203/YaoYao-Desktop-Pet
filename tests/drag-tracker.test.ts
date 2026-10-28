import { describe, expect, it } from 'vitest'
import { DRAG_THRESHOLD_PX, DragTracker } from '../src/shared/drag-tracker'

describe('DragTracker', () => {
  it('位移小于阈值时判定为单击，不进入拖动', () => {
    const tracker = new DragTracker()
    tracker.pointerDown(100, 100)
    // 微小抖动（3px，低于阈值）
    tracker.pointerMove(101, 101)
    tracker.pointerMove(103, 102)
    const result = tracker.pointerUp()
    expect(result.isClick).toBe(true)
    expect(result.wasDrag).toBe(false)
    expect(tracker.isDragging).toBe(false)
  })

  it('位移达到阈值后判定为拖动', () => {
    const tracker = new DragTracker()
    tracker.pointerDown(100, 100)
    tracker.pointerMove(110, 100)
    expect(tracker.isDragging).toBe(true)
    const result = tracker.pointerUp()
    expect(result.wasDrag).toBe(true)
    expect(result.isClick).toBe(false)
  })

  it('阈值判定基于起点距离，坐标原点无关', () => {
    const tracker = new DragTracker()
    tracker.pointerDown(-1920, -500)
    tracker.pointerMove(-1920 + DRAG_THRESHOLD_PX, -500)
    expect(tracker.isDragging).toBe(true)
  })

  it('拖动结束后再次单击仍可正常判定', () => {
    const tracker = new DragTracker()
    tracker.pointerDown(0, 0)
    tracker.pointerMove(50, 50)
    expect(tracker.pointerUp().wasDrag).toBe(true)
    // 第二次按下后轻微移动即松开 → 单击
    tracker.pointerDown(200, 200)
    tracker.pointerMove(202, 201)
    const second = tracker.pointerUp()
    expect(second.isClick).toBe(true)
    expect(second.wasDrag).toBe(false)
  })

  it('cancel 后状态复位，不会卡在拖动状态', () => {
    const tracker = new DragTracker()
    tracker.pointerDown(0, 0)
    tracker.pointerMove(50, 50)
    expect(tracker.isDragging).toBe(true)
    tracker.cancel()
    expect(tracker.isDragging).toBe(false)
    // cancel 后的孤立 pointerUp 不产生误判
    const result = tracker.pointerUp()
    expect(result.isClick).toBe(false)
    expect(result.wasDrag).toBe(false)
  })

  it('未按下时 pointerMove 不产生任何效果', () => {
    const tracker = new DragTracker()
    tracker.pointerMove(100, 100)
    tracker.pointerMove(200, 200)
    expect(tracker.isDragging).toBe(false)
    const result = tracker.pointerUp()
    expect(result.isClick).toBe(false)
    expect(result.wasDrag).toBe(false)
  })

  it('拖动阈值常量为正数', () => {
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(0)
  })
})
