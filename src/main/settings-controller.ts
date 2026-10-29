/**
 * 设置控制器（Task 12B，可注入端口，可被 Vitest 直接测试）。
 *
 * 职责：主进程作为配置唯一权威——
 * - 启动时经 store 读取（缺失/损坏回退默认）；
 * - updateSettings：载荷经 parsePetSettingsUpdate 白名单校验（非法整体
 *   拒绝），合并后立即应用到行为运行时（不重启、不重建窗口）并广播
 *   给各 renderer；持久化经防抖延迟执行（高频滑块输入只触发最后一次
 *   写盘，天然避免过期写入覆盖新值）；
 * - flush：退出前同步落盘（before-quit 调用，防抖未到期也不丢设置）；
 * - 写入失败经 onSaveError 反馈（不假装保存成功），内存中的最新设置
 *   保持生效（下次更新会再次尝试写盘）。
 *
 * 广播回环防护：广播是单向通知，renderer 收到广播只更新本地展示，
 * 不再发起新的 updateSettings（UI 侧约定），控制器不因广播触发保存。
 */

import {
  deciderConfigForSettings,
  parsePetSettingsUpdate,
  runSpeedForWalkSpeed,
  type PetSettings,
  type PetSettingsUpdate
} from '../shared/pet-settings'
import {
  DEFAULT_BEHAVIOR_DECIDER_CONFIG,
  type BehaviorDeciderConfig
} from '../shared/pet-behavior-decider'
import type { PetSettingsStore, LoadedSettings } from './settings-store'

/** 运行时配置应用端口（PetBehaviorRuntime 实现测试注入假实现） */
export interface SettingsRuntimePort {
  /** 动态应用速度与决策参数（不重置当前行为） */
  applyConfig(config: {
    walkSpeedPxPerSec?: number
    runSpeedPxPerSec?: number
    decider?: BehaviorDeciderConfig
  }): void
  /** 自动活动总开关 */
  setAutoActivityEnabled(enabled: boolean): void
}

/** 窗口标志应用端口（Task 12C：置顶/穿透；PetWindowFlagsController 实现） */
export interface SettingsWindowFlagsPort {
  /** 应用置顶；返回 false 表示 API 失败（调用方回滚字段） */
  applyAlwaysOnTop(enabled: boolean): boolean
  /** 应用穿透（含拖动竞态受控取消）；返回 false 表示 API 失败 */
  applyMousePassthrough(enabled: boolean): boolean
}

/** 窗口标志应用失败反馈（Task 12C） */
export interface WindowFlagsApplyError {
  setting: 'alwaysOnTop' | 'mousePassthrough'
  requested: boolean
}

export interface SettingsControllerPorts {
  store: PetSettingsStore
  runtime: SettingsRuntimePort
  /** 窗口标志应用（Task 12C：置顶/穿透，只作用于桌宠窗口） */
  windowFlags: SettingsWindowFlagsPort
  /** 设置变化广播（主进程 → 各 renderer，单向） */
  broadcast: (settings: PetSettings) => void
  /** 持久化成功广播（主进程 → 设置窗口，单向，无载荷；Task 12B-UI） */
  broadcastSaved: () => void
  /** 持久化失败反馈（日志/设置窗口提示） */
  onSaveError: (error: unknown) => void
  /** 窗口标志应用失败反馈（Task 12C：日志；字段已回滚） */
  onWindowFlagsError?: (error: WindowFlagsApplyError) => void
  /** 防抖写盘延迟（毫秒），默认 500 */
  saveDelayMs?: number
}

const DEFAULT_SAVE_DELAY_MS = 500

export class PetSettingsController {
  private readonly ports: SettingsControllerPorts
  private readonly saveDelayMs: number
  private settings: PetSettings
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(ports: SettingsControllerPorts, loaded?: LoadedSettings) {
    this.ports = ports
    this.saveDelayMs = ports.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS
    this.settings = loaded ? loaded.settings : ports.store.load().settings
  }

  /** 当前设置（返回副本，防止外部直接修改内部状态） */
  getSettings(): PetSettings {
    return { ...this.settings }
  }

  /**
   * 更新设置（IPC 入口）：
   * 非法载荷返回 null（调用方拒绝，不部分应用）；
   * 合法载荷合并 → 窗口标志先行应用（失败字段回滚，权威状态与实际
   * 窗口一致）→ 应用运行时 → 广播 → 防抖调度保存。
   */
  updateSettings(payload: unknown): PetSettings | null {
    if (this.disposed) {
      return null
    }
    const update = parsePetSettingsUpdate(payload)
    if (update === null) {
      return null
    }
    let next = mergeSettings(this.settings, update)
    // Task 12C：窗口标志（置顶/穿透）先行应用——API 失败时该字段回滚
    // 到当前值（不留下"设置显示已开但窗口未生效"的矛盾状态），其余
    // 字段照常应用，失败经 onWindowFlagsError 反馈。
    for (const field of ['alwaysOnTop', 'mousePassthrough'] as const) {
      const requested = update[field]
      if (requested === undefined || requested === this.settings[field]) {
        continue
      }
      const applied =
        field === 'alwaysOnTop'
          ? this.ports.windowFlags.applyAlwaysOnTop(requested)
          : this.ports.windowFlags.applyMousePassthrough(requested)
      if (!applied) {
        next = { ...next, [field]: this.settings[field] }
        this.ports.onWindowFlagsError?.({ setting: field, requested })
      }
    }
    this.settings = next
    this.applyToRuntime()
    this.ports.broadcast(this.getSettings())
    this.scheduleSave()
    return this.getSettings()
  }

  /** 立即同步落盘（退出前调用；无未保存变更时为幂等安全写） */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      this.ports.store.persist(this.settings)
      this.ports.broadcastSaved()
    } catch (error) {
      this.ports.onSaveError(error)
    }
  }

  /** 停用控制器（退出路径）：取消挂起的防抖保存 */
  dispose(): void {
    this.disposed = true
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  /**
   * 把当前设置映射为运行时参数并应用（不重置当前行为状态）。
   * 公开方法：启动时与运行时重建（activate 路径）后由接线层显式调用。
   * Task 12C：同步应用窗口标志（置顶/穿透）——重建窗口后不恢复旧
   * 设置；启动路径失败不回滚持久化值（下次重建/更新重试），仅由
   * onWindowFlagsError 反馈。
   */
  applyToRuntime(): void {
    this.ports.runtime.applyConfig({
      walkSpeedPxPerSec: this.settings.walkSpeedPxPerSec,
      runSpeedPxPerSec: runSpeedForWalkSpeed(this.settings.walkSpeedPxPerSec),
      decider: deciderConfigForSettings(DEFAULT_BEHAVIOR_DECIDER_CONFIG, this.settings)
    })
    this.ports.runtime.setAutoActivityEnabled(this.settings.autoActivityEnabled)
    if (!this.ports.windowFlags.applyAlwaysOnTop(this.settings.alwaysOnTop)) {
      this.ports.onWindowFlagsError?.({
        setting: 'alwaysOnTop',
        requested: this.settings.alwaysOnTop
      })
    }
    if (!this.ports.windowFlags.applyMousePassthrough(this.settings.mousePassthrough)) {
      this.ports.onWindowFlagsError?.({
        setting: 'mousePassthrough',
        requested: this.settings.mousePassthrough
      })
    }
  }

  /**
   * 防抖保存：每次更新重置计时器，仅最后一次设置写入磁盘
   * （连续滑块输入 → 至多一次写盘，且必然是最新值）。
   */
  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
    }
    this.saveTimer = setTimeout((): void => {
      this.saveTimer = null
      try {
        this.ports.store.persist(this.settings)
        this.ports.broadcastSaved()
      } catch (error) {
        this.ports.onSaveError(error)
      }
    }, this.saveDelayMs)
  }
}

function mergeSettings(current: PetSettings, update: PetSettingsUpdate): PetSettings {
  return {
    schemaVersion: current.schemaVersion,
    autoActivityEnabled: update.autoActivityEnabled ?? current.autoActivityEnabled,
    petScale: update.petScale ?? current.petScale,
    walkSpeedPxPerSec: update.walkSpeedPxPerSec ?? current.walkSpeedPxPerSec,
    runFrequency: update.runFrequency ?? current.runFrequency,
    restFrequency: update.restFrequency ?? current.restFrequency,
    alwaysOnTop: update.alwaysOnTop ?? current.alwaysOnTop,
    mousePassthrough: update.mousePassthrough ?? current.mousePassthrough
  }
}
