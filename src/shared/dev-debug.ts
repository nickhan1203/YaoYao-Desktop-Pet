/**
 * 开发调试控制协议（Task 11H-C，纯逻辑，无 Electron 依赖）。
 *
 * 用途：开发调试面板按钮 → 主进程行为运行时的受控调试接口。
 * 安全边界：
 * - 通道常量仅供 preload（contextBridge 暴露的固定方法）与主进程
 *（仅 !app.isPackaged 时注册 handler）使用；生产环境发送到未注册
 * 通道为无操作；
 * - 命令为固定字符串枚举，载荷经 parseDevDebugCommand 白名单校验，
 * 不接受任意结构；
 * - 主进程仍是窗口运动与行为状态的唯一权威——本协议只是触发
 * 运行时已有的状态机事件，不绕过状态机。
 */

/** 面板按钮命令（IPC 载荷；'resume-auto' 释放调试控制恢复自动决策） */
export type DevDebugCommand = 'idle' | 'walk' | 'run' | 'sit' | 'lie' | 'resume-auto'

/** 调试强制目标（行为运行时 debugForceBehavior 参数） */
export type DebugBehaviorTarget = 'idle' | 'walking' | 'running' | 'sitting' | 'lying'

/** 调试命令通道（renderer → 主进程，send，载荷为 DevDebugCommand） */
export const DEV_DEBUG_COMMAND_CHANNEL = 'pet:dev-debug-command'

/** 调试状态查询通道（renderer → 主进程，invoke，返回 DevDebugState） */
export const DEV_DEBUG_GET_STATE_CHANNEL = 'pet:dev-debug-get-state'

const DEV_DEBUG_COMMANDS: ReadonlySet<DevDebugCommand> = new Set([
  'idle',
  'walk',
  'run',
  'sit',
  'lie',
  'resume-auto'
])

/**
 * 解析并校验调试命令载荷：仅接受白名单内的字符串，其余（包括
 * 非字符串、伪造结构）一律返回 null（调用方忽略）。
 */
export function parseDevDebugCommand(payload: unknown): DevDebugCommand | null {
  if (typeof payload !== 'string') {
    return null
  }
  return DEV_DEBUG_COMMANDS.has(payload as DevDebugCommand) ? (payload as DevDebugCommand) : null
}

/** 调试状态查询结果 */
export interface DevDebugState {
  /** 是否处于调试控制模式（自动决策已挂起） */
  debugControlled: boolean
}

/** 校验调试状态查询结果载荷 */
export function isDevDebugState(payload: unknown): payload is DevDebugState {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { debugControlled?: unknown }).debugControlled === 'boolean'
  )
}
