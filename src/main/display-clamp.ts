/**
 * 窗口边界约束（纯逻辑，无 Electron 依赖，可被 Vitest 直接测试）。
 *
 * 目标：窗口可以自由移动，但至少保留 MIN_VISIBLE_PX 的可见区域
 * 在与其匹配（相交最多/最近）的显示器工作区内，避免桌宠被完全
 * 拖出屏幕后无法找回。不假设显示器坐标从 (0, 0) 开始，支持负坐标
 * 与多显示器；窗口可以在显示器之间移动，不会被强制拉回主显示器。
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口在单个显示器工作区内至少保留的可见尺寸（CSS px） */
export const MIN_VISIBLE_PX = 40

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function centerDistance(a: Rect, b: Rect): number {
  const ax = a.x + a.width / 2
  const ay = a.y + a.height / 2
  const bx = b.x + b.width / 2
  const by = b.y + b.height / 2
  return Math.hypot(ax - bx, ay - by)
}

/**
 * 选择与窗口匹配的显示器工作区：
 * 相交面积最大者；全部无相交时取中心距离最近者
 * （与 Electron screen.getDisplayMatching 的语义一致）。
 */
export function matchDisplay(windowRect: Rect, workAreas: Rect[]): Rect {
  let best = workAreas[0]
  let bestArea = -1
  for (const workArea of workAreas) {
    const area = intersectionArea(windowRect, workArea)
    if (area > bestArea) {
      bestArea = area
      best = workArea
    }
  }
  if (bestArea > 0) {
    return best
  }
  let nearest = workAreas[0]
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const workArea of workAreas) {
    const distance = centerDistance(windowRect, workArea)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = workArea
    }
  }
  return nearest
}

/**
 * 将提议的窗口位置约束到匹配显示器的工作区内，
 * 保证至少 minVisible 的可见区域。workAreas 为空时原样返回。
 */
export function clampWindowToDisplays(
  proposed: Rect,
  workAreas: Rect[],
  minVisible: number = MIN_VISIBLE_PX
): Rect {
  if (workAreas.length === 0) {
    return proposed
  }
  const workArea = matchDisplay(proposed, workAreas)
  const margin = Math.min(
    minVisible,
    workArea.width,
    workArea.height,
    proposed.width,
    proposed.height
  )
  const minX = workArea.x + margin - proposed.width
  const maxX = workArea.x + workArea.width - margin
  const minY = workArea.y + margin - proposed.height
  const maxY = workArea.y + workArea.height - margin
  return {
    ...proposed,
    x: Math.min(Math.max(proposed.x, minX), maxX),
    y: Math.min(Math.max(proposed.y, minY), maxY)
  }
}
