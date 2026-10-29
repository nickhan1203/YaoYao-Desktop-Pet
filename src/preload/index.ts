import { contextBridge, ipcRenderer } from 'electron'
import {
  createVisualStateSubscription,
  type PetVisualState,
  type VisualStateIpc
} from '../shared/pet-visual-state'
import { INTERACTION_CANCEL_CHANNEL } from '../shared/interaction-cancel'
import {
  SETTINGS_CHANGED_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SAVE_ERROR_CHANNEL,
  SETTINGS_SAVED_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  isPetSettings,
  type PetSettings,
  type PetSettingsUpdate
} from '../shared/pet-settings'
import {
  DEV_DEBUG_COMMAND_CHANNEL,
  DEV_DEBUG_GET_STATE_CHANNEL,
  DEV_INTERACTION_PREVIEW_CHANNEL,
  isDevInteractionPreviewKind
} from '../shared/dev-debug'

/** 视觉状态广播通道（与主进程 index.ts 保持一致） */
const VISUAL_STATE_CHANNEL = 'pet:visual-state-changed'
/** 视觉状态查询通道（订阅时获取当前状态） */
const GET_VISUAL_STATE_CHANNEL = 'pet:get-visual-state'

/**
 * 暴露给 renderer 的最小 API。
 * 仅通过 contextBridge 暴露受限能力：
 * - electronVersion：只读快照；
 * - dragStart / dragEnd：向固定窄通道发送拖动开始/结束信号（无载荷），
 *   拖动期间的窗口跟随由主进程完成，renderer 不发送高频消息；
 * - subscribeVisualState：订阅视觉状态（查询当前状态 + 监听变化，
 *   竞态与取消语义见 shared/pet-visual-state.ts），返回幂等的取消订阅函数；
 *   载荷经结构校验，非法载荷被丢弃；
 *   不暴露 ipcRenderer 本体、任意通道、Node.js 或文件系统能力。
 */
const ipc: VisualStateIpc = {
  on: (channel, listener): void => {
    ipcRenderer.on(channel, listener)
  },
  removeListener: (channel, listener): void => {
    ipcRenderer.removeListener(channel, listener)
  },
  invoke: (channel): Promise<unknown> => ipcRenderer.invoke(channel)
}

const yaoyaoAPI = {
  electronVersion: process.versions.electron,
  dragStart: (): void => {
    ipcRenderer.send('pet:drag-start')
  },
  dragEnd: (): void => {
    ipcRenderer.send('pet:drag-end')
  },
  /**
   * 请求打开桌宠右键菜单（Task 12A）：固定窄通道、无载荷——renderer
   * 只表达"打开菜单"意图，菜单内容由主进程权威状态构建。
   */
  showContextMenu: (): void => {
    ipcRenderer.send('pet:show-context-menu')
  },
  subscribeVisualState: (callback: (state: PetVisualState) => void): (() => void) =>
    createVisualStateSubscription(ipc, VISUAL_STATE_CHANNEL, GET_VISUAL_STATE_CHANNEL, callback),
  /**
   * Task 12C：订阅受控交互取消（主进程在拖动中开启鼠标穿透时发送，
   * 无载荷）。renderer 复用 pointercancel 同一取消语义。返回幂等取消
   * 订阅函数。
   */
  onInteractionCancel: (callback: () => void): (() => void) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on(INTERACTION_CANCEL_CHANNEL, listener)
    return (): void => {
      ipcRenderer.removeListener(INTERACTION_CANCEL_CHANNEL, listener)
    }
  },
  /**
   * Task 12B 用户设置：查询当前设置（invoke，主进程返回前已校验）。
   */
  getSettings: (): Promise<unknown> => ipcRenderer.invoke(SETTINGS_GET_CHANNEL),
  /**
   * Task 12B 用户设置：发送白名单更新载荷（send）。主进程对载荷做
   * 全量校验（字段/范围/原型污染防御），非法整体拒绝——renderer 不
   * 能传递任意字段或危险属性名。
   */
  updateSettings: (update: PetSettingsUpdate): void => {
    ipcRenderer.send(SETTINGS_UPDATE_CHANNEL, update)
  },
  /**
   * Task 12B 用户设置：订阅设置变化（主进程应用后单向广播）。
   * 载荷经 isPetSettings 校验，非法载荷丢弃；返回幂等取消订阅函数。
   */
  onSettingsChanged: (callback: (settings: PetSettings) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (isPetSettings(payload)) {
        callback(payload)
      }
    }
    ipcRenderer.on(SETTINGS_CHANGED_CHANNEL, listener)
    return (): void => {
      ipcRenderer.removeListener(SETTINGS_CHANGED_CHANNEL, listener)
    }
  },
  /**
   * Task 12B 用户设置：订阅持久化失败通知（无载荷）。返回幂等取消
   * 订阅函数。
   */
  onSettingsSaveError: (callback: () => void): (() => void) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on(SETTINGS_SAVE_ERROR_CHANNEL, listener)
    return (): void => {
      ipcRenderer.removeListener(SETTINGS_SAVE_ERROR_CHANNEL, listener)
    }
  },
  /**
   * Task 12B-UI：订阅持久化成功通知（无载荷，仅在真实落盘成功后由
   * 主进程广播）。返回幂等取消订阅函数。
   */
  onSettingsSaved: (callback: () => void): (() => void) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on(SETTINGS_SAVED_CHANNEL, listener)
    return (): void => {
      ipcRenderer.removeListener(SETTINGS_SAVED_CHANNEL, listener)
    }
  },
  /**
   * 开发调试专用（Task 11H-C）：向固定窄通道发送调试命令（载荷为
   * 白名单字符串，主进程侧校验）。安全边界：主进程仅在开发构建
   *（!app.isPackaged）注册对应 handler——生产环境下发送到未注册通道
   * 为无操作；renderer 侧调用点位于开发面板（import.meta.env.DEV 门控
   * 动态加载），生产构建整段剔除。
   */
  devDebugCommand: (command: string): void => {
    ipcRenderer.send(DEV_DEBUG_COMMAND_CHANNEL, command)
  },
  /** 开发调试专用（Task 11H-C）：查询调试控制状态；生产环境无 handler 时 reject */
  getDevDebugState: (): Promise<unknown> => ipcRenderer.invoke(DEV_DEBUG_GET_STATE_CHANNEL),
  /**
   * 开发调试专用（Task 11J）：订阅交互动画预览（主进程转发面板预览
   * 按钮，纯 renderer 视觉）。载荷经白名单校验，非法载荷丢弃；
   * 生产环境主进程不发送（dev handler 不注册），订阅为空转。
   * 返回幂等的取消订阅函数。
   */
  onDevInteractionPreview: (
    callback: (kind: 'click' | 'pickup' | 'release') => void
  ): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (isDevInteractionPreviewKind(payload)) {
        callback(payload)
      }
    }
    ipcRenderer.on(DEV_INTERACTION_PREVIEW_CHANNEL, listener)
    return (): void => {
      ipcRenderer.removeListener(DEV_INTERACTION_PREVIEW_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('yaoyao', yaoyaoAPI)
