import { contextBridge, ipcRenderer } from 'electron'
import {
  createVisualStateSubscription,
  type PetVisualState,
  type VisualStateIpc
} from '../shared/pet-visual-state'

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
  subscribeVisualState: (callback: (state: PetVisualState) => void): (() => void) =>
    createVisualStateSubscription(ipc, VISUAL_STATE_CHANNEL, GET_VISUAL_STATE_CHANNEL, callback)
}

contextBridge.exposeInMainWorld('yaoyao', yaoyaoAPI)
