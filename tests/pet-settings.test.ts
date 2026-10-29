import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PET_SETTINGS,
  FREQUENCY_LEVELS,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  PET_SETTINGS_SCHEMA_VERSION,
  WALK_SPEED_MAX,
  WALK_SPEED_MIN,
  deciderConfigForSettings,
  isNoOpSettingsUpdate,
  isPetSettings,
  migrateRawSettings,
  parsePetSettings,
  parsePetSettingsUpdate,
  runSpeedForWalkSpeed,
  type PetSettings
} from '../src/shared/pet-settings'
import { DEFAULT_BEHAVIOR_DECIDER_CONFIG } from '../src/shared/pet-behavior-decider'

function validSettings(overrides: Partial<PetSettings> = {}): PetSettings {
  return { ...DEFAULT_PET_SETTINGS, ...overrides }
}

describe('PetSettings 默认值（Task 12B：默认 = 已验收生产参数）', () => {
  it('默认值来自当前已验收配置', () => {
    expect(DEFAULT_PET_SETTINGS).toEqual({
      schemaVersion: 2,
      autoActivityEnabled: true,
      petScale: 1.0,
      walkSpeedPxPerSec: 60,
      runFrequency: 'normal',
      restFrequency: 'normal',
      alwaysOnTop: false,
      mousePassthrough: false
    })
    // 范围常量与任务规格一致
    expect([WALK_SPEED_MIN, WALK_SPEED_MAX]).toEqual([30, 120])
    expect([PET_SCALE_MIN, PET_SCALE_MAX]).toEqual([0.7, 1.0])
  })

  it('Task 12C：置顶/穿透默认关闭（沿用 12C 前已验收的实际窗口行为）', () => {
    expect(DEFAULT_PET_SETTINGS.alwaysOnTop).toBe(false)
    expect(DEFAULT_PET_SETTINGS.mousePassthrough).toBe(false)
    expect(PET_SETTINGS_SCHEMA_VERSION).toBe(2)
  })

  it('normal 档位映射严格等于决策器默认值', () => {
    const config = deciderConfigForSettings(DEFAULT_BEHAVIOR_DECIDER_CONFIG, validSettings())
    expect(config).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG)
  })
})

describe('parsePetSettings（读取/广播载荷校验）', () => {
  it('合法对象完整解析（未知字段忽略，不进入业务逻辑）', () => {
    const parsed = parsePetSettings({
      ...validSettings({ walkSpeedPxPerSec: 90 }),
      evilField: 'x',
      __proto__pollution: true
    })
    expect(parsed).toEqual(validSettings({ walkSpeedPxPerSec: 90 }))
    expect(Object.keys(parsed ?? {}).sort()).toEqual(Object.keys(DEFAULT_PET_SETTINGS).sort())
  })

  it('缺失字段回退默认值', () => {
    expect(parsePetSettings({})).toEqual(DEFAULT_PET_SETTINGS)
    expect(parsePetSettings({ walkSpeedPxPerSec: 45 })).toEqual(
      validSettings({ walkSpeedPxPerSec: 45 })
    )
  })

  it('无效数值回退默认（超范围/NaN/Infinity/非数值）', () => {
    expect(parsePetSettings({ walkSpeedPxPerSec: 200 })?.walkSpeedPxPerSec).toBe(60)
    expect(parsePetSettings({ walkSpeedPxPerSec: 10 })?.walkSpeedPxPerSec).toBe(60)
    expect(parsePetSettings({ walkSpeedPxPerSec: Number.NaN })?.walkSpeedPxPerSec).toBe(60)
    expect(parsePetSettings({ walkSpeedPxPerSec: '90' })?.walkSpeedPxPerSec).toBe(60)
    expect(parsePetSettings({ petScale: 1.3 })?.petScale).toBe(1.0)
    expect(parsePetSettings({ petScale: 0.5 })?.petScale).toBe(1.0)
  })

  it('非法频率回退默认；合法频率接受', () => {
    expect(parsePetSettings({ runFrequency: 'always' })?.runFrequency).toBe('normal')
    expect(parsePetSettings({ restFrequency: 1 })?.restFrequency).toBe('normal')
    expect(parsePetSettings({ runFrequency: 'low' })?.runFrequency).toBe('low')
    expect(parsePetSettings({ restFrequency: 'high' })?.restFrequency).toBe('high')
  })

  it('非布尔 autoActivityEnabled 回退默认', () => {
    expect(parsePetSettings({ autoActivityEnabled: 'yes' })?.autoActivityEnabled).toBe(true)
    expect(parsePetSettings({ autoActivityEnabled: 0 })?.autoActivityEnabled).toBe(true)
    expect(parsePetSettings({ autoActivityEnabled: false })?.autoActivityEnabled).toBe(false)
  })

  it('非 plain object 输入返回 null（数组/null/原型污染形态）', () => {
    expect(parsePetSettings(null)).toBeNull()
    expect(parsePetSettings([])).toBeNull()
    expect(parsePetSettings('settings')).toBeNull()
    expect(parsePetSettings(42)).toBeNull()
  })

  it('schemaVersion 校验：未知更高版本按缺失回退（当前仅 v1/v2，迁移链在 parse 入口统一接入）', () => {
    // 未来版本：字段级回退策略保证不崩溃；升级迁移在版本发布时接入
    expect(parsePetSettings({ schemaVersion: 99 })?.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
    expect(parsePetSettings({ schemaVersion: '1' })?.schemaVersion).toBe(
      PET_SETTINGS_SCHEMA_VERSION
    )
  })

  it('Task 12C：非布尔 alwaysOnTop / mousePassthrough 回退默认', () => {
    expect(parsePetSettings({ alwaysOnTop: 'yes' })?.alwaysOnTop).toBe(false)
    expect(parsePetSettings({ alwaysOnTop: 1 })?.alwaysOnTop).toBe(false)
    expect(parsePetSettings({ alwaysOnTop: true })?.alwaysOnTop).toBe(true)
    expect(parsePetSettings({ mousePassthrough: 0 })?.mousePassthrough).toBe(false)
    expect(parsePetSettings({ mousePassthrough: true })?.mousePassthrough).toBe(true)
  })

  it('isPetSettings 与 parsePetSettings 判定一致', () => {
    expect(isPetSettings(validSettings())).toBe(true)
    expect(isPetSettings({ walkSpeedPxPerSec: 999 })).toBe(true) // 字段级回退仍为合法结构
    expect(isPetSettings(null)).toBe(false)
    expect(isPetSettings('x')).toBe(false)
  })
})

describe('migrateRawSettings（Task 12C：显式 schema 迁移链 v1 → v2）', () => {
  it('v1 文件：新增字段补默认，旧字段原样保留，版本号升至 2', () => {
    const v1File = {
      schemaVersion: 1,
      autoActivityEnabled: false,
      petScale: 0.8,
      walkSpeedPxPerSec: 90,
      runFrequency: 'high',
      restFrequency: 'low'
    }
    const migrated = migrateRawSettings(v1File)
    expect(migrated).toEqual({
      ...v1File,
      alwaysOnTop: false,
      mousePassthrough: false,
      schemaVersion: 2
    })
    // 解析入口：v1 文件 → v2 设置（旧用户配置不丢失）
    expect(parsePetSettings(v1File)).toEqual(
      validSettings({
        autoActivityEnabled: false,
        petScale: 0.8,
        walkSpeedPxPerSec: 90,
        runFrequency: 'high',
        restFrequency: 'low'
      })
    )
  })

  it('v1 文件已含新字段（前向写入）：不覆盖用户已有值', () => {
    const migrated = migrateRawSettings({ schemaVersion: 1, alwaysOnTop: true, petScale: 0.75 })
    expect(migrated.alwaysOnTop).toBe(true)
    expect(migrated.mousePassthrough).toBe(false)
    expect(migrated.schemaVersion).toBe(2)
  })

  it('v2 文件：不重复迁移（原样返回，含已开启的置顶/穿透）', () => {
    const v2File = {
      schemaVersion: 2,
      alwaysOnTop: true,
      mousePassthrough: true,
      walkSpeedPxPerSec: 45
    }
    expect(migrateRawSettings(v2File)).toEqual(v2File)
    expect(parsePetSettings(v2File)?.alwaysOnTop).toBe(true)
    expect(parsePetSettings(v2File)?.mousePassthrough).toBe(true)
  })

  it('缺失版本号的旧文件：按 v1 处理（补默认并升级）', () => {
    const migrated = migrateRawSettings({ petScale: 0.85 })
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.alwaysOnTop).toBe(false)
    expect(migrated.mousePassthrough).toBe(false)
    expect(migrated.petScale).toBe(0.85)
  })

  it('迁移不修改输入对象（返回新对象）', () => {
    const input = { schemaVersion: 1, petScale: 0.9 }
    migrateRawSettings(input)
    expect(input).toEqual({ schemaVersion: 1, petScale: 0.9 })
  })
})

describe('parsePetSettingsUpdate（更新载荷白名单校验）', () => {
  it('合法部分更新解析', () => {
    expect(parsePetSettingsUpdate({ walkSpeedPxPerSec: 75 })).toEqual({
      walkSpeedPxPerSec: 75
    })
    expect(parsePetSettingsUpdate({ autoActivityEnabled: false })).toEqual({
      autoActivityEnabled: false
    })
    expect(parsePetSettingsUpdate({ petScale: 0.85, runFrequency: 'high' })).toEqual({
      petScale: 0.85,
      runFrequency: 'high'
    })
  })

  it('空对象与非法形态返回 null', () => {
    expect(parsePetSettingsUpdate({})).toBeNull()
    expect(parsePetSettingsUpdate(null)).toBeNull()
    expect(parsePetSettingsUpdate('x')).toBeNull()
    expect(parsePetSettingsUpdate([])).toBeNull()
  })

  it('任何非法字段值整体拒绝（不做字段级静默回退）', () => {
    expect(parsePetSettingsUpdate({ walkSpeedPxPerSec: 200 })).toBeNull()
    expect(parsePetSettingsUpdate({ walkSpeedPxPerSec: Number.NaN })).toBeNull()
    expect(parsePetSettingsUpdate({ petScale: 1.3 })).toBeNull()
    expect(parsePetSettingsUpdate({ runFrequency: 'always' })).toBeNull()
    expect(parsePetSettingsUpdate({ autoActivityEnabled: 'false' })).toBeNull()
    // 合法字段 + 非法字段 → 整体拒绝
    expect(parsePetSettingsUpdate({ petScale: 0.8, restFrequency: 'mid' })).toBeNull()
  })

  it('未知字段被忽略（白名单外不进入更新）', () => {
    expect(parsePetSettingsUpdate({ evil: true, petScale: 0.9 })).toEqual({ petScale: 0.9 })
    // schemaVersion 不在白名单：renderer 不能修改
    expect(parsePetSettingsUpdate({ schemaVersion: 99 })).toBeNull()
  })

  it('Task 12C：置顶/穿透可更新（布尔白名单）', () => {
    expect(parsePetSettingsUpdate({ alwaysOnTop: true })).toEqual({ alwaysOnTop: true })
    expect(parsePetSettingsUpdate({ mousePassthrough: false })).toEqual({ mousePassthrough: false })
    expect(parsePetSettingsUpdate({ alwaysOnTop: true, mousePassthrough: true })).toEqual({
      alwaysOnTop: true,
      mousePassthrough: true
    })
  })

  it('Task 12C：非布尔置顶/穿透整体拒绝', () => {
    expect(parsePetSettingsUpdate({ alwaysOnTop: 'true' })).toBeNull()
    expect(parsePetSettingsUpdate({ alwaysOnTop: 1 })).toBeNull()
    expect(parsePetSettingsUpdate({ mousePassthrough: 'off' })).toBeNull()
    // 合法字段 + 非法新字段 → 整体拒绝
    expect(parsePetSettingsUpdate({ petScale: 0.9, alwaysOnTop: 'yes' })).toBeNull()
  })
})

describe('频率档位映射（normal = 已验收默认值）', () => {
  it('跑步频率：low 降低概率并延长冷却，high 提高概率并缩短冷却', () => {
    const low = deciderConfigForSettings(
      DEFAULT_BEHAVIOR_DECIDER_CONFIG,
      validSettings({ runFrequency: 'low' })
    )
    const high = deciderConfigForSettings(
      DEFAULT_BEHAVIOR_DECIDER_CONFIG,
      validSettings({ runFrequency: 'high' })
    )
    expect(low.runChance).toBeLessThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.runChance)
    expect(low.runCooldownSec).toBeGreaterThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.runCooldownSec)
    expect(high.runChance).toBeGreaterThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.runChance)
    expect(high.runCooldownSec).toBeLessThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.runCooldownSec)
    // high 概率上限合理（≤ 0.7）
    expect(high.runChance).toBeLessThanOrEqual(0.7)
  })

  it('跑步时长与速度倍率不受频率影响（只调概率与冷却）', () => {
    for (const level of FREQUENCY_LEVELS) {
      const config = deciderConfigForSettings(
        DEFAULT_BEHAVIOR_DECIDER_CONFIG,
        validSettings({ runFrequency: level })
      )
      expect(config.runDurationSec).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG.runDurationSec)
    }
  })

  it('休息频率：low 减少休息，high 增加休息', () => {
    const low = deciderConfigForSettings(
      DEFAULT_BEHAVIOR_DECIDER_CONFIG,
      validSettings({ restFrequency: 'low' })
    )
    const high = deciderConfigForSettings(
      DEFAULT_BEHAVIOR_DECIDER_CONFIG,
      validSettings({ restFrequency: 'high' })
    )
    expect(low.restChance).toBeLessThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.restChance)
    expect(low.restCooldownSec).toBeGreaterThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.restCooldownSec)
    expect(high.restChance).toBeGreaterThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.restChance)
    expect(high.restCooldownSec).toBeLessThan(DEFAULT_BEHAVIOR_DECIDER_CONFIG.restCooldownSec)
    // 休息时长与分流不受频率影响
    expect(high.restSitDurationSec).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG.restSitDurationSec)
    expect(high.restSitShare).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG.restSitShare)
  })

  it('未映射字段保持 base 不变', () => {
    const config = deciderConfigForSettings(
      DEFAULT_BEHAVIOR_DECIDER_CONFIG,
      validSettings({ runFrequency: 'high', restFrequency: 'low' })
    )
    expect(config.idleDurationSec).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG.idleDurationSec)
    expect(config.walkDurationSec).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG.walkDurationSec)
    expect(config.turnDurationSec).toEqual(DEFAULT_BEHAVIOR_DECIDER_CONFIG.turnDurationSec)
  })
})

describe('跑步速度倍率模型', () => {
  it('runSpeed = walk × 1.6（默认 96 = 1.6 × 60，与已验收值一致）', () => {
    expect(runSpeedForWalkSpeed(60)).toBe(96)
    expect(runSpeedForWalkSpeed(30)).toBe(48)
    expect(runSpeedForWalkSpeed(120)).toBe(192)
  })
})

describe('isNoOpSettingsUpdate（Task 12B-UI：不重复提交同一配置更新）', () => {
  it('全部字段与当前值一致 → 无变化（true）', () => {
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, {})).toBe(true)
    expect(
      isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, {
        autoActivityEnabled: true,
        petScale: 1,
        walkSpeedPxPerSec: 60,
        runFrequency: 'normal',
        restFrequency: 'normal'
      })
    ).toBe(true)
    expect(isNoOpSettingsUpdate(validSettings({ petScale: 0.85 }), { petScale: 0.85 })).toBe(true)
  })

  it('任一字段不同 → 有变化（false）', () => {
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { petScale: 0.9 })).toBe(false)
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { walkSpeedPxPerSec: 45 })).toBe(false)
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { autoActivityEnabled: false })).toBe(false)
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { runFrequency: 'low' })).toBe(false)
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { restFrequency: 'high' })).toBe(false)
    expect(
      isNoOpSettingsUpdate(validSettings({ petScale: 0.9 }), {
        petScale: 0.9,
        walkSpeedPxPerSec: 75
      })
    ).toBe(false)
  })

  it('Task 12C：置顶/穿透字段参与 no-op 判定', () => {
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { alwaysOnTop: false })).toBe(true)
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { mousePassthrough: false })).toBe(true)
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { alwaysOnTop: true })).toBe(false)
    expect(isNoOpSettingsUpdate(DEFAULT_PET_SETTINGS, { mousePassthrough: true })).toBe(false)
    expect(isNoOpSettingsUpdate(validSettings({ alwaysOnTop: true }), { alwaysOnTop: true })).toBe(
      true
    )
  })
})
