import { useEffect, useRef } from 'react'
import { DragTracker } from '../../../shared/drag-tracker'

/**
 * 桌宠拖动交互 Hook。
 *
 * 职责划分：本 Hook 只负责把 DOM 指针事件转交给纯逻辑 DragTracker，
 * 在跨过拖动阈值时通过 preload 窄接口通知主进程 dragStart，
 * 松手/取消时通知 dragEnd；窗口跟随移动与边界约束全部在主进程完成
 * （见 src/main/ipc-handlers.ts），拖动期间不发送任何高频消息。
 *
 * 稳定性保障：
 * - setPointerCapture 保证指针移出元素/窗口后仍能收到 move/up；
 * - pointercancel 与 window blur 时结束拖动，不会卡死；
 * - 只处理鼠标左键，右键留给后续菜单任务。
 */
export function usePetDrag(): React.RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const tracker = new DragTracker()
    let dragNotified = false

    const notifyDragStart = (): void => {
      if (!dragNotified) {
        dragNotified = true
        window.yaoyao?.dragStart()
      }
    }

    const notifyDragEnd = (): void => {
      if (dragNotified) {
        dragNotified = false
        window.yaoyao?.dragEnd()
      }
    }

    const cancelDrag = (): void => {
      notifyDragEnd()
      tracker.cancel()
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return
      }
      container.setPointerCapture(event.pointerId)
      tracker.pointerDown(event.screenX, event.screenY)
    }

    const onPointerMove = (event: PointerEvent): void => {
      tracker.pointerMove(event.screenX, event.screenY)
      if (tracker.isDragging) {
        notifyDragStart()
      }
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId)
      }
      const result = tracker.pointerUp()
      notifyDragEnd()
      // 普通单击（result.isClick）的响应留给后续点击交互任务。
      void result
    }

    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointercancel', cancelDrag)
    window.addEventListener('blur', cancelDrag)

    return () => {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointercancel', cancelDrag)
      window.removeEventListener('blur', cancelDrag)
      notifyDragEnd()
      tracker.cancel()
    }
  }, [])

  return containerRef
}
