import { describe, expect, it, vi } from 'vitest'
import {
  AppLifecycleController,
  type LifecycleControllerPorts
} from '../src/main/app-lifecycle-controller'
import type { WorkAreaRect } from '../src/shared/pet-placement'

const WINDOW_W = 240
const WINDOW_H = 240
const MARGIN = 80

/** 主显示器工作区（1920×1080） */
const PRIMARY: WorkAreaRect = { x: 0, y: 0, width: 1920, height: 1080 }

interface FakeRuntimeState {
  paused: boolean
  dragging: boolean
  pauseCalls: number
  resumeCalls: number
  stopCalls: number
  syncCalls: number
}

interface FakeWindowState {
  x: number
  y: number
  visible: boolean
  destroyed: boolean
  hideCalls: number
  showCalls: number
  setPositionCalls: Array<{ x: number; y: number }>
}

/** 可编程假运行时：记录 pause/resume/stop/sync 调用 */
function makeRuntime(
  overrides: Partial<LifecycleControllerPorts['runtime']> = {}
): LifecycleControllerPorts['runtime'] & { state: FakeRuntimeState } {
  const state = {
    paused: false,
    dragging: false,
    pauseCalls: 0,
    resumeCalls: 0,
    stopCalls: 0,
    syncCalls: 0
  }
  const runtime = {
    pause: (): void => {
      state.pauseCalls += 1
      state.paused = true
    },
    resume: (): void => {
      state.resumeCalls += 1
      state.paused = false
    },
    isPaused: (): boolean => state.paused,
    isDragging: (): boolean => state.dragging,
    stop: (): void => {
      state.stopCalls += 1
    },
    syncWindowPosition: (): void => {
      state.syncCalls += 1
    },
    state
  }
  return { ...runtime, ...overrides }
}

/** 可编程假窗口：记录显隐/位置调用 */
function makeWindow(
  overrides: Partial<LifecycleControllerPorts['window']> = {}
): LifecycleControllerPorts['window'] & { state: FakeWindowState } {
  const state = {
    x: 100,
    y: 100,
    visible: true,
    destroyed: false,
    hideCalls: 0,
    showCalls: 0,
    setPositionCalls: [] as Array<{ x: number; y: number }>
  }
  const win = {
    width: WINDOW_W,
    height: WINDOW_H,
    hide: (): void => {
      state.hideCalls += 1
      state.visible = false
    },
    showInactive: (): void => {
      state.showCalls += 1
      state.visible = true
    },
    isVisible: (): boolean => state.visible,
    isDestroyed: (): boolean => state.destroyed,
    getPosition: (): { x: number; y: number } => ({ x: state.x, y: state.y }),
    setPosition: (x: number, y: number): void => {
      state.x = x
      state.y = y
      state.setPositionCalls.push({ x, y })
    },
    state
  }
  return { ...win, ...overrides }
}

interface FakeDisplaysCalls {
  readonly primaryCalls: number
  readonly nearestCalls: number
}

/** 假显示器：默认单屏；可注入"最近显示器不可用"模拟显示器移除 */
function makeDisplays(
  nearest: WorkAreaRect | null = PRIMARY
): LifecycleControllerPorts['displays'] & {
  calls: FakeDisplaysCalls
} {
  let primaryCalls = 0
  let nearestCalls = 0
  return {
    getNearestWorkArea: (point: { x: number; y: number }): WorkAreaRect | null => {
      void point
      nearestCalls += 1
      return nearest
    },
    getPrimaryWorkArea: (): WorkAreaRect => {
      primaryCalls += 1
      return PRIMARY
    },
    calls: {
      get primaryCalls(): number {
        return primaryCalls
      },
      get nearestCalls(): number {
        return nearestCalls
      }
    }
  }
}

interface Harness {
  controller: AppLifecycleController
  runtime: ReturnType<typeof makeRuntime>
  win: ReturnType<typeof makeWindow>
  displays: ReturnType<typeof makeDisplays>
  quit: ReturnType<typeof vi.fn>
  beforeQuit: ReturnType<typeof vi.fn>
}

function makeHarness(overrides?: {
  runtime?: Partial<LifecycleControllerPorts['runtime']>
  window?: Partial<LifecycleControllerPorts['window']>
  nearest?: WorkAreaRect | null
}): Harness {
  const runtime = makeRuntime(overrides?.runtime)
  const win = makeWindow(overrides?.window)
  const displays = makeDisplays(overrides?.nearest === undefined ? PRIMARY : overrides.nearest)
  const quit = vi.fn()
  const beforeQuit = vi.fn()
  const ports: LifecycleControllerPorts = {
    runtime,
    window: win,
    displays,
    onBeforeQuit: beforeQuit,
    quit,
    positionMargin: MARGIN
  }
  return { controller: new AppLifecycleController(ports), runtime, win, displays, quit, beforeQuit }
}

describe('Task 12A：暂停与继续', () => {
  it('暂停活动：运行时进入 paused（自动位移与决策由运行时冻结）', () => {
    const h = makeHarness()
    h.controller.pauseActivity()
    expect(h.runtime.state.paused).toBe(true)
    expect(h.runtime.state.pauseCalls).toBe(1)
    expect(h.controller.getControlState().paused).toBe(true)
    // 不退出应用、不隐藏窗口
    expect(h.quit).not.toHaveBeenCalled()
    expect(h.win.state.hideCalls).toBe(0)
  })

  it('暂停后继续：恢复原有行为机制（运行时 resume）', () => {
    const h = makeHarness()
    h.controller.pauseActivity()
    h.controller.resumeActivity()
    expect(h.runtime.state.paused).toBe(false)
    expect(h.controller.getControlState().paused).toBe(false)
  })

  it('重复点击暂停/继续幂等（不产生重复 pause/resume）', () => {
    const h = makeHarness()
    h.controller.pauseActivity()
    h.controller.pauseActivity()
    h.controller.pauseActivity()
    expect(h.runtime.state.pauseCalls).toBe(1)
    h.controller.resumeActivity()
    h.controller.resumeActivity()
    expect(h.runtime.state.resumeCalls).toBe(1)
  })

  it('暂停时窗口保持可见、应用不退出', () => {
    const h = makeHarness()
    h.controller.pauseActivity()
    expect(h.win.state.visible).toBe(true)
    expect(h.runtime.state.stopCalls).toBe(0)
  })
})

describe('Task 12A：隐藏与显示', () => {
  it('隐藏后窗口不可见但应用仍运行（不销毁窗口、不退出）', () => {
    const h = makeHarness()
    h.controller.hidePet()
    expect(h.win.state.visible).toBe(false)
    expect(h.win.state.destroyed).toBe(false)
    expect(h.runtime.state.stopCalls).toBe(0)
    expect(h.quit).not.toHaveBeenCalled()
    expect(h.controller.getControlState().hidden).toBe(true)
  })

  it('隐藏期间运行时被暂停（等效节能：计时冻结，无窗口位置更新）', () => {
    const h = makeHarness()
    h.controller.hidePet()
    expect(h.runtime.state.paused).toBe(true)
  })

  it('显示后窗口恢复且不重建（showInactive，不抢占焦点）', () => {
    const h = makeHarness()
    h.controller.hidePet()
    h.controller.showPet()
    expect(h.win.state.visible).toBe(true)
    expect(h.win.state.showCalls).toBe(1)
    expect(h.runtime.state.paused).toBe(false)
  })

  it('隐藏前已暂停的用户状态：显示后仍保持暂停', () => {
    const h = makeHarness()
    h.controller.pauseActivity()
    h.controller.hidePet()
    h.controller.showPet()
    expect(h.runtime.state.paused).toBe(true)
    expect(h.controller.getControlState().paused).toBe(true)
  })

  it('隐藏中用户点击"继续活动"：显示后正常运行（不双重暂停）', () => {
    const h = makeHarness()
    h.controller.hidePet()
    h.controller.resumeActivity()
    h.controller.showPet()
    expect(h.runtime.state.paused).toBe(false)
  })

  it('重复隐藏/显示幂等（无多余调用与状态翻转）', () => {
    const h = makeHarness()
    h.controller.hidePet()
    h.controller.hidePet()
    expect(h.runtime.state.pauseCalls).toBe(1)
    h.controller.showPet()
    h.controller.showPet()
    expect(h.win.state.showCalls).toBe(2)
    expect(h.runtime.state.paused).toBe(false)
    expect(h.runtime.state.resumeCalls).toBe(1)
  })

  it('显示时原位置在界内：保持原位置（无 setPosition）', () => {
    const h = makeHarness()
    h.controller.hidePet()
    h.controller.showPet()
    expect(h.win.state.setPositionCalls).toHaveLength(0)
    expect(h.runtime.state.syncCalls).toBe(0)
  })

  it('显示时原位置超出工作区：边界修正并同步运行时基准', () => {
    // 窗口被外部移动到越界位置后隐藏
    const h = makeHarness()
    h.win.state.x = 5000
    h.win.state.y = 5000
    h.controller.hidePet()
    h.controller.showPet()
    expect(h.win.state.setPositionCalls).toEqual([{ x: 1920 - WINDOW_W, y: 1080 - WINDOW_H }])
    expect(h.runtime.state.syncCalls).toBe(1)
  })
})

describe('Task 12A：重置位置', () => {
  it('重置到当前显示器工作区右下角（遵守 workArea 与边距）', () => {
    const h = makeHarness()
    const result = h.controller.resetPetPosition()
    expect(result).toBe('moved')
    expect(h.win.state.setPositionCalls).toEqual([
      { x: 1920 - WINDOW_W - MARGIN, y: 1080 - WINDOW_H - MARGIN }
    ])
  })

  it('重置位置后同步运行时基准：水平轨道更新为新的 Y（不拉回）', () => {
    const h = makeHarness()
    h.controller.resetPetPosition()
    expect(h.runtime.state.syncCalls).toBe(1)
  })

  it('负坐标扩展屏：相对该显示器 workArea 停靠（不漂移到主屏）', () => {
    const left: WorkAreaRect = { x: -1920, y: 0, width: 1920, height: 1040 }
    const h = makeHarness({ nearest: left })
    h.controller.resetPetPosition()
    expect(h.win.state.setPositionCalls).toEqual([
      { x: -1920 + 1920 - WINDOW_W - MARGIN, y: 1040 - WINDOW_H - MARGIN }
    ])
  })

  it('显示器移除（最近工作区不可用）：安全回退主显示器', () => {
    const h = makeHarness({ nearest: null })
    const result = h.controller.resetPetPosition()
    expect(result).toBe('moved')
    expect(h.displays.calls.primaryCalls).toBe(1)
    expect(h.win.state.setPositionCalls).toEqual([
      { x: 1920 - WINDOW_W - MARGIN, y: 1080 - WINDOW_H - MARGIN }
    ])
  })

  it('dragging 期间重置位置被安全忽略（不与拖动轮询竞争）', () => {
    const h = makeHarness({ runtime: { isDragging: (): boolean => true } })
    const result = h.controller.resetPetPosition()
    expect(result).toBe('ignored-dragging')
    expect(h.win.state.setPositionCalls).toHaveLength(0)
    expect(h.runtime.state.syncCalls).toBe(0)
  })
})

describe('Task 12A：退出应用', () => {
  it('退出：先清理（托盘钩子）再停运行时，最后 quit（不使用 process.exit）', () => {
    const h = makeHarness()
    h.controller.quitApplication()
    expect(h.beforeQuit).toHaveBeenCalledTimes(1)
    expect(h.runtime.state.stopCalls).toBe(1)
    expect(h.quit).toHaveBeenCalledTimes(1)
    expect(h.controller.isQuitting).toBe(true)
  })

  it('多次点击退出幂等（无重入：quit 只调用一次）', () => {
    const h = makeHarness()
    h.controller.quitApplication()
    h.controller.quitApplication()
    h.controller.quitApplication()
    expect(h.quit).toHaveBeenCalledTimes(1)
    expect(h.beforeQuit).toHaveBeenCalledTimes(1)
    expect(h.runtime.state.stopCalls).toBe(1)
  })

  it('退出进行中忽略一切菜单命令（暂停/隐藏/重置不再生效）', () => {
    const h = makeHarness()
    h.controller.quitApplication()
    h.controller.pauseActivity()
    h.controller.hidePet()
    expect(h.controller.getControlState()).toEqual({ paused: false, hidden: false })
    expect(h.win.state.hideCalls).toBe(0)
    expect(h.controller.resetPetPosition()).toBe('unavailable')
  })

  it('退出后运行时已停止：不再有行为推进（广播由 stop 后的运行时保证）', () => {
    const h = makeHarness()
    h.controller.quitApplication()
    // 运行时停止后 tick 不再执行（运行时自身测试覆盖）；此处验证 stop 已调用
    expect(h.runtime.state.stopCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('Task 12A：DEV 调试兼容与状态一致性', () => {
  it('用户暂停是控制器权威状态：隐藏/显示操作不覆盖暂停意图', () => {
    const h = makeHarness()
    h.controller.pauseActivity()
    h.controller.hidePet()
    h.controller.showPet()
    expect(h.controller.getControlState().paused).toBe(true)
    // 调试面板的 resume-auto 只作用于运行时调试标志，
    // 控制器的用户暂停意图不受影响（仍保持 paused）
    expect(h.runtime.state.paused).toBe(true)
  })

  it('拖动中暂停：用户意图被记录（运行时挂起语义由状态机保证）', () => {
    // 拖动中的运行时（isPaused 反映状态机 dragging+挂起暂停语义）：
    // 控制器 reconcile 观察到运行时已暂停，不重复调用 pause。
    const h = makeHarness({
      runtime: { isDragging: (): boolean => true, isPaused: (): boolean => true }
    })
    h.controller.pauseActivity()
    expect(h.controller.getControlState().paused).toBe(true)
    expect(h.runtime.state.pauseCalls).toBe(0)
  })

  it('异常销毁窗口的显示请求：不崩溃，仅解除隐藏并恢复行为', () => {
    const h = makeHarness({ window: { isDestroyed: (): boolean => true } })
    h.controller.hidePet()
    expect(() => h.controller.showPet()).not.toThrow()
    expect(h.controller.getControlState().hidden).toBe(false)
    expect(h.runtime.state.paused).toBe(false)
  })
})
