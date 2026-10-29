import { describe, expect, it, vi } from 'vitest'
import { LoginItemController, LOGIN_ITEM_DEV_MODE_REASON } from '../src/main/login-item-controller'
import { parseLoginItemUpdate } from '../src/shared/login-item'

interface Harness {
  controller: LoginItemController
  setLoginItemSettings: ReturnType<typeof vi.fn>
  getLoginItemSettings: ReturnType<typeof vi.fn>
}

/** 内存登录项 API 模拟：openAtLogin 状态由 set/get 真实联动（可注入失败） */
function makeHarness(options?: {
  packaged?: boolean
  getThrows?: boolean
  setThrows?: boolean
  /** set 后实际生效值（模拟系统拒绝/需批准：与请求不一致） */
  effectiveAfterSet?: boolean
}): Harness {
  let registered = false
  const setLoginItemSettings = vi.fn((settings: { openAtLogin: boolean }): void => {
    if (options?.setThrows) {
      throw new Error('permission denied')
    }
    if (options?.effectiveAfterSet === undefined) {
      registered = settings.openAtLogin
    } else {
      registered = options.effectiveAfterSet
    }
  })
  const getLoginItemSettings = vi.fn((): { openAtLogin: boolean } => {
    if (options?.getThrows) {
      throw new Error('read failed')
    }
    return { openAtLogin: registered }
  })
  const controller = new LoginItemController({
    api: { setLoginItemSettings, getLoginItemSettings },
    isPackaged: options?.packaged ?? true
  })
  return { controller, setLoginItemSettings, getLoginItemSettings }
}

describe('LoginItemController.readStatus（读取系统实际状态）', () => {
  it('默认关闭策略：未注册时 enabled=false（首次启动不主动注册）', () => {
    const h = makeHarness()
    expect(h.controller.readStatus()).toEqual({ supported: true, enabled: false })
    expect(h.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('读取系统实际开关状态（每次实时查询，无缓存）', () => {
    const h = makeHarness()
    h.controller.setEnabled(true)
    expect(h.controller.readStatus()).toEqual({ supported: true, enabled: true })
    // 外部（系统设置）修改后再次读取立即反映新状态
    h.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: false })
    expect(h.controller.readStatus()).toEqual({ supported: true, enabled: false })
    expect(h.getLoginItemSettings).toHaveBeenCalledTimes(3)
  })

  it('读取失败按"未注册"展示（不假定注册成功），开关仍可用', () => {
    const h = makeHarness({ getThrows: true })
    expect(h.controller.readStatus()).toEqual({ supported: true, enabled: false })
  })
})

describe('LoginItemController.setEnabled（注册与注销）', () => {
  it('正式构建中开启注册：调用官方 API 且写后读回复核', () => {
    const h = makeHarness()
    expect(h.controller.setEnabled(true)).toEqual({ ok: true })
    expect(h.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(h.controller.readStatus().enabled).toBe(true)
  })

  it('正式构建中关闭注册：注销同样读回复核', () => {
    const h = makeHarness()
    h.controller.setEnabled(true)
    expect(h.controller.setEnabled(false)).toEqual({ ok: true })
    expect(h.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false })
    expect(h.controller.readStatus().enabled).toBe(false)
  })

  it('开发模式拒绝系统写入（dev 实例永不成为登录项）', () => {
    const h = makeHarness({ packaged: false })
    expect(h.controller.setEnabled(true)).toEqual({ ok: false, reason: LOGIN_ITEM_DEV_MODE_REASON })
    expect(h.controller.setEnabled(false)).toEqual({
      ok: false,
      reason: LOGIN_ITEM_DEV_MODE_REASON
    })
    expect(h.setLoginItemSettings).not.toHaveBeenCalled()
    expect(h.controller.readStatus()).toEqual({ supported: false, enabled: false })
  })

  it('注册失败处理：API 抛错捕获并返回失败原因（不崩溃、不显示虚假成功）', () => {
    const h = makeHarness({ setThrows: true })
    const result = h.controller.setEnabled(true)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('permission denied')
    }
    // 失败后状态未被污染：仍可重试
    expect(h.controller.readStatus().enabled).toBe(false)
  })

  it('写后读回复核：系统未生效（如 macOS 需批准）返回失败', () => {
    const h = makeHarness({ effectiveAfterSet: false })
    const result = h.controller.setEnabled(true)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('系统未生效')
    }
    expect(h.controller.readStatus().enabled).toBe(false)
  })

  it('注销未生效同样返回失败（不显示虚假的已保存）', () => {
    // 已注册状态请求注销，但系统拒绝（effective 保持 true）
    let registered = true
    const api = {
      setLoginItemSettings: vi.fn((): void => {
        /* 系统拒绝：状态不变 */
      }),
      getLoginItemSettings: vi.fn((): { openAtLogin: boolean } => ({ openAtLogin: registered }))
    }
    const controller = new LoginItemController({ api, isPackaged: true })
    const result = controller.setEnabled(false)
    expect(result.ok).toBe(false)
    registered = false
  })

  it('连续快速切换：顺序执行，最后操作状态正确', () => {
    const h = makeHarness()
    h.controller.setEnabled(true)
    h.controller.setEnabled(false)
    h.controller.setEnabled(true)
    expect(h.controller.readStatus().enabled).toBe(true)
    expect(h.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true })
  })

  it('重复设置幂等：同值再注册仍返回成功', () => {
    const h = makeHarness()
    h.controller.setEnabled(true)
    expect(h.controller.setEnabled(true)).toEqual({ ok: true })
  })
})

describe('parseLoginItemUpdate（IPC 载荷校验）', () => {
  it('仅接受严格布尔（其余整体拒绝）', () => {
    expect(parseLoginItemUpdate(true)).toBe(true)
    expect(parseLoginItemUpdate(false)).toBe(false)
    expect(parseLoginItemUpdate('true')).toBeNull()
    expect(parseLoginItemUpdate(1)).toBeNull()
    expect(parseLoginItemUpdate(null)).toBeNull()
    expect(parseLoginItemUpdate({ enabled: true })).toBeNull()
    expect(parseLoginItemUpdate(undefined)).toBeNull()
  })
})
