import type { PetVisualState } from '../shared/pet-visual-state'
import type { PetSettings, PetSettingsUpdate } from '../shared/pet-settings'

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的最小只读/受限 API */
    yaoyao: {
      /** 当前 Electron 版本号（只读快照） */
      electronVersion: string
      /** 通知主进程拖动开始（跨过拖动阈值后调用一次） */
      dragStart: () => void
      /** 通知主进程拖动结束（松手/取消时调用一次） */
      dragEnd: () => void
      /**
       * 请求打开桌宠右键菜单（Task 12A）：无载荷窄通道信号，
       * 菜单内容完全由主进程权威状态决定。
       */
      showContextMenu: () => void
      /**
       * 订阅视觉状态：立即回调一次当前状态，之后每次变化回调一次。
       * 返回取消订阅函数（幂等）；载荷已通过结构校验。
       */
      subscribeVisualState: (callback: (state: PetVisualState) => void) => () => void
      /**
       * Task 12C：订阅受控交互取消（拖动中开启鼠标穿透时主进程发送，
       * 无载荷）。返回幂等取消订阅函数。
       */
      onInteractionCancel: (callback: () => void) => () => void
      /**
       * Task 12B 用户设置：查询当前设置（主进程返回前已结构校验）。
       */
      getSettings: () => Promise<unknown>
      /**
       * Task 12B 用户设置：发送白名单更新载荷；主进程全量校验，
       * 非法载荷整体拒绝。
       */
      updateSettings: (update: PetSettingsUpdate) => void
      /**
       * Task 12B 用户设置：订阅设置变化广播（载荷经结构校验）。
       * 返回幂等取消订阅函数。
       */
      onSettingsChanged: (callback: (settings: PetSettings) => void) => () => void
      /**
       * Task 12B 用户设置：订阅持久化失败通知（无载荷）。
       * 返回幂等取消订阅函数。
       */
      onSettingsSaveError: (callback: () => void) => () => void
      /**
       * Task 12B-UI：订阅持久化成功通知（无载荷，真实落盘成功后广播）。
       * 返回幂等取消订阅函数。
       */
      onSettingsSaved: (callback: () => void) => () => void
      /**
       * 开发调试专用（Task 11H-C）：发送调试命令（白名单字符串载荷，
       * 主进程侧校验；生产构建不注册 handler，调用为无操作）。
       */
      devDebugCommand: (command: string) => void
      /**
       * 开发调试专用（Task 11H-C）：查询调试控制状态
       * { debugControlled: boolean }；生产环境无 handler 时 reject。
       */
      getDevDebugState: () => Promise<unknown>
      /**
       * 开发调试专用（Task 11J）：订阅交互动画预览（纯 renderer 视觉；
       * 主进程仅开发构建转发，生产环境无发送）。返回幂等的取消订阅函数。
       */
      onDevInteractionPreview: (
        callback: (kind: 'click' | 'pickup' | 'release') => void
      ) => () => void
      /**
       * Task 12E 登录自启动：查询系统实际登录项状态（实时读取无缓存；
       * 开发环境 supported=false）。返回幂等取消订阅函数。
       */
      getLoginItemStatus: () => Promise<unknown>
      /**
       * Task 12E 登录自启动：请求注册/注销（仅布尔载荷，系统写入由
       * 主进程执行且开发环境拒绝）。
       */
      updateLoginItem: (enabled: boolean) => void
      /**
       * Task 12E 登录自启动：订阅操作成功后的状态广播。
       * 返回幂等取消订阅函数。
       */
      onLoginItemChanged: (callback: (enabled: boolean) => void) => () => void
      /**
       * Task 12E 登录自启动：订阅操作失败反馈（含面向用户的原因文案）。
       * 返回幂等取消订阅函数。
       */
      onLoginItemError: (callback: (reason: string) => void) => () => void
    }
  }
}

export {}
