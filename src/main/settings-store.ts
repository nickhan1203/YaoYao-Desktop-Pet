/**
 * 设置持久化存储（Task 12B）。
 *
 * 职责：userData 下应用专属 JSON 文件的读取与原子写入。
 * - 读取：文件不存在 → null（调用方用默认值）；损坏/非法 JSON →
 *   parseSettings 报告 degraded，调用方安全降级到默认值（不影响启动）；
 * - 写入：先写临时文件再 rename 原子替换（降低写入中断产生半文件的风险）；
 * - 文件系统访问经 SettingsFileAdapter 注入（测试用内存实现），
 *   本模块不含 Electron 依赖，可被 Vitest 直接测试。
 */

import { DEFAULT_PET_SETTINGS, parsePetSettings, type PetSettings } from '../shared/pet-settings'

/** 文件系统最小适配器（生产实现基于 node:fs，测试注入内存实现） */
export interface SettingsFileAdapter {
  /** 读取文件内容；文件不存在或不可读返回 null */
  read(): string | null
  /** 原子写入（临时文件 + rename）；失败抛异常 */
  writeAtomic(content: string): void
}

export interface LoadedSettings {
  settings: PetSettings
  /** true = 文件存在但损坏/非法，已降级到默认值 */
  degraded: boolean
}

export class PetSettingsStore {
  private readonly adapter: SettingsFileAdapter

  constructor(adapter: SettingsFileAdapter) {
    this.adapter = adapter
  }

  /**
   * 读取并校验设置：
   * - 文件不存在 → 默认值（degraded=false）；
   * - JSON 解析失败或结构非法 → 默认值（degraded=true，安全降级）；
   * - 合法文件 → 字段级回退后的干净对象（未知字段不进入业务逻辑）。
   */
  load(): LoadedSettings {
    const content = this.adapter.read()
    if (content === null) {
      return { settings: { ...DEFAULT_PET_SETTINGS }, degraded: false }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return { settings: { ...DEFAULT_PET_SETTINGS }, degraded: true }
    }
    const settings = parsePetSettings(parsed)
    if (settings === null) {
      return { settings: { ...DEFAULT_PET_SETTINGS }, degraded: true }
    }
    return { settings, degraded: false }
  }

  /**
   * 持久化设置（原子替换）。写入失败向上抛出（调用方负责反馈），
   * 不假装保存成功。
   */
  persist(settings: PetSettings): void {
    this.adapter.writeAtomic(JSON.stringify(settings, null, 2))
  }
}
