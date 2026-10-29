/**
 * 指针意图识别跟踪器（Task 11J，纯逻辑，无 DOM 依赖，可被 Vitest 直接测试）。
 *
 * 在既有 DragTracker（拖动阈值 4px，已验收手感）之上增加鼠标意图识别：
 * - 短点击：按下后未超阈值、未到长按时长即释放 → click；
 * - 长按拎起：按住达到长按时长（候选值 230ms，来自 v4 离线预览参考）
 *   且未超过移动阈值 → lift（鼠标未动也进入拎起，之后移动即拖动）；
 * - 移动拎起：位移 ≥ 拖动阈值（4px）→ 立即 lift（不等长按时长，
 *   保持窗口跟手无延迟）；
 * - 已拎起后的释放 → drop；未拎起的异常取消（pointercancel / 失焦 /
 *   卸载）→ cancel（不发放下事件）。
 *
 * 时间注入：长按判定由调用方以时间戳驱动（tick(now) 或下次事件携带
 * now），不做真实定时器依赖，测试可用注入时钟确定性复现。
 *
 * 坐标说明：接受任意稳定坐标系（推荐指针事件的屏幕坐标），仅用于
 * 位移阈值判定。
 */

import { DRAG_THRESHOLD_PX } from './drag-tracker'

/** 长按判定时长（毫秒）：按住达到该时长未移动即触发拎起 */
export const LONG_PRESS_MS = 230

/** 意图事件（由 hook 层翻译为交互动画与窄 IPC 调用） */
export type PointerIntentEvent = 'click' | 'lift' | 'drop' | 'cancel'

export interface PointerIntentCallbacks {
  /** 短点击（未拖动、未长按即释放） */
  onClick: () => void
  /** 拎起（长按或移动超阈值，一次性触发；重复触发被忽略） */
  onLift: () => void
  /** 释放（仅已拎起后） */
  onDrop: () => void
  /** 异常取消（未拎起：pointercancel / 失焦 / 卸载） */
  onCancel: () => void
}

/** 内部意图状态 */
type IntentState = 'idle' | 'waiting' | 'lifted'

export class PointerIntentTracker {
  private state: IntentState = 'idle'
  private startX = 0
  private startY = 0
  private downAtMs = 0

  constructor(private readonly callbacks: PointerIntentCallbacks) {}

  /** 当前是否处于按下跟踪中（waiting 或 lifted） */
  get isTracking(): boolean {
    return this.state !== 'idle'
  }

  /** 当前是否已触发拎起（hook 层据此决定释放时发 drop 还是 click） */
  get isLifted(): boolean {
    return this.state === 'lifted'
  }

  /**
   * 指针按下：开始意图跟踪。已在跟踪中时重置（最新事件优先，
   * 防御性处理异常的重复 pointerdown）。
   * @param nowMs 按下时刻（注入时钟，单调毫秒）
   */
  pointerDown(x: number, y: number, nowMs: number): void {
    this.state = 'waiting'
    this.startX = x
    this.startY = y
    this.downAtMs = nowMs
  }

  /**
   * 指针移动：位移超过拖动阈值 → 立即拎起（不等长按时长）。
   * 已拎起后继续移动不重复触发。
   */
  pointerMove(x: number, y: number): void {
    if (this.state !== 'waiting') {
      return
    }
    const distance = Math.hypot(x - this.startX, y - this.startY)
    if (distance >= DRAG_THRESHOLD_PX) {
      this.state = 'lifted'
      this.callbacks.onLift()
    }
  }

  /**
   * 时间推进（由 hook 层的计时器驱动，注入时钟毫秒）：
   * 按住达到长按时长且未超移动阈值 → 拎起。
   */
  tick(nowMs: number): void {
    if (this.state !== 'waiting') {
      return
    }
    if (nowMs - this.downAtMs >= LONG_PRESS_MS) {
      this.state = 'lifted'
      this.callbacks.onLift()
    }
  }

  /**
   * 指针释放：waiting → 短点击；lifted → 放下。
   * 未跟踪时（异常释放）为无操作。
   */
  pointerUp(): void {
    if (this.state === 'waiting') {
      this.state = 'idle'
      this.callbacks.onClick()
      return
    }
    if (this.state === 'lifted') {
      this.state = 'idle'
      this.callbacks.onDrop()
    }
  }

  /**
   * 异常取消（pointercancel / 窗口失焦 / 组件卸载）：
   * 已拎起 → 视为释放（onDrop，hook 层补发 dragEnd 保证主进程不卡拖动）；
   * 未拎起 → 静默取消（onCancel 通知清理计时器）。
   */
  cancel(): void {
    if (this.state === 'lifted') {
      this.state = 'idle'
      this.callbacks.onDrop()
      return
    }
    if (this.state === 'waiting') {
      this.state = 'idle'
      this.callbacks.onCancel()
    }
  }
}
