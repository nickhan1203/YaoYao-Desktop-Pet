/**
 * 幺幺桌宠用户设置模型（Task 12B，纯逻辑，可被 Vitest 直接测试）。
 *
 * 设计约束：
 * - 用户设置与内部行为决策配置（BehaviorDeciderConfig）分离：
 *   用户侧只表达少量可理解偏好（频率档位/速度/倍率），
 *   由本模块映射为内部参数，renderer 与存储只接触用户模型；
 * - normal 档位严格等于当前已验收默认值（不因设计稿覆盖生产参数）；
 * - 所有数值字段拥有显式范围；解析函数对任意未知输入
 *   （含原型污染形态）返回 null 或回退默认，不产生半合法对象。
 */

import type { BehaviorDeciderConfig } from './pet-behavior-decider'

/** 当前设置模式版本（存储文件包含该字段，支持后续迁移） */
export const PET_SETTINGS_SCHEMA_VERSION = 2

/**
 * 设置 IPC 通道（Task 12B，主进程与 preload 共用的协议常量）：
 * - GET：renderer 查询当前设置（invoke，返回 PetSettings | null）；
 * - UPDATE：renderer 发送白名单更新载荷（send，主进程全量校验）；
 * - CHANGED：主进程 → renderer 单向广播（应用后广播最新设置）；
 * - SAVE_ERROR：主进程 → 设置窗口的持久化失败通知（无载荷）。
 */
export const SETTINGS_GET_CHANNEL = 'pet:get-settings'
export const SETTINGS_UPDATE_CHANNEL = 'pet:update-settings'
export const SETTINGS_CHANGED_CHANNEL = 'pet:settings-changed'
export const SETTINGS_SAVE_ERROR_CHANNEL = 'pet:settings-save-error'
/**
 * 保存完成通知（Task 12B-UI）：主进程持久化成功后单向广播（无载荷）。
 * 设置页据此展示真实的"已保存"状态（不以 UI 点击伪造成功）。
 */
export const SETTINGS_SAVED_CHANNEL = 'pet:settings-saved'

/**
 * 载荷结构校验（preload / IPC 边界防御）：判断任意值是否为合法设置。
 * 与 parsePetSettings 一致的字段级判定，不要求额外字段。
 */
export function isPetSettings(value: unknown): value is PetSettings {
  return parsePetSettings(value) !== null
}

/**
 * 判断更新载荷是否不改变当前设置（所有出现的字段都与当前值一致）。
 * Task 12B-UI：设置页据此跳过重复提交（滑块回显/广播回执不再触发
 * 无意义的 IPC 与磁盘写入，保存状态不被无变化操作扰动）。
 */
export function isNoOpSettingsUpdate(current: PetSettings, update: PetSettingsUpdate): boolean {
  return (
    (update.autoActivityEnabled === undefined ||
      update.autoActivityEnabled === current.autoActivityEnabled) &&
    (update.petScale === undefined || update.petScale === current.petScale) &&
    (update.walkSpeedPxPerSec === undefined ||
      update.walkSpeedPxPerSec === current.walkSpeedPxPerSec) &&
    (update.runFrequency === undefined || update.runFrequency === current.runFrequency) &&
    (update.restFrequency === undefined || update.restFrequency === current.restFrequency) &&
    (update.alwaysOnTop === undefined || update.alwaysOnTop === current.alwaysOnTop) &&
    (update.mousePassthrough === undefined || update.mousePassthrough === current.mousePassthrough)
  )
}

/** 频率档位：low / normal / high */
export type FrequencyLevel = 'low' | 'normal' | 'high'

export const FREQUENCY_LEVELS: readonly FrequencyLevel[] = ['low', 'normal', 'high']

/** 用户可编辑设置（与内部决策配置分离的公开模型） */
export interface PetSettings {
  schemaVersion: number
  /** 自动活动总开关：关闭后无自主移动/随机行为，交互保留 */
  autoActivityEnabled: boolean
  /** 宠物显示倍率（等比）：0.70 ~ 1.00（>1 需窗口尺寸联动，后续任务） */
  petScale: number
  /** 行走速度（px/s）：30 ~ 120 */
  walkSpeedPxPerSec: number
  /** 跑步频率档位 */
  runFrequency: FrequencyLevel
  /** 休息频率档位 */
  restFrequency: FrequencyLevel
  /** 窗口置顶（Task 12C）：普通 always-on-top 层级，默认关闭（沿用
   * 12C 前已验收的实际行为——窗口未置顶） */
  alwaysOnTop: boolean
  /** 鼠标穿透（Task 12C）：开启后鼠标事件由下方窗口接收；托盘始终
   * 保留关闭入口（防不可恢复），默认关闭 */
  mousePassthrough: boolean
}

/**
 * 行走速度允许范围（px/s）。
 * 下限 30：明显慢于默认但不至于停滞感过强；上限 120：接近跑步默认
 * 速度（96px/s）的两倍行走以下，避免行走/跑步速度倒挂体验。
 */
export const WALK_SPEED_MIN = 30
export const WALK_SPEED_MAX = 120

/**
 * 宠物倍率允许范围。
 * 上限 1.00：侧面行走最宽帧显示宽度 237.5px（CHARACTER_SCALE 0.625 ×
 * 横向 ±190px），240×240 透明画布横向余量仅 1.25px/侧——超过 1.00
 * 必然裁剪。扩大支持范围需要窗口尺寸联动（后续独立任务），
 * 本轮以安全可验证范围交付。
 */
export const PET_SCALE_MIN = 0.7
export const PET_SCALE_MAX = 1.0

/** 默认设置：全部来自当前已验收的实际配置（normal 档 = 生产默认值） */
export const DEFAULT_PET_SETTINGS: PetSettings = {
  schemaVersion: PET_SETTINGS_SCHEMA_VERSION,
  autoActivityEnabled: true,
  petScale: 1.0,
  walkSpeedPxPerSec: 60,
  runFrequency: 'normal',
  restFrequency: 'normal',
  alwaysOnTop: false,
  mousePassthrough: false
}

/** 设置更新载荷（updateSettings 只允许这些字段；schemaVersion 不可由 renderer 修改） */
export type PetSettingsUpdate = Partial<Omit<PetSettings, 'schemaVersion'>>

function isFrequencyLevel(value: unknown): value is FrequencyLevel {
  return typeof value === 'string' && (FREQUENCY_LEVELS as readonly string[]).includes(value)
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * 显式 schema 迁移链（Task 12C）：
 * v1 → v2：新增 alwaysOnTop / mousePassthrough（缺失按默认值补齐，
 * 其余字段原样保留——旧用户配置不丢失）。
 * 未来版本在此追加分支；解析入口统一先经本函数升级再字段级校验，
 * 不依赖"字段缺失静默回退"掩盖版本兼容问题。
 */
export function migrateRawSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const version =
    typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion)
      ? raw.schemaVersion
      : 1
  const upgraded: Record<string, unknown> = { ...raw }
  if (version < 2) {
    if (!('alwaysOnTop' in upgraded)) {
      upgraded.alwaysOnTop = DEFAULT_PET_SETTINGS.alwaysOnTop
    }
    if (!('mousePassthrough' in upgraded)) {
      upgraded.mousePassthrough = DEFAULT_PET_SETTINGS.mousePassthrough
    }
    upgraded.schemaVersion = PET_SETTINGS_SCHEMA_VERSION
  }
  return upgraded
}

/**
 * 解析完整设置对象（存储读取 / IPC 查询返回 / 广播载荷校验）。
 * 未知字段忽略、缺失字段回退默认、任何非法字段回退默认；
 * 非 plain object（null/数组/原型污染形态）返回 null。
 * 返回全新对象，不保留输入引用（未知字段不进入业务逻辑）。
 */
export function parsePetSettings(value: unknown): PetSettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const rawProto = value as Record<string, unknown>
  const proto = Object.getPrototypeOf(rawProto)
  if (proto !== Object.prototype && proto !== null) {
    return null
  }
  // 先经显式迁移链升级（旧版本文件 → 当前 schema），再字段级校验。
  const raw = migrateRawSettings(rawProto)
  const settings: PetSettings = { ...DEFAULT_PET_SETTINGS }
  if (isFrequencyLevel(raw.runFrequency)) {
    settings.runFrequency = raw.runFrequency
  }
  if (isFrequencyLevel(raw.restFrequency)) {
    settings.restFrequency = raw.restFrequency
  }
  if (typeof raw.autoActivityEnabled === 'boolean') {
    settings.autoActivityEnabled = raw.autoActivityEnabled
  }
  if (isNumberInRange(raw.petScale, PET_SCALE_MIN, PET_SCALE_MAX)) {
    settings.petScale = raw.petScale
  }
  if (isNumberInRange(raw.walkSpeedPxPerSec, WALK_SPEED_MIN, WALK_SPEED_MAX)) {
    settings.walkSpeedPxPerSec = raw.walkSpeedPxPerSec
  }
  if (typeof raw.alwaysOnTop === 'boolean') {
    settings.alwaysOnTop = raw.alwaysOnTop
  }
  if (typeof raw.mousePassthrough === 'boolean') {
    settings.mousePassthrough = raw.mousePassthrough
  }
  // schemaVersion：经迁移链统一为当前版本；未知更高版本同样按字段级
  // 回退策略处理（未来版本升级在 migrateRawSettings 接入分支）。
  return settings
}

/**
 * 解析更新载荷（updateSettings IPC）。
 * 只接受白名单字段；任何出现的字段非法即整体拒绝（返回 null），
 * 不做字段级静默回退——更新是显式用户动作，非法输入应当失败可感知。
 */
export function parsePetSettingsUpdate(value: unknown): PetSettingsUpdate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) {
    return null
  }
  const update: PetSettingsUpdate = {}
  let hasField = false
  if ('autoActivityEnabled' in raw) {
    if (typeof raw.autoActivityEnabled !== 'boolean') {
      return null
    }
    update.autoActivityEnabled = raw.autoActivityEnabled
    hasField = true
  }
  if ('petScale' in raw) {
    if (!isNumberInRange(raw.petScale, PET_SCALE_MIN, PET_SCALE_MAX)) {
      return null
    }
    update.petScale = raw.petScale
    hasField = true
  }
  if ('walkSpeedPxPerSec' in raw) {
    if (!isNumberInRange(raw.walkSpeedPxPerSec, WALK_SPEED_MIN, WALK_SPEED_MAX)) {
      return null
    }
    update.walkSpeedPxPerSec = raw.walkSpeedPxPerSec
    hasField = true
  }
  if ('runFrequency' in raw) {
    if (!isFrequencyLevel(raw.runFrequency)) {
      return null
    }
    update.runFrequency = raw.runFrequency
    hasField = true
  }
  if ('restFrequency' in raw) {
    if (!isFrequencyLevel(raw.restFrequency)) {
      return null
    }
    update.restFrequency = raw.restFrequency
    hasField = true
  }
  if ('alwaysOnTop' in raw) {
    if (typeof raw.alwaysOnTop !== 'boolean') {
      return null
    }
    update.alwaysOnTop = raw.alwaysOnTop
    hasField = true
  }
  if ('mousePassthrough' in raw) {
    if (typeof raw.mousePassthrough !== 'boolean') {
      return null
    }
    update.mousePassthrough = raw.mousePassthrough
    hasField = true
  }
  return hasField ? update : null
}

/**
 * 跑步频率档位 → 决策器参数覆盖。
 * 只调整触发概率与冷却（任务约定：保留已验收的跑步时长与速度倍率）。
 * normal 严格等于 DEFAULT_BEHAVIOR_DECIDER_CONFIG 当前值。
 */
const RUN_FREQUENCY_PRESETS: Readonly<Record<FrequencyLevel, Partial<BehaviorDeciderConfig>>> = {
  low: { runChance: 0.15, runCooldownSec: 40 },
  normal: { runChance: 0.45, runCooldownSec: 20 },
  high: { runChance: 0.7, runCooldownSec: 8 }
}

/**
 * 休息频率档位 → 决策器参数覆盖。
 * 只调整触发概率与冷却（sit/lie 帧与时长、REST_EXIT_GUARD 不变）。
 * normal 严格等于 DEFAULT_BEHAVIOR_DECIDER_CONFIG 当前值。
 */
const REST_FREQUENCY_PRESETS: Readonly<Record<FrequencyLevel, Partial<BehaviorDeciderConfig>>> = {
  low: { restChance: 0.15, restCooldownSec: 90 },
  normal: { restChance: 0.4, restCooldownSec: 45 },
  high: { restChance: 0.65, restCooldownSec: 25 }
}

/**
 * 用户设置 → 行为决策配置（normal 全等默认值）。
 * 基于传入 base（默认 DEFAULT_BEHAVIOR_DECIDER_CONFIG）叠加档位覆盖，
 * 未映射字段（时长/分流/转向等）保持 base 不变。
 */
export function deciderConfigForSettings(
  base: BehaviorDeciderConfig,
  settings: PetSettings
): BehaviorDeciderConfig {
  return {
    ...base,
    ...RUN_FREQUENCY_PRESETS[settings.runFrequency],
    ...REST_FREQUENCY_PRESETS[settings.restFrequency]
  }
}

/**
 * 跑步速度模型：行走速度 × 1.6（与已验收默认 96 = 1.6 × 60 同一倍率）。
 * 用户调整行走速度时跑步速度等比跟随，倍率恒定。
 */
export const RUN_SPEED_RATIO = 1.6

export function runSpeedForWalkSpeed(walkSpeedPxPerSec: number): number {
  return walkSpeedPxPerSec * RUN_SPEED_RATIO
}
