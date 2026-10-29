import { describe, expect, it } from 'vitest'
import {
  MIN_VISIBLE_PX,
  clampWindowToDisplays,
  matchDisplay,
  type Rect
} from '../src/main/display-clamp'

const PET: Rect = { x: 0, y: 0, width: 240, height: 240 }
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
const SECONDARY: Rect = { x: 1920, y: 0, width: 1920, height: 1080 }
const NEGATIVE: Rect = { x: -1920, y: 0, width: 1920, height: 1040 }

describe('matchDisplay', () => {
  it('选择相交面积最大的显示器', () => {
    const windowRect = { ...PET, x: 1500 }
    expect(matchDisplay(windowRect, [PRIMARY, SECONDARY])).toBe(PRIMARY)
    const crossing = { ...PET, x: 1850 }
    expect(matchDisplay(crossing, [PRIMARY, SECONDARY])).toBe(SECONDARY)
  })

  it('全部无相交时选择中心距离最近的显示器', () => {
    const windowRect = { ...PET, x: 5000, y: 5000 }
    expect(matchDisplay(windowRect, [PRIMARY, SECONDARY])).toBe(SECONDARY)
  })
})

describe('clampWindowToDisplays', () => {
  it('位置在屏幕内时不做修改', () => {
    const proposed = { ...PET, x: 100, y: 100 }
    expect(clampWindowToDisplays(proposed, [PRIMARY])).toEqual(proposed)
  })

  it('拖出右侧边界时至少保留 MIN_VISIBLE_PX 可见', () => {
    const clamped = clampWindowToDisplays({ ...PET, x: 3000, y: 100 }, [PRIMARY])
    expect(clamped.x).toBe(PRIMARY.x + PRIMARY.width - MIN_VISIBLE_PX)
    expect(clamped.y).toBe(100)
  })

  it('拖出左侧边界时窗口右侧至少保留 MIN_VISIBLE_PX 可见', () => {
    const clamped = clampWindowToDisplays({ ...PET, x: -500, y: 100 }, [PRIMARY])
    expect(clamped.x).toBe(PRIMARY.x + MIN_VISIBLE_PX - PET.width)
    expect(clamped.y).toBe(100)
  })

  it('拖出上/下边界时同样约束', () => {
    const bottom = clampWindowToDisplays({ ...PET, x: 100, y: 2000 }, [PRIMARY])
    expect(bottom.y).toBe(PRIMARY.y + PRIMARY.height - MIN_VISIBLE_PX)
    const top = clampWindowToDisplays({ ...PET, x: 100, y: -500 }, [PRIMARY])
    expect(top.y).toBe(PRIMARY.y + MIN_VISIBLE_PX - PET.height)
  })

  it('支持负坐标显示器（左侧副屏）', () => {
    // 拖出副屏左侧边界：窗口右缘保留 MIN_VISIBLE_PX 可见
    const clamped = clampWindowToDisplays({ ...PET, x: -2500, y: 100 }, [NEGATIVE])
    expect(clamped.x).toBe(NEGATIVE.x + MIN_VISIBLE_PX - PET.width)
    expect(clamped.y).toBe(100)
    // 拖出副屏右侧边界：窗口左缘保留 MIN_VISIBLE_PX 可见
    const tooRight = clampWindowToDisplays({ ...PET, x: 100, y: 100 }, [NEGATIVE])
    expect(tooRight.x).toBe(NEGATIVE.x + NEGATIVE.width - MIN_VISIBLE_PX)
  })

  it('多显示器之间拖动不会被拉回主显示器', () => {
    // 窗口大部分已在副屏，应按副屏工作区约束，而不是被强制拉回主屏
    const onSecondary = clampWindowToDisplays({ ...PET, x: 2100, y: 100 }, [PRIMARY, SECONDARY])
    expect(onSecondary.x).toBeGreaterThanOrEqual(SECONDARY.x + MIN_VISIBLE_PX - PET.width)
    expect(onSecondary.x).toBeLessThanOrEqual(SECONDARY.x + SECONDARY.width - MIN_VISIBLE_PX)

    // 仍在主屏范围内时位置保持不变
    const onPrimary = clampWindowToDisplays({ ...PET, x: 500, y: 100 }, [PRIMARY, SECONDARY])
    expect(onPrimary.x).toBe(500)
  })

  it('完全脱离所有屏幕时约束到最近的显示器内（至少部分可见）', () => {
    const clamped = clampWindowToDisplays({ ...PET, x: 10000, y: 10000 }, [PRIMARY, SECONDARY])
    // 最近的副屏（右缘方向）被钳制，右/下各保留 MIN_VISIBLE_PX 可见
    expect(clamped.x).toBe(SECONDARY.x + SECONDARY.width - MIN_VISIBLE_PX)
    expect(clamped.y).toBe(SECONDARY.y + SECONDARY.height - MIN_VISIBLE_PX)
    // 窗口与副屏工作区确实相交
    const intersects =
      clamped.x < SECONDARY.x + SECONDARY.width && clamped.x + PET.width > SECONDARY.x
    expect(intersects).toBe(true)
  })

  it('显示器列表为空时原样返回', () => {
    const proposed = { ...PET, x: -9999, y: -9999 }
    expect(clampWindowToDisplays(proposed, [])).toEqual(proposed)
  })
})
