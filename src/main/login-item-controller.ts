/**
 * 登录自启动控制器（Task 12E，可注入端口，可被 Vitest 直接测试）。
 *
 * 职责：把"登录时自动启动"映射为 Electron 官方登录项 API：
 * - 读取：app.getLoginItemSettings().openAtLogin（每次实时读取，
 *   不缓存——用户在系统设置外部修改后，下次查询立即反映）；
 * - 写入：app.setLoginItemSettings({ openAtLogin })；写后读回复核
 *   （setLoginItemSettings 无返回值，openAtLogin 未生效即失败，
 *   覆盖 macOS requires-approval / 权限不足等场景，不显示虚假成功）；
 * - 开发环境保护（本任务重点）：未打包环境一律拒绝系统写入并返回
 *   不可用状态——`npm run dev` 的 Electron 实例（指向 node_modules
 *   临时可执行文件）永不注册为系统登录项；读取在 dev 下同样不触碰
 *   系统 API（避免与打包应用的同名登录项混淆），展示为不可用。
 *
 * 平台适配：macOS 默认 mainAppService（SMAppService，Electron 44 默认）；
 * Windows 默认注册当前 exe 的 HKCU Run 键（NSIS per-user 安装路径稳定）。
 * 不传自定义 path/args——始终注册当前运行的可执行文件，不开放任意
 * 路径或系统命令参数（安全边界）。
 */

import type { LoginItemStatus } from '../shared/login-item'

/** Electron 登录项 API 最小端口（测试注入假实现） */
export interface LoginItemPort {
  /** 写入登录项（Electron API 无返回值，成功与否经读回复核） */
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
  /** 读取登录项实际注册状态 */
  getLoginItemSettings(): { openAtLogin: boolean }
}

export interface LoginItemPorts {
  /** Electron app 登录项 API（主进程接线层注入） */
  api: LoginItemPort
  /** 是否为正式打包环境（app.isPackaged） */
  isPackaged: boolean
}

/** 写入操作结果：成功或失败（含面向用户的原因） */
export type LoginItemUpdateResult = { ok: true } | { ok: false; reason: string }

/** 开发模式不可用提示（设置页与错误反馈共用同一文案来源） */
export const LOGIN_ITEM_DEV_MODE_REASON = '开发模式下不可修改系统登录项，请使用正式打包应用验证'

export class LoginItemController {
  private readonly ports: LoginItemPorts

  constructor(ports: LoginItemPorts) {
    this.ports = ports
  }

  /**
   * 读取当前登录项状态（每次实时查询，无缓存）。
   * 开发模式：supported=false（不触碰系统 API，开关禁用并提示）。
   */
  readStatus(): LoginItemStatus {
    if (!this.ports.isPackaged) {
      return { supported: false, enabled: false }
    }
    try {
      return { supported: true, enabled: this.ports.api.getLoginItemSettings().openAtLogin }
    } catch {
      // 读取失败按"未注册"展示（不假定注册成功），开关仍可用可重试。
      return { supported: true, enabled: false }
    }
  }

  /**
   * 注册/注销登录项（仅正式打包环境）：
   * - dev 拒绝（防止开发实例成为系统登录项）；
   * - 写后读回复核：openAtLogin 与请求不符即失败（覆盖 API 静默失效、
   *   macOS 需批准等场景，不显示虚假的"已保存"）；
   * - API 抛错：捕获并返回失败原因（不向上传播导致主进程崩溃）。
   */
  setEnabled(enabled: boolean): LoginItemUpdateResult {
    if (!this.ports.isPackaged) {
      return { ok: false, reason: LOGIN_ITEM_DEV_MODE_REASON }
    }
    try {
      this.ports.api.setLoginItemSettings({ openAtLogin: enabled })
      if (this.ports.api.getLoginItemSettings().openAtLogin !== enabled) {
        return {
          ok: false,
          reason: enabled ? '系统未生效（可能需要在系统设置中批准）' : '注销未生效，请稍后重试'
        }
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        reason: `系统登录项操作失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}
