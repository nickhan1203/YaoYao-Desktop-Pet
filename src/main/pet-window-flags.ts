/**
 * 桌宠窗口标志控制器（Task 12C，可注入端口，可被 Vitest 直接测试）。
 *
 * 职责：把用户设置的窗口置顶 / 鼠标穿透应用到桌宠 BrowserWindow：
 * - 只作用于桌宠窗口（设置窗口等普通管理窗口永不穿透）；
 * - 置顶：普通 always-on-top 层级（不使用 screen-saver 等过高层级，
 *   不承诺覆盖全屏游戏/系统安全界面），不改变坐标/尺寸/缩放/行为；
 * - 穿透开启的受控交互取消流程（最高优先级安全语义）：
 *   1. 若运行时处于 dragging：先经 IPC 通知 renderer 取消交互
 *      （复用 11J pointercancel/blur 语义：tracker.cancel → onDrop →
 *      补发幂等 dragEnd + held→dropping 落地动画），再由主进程同步
 *      handleDragEnd 结束拖动（停止窗口跟随鼠标，落地保护照常）；
 *   2. 之后才 setIgnoreMouseEvents(true)——此后 pointer 事件不再送达，
 *      但 renderer 交互状态已被受控收口，不会出现 dragging 卡住、
 *      held 无限循环或窗口跟随旧鼠标位置；
 * - 穿透关闭：恢复点击/右键/拎起/拖动，不重建窗口、不重注册事件；
 * - API 失败（抛异常/返回 false）：返回 false 由调用方（设置控制器）
 *   回滚该字段并反馈，不留下"设置说开了但窗口没开"的矛盾状态。
 *
 * 托盘恢复入口保证：穿透只改变鼠标命中，不影响托盘/设置窗口/主进程
 * 行为；隐藏/暂停/退出流程与本模块正交。
 */

/** 桌宠窗口最小能力端口（测试注入假实现） */
export interface PetWindowFlagsWindowPort {
  setAlwaysOnTop(enabled: boolean): void
  setIgnoreMouseEvents(ignore: boolean): void
  isDestroyed(): boolean
}

/** 行为运行时最小能力端口（拖动竞态收口） */
export interface PetWindowFlagsRuntimePort {
  /** 主进程权威：是否正在拖动 */
  isDragging(): boolean
  /** 结束拖动（幂等：非拖动状态为无操作；落地保护照常计时） */
  handleDragEnd(): void
}

/** 受控交互取消通知端口（主进程 → 桌宠 renderer 的窄 IPC） */
export interface PetWindowFlagsNotifyPort {
  /** 通知 renderer 取消进行中的指针交互（无载荷窄通道信号） */
  notifyInteractionCancel(): void
}

export interface PetWindowFlagsPorts {
  window: PetWindowFlagsWindowPort
  runtime: PetWindowFlagsRuntimePort
  notifier: PetWindowFlagsNotifyPort
}

export class PetWindowFlagsController {
  private readonly ports: PetWindowFlagsPorts

  constructor(ports: PetWindowFlagsPorts) {
    this.ports = ports
  }

  /**
   * 应用窗口置顶（幂等）。成功返回 true；窗口销毁或 Electron API
   * 抛错返回 false（调用方回滚设置并反馈）。
   */
  applyAlwaysOnTop(enabled: boolean): boolean {
    if (this.ports.window.isDestroyed()) {
      return false
    }
    try {
      // 普通 always-on-top 层级：不抢占焦点、不改坐标/尺寸。
      this.ports.window.setAlwaysOnTop(enabled)
      return true
    } catch {
      return false
    }
  }

  /**
   * 应用鼠标穿透（幂等）。开启前先执行受控交互取消（见模块注释）；
   * 成功返回 true；窗口销毁或 API 抛错返回 false（调用方回滚设置，
   * 不进入无法交互又未生效的矛盾状态）。
   */
  applyMousePassthrough(enabled: boolean): boolean {
    if (this.ports.window.isDestroyed()) {
      return false
    }
    try {
      if (enabled) {
        // 受控取消必须先于 setIgnoreMouseEvents：保证 renderer 在失去
        // 指针事件前收到取消信号（IPC 不受鼠标事件忽略影响，但顺序
        // 保证拖动窗口跟随先停止）。
        if (this.ports.runtime.isDragging()) {
          this.ports.notifier.notifyInteractionCancel()
          this.ports.runtime.handleDragEnd()
        }
        this.ports.window.setIgnoreMouseEvents(true)
      } else {
        this.ports.window.setIgnoreMouseEvents(false)
      }
      return true
    } catch {
      return false
    }
  }
}
