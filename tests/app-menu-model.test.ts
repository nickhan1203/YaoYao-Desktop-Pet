import { describe, expect, it } from 'vitest'
import { buildAppMenuItems } from '../src/shared/app-menu-model'

/** Task 12C：默认窗口标志状态（与 DEFAULT_PET_SETTINGS 一致） */
const baseState = { paused: false, hidden: false, alwaysOnTop: false, mousePassthrough: false }

describe('buildAppMenuItems（Task 12A 菜单状态同步）', () => {
  it('活动中：显示"暂停活动"与"隐藏幺幺"（含设置入口，Task 12B；置顶/穿透默认未勾选，Task 12C）', () => {
    expect(buildAppMenuItems(baseState)).toEqual([
      { command: 'toggle-pause', label: '暂停活动' },
      { command: 'toggle-visibility', label: '隐藏幺幺' },
      { command: 'toggle-always-on-top', label: '始终置顶', checked: false },
      { command: 'toggle-mouse-passthrough', label: '鼠标穿透', checked: false },
      { command: 'reset-position', label: '重置位置' },
      { command: 'open-settings', label: '设置...' },
      { command: 'quit-application', label: '退出应用' }
    ])
  })

  it('已暂停：显示"继续活动"', () => {
    const items = buildAppMenuItems({ ...baseState, paused: true })
    expect(items[0]).toEqual({ command: 'toggle-pause', label: '继续活动' })
    expect(items[1]).toEqual({ command: 'toggle-visibility', label: '隐藏幺幺' })
  })

  it('已隐藏：显示"显示幺幺"', () => {
    const items = buildAppMenuItems({ ...baseState, hidden: true })
    expect(items[1]).toEqual({ command: 'toggle-visibility', label: '显示幺幺' })
    expect(items[0]).toEqual({ command: 'toggle-pause', label: '暂停活动' })
  })

  it('隐藏且暂停：两个状态标签同时正确（不互相矛盾）', () => {
    expect(buildAppMenuItems({ ...baseState, paused: true, hidden: true })).toEqual([
      { command: 'toggle-pause', label: '继续活动' },
      { command: 'toggle-visibility', label: '显示幺幺' },
      { command: 'toggle-always-on-top', label: '始终置顶', checked: false },
      { command: 'toggle-mouse-passthrough', label: '鼠标穿透', checked: false },
      { command: 'reset-position', label: '重置位置' },
      { command: 'open-settings', label: '设置...' },
      { command: 'quit-application', label: '退出应用' }
    ])
  })

  it('同一状态推导结果确定（托盘与右键菜单共享同一输入必然一致）', () => {
    const state = { paused: true, hidden: false, alwaysOnTop: true, mousePassthrough: false }
    expect(buildAppMenuItems(state)).toEqual(buildAppMenuItems({ ...state }))
  })
})

describe('buildAppMenuItems（Task 12C 勾选型菜单项）', () => {
  it('置顶开启：置顶项勾选，穿透不受影响', () => {
    const items = buildAppMenuItems({ ...baseState, alwaysOnTop: true })
    expect(items[2]).toEqual({ command: 'toggle-always-on-top', label: '始终置顶', checked: true })
    expect(items[3]).toEqual({
      command: 'toggle-mouse-passthrough',
      label: '鼠标穿透',
      checked: false
    })
  })

  it('穿透开启：穿透项勾选（托盘保留关闭入口的最小依据）', () => {
    const items = buildAppMenuItems({ ...baseState, mousePassthrough: true })
    expect(items[3]).toEqual({
      command: 'toggle-mouse-passthrough',
      label: '鼠标穿透',
      checked: true
    })
    expect(items[2]).toEqual({ command: 'toggle-always-on-top', label: '始终置顶', checked: false })
  })

  it('置顶与穿透同时开启：两项均勾选且顺序固定（暂停→显隐→置顶→穿透→重置→设置→退出）', () => {
    const items = buildAppMenuItems({ ...baseState, alwaysOnTop: true, mousePassthrough: true })
    expect(items.map((item) => item.command)).toEqual([
      'toggle-pause',
      'toggle-visibility',
      'toggle-always-on-top',
      'toggle-mouse-passthrough',
      'reset-position',
      'open-settings',
      'quit-application'
    ])
    expect(items[2].checked).toBe(true)
    expect(items[3].checked).toBe(true)
  })

  it('穿透开启期间托盘菜单仍完整输出（含穿透关闭项与退出项）', () => {
    const items = buildAppMenuItems({ ...baseState, mousePassthrough: true })
    const commands = items.map((item) => item.command)
    expect(commands).toContain('toggle-mouse-passthrough')
    expect(commands).toContain('quit-application')
    expect(commands).toContain('open-settings')
  })
})
