/**
 * 应用控制菜单模型（纯逻辑，无 Electron 依赖，可被 Vitest 直接测试）。
 *
 * Task 12A：托盘菜单与桌宠右键菜单共享同一套命令与状态推导，
 * 主进程权威状态（AppControlState）→ 菜单描述符列表。
 * Electron Menu 的构建只是描述符的薄适配（main/app-tray.ts），
 * renderer 不参与菜单业务逻辑（安全边界：renderer 只能发送
 * "打开菜单"的无载荷请求，菜单内容完全由主进程决定）。
 */

/** 菜单可触发的控制命令（主进程生命周期控制器逐一实现，均幂等） */
export type AppControlCommand =
  | 'toggle-pause'
  | 'toggle-visibility'
  | 'toggle-always-on-top'
  | 'toggle-mouse-passthrough'
  | 'reset-position'
  | 'open-settings'
  | 'quit-application'

/** 单个菜单项描述符（Electron 适配层据此创建 menuItem） */
export interface AppMenuItemDescriptor {
  command: AppControlCommand
  label: string
  /**
   * 勾选型菜单项的当前勾选状态（Task 12C：置顶/穿透）；
   * 普通命令项为 undefined（非勾选型）。
   */
  checked?: boolean
}

/** 主进程权威控制状态（菜单推导的唯一输入） */
export interface AppControlState {
  /** 用户主动暂停中（菜单显示"继续活动"） */
  paused: boolean
  /** 幺幺当前隐藏中（菜单显示"显示幺幺"） */
  hidden: boolean
  /** 窗口置顶开关（Task 12C，勾选型） */
  alwaysOnTop: boolean
  /** 鼠标穿透开关（Task 12C，勾选型；开启期间右键菜单不可用，
   * 托盘始终保留关闭入口） */
  mousePassthrough: boolean
}

/**
 * 由权威状态推导菜单项（顺序固定：暂停 → 显隐 → 置顶 → 穿透 →
 * 重置 → 设置 → 退出）。同一状态推导结果确定，托盘与右键菜单
 * 不会互相矛盾；勾选型项 checked 直接来自主进程权威状态。
 */
export function buildAppMenuItems(state: AppControlState): AppMenuItemDescriptor[] {
  return [
    { command: 'toggle-pause', label: state.paused ? '继续活动' : '暂停活动' },
    { command: 'toggle-visibility', label: state.hidden ? '显示幺幺' : '隐藏幺幺' },
    { command: 'toggle-always-on-top', label: '始终置顶', checked: state.alwaysOnTop },
    { command: 'toggle-mouse-passthrough', label: '鼠标穿透', checked: state.mousePassthrough },
    { command: 'reset-position', label: '重置位置' },
    { command: 'open-settings', label: '设置...' },
    { command: 'quit-application', label: '退出应用' }
  ]
}
