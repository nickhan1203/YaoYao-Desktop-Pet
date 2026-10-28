import { ipcMain, screen, type BrowserWindow } from 'electron'
import { clampWindowToDisplays, type Rect } from './display-clamp'

const DRAG_START_CHANNEL = 'pet:drag-start'
const DRAG_END_CHANNEL = 'pet:drag-end'

/** 拖动跟随的轮询间隔（约 60fps） */
const DRAG_POLL_INTERVAL_MS = 16

interface DragState {
  /** 鼠标相对窗口左上角的锚点偏移（屏幕坐标） */
  anchorX: number
  anchorY: number
  pollTimer: ReturnType<typeof setInterval>
}

/**
 * 注册桌宠拖动相关的 IPC handler。
 *
 * 最小权限说明：
 * - 只监听两条一次性窄通道 'pet:drag-start' / 'pet:drag-end'，无载荷；
 * - 不暴露任意通道调用、文件系统或 shell 能力。
 *
 * 绝对锚点拖动：drag-start 时记录鼠标与窗口的相对偏移，
 * 之后主进程用 screen.getCursorScreenPoint() 轮询驱动窗口跟随。
 * 优点：
 * - 无高频 IPC（拖动期间 renderer 不发任何消息）；
 * - 主进程坐标系，不受 renderer 屏幕坐标跨显示器/混合 DPI 跳变影响；
 * - 边界约束"吃掉"的位移在约束解除后自动恢复，鼠标与窗口不会跑偏。
 */
export function registerPetIpcHandlers(getPetWindow: () => BrowserWindow | null): void {
  let dragState: DragState | null = null

  const stopDrag = (): void => {
    if (dragState) {
      clearInterval(dragState.pollTimer)
      dragState = null
    }
  }

  ipcMain.on(DRAG_START_CHANNEL, () => {
    // 已在拖动中时忽略重复的 start 消息。
    if (dragState) {
      return
    }
    const petWindow = getPetWindow()
    if (!petWindow || petWindow.isDestroyed()) {
      return
    }

    const cursor = screen.getCursorScreenPoint()
    const [windowX, windowY] = petWindow.getPosition()
    const anchorX = cursor.x - windowX
    const anchorY = cursor.y - windowY

    const pollTimer = setInterval(() => {
      const win = getPetWindow()
      if (!win || win.isDestroyed()) {
        stopDrag()
        return
      }
      const currentCursor = screen.getCursorScreenPoint()
      const bounds = win.getBounds()
      const workAreas: Rect[] = screen.getAllDisplays().map((display) => display.workArea)
      const clamped = clampWindowToDisplays(
        {
          x: currentCursor.x - anchorX,
          y: currentCursor.y - anchorY,
          width: bounds.width,
          height: bounds.height
        },
        workAreas
      )
      // Electron setPosition 只接受整数坐标；高 DPI 缩放下光标坐标为小数，
      // 直接传入会抛 "conversion failure"。取整误差不随时间累积（每帧重算）。
      win.setPosition(Math.round(clamped.x), Math.round(clamped.y), false)
    }, DRAG_POLL_INTERVAL_MS)

    dragState = { anchorX, anchorY, pollTimer }
  })

  ipcMain.on(DRAG_END_CHANNEL, () => {
    stopDrag()
  })
}
