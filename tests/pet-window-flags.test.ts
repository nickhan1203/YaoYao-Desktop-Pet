import { describe, expect, it, vi } from 'vitest'
import { PetWindowFlagsController } from '../src/main/pet-window-flags'

interface FlagsHarness {
  controller: PetWindowFlagsController
  setAlwaysOnTop: ReturnType<typeof vi.fn>
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isDragging: ReturnType<typeof vi.fn>
  handleDragEnd: ReturnType<typeof vi.fn>
  notifyInteractionCancel: ReturnType<typeof vi.fn>
  /** 按实际发生顺序记录的关键调用名（验证受控取消先于穿透生效） */
  calls: string[]
}

function makeHarness(options?: {
  destroyed?: boolean
  dragging?: boolean
  failSetAlwaysOnTop?: boolean
  failSetIgnoreMouseEvents?: boolean
}): FlagsHarness {
  const calls: string[] = []
  const setAlwaysOnTop = vi.fn((enabled: boolean): void => {
    if (options?.failSetAlwaysOnTop) {
      throw new Error('always-on-top failed')
    }
    calls.push(`setAlwaysOnTop:${enabled}`)
  })
  const setIgnoreMouseEvents = vi.fn((ignore: boolean): void => {
    if (options?.failSetIgnoreMouseEvents) {
      throw new Error('ignore-mouse-events failed')
    }
    calls.push(`setIgnoreMouseEvents:${ignore}`)
  })
  const isDestroyed = vi.fn((): boolean => options?.destroyed ?? false)
  const isDragging = vi.fn((): boolean => options?.dragging ?? false)
  const handleDragEnd = vi.fn((): void => {
    calls.push('handleDragEnd')
  })
  const notifyInteractionCancel = vi.fn((): void => {
    calls.push('notifyInteractionCancel')
  })
  const controller = new PetWindowFlagsController({
    window: { setAlwaysOnTop, setIgnoreMouseEvents, isDestroyed },
    runtime: { isDragging, handleDragEnd },
    notifier: { notifyInteractionCancel }
  })
  return {
    controller,
    setAlwaysOnTop,
    setIgnoreMouseEvents,
    isDestroyed,
    isDragging,
    handleDragEnd,
    notifyInteractionCancel,
    calls
  }
}

describe('PetWindowFlagsController.applyAlwaysOnTop（Task 12C 窗口置顶）', () => {
  it('开启/关闭成功调用 setAlwaysOnTop 并返回 true（幂等）', () => {
    const h = makeHarness()
    expect(h.controller.applyAlwaysOnTop(true)).toBe(true)
    expect(h.controller.applyAlwaysOnTop(false)).toBe(true)
    expect(h.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true)
    expect(h.setAlwaysOnTop).toHaveBeenNthCalledWith(2, false)
  })

  it('窗口已销毁：不调用 API，返回 false（调用方回滚设置）', () => {
    const h = makeHarness({ destroyed: true })
    expect(h.controller.applyAlwaysOnTop(true)).toBe(false)
    expect(h.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('Electron API 抛错：捕获并返回 false（不向上传播导致崩溃）', () => {
    const h = makeHarness({ failSetAlwaysOnTop: true })
    expect(h.controller.applyAlwaysOnTop(true)).toBe(false)
  })
})

describe('PetWindowFlagsController.applyMousePassthrough（Task 12C 鼠标穿透）', () => {
  it('非拖动状态开启：直接 setIgnoreMouseEvents(true)，不触发交互取消', () => {
    const h = makeHarness()
    expect(h.controller.applyMousePassthrough(true)).toBe(true)
    expect(h.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(h.notifyInteractionCancel).not.toHaveBeenCalled()
    expect(h.handleDragEnd).not.toHaveBeenCalled()
  })

  it('拖动中开启：受控取消先于穿透生效（notify → dragEnd → ignore）', () => {
    const h = makeHarness({ dragging: true })
    expect(h.controller.applyMousePassthrough(true)).toBe(true)
    expect(h.notifyInteractionCancel).toHaveBeenCalledTimes(1)
    expect(h.handleDragEnd).toHaveBeenCalledTimes(1)
    expect(h.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    // 顺序硬约束：renderer 收到取消信号且窗口停止跟随，之后才忽略鼠标
    expect(h.calls).toEqual([
      'notifyInteractionCancel',
      'handleDragEnd',
      'setIgnoreMouseEvents:true'
    ])
  })

  it('关闭穿透：仅恢复鼠标事件，不触碰运行时交互状态', () => {
    const h = makeHarness({ dragging: true })
    expect(h.controller.applyMousePassthrough(false)).toBe(true)
    expect(h.setIgnoreMouseEvents).toHaveBeenCalledWith(false)
    expect(h.notifyInteractionCancel).not.toHaveBeenCalled()
    expect(h.handleDragEnd).not.toHaveBeenCalled()
  })

  it('窗口已销毁：返回 false，不调用任何 API', () => {
    const h = makeHarness({ destroyed: true })
    expect(h.controller.applyMousePassthrough(true)).toBe(false)
    expect(h.setIgnoreMouseEvents).not.toHaveBeenCalled()
    expect(h.notifyInteractionCancel).not.toHaveBeenCalled()
  })

  it('setIgnoreMouseEvents 抛错：返回 false（不留下"设置已开但未生效"状态）', () => {
    const h = makeHarness({ failSetIgnoreMouseEvents: true, dragging: true })
    expect(h.controller.applyMousePassthrough(true)).toBe(false)
    // 取消流程仍先执行（拖动已被收口，即使穿透失败也不卡 dragging）
    expect(h.notifyInteractionCancel).toHaveBeenCalledTimes(1)
    expect(h.handleDragEnd).toHaveBeenCalledTimes(1)
  })

  it('重复应用幂等（连续两次开启互不干扰）', () => {
    const h = makeHarness()
    expect(h.controller.applyMousePassthrough(true)).toBe(true)
    expect(h.controller.applyMousePassthrough(true)).toBe(true)
    expect(h.setIgnoreMouseEvents).toHaveBeenCalledTimes(2)
    expect(h.setIgnoreMouseEvents.mock.calls.every((call) => call[0] === true)).toBe(true)
  })
})
