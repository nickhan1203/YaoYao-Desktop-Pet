import { contextBridge } from 'electron'

/**
 * 暴露给 renderer 的最小只读 API。
 * 仅通过 contextBridge 暴露安全快照数据，不暴露 ipcRenderer、
 * 任意 IPC 通道、Node.js 或文件系统能力。
 */
const yaoyaoAPI = {
  electronVersion: process.versions.electron
}

contextBridge.exposeInMainWorld('yaoyao', yaoyaoAPI)
