/**
 * 幺幺桌宠共享常量（main 与 renderer 共用，纯逻辑、可被 Vitest 直接测试）。
 */
export const PET_WINDOW_WIDTH = 320
export const PET_WINDOW_HEIGHT = 420
export const PET_WINDOW_MIN_WIDTH = 240
export const PET_WINDOW_MIN_HEIGHT = 320
export const PET_WINDOW_TITLE = '幺幺桌宠'

export const PET_CANVAS_WIDTH = 240
export const PET_CANVAS_HEIGHT = 240
export const PET_CANVAS_BACKGROUND = '#f6f1e7'
export const PET_PLACEHOLDER_RADIUS = 64
export const PET_PLACEHOLDER_COLOR = 0xe8b04b

export const PLACEHOLDER_NOTE = '占位界面：透明窗口与动画将在后续任务实现'

/** 校验占位圆形是否始终在画布范围内。 */
export function isPlaceholderRadiusWithinCanvas(): boolean {
  return PET_PLACEHOLDER_RADIUS * 2 <= Math.min(PET_CANVAS_WIDTH, PET_CANVAS_HEIGHT)
}
