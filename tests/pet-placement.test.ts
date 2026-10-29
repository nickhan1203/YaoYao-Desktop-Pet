import { describe, expect, it } from 'vitest'
import { clampPlacementToWorkArea, computePetPlacement } from '../src/shared/pet-placement'

const WINDOW_W = 240
const WINDOW_H = 240

describe('computePetPlacement（右下角停靠，Task 12A）', () => {
  it('主显示器常规工作区：停靠右下角并留出边距', () => {
    // 1920×1080 + margin 80 → x = 1920-240-80 = 1600, y = 1080-240-80 = 760
    expect(
      computePetPlacement({ x: 0, y: 0, width: 1920, height: 1080 }, WINDOW_W, WINDOW_H, 80)
    ).toEqual({ x: 1600, y: 760 })
  })

  it('负坐标显示器（左侧扩展屏）：结果相对 workArea 原点，不出现正坐标漂移', () => {
    const workArea = { x: -1920, y: 0, width: 1920, height: 1040 }
    const placement = computePetPlacement(workArea, WINDOW_W, WINDOW_H, 40)
    expect(placement.x).toBe(-1920 + 1920 - WINDOW_W - 40)
    expect(placement.y).toBe(1040 - WINDOW_H - 40)
    expect(placement.x).toBeLessThan(0)
  })

  it('工作区小于窗口（退化）：钳制到工作区原点，不越界', () => {
    expect(
      computePetPlacement({ x: 100, y: 100, width: 200, height: 200 }, WINDOW_W, WINDOW_H, 80)
    ).toEqual({ x: 100, y: 100 })
  })
})

describe('clampPlacementToWorkArea（显示时边界修正，Task 12A）', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it('界内位置保持不变（显示幺幺保持原位置）', () => {
    expect(clampPlacementToWorkArea({ x: 500, y: 300 }, workArea, WINDOW_W, WINDOW_H)).toEqual({
      x: 500,
      y: 300
    })
  })

  it('右侧越界收敛到右边界内', () => {
    expect(clampPlacementToWorkArea({ x: 5000, y: 300 }, workArea, WINDOW_W, WINDOW_H)).toEqual({
      x: 1920 - WINDOW_W,
      y: 300
    })
  })

  it('下方/上方越界收敛到上下边界内', () => {
    expect(clampPlacementToWorkArea({ x: 100, y: 2000 }, workArea, WINDOW_W, WINDOW_H)).toEqual({
      x: 100,
      y: 1080 - WINDOW_H
    })
    expect(clampPlacementToWorkArea({ x: 100, y: -500 }, workArea, WINDOW_W, WINDOW_H)).toEqual({
      x: 100,
      y: 0
    })
  })

  it('显示器移除后原坐标落在新工作区外：收敛回新工作区（回退安全）', () => {
    // 原显示器 (-1920) 被移除，主工作区为正坐标区域
    expect(clampPlacementToWorkArea({ x: -1800, y: 200 }, workArea, WINDOW_W, WINDOW_H)).toEqual({
      x: 0,
      y: 200
    })
  })

  it('负坐标工作区同样正确钳制（越出右侧收敛到右边界内）', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    // maxX = -1920 + (1920 - 240) = -240
    expect(clampPlacementToWorkArea({ x: 500, y: 200 }, left, WINDOW_W, WINDOW_H)).toEqual({
      x: -240,
      y: 200
    })
    // 左侧越出收敛到左边界
    expect(clampPlacementToWorkArea({ x: -5000, y: 200 }, left, WINDOW_W, WINDOW_H)).toEqual({
      x: -1920,
      y: 200
    })
  })
})
