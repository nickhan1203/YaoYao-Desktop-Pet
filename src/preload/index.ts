import { contextBridge, ipcRenderer } from 'electron'

/**
 * 暴露给 renderer 的最小 API。
 * 仅通过 contextBridge 暴露受限能力：
 * - electronVersion：只读快照；
 * - dragStart / dragEnd：向固定窄通道发送拖动开始/结束信号（无载荷），
 *   拖动期间的窗口跟随由主进程完成，renderer 不发送高频消息；
 *   不暴露 ipcRenderer 本身、任意通道、Node.js 或文件系统能力。
 */
const yaoyaoAPI = {
  electronVersion: process.versions.electron,
  dragStart: (): void => {
    ipcRenderer.send('pet:drag-start')
  },
  dragEnd: (): void => {
    ipcRenderer.send('pet:drag-end')
  }
}

contextBridge.exposeInMainWorld('yaoyao', yaoyaoAPI)
