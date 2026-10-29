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
       * 开发调试专用（Task 11H-C）：发送调试命令（白名单字符串载荷，
       * 主进程侧校验；生产构建不注册 handler，调用为无操作）。
       */
      devDebugCommand: (command: string) => void
      /**
       * 开发调试专用（Task 11H-C）：查询调试控制状态
       * { debugControlled: boolean }；生产环境无 handler 时 reject。
       */
      getDevDebugState: () => Promise<unknown>
    }
  }
}

export {}
