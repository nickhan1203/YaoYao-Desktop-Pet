/**
 * 受控交互取消通道（Task 12C，纯协议常量，无 Electron 依赖）。
 *
 * 方向：主进程 → 桌宠 renderer，无载荷窄通道信号。
 * 触发场景：拖动进行中用户开启鼠标穿透——setIgnoreMouseEvents 后
 * pointerup/pointercancel 不再保证送达 renderer，若不主动取消，
 * dragging 状态、held 动画与窗口跟随将失去收口。renderer 收到信号后
 * 复用 Task 11J 的取消语义（tracker.cancel → onDrop → 幂等补发
 * dragEnd + held→dropping 落地动画），主进程则同步 handleDragEnd
 *（拖动轮询停止、落地保护照常计时）。
 *
 * 安全边界：无载荷、renderer 不发送；主进程仅在开启穿透且运行时
 * 处于 dragging 时发送。
 */
export const INTERACTION_CANCEL_CHANNEL = 'pet:cancel-interaction'
