import { useEffect, useRef } from 'react'
import { LONG_PRESS_MS, PointerIntentTracker } from '../../../shared/pointer-intent-tracker'

/**
 * 桌宠指针交互 Hook（Task 11J，替代 usePetDrag 的拖动单一语义）。
 *
 * 职责划分：本 Hook 只把 DOM 指针事件转交给纯逻辑 PointerIntentTracker，
 * 按意图事件协调交互动画与窄 IPC：
 * - click → 交互动画（点击反馈），无 IPC（不影响主进程行为）；
 * - lift → window.yaoyao.dragStart()（真实拖动开始：主进程锚点轮询
 *   + 行为状态机 DRAG_START）+ 交互动画（拎起）；
 * - drop → window.yaoyao.dragEnd()（真实拖动结束：窗口停在释放位置，
 *   行为状态回 idle）+ 交互动画（放下过渡）；
 * - cancel（未拎起的异常取消）→ 仅清理计时器。
 *
 * 意图识别时序（保持既有拖动手感）：
 * - 位移 ≥ 4px（DragTracker 阈值）立即拎起（不等长按，窗口跟手无延迟）；
 * - 按住 230ms 未移动 → 长按拎起（鼠标未动，窗口静止但进入真实
 *   dragging；之后移动即跟随）；
 * - 提前释放且未超阈值/未长按 → 短点击。
 *
 * 稳定性保障：
 * - setPointerCapture 保证指针移出元素/窗口后仍能收到 move/up；
 * - pointercancel 与 window blur 时结束意图（已拎起则补发 dragEnd，
 *   不让主进程卡在 dragging；未拎起静默取消）；
 * - 只处理鼠标左键；
 * - 卸载时清理监听与计时器，并结束未完成的拎起。
 *
 * 交互动画控制器（朝向锁定等）由 PetCanvas 通过 handlers 注入，
 * 本 Hook 不持有 PixiJS 资源。
 */

/** 意图事件 → 交互动画/朝向锁定的接线（PetCanvas 主 effect 注入） */
export interface PetInteractionHandlers {
  /** 拎起：锁定抓取朝向并进入 lifting（PetCanvas 实现） */
  onLift: () => void
  /** 放下：进入 dropping（PetCanvas 实现） */
  onDrop: () => void
  /** 短点击：播放点击反馈（PetCanvas 实现） */
  onClick: () => void
}

export function usePetInteraction(
  handlersRef: React.RefObject<PetInteractionHandlers | null>
): React.RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    let dragNotified = false
    let longPressTimer: ReturnType<typeof setTimeout> | null = null

    const clearLongPressTimer = (): void => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
    }

    const tracker = new PointerIntentTracker({
      onClick: (): void => {
        clearLongPressTimer()
        handlersRef.current?.onClick()
      },
      onLift: (): void => {
        clearLongPressTimer()
        if (!dragNotified) {
          dragNotified = true
          window.yaoyao?.dragStart()
        }
        handlersRef.current?.onLift()
      },
      onDrop: (): void => {
        clearLongPressTimer()
        if (dragNotified) {
          dragNotified = false
          window.yaoyao?.dragEnd()
        }
        handlersRef.current?.onDrop()
      },
      onCancel: (): void => {
        clearLongPressTimer()
      }
    })

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return
      }
      container.setPointerCapture(event.pointerId)
      tracker.pointerDown(event.screenX, event.screenY, performance.now())
      // 长按计时：到时以注入时钟判定（未移动则拎起）。
      longPressTimer = setTimeout((): void => {
        longPressTimer = null
        tracker.tick(performance.now())
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (event: PointerEvent): void => {
      tracker.pointerMove(event.screenX, event.screenY)
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId)
      }
      tracker.pointerUp()
    }

    const onPointerCancel = (): void => {
      tracker.cancel()
    }

    const onBlur = (): void => {
      tracker.cancel()
    }

    // Task 12C：受控交互取消（主进程在拖动中开启鼠标穿透时发送）。
    // 复用 pointercancel 同一取消语义：tracker.cancel 已拎起时触发
    // onDrop（补发幂等 dragEnd + held→dropping 落地动画），未拎起时
    // 静默清理计时器——拖动/悬空动画均有收口，不卡 dragging。
    const unsubscribeInteractionCancel = window.yaoyao?.onInteractionCancel(() => {
      tracker.cancel()
    })

    // 右键菜单（Task 12A）：仅透传"打开菜单"信号给主进程（菜单内容由
    // 主进程权威状态构建）。右键不参与左键意图识别（onPointerDown 只处理
    // button 0），不触发点击动画/拎起/拖动；浏览器默认菜单被抑制。
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      window.yaoyao?.showContextMenu()
    }

    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointercancel', onPointerCancel)
    container.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('blur', onBlur)

    return (): void => {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointercancel', onPointerCancel)
      container.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('blur', onBlur)
      unsubscribeInteractionCancel?.()
      clearLongPressTimer()
      // 卸载时结束未完成的意图：已拎起 → 补发 dragEnd（主进程不卡拖动）。
      tracker.cancel()
    }
  }, [handlersRef])

  return containerRef
}
