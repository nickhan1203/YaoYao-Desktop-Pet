declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的最小只读 API */
    yaoyao: {
      /** 当前 Electron 版本号（只读快照） */
      electronVersion: string
    }
  }
}

export {}
