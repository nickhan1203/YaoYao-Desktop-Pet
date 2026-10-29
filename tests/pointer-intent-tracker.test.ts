/**
 * Task 11J：指针意图识别跟踪器纯逻辑层测试。
 *
 * 覆盖任务规格的测试点：
 * 1.  短点击识别（未超阈值、未到长按时长即释放 → click）；
 * 2.  长按 230ms 触发拎起（未移动，鼠标不动也进入拎起）；
 * 3.  移动超阈值（4px，保持既有拖动手感）立即拎起，不等长按时长；
 * 4.  已拎起后释放 → drop；
 * 5.  未拎起的异常取消（pointercancel / 失焦 / 卸载）→ cancel；
 * 6.  已拎起的异常取消 → 视为释放（drop，hook 层补发 dragEnd）；
 * 7.  已拎起后继续移动不重复触发 lift；
 * 8.  意图跟踪中的重复 pointerdown 重置（最新事件优先）；
 * 9.  长按边界：229ms 未触发、230ms 触发；
 * 10. 移动阈值边界：3.9px 不触发、4px 触发；
 * 11. 未跟踪时的 pointerUp / tick / cancel 为无操作；
 * 12. 意图事件的一次性语义（lift 只触发一次）。
 */

import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, PointerIntentTracker } from '../src/shared/pointer-intent-tracker'

interface Recorded {
  clicks: number
  lifts: number
  drops: number
  cancels: number
}

function makeTracker(): { tracker: PointerIntentTracker; events: Recorded } {
  const events: Recorded = { clicks: 0, lifts: 0, drops: 0, cancels: 0 }
  const tracker = new PointerIntentTracker({
    onClick: (): void => {
      events.clicks += 1
    },
    onLift: (): void => {
      events.lifts += 1
    },
    onDrop: (): void => {
      events.drops += 1
    },
    onCancel: (): void => {
      events.cancels += 1
    }
  })
  return { tracker, events }
}

describe('Task 11J：短点击识别', () => {
  it('未移动、未到长按时长即释放 → click（无 lift/drop）', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(100, 100, 0)
    tracker.tick(100) // 100ms < 230ms
    tracker.pointerUp()
    expect(events.clicks).toBe(1)
    expect(events.lifts).toBe(0)
    expect(events.drops).toBe(0)
    expect(tracker.isTracking).toBe(false)
  })

  it('小幅移动（<4px）后释放仍为 click', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(100, 100, 0)
    tracker.pointerMove(103, 101) // 距离 ~3.16px < 4
    tracker.pointerUp()
    expect(events.clicks).toBe(1)
    expect(events.lifts).toBe(0)
  })
})

describe('Task 11J：长按拎起', () => {
  it('按住 230ms 未移动 → lift（鼠标不动也进入拎起）', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(100, 100, 0)
    tracker.tick(LONG_PRESS_MS)
    expect(events.lifts).toBe(1)
    expect(tracker.isLifted).toBe(true)
  })

  it('长按边界：229ms 不触发、230ms 触发', () => {
    const a = makeTracker()
    a.tracker.pointerDown(0, 0, 0)
    a.tracker.tick(229)
    expect(a.events.lifts).toBe(0)
    const b = makeTracker()
    b.tracker.pointerDown(0, 0, 0)
    b.tracker.tick(230)
    expect(b.events.lifts).toBe(1)
  })

  it('lift 只触发一次（后续 tick 不重复）', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.tick(230)
    tracker.tick(1000)
    tracker.tick(5000)
    expect(events.lifts).toBe(1)
  })
})

describe('Task 11J：移动拎起（不等长按，跟手无延迟）', () => {
  it('位移 ≥4px 立即 lift（沿用 DragTracker 阈值，保持既有手感）', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(100, 100, 0)
    tracker.pointerMove(104, 100) // 恰好 4px
    expect(events.lifts).toBe(1)
    expect(tracker.isLifted).toBe(true)
  })

  it('阈值边界：3.9px 不触发、4px 触发', () => {
    const a = makeTracker()
    a.tracker.pointerDown(0, 0, 0)
    a.tracker.pointerMove(3.9, 0)
    expect(a.events.lifts).toBe(0)
    const b = makeTracker()
    b.tracker.pointerDown(0, 0, 0)
    b.tracker.pointerMove(4, 0)
    expect(b.events.lifts).toBe(1)
  })

  it('已拎起后继续移动不重复触发 lift', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.pointerMove(4, 0)
    tracker.pointerMove(50, 30)
    tracker.pointerMove(200, 200)
    expect(events.lifts).toBe(1)
  })

  it('移动拎起后 tick（长按计时到期）不重复触发', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.pointerMove(10, 0)
    tracker.tick(1000)
    expect(events.lifts).toBe(1)
  })
})

describe('Task 11J：释放与异常取消', () => {
  it('已拎起后 pointerUp → drop', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.pointerMove(10, 0)
    tracker.pointerUp()
    expect(events.drops).toBe(1)
    expect(events.clicks).toBe(0)
    expect(tracker.isTracking).toBe(false)
  })

  it('长按拎起后 pointerUp → drop（不再判 click）', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.tick(230)
    tracker.pointerUp()
    expect(events.drops).toBe(1)
    expect(events.clicks).toBe(0)
  })

  it('未拎起的 cancel（pointercancel/失焦）→ onCancel，无 drop', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.cancel()
    expect(events.cancels).toBe(1)
    expect(events.drops).toBe(0)
    expect(tracker.isTracking).toBe(false)
  })

  it('已拎起的 cancel → 视为释放（onDrop，hook 层补发 dragEnd）', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.pointerMove(10, 0)
    tracker.cancel()
    expect(events.drops).toBe(1)
    expect(events.cancels).toBe(0)
  })
})

describe('Task 11J：状态重置与防御', () => {
  it('意图跟踪中的重复 pointerDown 重置起点（最新事件优先）', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.tick(200) // 未到阈值
    tracker.pointerDown(500, 500, 1000) // 异常重复按下：重置
    tracker.pointerMove(503, 500) // 距新起点 ~3px，不触发
    expect(events.lifts).toBe(0)
    tracker.pointerMove(504, 500)
    expect(events.lifts).toBe(1)
  })

  it('未跟踪时 pointerUp / tick / cancel 均为无操作', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerUp()
    tracker.tick(1000)
    tracker.cancel()
    expect(events.clicks).toBe(0)
    expect(events.lifts).toBe(0)
    expect(events.drops).toBe(0)
    expect(events.cancels).toBe(0)
  })

  it('click 后（idle 状态）再次完整流程不受上一次影响', () => {
    const { tracker, events } = makeTracker()
    tracker.pointerDown(0, 0, 0)
    tracker.pointerUp() // click
    tracker.pointerDown(0, 0, 1000)
    tracker.tick(1230) // 注入时钟为绝对毫秒：1000 + 230
    tracker.pointerUp() // drop
    expect(events.clicks).toBe(1)
    expect(events.lifts).toBe(1)
    expect(events.drops).toBe(1)
  })
})
