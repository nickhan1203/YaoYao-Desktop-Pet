import { describe, expect, it } from 'vitest'
import {
  PET_CANVAS_HEIGHT,
  PET_CANVAS_WIDTH,
  PET_PLACEHOLDER_RADIUS,
  PET_WINDOW_HEIGHT,
  PET_WINDOW_MIN_HEIGHT,
  PET_WINDOW_MIN_WIDTH,
  PET_WINDOW_TITLE,
  PET_WINDOW_WIDTH,
  PLACEHOLDER_NOTE,
  isPlaceholderRadiusWithinCanvas
} from '../src/shared/pet-config'

describe('pet-config 共享常量', () => {
  it('窗口尺寸为正数，且最小尺寸不超过默认尺寸', () => {
    expect(PET_WINDOW_WIDTH).toBeGreaterThan(0)
    expect(PET_WINDOW_HEIGHT).toBeGreaterThan(0)
    expect(PET_WINDOW_MIN_WIDTH).toBeGreaterThan(0)
    expect(PET_WINDOW_MIN_HEIGHT).toBeGreaterThan(0)
    expect(PET_WINDOW_MIN_WIDTH).toBeLessThanOrEqual(PET_WINDOW_WIDTH)
    expect(PET_WINDOW_MIN_HEIGHT).toBeLessThanOrEqual(PET_WINDOW_HEIGHT)
  })

  it('标题与占位说明为非空字符串', () => {
    expect(PET_WINDOW_TITLE.length).toBeGreaterThan(0)
    expect(PLACEHOLDER_NOTE.length).toBeGreaterThan(0)
  })

  it('画布尺寸为正数，且不超过窗口默认尺寸', () => {
    expect(PET_CANVAS_WIDTH).toBeGreaterThan(0)
    expect(PET_CANVAS_HEIGHT).toBeGreaterThan(0)
    expect(PET_CANVAS_WIDTH).toBeLessThanOrEqual(PET_WINDOW_WIDTH)
    expect(PET_CANVAS_HEIGHT).toBeLessThanOrEqual(PET_WINDOW_HEIGHT)
  })

  it('占位圆形半径在画布范围内', () => {
    expect(PET_PLACEHOLDER_RADIUS).toBeGreaterThan(0)
    expect(isPlaceholderRadiusWithinCanvas()).toBe(true)
  })
})
