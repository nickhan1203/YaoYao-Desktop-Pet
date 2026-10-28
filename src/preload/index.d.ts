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
    }
  }
}

export {}
