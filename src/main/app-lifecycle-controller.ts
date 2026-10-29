/**
 * 应用生命周期控制器（Task 12A，可注入端口、可被 Vitest 直接测试）。
 *
 * 职责：作为托盘菜单 / 桌宠右键菜单共用的主进程控制入口，协调
 * 行为运行时（唯一暂停状态机）与桌宠窗口的显隐、位置与退出：
 * - pauseActivity / resumeActivity：用户主动暂停/继续（复用运行时
 *   paused 状态，不创建第二套暂停状态机）；
 * - hidePet / showPet：隐藏不销毁窗口；隐藏期间复用运行时 paused
 *   冻结行为计时（等效节能），显示时恢复并做工作区边界修正；
 * - resetPetPosition：右下角重置到当前显示器工作区，显示移除时
 *   回退主显示器；拖动中忽略（避免与拖动轮询竞争）；
 * - quitApplication：真正的应用退出（幂等），清理顺序由接线层
 *   通过 onBeforeQuit 钩子完成托盘销毁，运行时停止后 app.quit。
 *
 * 暂停归属模型（避免多模块争夺一个布尔值）：
 * - userPaused：用户通过菜单表达的暂停意图（本模块持有）；
 * - hidden：窗口隐藏标记（本模块持有）；
 * - 生效暂停 = userPaused || hidden，reconcile() 据此调用运行时
 *   pause/resume——运行时内部仍只有一套 paused 状态机。
 * 因此"隐藏前已暂停的用户状态，显示后仍保持暂停"自然成立；
 * 调试面板的恢复（debugResumeAutoBehavior）只释放调试控制，
 * 不触碰 paused，不会意外解除用户暂停。
 *
 * 幂等性：所有命令重复调用无副作用；quitting 后忽略一切菜单命令
 * （退出进行中收到菜单操作不会复活应用）。
 */

import {
  clampPlacementToWorkArea,
  computePetPlacement,
  type WorkAreaRect
} from '../shared/pet-placement'

/** 行为运行时所需的最小能力（测试注入假实现） */
export interface LifecycleRuntimePort {
  pause(): void
  resume(): void
  /** 主进程权威：当前是否处于暂停（含拖动中挂起的暂停，复用状态机语义） */
  isPaused(): boolean
  /** 是否正在拖动（重置位置安全检查） */
  isDragging(): boolean
  /** 停止运行循环（幂等） */
  stop(): void
  /** 外部移动窗口后同步运行时位置基准（防止下一 tick 拉回旧位置） */
  syncWindowPosition(): void
}

/** 桌宠窗口所需的最小能力（测试注入假实现） */
export interface LifecycleWindowPort {
  readonly width: number
  readonly height: number
  hide(): void
  /** 恢复显示（不抢夺其他应用焦点） */
  showInactive(): void
  isVisible(): boolean
  isDestroyed(): boolean
  getPosition(): { x: number; y: number }
  setPosition(x: number, y: number): void
}

/** 显示器工作区所需的最小能力（测试注入假实现） */
export interface LifecycleDisplayPort {
  /** 指定点所在显示器的工作区；无可用显示器时返回 null */
  getNearestWorkArea(point: { x: number; y: number }): WorkAreaRect | null
  /** 主显示器工作区（回退目标） */
  getPrimaryWorkArea(): WorkAreaRect
}

export interface LifecycleControllerPorts {
  runtime: LifecycleRuntimePort
  window: LifecycleWindowPort
  displays: LifecycleDisplayPort
  /** 退出前清理钩子（接线层销毁托盘等）；先于运行时停止执行 */
  onBeforeQuit: () => void
  /** 真正发起应用退出（接线层实现为 app.quit()） */
  quit: () => void
  /** 重置/显示时使用的窗口停靠边距 */
  positionMargin: number
}

export type ResetPositionResult = 'moved' | 'ignored-dragging' | 'unavailable'

export class AppLifecycleController {
  private readonly ports: LifecycleControllerPorts
  /** 用户主动暂停意图（菜单"暂停活动"设置） */
  private userPaused = false
  /** 窗口隐藏标记 */
  private hidden = false
  /** 退出进行中（幂等保护 + 菜单命令忽略） */
  private quitting = false

  constructor(ports: LifecycleControllerPorts) {
    this.ports = ports
  }

  /** 暂停活动（幂等）：隐藏中仅记录意图，恢复显示后仍保持暂停 */
  pauseActivity(): void {
    if (this.quitting) {
      return
    }
    this.userPaused = true
    this.reconcileRuntimePause()
  }

  /** 继续活动（幂等）：不清除隐藏标记（隐藏中继续 → 显示后正常运行） */
  resumeActivity(): void {
    if (this.quitting) {
      return
    }
    this.userPaused = false
    this.reconcileRuntimePause()
  }

  /** 隐藏幺幺（幂等）：不销毁窗口；隐藏期间冻结行为计时 */
  hidePet(): void {
    if (this.quitting) {
      return
    }
    this.hidden = true
    if (!this.ports.window.isDestroyed()) {
      this.ports.window.hide()
    }
    this.reconcileRuntimePause()
  }

  /**
   * 显示幺幺（幂等）：
   * - 不重建窗口（销毁态除外，重建由接线层负责）；
   * - 原位置超出当前工作区时边界修正（含显示器移除回退主显示器）；
   * - 修正位置后同步运行时基准，防止行走 tick 拉回；
   * - 显示不抢占其他应用焦点（showInactive）；
   * - 用户暂停状态不受显示影响（reconcile 保持 paused）。
   */
  showPet(): void {
    if (this.quitting) {
      return
    }
    if (this.ports.window.isDestroyed()) {
      // 窗口已销毁的异常路径：仅解除隐藏标记并恢复行为，
      // 窗口重建由接线层的 activate 逻辑负责。
      this.hidden = false
      this.reconcileRuntimePause()
      return
    }
    const position = this.ports.window.getPosition()
    const workArea =
      this.ports.displays.getNearestWorkArea({
        x: position.x + this.ports.window.width / 2,
        y: position.y + this.ports.window.height / 2
      }) ?? this.ports.displays.getPrimaryWorkArea()
    const clamped = clampPlacementToWorkArea(
      position,
      workArea,
      this.ports.window.width,
      this.ports.window.height
    )
    if (clamped.x !== position.x || clamped.y !== position.y) {
      this.ports.window.setPosition(clamped.x, clamped.y)
      this.ports.runtime.syncWindowPosition()
    }
    this.hidden = false
    this.ports.window.showInactive()
    this.reconcileRuntimePause()
  }

  /**
   * 重置位置（右下角停靠当前显示器工作区）：
   * - 拖动中忽略（与拖动轮询的位置更新竞争不安全）；
   * - 当前显示器工作区不可用时回退主显示器；
   * - 重置后同步运行时位置基准：新 Y 即新的水平行走轨道，
   *   运行时不会在下一 tick 拉回旧位置。
   */
  resetPetPosition(): ResetPositionResult {
    if (this.quitting) {
      return 'unavailable'
    }
    if (this.ports.runtime.isDragging() || this.ports.window.isDestroyed()) {
      // 拖动中重置会与主进程拖动轮询竞争窗口位置：安全忽略。
      return 'ignored-dragging'
    }
    const position = this.ports.window.getPosition()
    const workArea =
      this.ports.displays.getNearestWorkArea({
        x: position.x + this.ports.window.width / 2,
        y: position.y + this.ports.window.height / 2
      }) ?? this.ports.displays.getPrimaryWorkArea()
    if (workArea.width <= 0 || workArea.height <= 0) {
      return 'unavailable'
    }
    const placement = computePetPlacement(
      workArea,
      this.ports.window.width,
      this.ports.window.height,
      this.ports.positionMargin
    )
    this.ports.window.setPosition(placement.x, placement.y)
    this.ports.runtime.syncWindowPosition()
    return 'moved'
  }

  /**
   * 退出应用（幂等）：清理顺序
   * onBeforeQuit（销毁托盘等）→ 运行时停止 → quit()（app.quit，
   * 由 Electron 完成窗口销毁与进程收尾，不使用 process.exit）。
   * 重复调用直接返回，不产生重入异常。
   */
  quitApplication(): void {
    if (this.quitting) {
      return
    }
    this.quitting = true
    this.ports.onBeforeQuit()
    this.ports.runtime.stop()
    this.ports.quit()
  }

  /** 退出是否进行中（菜单命令忽略判定） */
  get isQuitting(): boolean {
    return this.quitting
  }

  /** 主进程权威控制状态（托盘/右键菜单共享的唯一状态来源） */
  getControlState(): { paused: boolean; hidden: boolean } {
    return { paused: this.userPaused, hidden: this.hidden }
  }

  /**
   * 按生效暂停（userPaused || hidden）对齐运行时 paused 状态。
   * 运行时内部语义（paused.restore、拖动中挂起暂停）由状态机保证，
   * 这里只做方向性对齐，双向幂等。
   */
  private reconcileRuntimePause(): void {
    const effectivePaused = this.userPaused || this.hidden
    if (effectivePaused && !this.ports.runtime.isPaused()) {
      this.ports.runtime.pause()
    } else if (!effectivePaused && this.ports.runtime.isPaused()) {
      this.ports.runtime.resume()
    }
  }
}
