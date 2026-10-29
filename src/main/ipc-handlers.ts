import { ipcMain, screen, type BrowserWindow } from 'electron'
import { clampWindowToDisplays, type Rect } from './display-clamp'
import { isPetVisualState, type PetVisualState } from '../shared/pet-visual-state'
import {
  DEV_DEBUG_COMMAND_CHANNEL,
  DEV_DEBUG_GET_STATE_CHANNEL,
  parseDevDebugCommand,
  type DebugBehaviorTarget,
  type DevDebugState
} from '../shared/dev-debug'

const DRAG_START_CHANNEL = 'pet:drag-start'
const DRAG_END_CHANNEL = 'pet:drag-end'
/** 视觉状态查询通道：renderer 订阅时获取当前状态（一次性 invoke） */
const GET_VISUAL_STATE_CHANNEL = 'pet:get-visual-state'

/** 拖动跟随的轮询间隔（约 60fps） */
const DRAG_POLL_INTERVAL_MS = 16

interface DragState {
  /** 鼠标相对窗口左上角的锚点偏移（屏幕坐标） */
  anchorX: number
  anchorY: number
  pollTimer: ReturnType<typeof setInterval>
}

/** 拖动生命周期回调（供行为运行时协调自动行为） */
export interface DragCallbacks {
  onDragStart?: () => void
  onDragEnd?: () => void
}

/** 视觉状态相关注册选项 */
export interface VisualStateHandlers {
  /** 返回当前视觉状态（来自行为运行时的权威快照）；未提供时不注册查询通道 */
  getVisualState?: () => PetVisualState | null
}

/**
 * 开发调试控制回调（Task 11H-C）。
 * 主进程仍是行为状态与窗口运动的唯一权威：回调只触发行为运行时
 * 已有的调试方法（合成决策走状态机，不绕过内部状态）。
 */
export interface DevDebugCallbacks {
  /** 强制目标行为（进入调试控制模式，自动决策挂起） */
  forceBehavior: (target: DebugBehaviorTarget) => void
  /** 释放调试控制，恢复自动决策 */
  resumeAutoBehavior: () => void
  /** 当前是否处于调试控制模式 */
  isDebugControlled: () => boolean
}

/**
 * 注册开发调试控制通道（Task 11H-C，替换 Task 11F-B 的预览暂停通道）。
 *
 * 最小权限与安全边界：
 * - 命令通道为固定窄通道，载荷经 parseDevDebugCommand 白名单校验
 *（非法载荷直接忽略，不回执、不抛错）；
 * - 状态查询通道返回固定结构 { debugControlled: boolean }，无其他信息；
 * - 只允许在开发构建中调用（由 index.ts 以 !app.isPackaged 门控注册；
 *   生产构建不注册 handler，任何发送都是无操作）；
 * - 不暴露任何 Electron API、文件系统或 shell 能力。
 */
export function registerDevDebugHandlers(callbacks: DevDebugCallbacks): void {
  ipcMain.on(DEV_DEBUG_COMMAND_CHANNEL, (_event, payload: unknown) => {
    const command = parseDevDebugCommand(payload)
    if (command === null) {
      return
    }
    const targets: Record<Exclude<typeof command, 'resume-auto'>, DebugBehaviorTarget> = {
      idle: 'idle',
      walk: 'walking',
      run: 'running',
      sit: 'sitting',
      lie: 'lying'
    }
    if (command === 'resume-auto') {
      callbacks.resumeAutoBehavior()
      return
    }
    callbacks.forceBehavior(targets[command])
  })
  ipcMain.handle(DEV_DEBUG_GET_STATE_CHANNEL, (): DevDebugState => ({
    debugControlled: callbacks.isDebugControlled()
  }))
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
 *
 * onDragStart / onDragEnd 在拖动开始/结束时通知行为运行时，
 * 使自动移动在拖动期间立即停止、结束后从真实位置恢复。
 */
export function registerPetIpcHandlers(
  getPetWindow: () => BrowserWindow | null,
  callbacks: DragCallbacks = {},
  visualStateHandlers: VisualStateHandlers = {}
): void {
  let dragState: DragState | null = null

  // 视觉状态查询：renderer 订阅时获取当前状态，不依赖监听到第一条广播。
  // 载荷经 isPetVisualState 校验后才返回，null 表示运行时尚未启动。
  if (visualStateHandlers.getVisualState) {
    const getVisualState = visualStateHandlers.getVisualState
    ipcMain.handle(GET_VISUAL_STATE_CHANNEL, (): PetVisualState | null => {
      const state = getVisualState()
      return isPetVisualState(state) ? state : null
    })
  }

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
    callbacks.onDragStart?.()
  })

  ipcMain.on(DRAG_END_CHANNEL, () => {
    stopDrag()
    callbacks.onDragEnd?.()
  })
}
