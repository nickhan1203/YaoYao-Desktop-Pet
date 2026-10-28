/**
 * 拖动手势跟踪器（纯逻辑，无 DOM 依赖，可被 Vitest 直接测试）。
 *
 * 职责：
 * - 区分单击与拖动：指针按下后位移超过阈值才判定为拖动；
 * - 支持显式取消（pointercancel / window blur），不会卡在拖动状态。
 *
 * 坐标说明：接受任意稳定坐标系（推荐指针事件的屏幕坐标），
 * 只用于位移阈值判定，不依赖具体坐标原点。
 */
export const DRAG_THRESHOLD_PX = 4

export interface DragEndResult {
  /** 本次按下是否构成了拖动（超过阈值） */
  wasDrag: boolean
  /** 本次按下是否为普通单击（未超过阈值） */
  isClick: boolean
}

export class DragTracker {
  private startX = 0
  private startY = 0
  private active = false
  private dragging = false

  pointerDown(x: number, y: number): void {
    this.active = true
    this.dragging = false
    this.startX = x
    this.startY = y
  }

  pointerMove(x: number, y: number): void {
    if (!this.active || this.dragging) {
      return
    }
    const distance = Math.hypot(x - this.startX, y - this.startY)
    if (distance >= DRAG_THRESHOLD_PX) {
      this.dragging = true
    }
  }

  pointerUp(): DragEndResult {
    const result: DragEndResult = {
      wasDrag: this.dragging,
      isClick: this.active && !this.dragging
    }
    this.reset()
    return result
  }

  /** 异常取消（pointercancel / blur）：复位状态，不会卡在拖动状态。 */
  cancel(): void {
    this.reset()
  }

  get isDragging(): boolean {
    return this.dragging
  }

  private reset(): void {
    this.active = false
    this.dragging = false
  }
}
