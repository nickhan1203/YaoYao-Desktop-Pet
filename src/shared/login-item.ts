/**
 * 登录自启动协议常量与类型（Task 12E，纯逻辑，无 Electron 依赖）。
 *
 * 权威关系设计：操作系统登录项是唯一权威（app.getLoginItemSettings），
 * 本任务不新增 settings.json 字段——用户可经系统设置手动修改登录项，
 * JSON 布尔缓存会立即过期形成双权威矛盾；设置页每次挂载与每次操作后
 * 实时读取系统状态刷新显示。
 *
 * IPC 通道（与 settings 同一模式：invoke 查询 + send 更新 + 单向广播）：
 * - GET：renderer 查询当前登录项状态（invoke，返回 LoginItemStatus）；
 * - UPDATE：renderer 发送布尔载荷请求注册/注销（send，主进程全量校验）；
 * - CHANGED：注册/注销成功后的状态广播（主进程 → 设置窗口）；
 * - ERROR：操作失败反馈（含可展示原因，主进程 → 设置窗口）。
 */
export const LOGIN_ITEM_GET_CHANNEL = 'pet:get-login-item'
export const LOGIN_ITEM_UPDATE_CHANNEL = 'pet:update-login-item'
export const LOGIN_ITEM_CHANGED_CHANNEL = 'pet:login-item-changed'
export const LOGIN_ITEM_ERROR_CHANNEL = 'pet:login-item-error'

/**
 * 登录项状态（renderer 展示用）。
 * - supported=false：当前环境不可用（开发模式等），开关禁用并提示；
 * - enabled：系统实际注册状态（读取时刻的快照，非缓存）。
 */
export interface LoginItemStatus {
  supported: boolean
  enabled: boolean
}

/** 登录项操作失败反馈（reason 面向用户的中文提示） */
export interface LoginItemError {
  reason: string
}

/** 登录项更新载荷校验：仅接受严格布尔值（其余形态整体拒绝） */
export function parseLoginItemUpdate(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}
