import type { PetVisualState } from '../shared/pet-visual-state'

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
       * 订阅视觉状态：立即回调一次当前状态，之后每次变化回调一次。
       * 返回取消订阅函数（幂等）；载荷已通过结构校验。
       */
      subscribeVisualState: (callback: (state: PetVisualState) => void) => () => void
      /**
       * 开发预览专用（Task 11F-B）：暂停主进程自动行为（固定窄通道，无载荷）。
       * 生产构建主进程不注册对应 handler，调用为无操作。
       */
      suspendAutoBehaviorForDevPreview: () => void
      /**
       * 开发预览专用（Task 11F-B）：恢复主进程自动行为（固定窄通道，无载荷）。
       * 生产构建主进程不注册对应 handler，调用为无操作。
       */
      resumeAutoBehaviorForDevPreview: () => void
    }
  }
}

export {}
