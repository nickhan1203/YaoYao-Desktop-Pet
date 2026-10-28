/**
 * 幺幺桌宠视觉状态协议（主进程 → renderer 单向广播的载荷定义与校验）。
 *
 * 职责：把行为运行时的权威状态（状态机 kind + 行走朝向）表达为
 * 可序列化的最小载荷，供 preload 校验后递给 renderer 的动画/视觉层。
 *
 * 设计约束：
 * - kind 复用 pet-state-machine 的状态联合（PetState['kind']），
 *   不为视觉通信重建第二套状态机，也不改变现有转换规则；
 * - facing 忠实于行为决策器的四向行走方向（WALK_DIRECTIONS），
 *   不从窗口位置推断朝向；
 * - 校验函数 isPetVisualState 供 preload 使用：IPC 载荷是不可信输入，
 *   结构不合法的载荷不得被 renderer 当作合法状态使用。
 */

import type { PetState } from './pet-state-machine'
import type { Vec2 } from './movement-controller'

/** 视觉朝向：与行为运行时的行走方向一一对应（左/右/上/下） */
export type PetFacing = 'left' | 'right' | 'up' | 'down'

/** 视觉状态载荷：当前行为状态 + 当前朝向 */
export interface PetVisualState {
  /** 行为状态（与状态机 PetState['kind'] 完全一致） */
  kind: PetState['kind']
  /** 当前朝向；非行走期沿用最近一次行走方向 */
  facing: PetFacing
}

const VALID_KINDS: ReadonlySet<PetState['kind']> = new Set([
  'idle',
  'walking',
  'turning',
  'paused',
  'dragging'
])

const VALID_FACINGS: ReadonlySet<PetFacing> = new Set(['left', 'right', 'up', 'down'])

/**
 * 结构校验：判断任意 IPC 载荷是否为合法的视觉状态。
 * 只要求必需字段合法，不禁止额外字段（向前兼容）。
 */
export function isPetVisualState(value: unknown): value is PetVisualState {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<PetVisualState>
  return (
    typeof candidate.kind === 'string' &&
    VALID_KINDS.has(candidate.kind as PetState['kind']) &&
    typeof candidate.facing === 'string' &&
    VALID_FACINGS.has(candidate.facing as PetFacing)
  )
}

/**
 * 由行走方向单位向量推导视觉朝向。
 * x 分量优先（左右行走在视觉上以水平镜像区分）；
 * 零向量或非法向量保守回退为 right（与运行时初始方向一致）。
 */
export function toPetFacing(direction: Vec2): PetFacing {
  if (Number.isFinite(direction.x) && Number.isFinite(direction.y)) {
    if (direction.x < 0) {
      return 'left'
    }
    if (direction.x > 0) {
      return 'right'
    }
    if (direction.y < 0) {
      return 'up'
    }
    if (direction.y > 0) {
      return 'down'
    }
  }
  return 'right'
}

/**
 * 订阅所需的最小 IPC 能力（结构化接口，不依赖 electron，
 * 供 preload 注入 ipcRenderer 的受控子集、供单元测试注入假实现）。
 * listener 形状与 ipcRenderer 一致（首参为事件对象，载荷在后）。
 */
export interface VisualStateIpc {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void
  invoke(channel: string): Promise<unknown>
}

/**
 * 创建视觉状态订阅（preload 订阅逻辑的可测实现）。
 *
 * 行为：
 * - 订阅即通过 invoke 查询当前状态并回调一次（不依赖监听到第一条广播）；
 * - 之后每次合法广播回调一次；非法载荷丢弃；
 * - 竞态安全：若广播先于查询响应到达（查询返回的是旧快照），
 *   旧快照不会覆盖已收到的新状态；
 * - 取消订阅后：不再接收广播，迟到的查询响应也不会触发回调；
 * - 查询失败（如主进程未注册 handler）仅记录告警，不产生未处理 rejection。
 *
 * 返回幂等的取消订阅函数。
 */
export function createVisualStateSubscription(
  ipc: VisualStateIpc,
  broadcastChannel: string,
  queryChannel: string,
  callback: (state: PetVisualState) => void
): () => void {
  let unsubscribed = false
  let receivedBroadcast = false
  const listener = (_event: unknown, payload: unknown): void => {
    if (unsubscribed || !isPetVisualState(payload)) {
      return
    }
    receivedBroadcast = true
    callback(payload)
  }
  ipc.on(broadcastChannel, listener)
  void ipc
    .invoke(queryChannel)
    .then((payload: unknown) => {
      if (unsubscribed || receivedBroadcast || !isPetVisualState(payload)) {
        return
      }
      callback(payload)
    })
    .catch((error: unknown) => {
      console.warn('[pet-visual-state] 查询当前视觉状态失败:', error)
    })
  return (): void => {
    if (unsubscribed) {
      return
    }
    unsubscribed = true
    ipc.removeListener(broadcastChannel, listener)
  }
}
