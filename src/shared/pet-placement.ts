/**
 * 桌宠窗口位置计算（纯逻辑，无 Electron 依赖，可被 Vitest 直接测试）。
 *
 * Task 12A：把"窗口初始位置"与"重置位置"统一到同一套纯函数：
 * - computePetPlacement：在给定工作区内计算右下角停靠位置；
 * - clampPlacementToWorkArea：把任意位置钳制回工作区内
 *   （显示幺幺时的边界修正、重置位置的安全兜底共用）。
 *
 * 坐标语义与 Electron screen 一致：workArea.x/y 可为负（多显示器布局），
 * 全部使用 CSS 像素整数（Electron setPosition 只接受整数坐标）。
 */

/** 与 movement-controller 的 MovementBounds 同构的工作区矩形 */
export interface WorkAreaRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 在工作区内计算右下角停靠位置（预留 margin）。
 * 工作区放不下窗口（退化显示器）时钳制到工作区原点，不越界。
 */
export function computePetPlacement(
  workArea: WorkAreaRect,
  windowWidth: number,
  windowHeight: number,
  margin: number
): { x: number; y: number } {
  return {
    x: workArea.x + Math.max(0, workArea.width - windowWidth - margin),
    y: workArea.y + Math.max(0, workArea.height - windowHeight - margin)
  }
}

/**
 * 把窗口位置钳制回工作区内（允许完整容纳窗口时对齐右/下边界；
 * 工作区小于窗口时对齐左/上边界原点）。
 * 用于显示幺幺时的边界修正：原位置超出当前可用工作区域时收敛回界内。
 */
export function clampPlacementToWorkArea(
  position: { x: number; y: number },
  workArea: WorkAreaRect,
  windowWidth: number,
  windowHeight: number
): { x: number; y: number } {
  const maxX = workArea.x + Math.max(0, workArea.width - windowWidth)
  const maxY = workArea.y + Math.max(0, workArea.height - windowHeight)
  return {
    x: Math.min(Math.max(position.x, workArea.x), maxX),
    y: Math.min(Math.max(position.y, workArea.y), maxY)
  }
}
