/**
 * 系统托盘控制器（Task 12A）。
 *
 * 职责：
 * - 单一 Tray 实例（ensureTray 幂等，重复调用不会创建重复图标）；
 * - 图标（Task 13）：托盘使用与应用图标独立的单色轮廓图——
 *   - macOS：16px 模板 PNG（@1x + @2x 双表示，文件名 Template 约定
 *     自动模板化，菜单栏深浅主题自动适配轮廓颜色）；
 *   - Windows：32px 黑色轮廓（通知区域浅色背景为主，后续如需
 *     跟随主题可经 tray.setImage 切换白色版本）。
 *   托盘图标与打包应用图标（build/icon.icns、icon.ico）互不影响；
 *   菜单、点击行为、关闭入口与 12C 勾选项完全不变。
 * - 菜单：由 shared/app-menu-model 的纯逻辑描述符构建（状态驱动，
 *   每次状态变化重建并 setContextMenu，托盘与右键菜单状态必然一致）；
 * - 平台点击习惯：
 *   - macOS：setContextMenu 后左键即弹出菜单（菜单栏应用惯例）；
 *   - Windows：右键弹出上下文菜单（setContextMenu 惯例），
 *     左键切换幺幺显示/隐藏（通知区域图标常见行为）；
 * - destroy：销毁 Tray 实例（其全部事件监听随实例释放），幂等。
 *
 * 安全边界：菜单内容完全由主进程权威状态推导，renderer 不传递任何
 * 菜单模板或 Electron 参数。
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import trayTemplatePath from '../../resources/tray/yaoyaoTemplate.png?asset'
import trayTemplate2xPath from '../../resources/tray/yaoyaoTemplate@2x.png?asset'
import trayBlack32Path from '../../resources/tray/tray-black-32.png?asset'
import {
  buildAppMenuItems,
  type AppControlCommand,
  type AppControlState
} from '../shared/app-menu-model'

/** 菜单命令执行入口（生命周期控制器，由接线层注入） */
export type AppControlExecutor = (command: AppControlCommand) => void

/**
 * 创建托盘图标（Task 13，平台分支）：
 * - macOS：16px 模板图 + @2x 双表示（Retina 清晰；Template 命名约定
 *   由 Electron 自动 setTemplateImage，深浅菜单栏自动适配）；
 * - Windows：32px 黑色轮廓（通知区域默认浅色背景）。
 */
function createTrayIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(trayTemplatePath)
    if (!icon.isEmpty()) {
      const icon2x = nativeImage.createFromPath(trayTemplate2xPath)
      if (!icon2x.isEmpty()) {
        icon.addRepresentation({ scaleFactor: 2, buffer: icon2x.toPNG(), width: 16, height: 16 })
      }
      icon.setTemplateImage(true)
      return icon
    }
  }
  return nativeImage.createFromPath(trayBlack32Path)
}

export class AppTrayController {
  private tray: Tray | null = null
  private executor: AppControlExecutor | null = null
  /** 最近一次构建菜单的状态（updateMenu 幂等判定） */
  private lastMenuState: AppControlState | null = null

  /** 托盘是否已创建 */
  get isCreated(): boolean {
    return this.tray !== null && !this.tray.isDestroyed()
  }

  /**
   * 创建托盘（幂等）：已存在时仅刷新菜单，不重复创建实例
   * （防止重复图标）。
   */
  ensureTray(state: AppControlState, executor: AppControlExecutor): void {
    if (this.tray && !this.tray.isDestroyed()) {
      this.executor = executor
      this.updateMenu(state)
      return
    }
    this.executor = executor
    const icon = createTrayIcon()
    this.tray = new Tray(icon)
    this.tray.setToolTip('幺幺桌宠')
    // Windows：左键切换显示/隐藏（macOS 下 setContextMenu 使 click
    // 事件不触发，左键行为由菜单承担，符合平台习惯）。
    if (process.platform === 'win32') {
      this.tray.on('click', () => {
        this.executor?.('toggle-visibility')
      })
    }
    this.updateMenu(state)
  }

  /**
   * 按权威状态重建菜单（幂等）：状态未变化时不重复构建。
   * macOS 上 setContextMenu 后左键即显示该菜单；Windows 上右键显示。
   */
  updateMenu(state: AppControlState): void {
    if (!this.tray || this.tray.isDestroyed()) {
      return
    }
    if (
      this.lastMenuState !== null &&
      this.lastMenuState.paused === state.paused &&
      this.lastMenuState.hidden === state.hidden &&
      this.lastMenuState.alwaysOnTop === state.alwaysOnTop &&
      this.lastMenuState.mousePassthrough === state.mousePassthrough
    ) {
      return
    }
    this.lastMenuState = { ...state }
    this.tray.setContextMenu(this.buildMenu(state))
  }

  /**
   * 在桌宠窗口光标位置弹出右键菜单（与托盘菜单同源同状态）。
   * 菜单关闭后引用即释放，不持有长期监听。
   */
  popupPetContextMenu(state: AppControlState): void {
    // 回调式弹出（非阻塞）：同步 popup() 在 macOS 会阻塞主进程事件循环
    //（行为运行时 tick / 拖动轮询随之停摆）；callback 形式立即返回。
    // 默认在当前光标位置弹出（桌宠右键场景）。
    this.buildMenu(state).popup({ callback: (): undefined => undefined })
  }

  /** 销毁托盘（幂等）：退出时调用，图标与监听一并释放 */
  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy()
    }
    this.tray = null
    this.executor = null
    this.lastMenuState = null
  }

  /** 由纯逻辑描述符构建 Electron Menu（薄适配，无业务逻辑） */
  private buildMenu(state: AppControlState): Menu {
    const executor = this.executor
    const items: MenuItemConstructorOptions[] = buildAppMenuItems(state).map((descriptor) => ({
      label: descriptor.label,
      // Task 12C：勾选型菜单项（置顶/穿透）携带 checked，
      // undefined 保持普通命令项语义。
      ...(descriptor.checked === undefined
        ? {}
        : { type: 'checkbox' as const, checked: descriptor.checked }),
      click: (): void => {
        executor?.(descriptor.command)
      }
    }))
    return Menu.buildFromTemplate(items)
  }
}
