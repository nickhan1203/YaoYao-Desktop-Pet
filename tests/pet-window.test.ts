import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Task 12E-B：窗口构造参数测试（mock Electron BrowserWindow 捕获选项）。
 *
 * Windows 实机发现桌宠窗口在任务栏显示图标，任务栏"关闭窗口"触发
 * 12A close 拦截转隐藏（进程存活、托盘可恢复）——语义本身正确，
 * 根因是桌宠窗口缺少 skipTaskbar。本测试锁定构造级约定：
 * - 桌宠窗口：skipTaskbar=true 且透明/无边框基线不变；
 * - 设置窗口：不启用 skipTaskbar（保持正常任务栏切换）；
 * - activate 重建走同一 createPetWindow 构造，自动保持。
 *
 * 显隐重复调用不触碰 setSkipTaskbar、置顶/穿透切换不触碰任务栏状态
 * 分别由 app-lifecycle-controller（hide/show 端口）与 pet-window-flags
 * （仅 setAlwaysOnTop/setIgnoreMouseEvents 调用集）的既有测试覆盖。
 */

const petWindowOptions: Array<Record<string, unknown>> = []
const settingsWindowOptions: Array<Record<string, unknown>> = []

vi.mock('electron', () => {
  class MockBrowserWindow {
    constructor(options: Record<string, unknown>) {
      // 依据 preload 路径区分两类窗口的构造（pet 为 transparent，settings 无）
      if (options.transparent === true) {
        petWindowOptions.push(options)
      } else {
        settingsWindowOptions.push(options)
      }
    }
    on(): void {
      /* mock：构造参数捕获不需要事件订阅 */
    }
    loadURL(): void {
      /* mock：不加载页面 */
    }
    loadFile(): void {
      /* mock：不加载页面 */
    }
    get webContents(): { setWindowOpenHandler(): void } {
      return {
        setWindowOpenHandler(): void {
          /* mock：不拦截窗口打开 */
        }
      }
    }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getPrimaryDisplay: (): {
        workArea: { x: number; y: number; width: number; height: number }
      } => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 }
      })
    },
    shell: { openExternal: vi.fn() }
  }
})

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

describe('桌宠窗口构造（Task 12E-B：skipTaskbar）', () => {
  beforeEach(() => {
    petWindowOptions.length = 0
    settingsWindowOptions.length = 0
  })

  it('桌宠窗口 skipTaskbar=true（Windows 任务栏不显示桌宠图标）', async () => {
    const { createPetWindow } = await import('../src/main/pet-window')
    createPetWindow()
    expect(petWindowOptions).toHaveLength(1)
    expect(petWindowOptions[0].skipTaskbar).toBe(true)
  })

  it('桌宠窗口透明/无边框/安全基线不变（skipTaskbar 不改变既有外观）', async () => {
    const { createPetWindow } = await import('../src/main/pet-window')
    createPetWindow()
    const options = petWindowOptions[0]
    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.hasShadow).toBe(false)
    expect(options.resizable).toBe(false)
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('窗口重建走同一构造：再次创建仍保持 skipTaskbar=true（activate 路径）', async () => {
    const { createPetWindow } = await import('../src/main/pet-window')
    createPetWindow()
    createPetWindow()
    expect(petWindowOptions).toHaveLength(2)
    expect(petWindowOptions.every((options) => options.skipTaskbar === true)).toBe(true)
  })

  it('设置窗口不启用 skipTaskbar（保持正常任务栏切换能力）', async () => {
    const { createSettingsWindow } = await import('../src/main/settings-window')
    createSettingsWindow()
    expect(settingsWindowOptions).toHaveLength(1)
    expect(settingsWindowOptions[0].skipTaskbar).toBeUndefined()
    // 普通窗口基线：非透明、非无边框
    expect(settingsWindowOptions[0].transparent).toBeUndefined()
    expect(settingsWindowOptions[0].frame).toBeUndefined()
  })
})
