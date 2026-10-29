import { describe, expect, it, vi } from 'vitest'
import { PetSettingsStore, type SettingsFileAdapter } from '../src/main/settings-store'
import { PetSettingsController } from '../src/main/settings-controller'
import { DEFAULT_BEHAVIOR_DECIDER_CONFIG } from '../src/shared/pet-behavior-decider'
import { DEFAULT_PET_SETTINGS, type PetSettings } from '../src/shared/pet-settings'

/** 内存文件适配器：模拟磁盘文件（记录写入内容，可注入读写失败） */
function makeMemoryAdapter(initial?: string): SettingsFileAdapter & {
  content: string | null
  writeCalls: string[]
  failWrite: boolean
} {
  const state = {
    content: initial ?? null,
    writeCalls: [] as string[],
    failWrite: false
  }
  return {
    get content(): string | null {
      return state.content
    },
    get writeCalls(): string[] {
      return state.writeCalls
    },
    get failWrite(): boolean {
      return state.failWrite
    },
    set failWrite(value: boolean) {
      state.failWrite = value
    },
    read: (): string | null => state.content,
    writeAtomic: (content: string): void => {
      if (state.failWrite) {
        throw new Error('disk full')
      }
      state.writeCalls.push(content)
      state.content = content
    }
  }
}

const CUSTOM: PetSettings = {
  ...DEFAULT_PET_SETTINGS,
  autoActivityEnabled: false,
  petScale: 0.8,
  walkSpeedPxPerSec: 90,
  runFrequency: 'high',
  restFrequency: 'low'
}

describe('PetSettingsStore（本地持久化）', () => {
  it('文件不存在：返回默认值（degraded=false）', () => {
    const store = new PetSettingsStore(makeMemoryAdapter())
    const loaded = store.load()
    expect(loaded.settings).toEqual(DEFAULT_PET_SETTINGS)
    expect(loaded.degraded).toBe(false)
  })

  it('保存与重新读取一致（往返）', () => {
    const adapter = makeMemoryAdapter()
    const store = new PetSettingsStore(adapter)
    store.persist(CUSTOM)
    const reloaded = new PetSettingsStore(adapter).load()
    expect(reloaded.settings).toEqual(CUSTOM)
    expect(reloaded.degraded).toBe(false)
  })

  it('损坏 JSON：安全降级默认值（degraded=true，不影响启动）', () => {
    const store = new PetSettingsStore(makeMemoryAdapter('{ not valid json !!'))
    const loaded = store.load()
    expect(loaded.settings).toEqual(DEFAULT_PET_SETTINGS)
    expect(loaded.degraded).toBe(true)
  })

  it('结构非法（数组/字符串）：安全降级默认值', () => {
    expect(new PetSettingsStore(makeMemoryAdapter('"hello"')).load().degraded).toBe(true)
    expect(new PetSettingsStore(makeMemoryAdapter('[1,2]')).load().degraded).toBe(true)
  })

  it('部分字段缺失/非法：字段级回退（未知字段不进入业务逻辑）', () => {
    const raw = JSON.stringify({ walkSpeedPxPerSec: 45, evil: true })
    const loaded = new PetSettingsStore(makeMemoryAdapter(raw)).load()
    expect(loaded.degraded).toBe(false)
    expect(loaded.settings.walkSpeedPxPerSec).toBe(45)
    expect(loaded.settings.autoActivityEnabled).toBe(true)
    expect(Object.keys(loaded.settings)).not.toContain('evil')
  })

  it('写入失败向上抛出（不假装保存成功）', () => {
    const adapter = makeMemoryAdapter()
    adapter.failWrite = true
    const store = new PetSettingsStore(adapter)
    expect(() => store.persist(CUSTOM)).toThrow('disk full')
  })
})

describe('PetSettingsController（防抖保存与运行时应用）', () => {
  interface ControllerHarness {
    controller: InstanceType<typeof PetSettingsController>
    adapter: ReturnType<typeof makeMemoryAdapter>
    applyConfig: ReturnType<typeof vi.fn>
    setAutoActivityEnabled: ReturnType<typeof vi.fn>
    applyAlwaysOnTop: ReturnType<typeof vi.fn>
    applyMousePassthrough: ReturnType<typeof vi.fn>
    onWindowFlagsError: ReturnType<typeof vi.fn>
    broadcast: ReturnType<typeof vi.fn>
    broadcastSaved: ReturnType<typeof vi.fn>
    onSaveError: ReturnType<typeof vi.fn>
  }

  function makeHarness(options?: {
    initial?: string
    saveDelayMs?: number
    applyAlwaysOnTop?: () => boolean
    applyMousePassthrough?: () => boolean
  }): ControllerHarness {
    const adapter = makeMemoryAdapter(options?.initial)
    const store = new PetSettingsStore(adapter)
    const applyConfig = vi.fn()
    const setAutoActivityEnabled = vi.fn()
    const applyAlwaysOnTop = vi.fn(options?.applyAlwaysOnTop ?? ((): boolean => true))
    const applyMousePassthrough = vi.fn(options?.applyMousePassthrough ?? ((): boolean => true))
    const onWindowFlagsError = vi.fn()
    const broadcast = vi.fn()
    const broadcastSaved = vi.fn()
    const onSaveError = vi.fn()
    const controller = new PetSettingsController(
      {
        store,
        runtime: { applyConfig, setAutoActivityEnabled },
        windowFlags: { applyAlwaysOnTop, applyMousePassthrough },
        broadcast,
        broadcastSaved,
        onSaveError,
        onWindowFlagsError,
        saveDelayMs: options?.saveDelayMs ?? 100
      },
      undefined
    )
    return {
      controller,
      adapter,
      applyConfig,
      setAutoActivityEnabled,
      applyAlwaysOnTop,
      applyMousePassthrough,
      onWindowFlagsError,
      broadcast,
      broadcastSaved,
      onSaveError
    }
  }

  it('构造时从 store 读取设置（文件不存在 → 默认值）', () => {
    const h = makeHarness()
    expect(h.controller.getSettings()).toEqual(DEFAULT_PET_SETTINGS)
  })

  it('构造时从已有文件恢复设置（重启后设置保留的数据链路）', () => {
    const h = makeHarness({ initial: JSON.stringify(CUSTOM) })
    expect(h.controller.getSettings()).toEqual(CUSTOM)
  })

  it('applyToRuntime：速度/决策配置/自动活动一次应用到运行时', () => {
    const h = makeHarness()
    h.controller.applyToRuntime()
    expect(h.applyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ walkSpeedPxPerSec: 60, runSpeedPxPerSec: 96 })
    )
    expect(h.setAutoActivityEnabled).toHaveBeenCalledWith(true)
  })

  it('updateSettings：合法载荷合并、应用、广播、防抖保存', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      const result = h.controller.updateSettings({ walkSpeedPxPerSec: 90 })
      expect(result?.walkSpeedPxPerSec).toBe(90)
      expect(h.broadcast).toHaveBeenCalledTimes(1)
      // 防抖期内未写盘
      expect(h.adapter.writeCalls).toHaveLength(0)
      vi.advanceTimersByTime(100)
      expect(h.adapter.writeCalls).toHaveLength(1)
      expect(JSON.parse(h.adapter.writeCalls[0]).walkSpeedPxPerSec).toBe(90)
    } finally {
      vi.useRealTimers()
    }
  })

  it('非法载荷整体拒绝（null，不应用不广播不保存）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      expect(h.controller.updateSettings({ walkSpeedPxPerSec: 999 })).toBeNull()
      expect(h.controller.updateSettings('bad')).toBeNull()
      expect(h.controller.updateSettings({ evil: 1 })).toBeNull()
      expect(h.broadcast).not.toHaveBeenCalled()
      expect(h.applyConfig).not.toHaveBeenCalled()
      vi.advanceTimersByTime(500)
      expect(h.adapter.writeCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('高频连续更新只写盘最后一次（防抖合并，最后一次设置不丢失）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      for (const speed of [35, 45, 55, 65, 75, 85]) {
        h.controller.updateSettings({ walkSpeedPxPerSec: speed })
        vi.advanceTimersByTime(50) // 每次都在防抖期内重置
      }
      expect(h.adapter.writeCalls).toHaveLength(0)
      vi.advanceTimersByTime(100)
      expect(h.adapter.writeCalls).toHaveLength(1)
      expect(JSON.parse(h.adapter.writeCalls[0]).walkSpeedPxPerSec).toBe(85)
    } finally {
      vi.useRealTimers()
    }
  })

  it('过期异步保存不覆盖新值：防抖计时器重置保证最新值落盘', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.controller.updateSettings({ petScale: 0.75 })
      vi.advanceTimersByTime(60) // 第一次更新的保存尚未到期
      h.controller.updateSettings({ petScale: 0.95 }) // 重置计时器
      vi.advanceTimersByTime(100)
      expect(h.adapter.writeCalls).toHaveLength(1)
      expect(JSON.parse(h.adapter.writeCalls[0]).petScale).toBe(0.95)
    } finally {
      vi.useRealTimers()
    }
  })

  it('写入失败反馈（onSaveError），内存设置保持生效', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.adapter.failWrite = true
      h.controller.updateSettings({ walkSpeedPxPerSec: 45 })
      vi.advanceTimersByTime(100)
      expect(h.onSaveError).toHaveBeenCalledTimes(1)
      // 设置仍生效（运行时已应用）
      expect(h.controller.getSettings().walkSpeedPxPerSec).toBe(45)
      // 恢复磁盘后下次更新可再次尝试写盘
      h.adapter.failWrite = false
      h.controller.updateSettings({ walkSpeedPxPerSec: 55 })
      vi.advanceTimersByTime(100)
      expect(h.adapter.writeCalls).toHaveLength(1)
      expect(JSON.parse(h.adapter.writeCalls[0]).walkSpeedPxPerSec).toBe(55)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush：立即同步落盘（防抖未到期也不丢最新设置）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.controller.updateSettings({ autoActivityEnabled: false })
      expect(h.adapter.writeCalls).toHaveLength(0)
      h.controller.flush()
      expect(h.adapter.writeCalls).toHaveLength(1)
      expect(JSON.parse(h.adapter.writeCalls[0]).autoActivityEnabled).toBe(false)
      // flush 后计时器已清理（不再重复写盘）
      vi.advanceTimersByTime(500)
      expect(h.adapter.writeCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose：取消挂起的防抖保存（退出路径不再写盘）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.controller.updateSettings({ petScale: 0.9 })
      h.controller.dispose()
      vi.advanceTimersByTime(500)
      expect(h.adapter.writeCalls).toHaveLength(0)
      // dispose 后更新被拒绝
      expect(h.controller.updateSettings({ petScale: 0.8 })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('保存完成广播（Task 12B-UI）：防抖落盘成功后广播 saved（真实持久化结果）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.controller.updateSettings({ walkSpeedPxPerSec: 75 })
      // 防抖期内不广播"已保存"（不得伪造成功状态）
      vi.advanceTimersByTime(50)
      expect(h.broadcastSaved).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)
      expect(h.broadcastSaved).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('保存完成广播：非法更新与写入失败均不广播 saved', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.controller.updateSettings({ walkSpeedPxPerSec: 999 })
      vi.advanceTimersByTime(200)
      expect(h.broadcastSaved).not.toHaveBeenCalled()
      h.adapter.failWrite = true
      h.controller.updateSettings({ walkSpeedPxPerSec: 55 })
      vi.advanceTimersByTime(200)
      expect(h.broadcastSaved).not.toHaveBeenCalled()
      expect(h.onSaveError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush 成功同样广播 saved（退出前落盘的 UI 状态收口）', () => {
    const h = makeHarness()
    h.controller.flush()
    expect(h.broadcastSaved).toHaveBeenCalledTimes(1)
  })

  it('高频连续更新只广播一次 saved（防抖合并）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      for (const speed of [35, 45, 55]) {
        h.controller.updateSettings({ walkSpeedPxPerSec: speed })
        vi.advanceTimersByTime(50)
      }
      vi.advanceTimersByTime(100)
      expect(h.broadcastSaved).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('运行时参数映射：速度倍率 1.6 派生 + 频率档位覆盖决策配置', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.controller.updateSettings({ walkSpeedPxPerSec: 100, runFrequency: 'high' })
      expect(h.applyConfig).toHaveBeenCalledWith(
        expect.objectContaining({ walkSpeedPxPerSec: 100, runSpeedPxPerSec: 160 })
      )
      const decider = h.applyConfig.mock.calls.at(-1)?.[0]?.decider
      expect(decider.runChance).toBe(0.7)
      expect(decider.runCooldownSec).toBe(8)
      // 未映射字段保持默认
      expect(decider.walkDurationSec).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG.walkDurationSec)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Task 12C：置顶/穿透更新先行应用到窗口标志并持久化（schemaVersion 2）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      h.controller.updateSettings({ alwaysOnTop: true, mousePassthrough: true })
      expect(h.applyAlwaysOnTop).toHaveBeenCalledWith(true)
      expect(h.applyMousePassthrough).toHaveBeenCalledWith(true)
      expect(h.controller.getSettings().alwaysOnTop).toBe(true)
      expect(h.controller.getSettings().mousePassthrough).toBe(true)
      vi.advanceTimersByTime(100)
      const persisted = JSON.parse(h.adapter.writeCalls[0])
      expect(persisted.schemaVersion).toBe(2)
      expect(persisted.alwaysOnTop).toBe(true)
      expect(persisted.mousePassthrough).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Task 12C：置顶 API 失败 → 该字段回滚当前值，其余字段照常应用，失败经 onWindowFlagsError 反馈', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ applyAlwaysOnTop: (): boolean => false })
      const result = h.controller.updateSettings({
        alwaysOnTop: true,
        walkSpeedPxPerSec: 45
      })
      // 权威状态与实际窗口一致：置顶保持关闭
      expect(result?.alwaysOnTop).toBe(false)
      expect(result?.walkSpeedPxPerSec).toBe(45)
      expect(h.onWindowFlagsError).toHaveBeenCalledWith({
        setting: 'alwaysOnTop',
        requested: true
      })
      // 广播同样不带未生效的置顶值
      expect(h.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ alwaysOnTop: false, walkSpeedPxPerSec: 45 })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('Task 12C：穿透 API 失败 → 字段回滚（不进入无法交互又未生效的矛盾状态）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ applyMousePassthrough: (): boolean => false })
      const result = h.controller.updateSettings({ mousePassthrough: true })
      expect(result?.mousePassthrough).toBe(false)
      expect(h.onWindowFlagsError).toHaveBeenCalledWith({
        setting: 'mousePassthrough',
        requested: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('Task 12C：未变化字段不触发先行应用（值相同的更新只走 applyToRuntime 常规同步）', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      // 当前值为 false，再提交 false → 先行应用跳过
      h.controller.updateSettings({ alwaysOnTop: false })
      // applyToRuntime 仍同步一次（幂等安全）
      expect(h.applyAlwaysOnTop).toHaveBeenCalledTimes(1)
      expect(h.applyAlwaysOnTop).toHaveBeenCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Task 12C：applyToRuntime 同步窗口标志（activate 重建窗口后恢复置顶/穿透）', () => {
    const h = makeHarness({
      initial: JSON.stringify({
        schemaVersion: 2,
        alwaysOnTop: true,
        mousePassthrough: true,
        walkSpeedPxPerSec: 75
      })
    })
    h.controller.applyToRuntime()
    expect(h.applyAlwaysOnTop).toHaveBeenCalledWith(true)
    expect(h.applyMousePassthrough).toHaveBeenCalledWith(true)
  })

  it('Task 12C：启动应用失败不回滚持久化值（下次重建/更新重试），仅反馈错误', () => {
    const h = makeHarness({
      initial: JSON.stringify({ schemaVersion: 2, alwaysOnTop: true, mousePassthrough: false })
    })
    // 窗口 API 暂时失败（重建窗口场景）
    h.applyAlwaysOnTop.mockReturnValue(false)
    h.controller.applyToRuntime()
    expect(h.onWindowFlagsError).toHaveBeenCalledWith({
      setting: 'alwaysOnTop',
      requested: true
    })
    // 内存设置保持用户值（不因一次失败降级为默认）
    expect(h.controller.getSettings().alwaysOnTop).toBe(true)
    // 恢复后重试成功
    h.applyAlwaysOnTop.mockReturnValue(true)
    h.controller.applyToRuntime()
    expect(h.applyAlwaysOnTop).toHaveBeenLastCalledWith(true)
  })

  it('Task 12C：v1 旧文件迁移 → 控制器读到 v2 设置（旧值保留，新字段默认关闭）', () => {
    const h = makeHarness({
      initial: JSON.stringify({
        schemaVersion: 1,
        autoActivityEnabled: false,
        petScale: 0.8,
        walkSpeedPxPerSec: 90
      })
    })
    const settings = h.controller.getSettings()
    expect(settings.schemaVersion).toBe(2)
    expect(settings.autoActivityEnabled).toBe(false)
    expect(settings.petScale).toBe(0.8)
    expect(settings.walkSpeedPxPerSec).toBe(90)
    expect(settings.alwaysOnTop).toBe(false)
    expect(settings.mousePassthrough).toBe(false)
  })
})
