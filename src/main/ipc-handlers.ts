import { ipcMain, screen, type BrowserWindow } from 'electron'
import { clampWindowToDisplays, type Rect } from './display-clamp'
import { isPetVisualState, type PetVisualState } from '../shared/pet-visual-state'
import {
  SETTINGS_GET_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  isPetSettings,
  type PetSettings
} from '../shared/pet-settings'
import {
  DEV_DEBUG_COMMAND_CHANNEL,
  DEV_DEBUG_GET_STATE_CHANNEL,
  parseDevDebugCommand,
  type DebugBehaviorTarget,
  type DevDebugCommand,
  type DevDebugState,
  type DevInteractionPreviewKind
} from '../shared/dev-debug'

const DRAG_START_CHANNEL = 'pet:drag-start'
const DRAG_END_CHANNEL = 'pet:drag-end'
/** 视觉状态查询通道：renderer 订阅时获取当前状态（一次性 invoke） */
const GET_VISUAL_STATE_CHANNEL = 'pet:get-visual-state'
/** 右键菜单请求通道（Task 12A）：renderer 仅发送无载荷的"打开菜单"信号 */
const SHOW_CONTEXT_MENU_CHANNEL = 'pet:show-context-menu'

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
 * Task 11J：previewInteraction 为纯 renderer 交互动画预览转发
 *（不触发行为状态机、不伪造 dragging）。
 */
export interface DevDebugCallbacks {
  /** 强制目标行为（进入调试控制模式，自动决策挂起）；facing 仅对 walking 生效（Task 11I） */
  forceBehavior: (target: DebugBehaviorTarget, facing?: 'left' | 'right') => void
  /** 释放调试控制，恢复自动决策 */
  resumeAutoBehavior: () => void
  /** 当前是否处于调试控制模式 */
  isDebugControlled: () => boolean
  /** 交互动画预览（主进程向桌宠 renderer 转发，Task 11J） */
  previewInteraction: (kind: DevInteractionPreviewKind) => void
  /** 打开设置窗口（Task 12B-UI 开发工具，供开发调试与自动化验收） */
  openSettings: () => void
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
    const targets: Partial<Record<Exclude<DevDebugCommand, 'resume-auto'>, DebugBehaviorTarget>> = {
      idle: 'idle',
      'walk-left': 'walking',
      'walk-right': 'walking',
      run: 'running',
      sit: 'sitting',
      lie: 'lying'
    }
    // Task 11I：方向化行走命令映射显式朝向（面板左/右向行走预览）。
    const facings: Partial<Record<DevDebugCommand, 'left' | 'right'>> = {
      'walk-left': 'left',
      'walk-right': 'right'
    }
    // Task 11J：交互预览命令映射（纯 renderer 视觉，不触发行为状态机）。
    const previews: Partial<Record<DevDebugCommand, DevInteractionPreviewKind>> = {
      'preview-click': 'click',
      'preview-pickup': 'pickup',
      'preview-release': 'release'
    }
    if (command === 'resume-auto') {
      callbacks.resumeAutoBehavior()
      return
    }
    // Task 12B-UI：打开设置窗口（开发工具命令，不触碰行为状态机）。
    if (command === 'open-settings') {
      callbacks.openSettings()
      return
    }
    const preview = previews[command]
    if (preview !== undefined) {
      callbacks.previewInteraction(preview)
      return
    }
    const target = targets[command]
    if (target !== undefined) {
      callbacks.forceBehavior(target, facings[command])
    }
  })
  ipcMain.handle(DEV_DEBUG_GET_STATE_CHANNEL, (): DevDebugState => ({
    debugControlled: callbacks.isDebugControlled()
  }))
}

/**
 * 注册右键菜单请求 handler（Task 12A）。
 *
 * 最小权限说明：固定窄通道、无载荷校验（renderer 只能表达"打开菜单"
 * 这一意图）；菜单内容与位置完全由主进程权威状态与光标位置决定，
 * renderer 不得传递菜单模板或任何 Electron 参数。
 */
export function registerContextMenuHandler(showContextMenu: () => void): void {
  ipcMain.on(SHOW_CONTEXT_MENU_CHANNEL, () => {
    showContextMenu()
  })
}

/**
 * 注册设置 IPC handler（Task 12B）。
 *
 * 最小权限说明：
 * - GET（invoke）：返回固定结构 PetSettings（返回前经 isPetSettings
 *   结构校验，非法值返回 null）；
 * - UPDATE（send）：载荷为任意未知输入，交由控制器经
 *   parsePetSettingsUpdate 白名单校验（字段级 + 范围 + 原型污染防御），
 *   非法整体拒绝（不部分应用、不回执）；
 * - 广播与失败通知由主进程主动发送（renderer 无法触发）；
 * - 不暴露文件路径、任意通道或 Electron API。
 */
export interface SettingsHandlers {
  getSettings: () => PetSettings
  updateSettings: (payload: unknown) => PetSettings | null
}

export function registerSettingsHandlers(handlers: SettingsHandlers): void {
  ipcMain.handle(SETTINGS_GET_CHANNEL, (): PetSettings | null => {
    const settings = handlers.getSettings()
    return isPetSettings(settings) ? settings : null
  })
  ipcMain.on(SETTINGS_UPDATE_CHANNEL, (_event, payload: unknown) => {
    handlers.updateSettings(payload)
  })
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
