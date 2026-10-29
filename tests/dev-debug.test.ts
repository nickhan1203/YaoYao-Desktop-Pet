import { describe, expect, it } from 'vitest'
import {
  DEV_DEBUG_COMMAND_CHANNEL,
  DEV_DEBUG_GET_STATE_CHANNEL,
  isDevDebugState,
  parseDevDebugCommand
} from '../src/shared/dev-debug'

describe('Task 11H-C：开发调试命令解析（IPC 载荷白名单校验）', () => {
  it('六个合法命令字符串通过校验', () => {
    expect(parseDevDebugCommand('idle')).toBe('idle')
    expect(parseDevDebugCommand('walk')).toBe('walk')
    expect(parseDevDebugCommand('run')).toBe('run')
    expect(parseDevDebugCommand('sit')).toBe('sit')
    expect(parseDevDebugCommand('lie')).toBe('lie')
    expect(parseDevDebugCommand('resume-auto')).toBe('resume-auto')
  })

  it('非法载荷一律拒绝（返回 null，不抛错）', () => {
    expect(parseDevDebugCommand('fly')).toBeNull()
    expect(parseDevDebugCommand('')).toBeNull()
    expect(parseDevDebugCommand('IDLE')).toBeNull()
    expect(parseDevDebugCommand('idle ')).toBeNull()
    expect(parseDevDebugCommand(42)).toBeNull()
    expect(parseDevDebugCommand(null)).toBeNull()
    expect(parseDevDebugCommand(undefined)).toBeNull()
    expect(parseDevDebugCommand({ command: 'idle' })).toBeNull()
    expect(parseDevDebugCommand(['idle'])).toBeNull()
    expect(parseDevDebugCommand(true)).toBeNull()
  })

  it('通道常量为固定窄通道（与主进程/preload 注册一致）', () => {
    expect(DEV_DEBUG_COMMAND_CHANNEL).toBe('pet:dev-debug-command')
    expect(DEV_DEBUG_GET_STATE_CHANNEL).toBe('pet:dev-debug-get-state')
  })
})

describe('Task 11H-C：调试状态载荷校验', () => {
  it('合法结构通过；非法结构拒绝', () => {
    expect(isDevDebugState({ debugControlled: true })).toBe(true)
    expect(isDevDebugState({ debugControlled: false })).toBe(true)
    expect(isDevDebugState({ debugControlled: 'yes' })).toBe(false)
    expect(isDevDebugState({})).toBe(false)
    expect(isDevDebugState(null)).toBe(false)
    expect(isDevDebugState('true')).toBe(false)
    expect(isDevDebugState({ debugControlled: true, extra: 1 })).toBe(true)
  })
})
