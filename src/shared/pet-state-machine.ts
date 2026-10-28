/**
 * 幺幺桌宠行为状态机（纯逻辑，无 Electron/React/PixiJS/DOM/计时器依赖，
 * 可被 Vitest 直接测试；renderer 与主进程均可引用）。
 *
 * 状态模型（判别联合，避免任意字符串与布尔组合）：
 * - idle：待机，无自动行为进行中。
 * - walking：行走中（自动行为）。
 * - turning：转向中（自动行为）。
 * - paused：已暂停，restore 记录暂停前的自动行为状态；RESUME 时恢复。
 * - dragging：用户拖动中，restore 记录拖动前的状态（自动行为或 paused），
 *   拖动结束后恢复到 restore，避免无条件回到 walking。
 *
 * 优先级：dragging > paused > 自动行为（walking / turning）。
 *
 * 与 Task 3A 拖动接口的衔接约定（本任务不接入，仅预留）：
 * - use-pet-drag 跨过拖动阈值 → 发送 DRAG_START；
 * - 松手 / pointercancel / blur → 发送 DRAG_END；
 * - 拖动期间状态机处于 dragging，自动行为（WALK_START/TURN_START）被忽略。
 */

export interface IdleState {
  kind: 'idle'
}

export interface WalkingState {
  kind: 'walking'
}

export interface TurningState {
  kind: 'turning'
}

export interface PausedState {
  kind: 'paused'
  /** 暂停前的自动行为状态，RESUME 时恢复 */
  restore: AutoState
}

export interface DraggingState {
  kind: 'dragging'
  /** 拖动前的状态：自动行为状态或 paused（拖动前已暂停时，结束后回到 paused） */
  restore: AutoState | PausedState
}

/** 自动行为状态（可被 paused / dragging 中断的状态） */
export type AutoState = IdleState | WalkingState | TurningState

export type PetState = IdleState | WalkingState | TurningState | PausedState | DraggingState

export type PetEvent =
  /** 自动行为启动：开始行走（对应"自动行为启动或恢复"中的启动部分） */
  | { type: 'WALK_START' }
  /** 行走结束 → 待机 */
  | { type: 'WALK_END' }
  /** 开始转向（待机或行走中均可） */
  | { type: 'TURN_START' }
  /** 转向结束 → 待机 */
  | { type: 'TURN_END' }
  /** 用户开始拖动（对应 preload dragStart） */
  | { type: 'DRAG_START' }
  /** 用户结束拖动（对应 preload dragEnd） */
  | { type: 'DRAG_END' }
  /** 暂停自动行为 */
  | { type: 'PAUSE' }
  /** 继续自动行为（"自动行为恢复"事件） */
  | { type: 'RESUME' }

export const INITIAL_PET_STATE: PetState = { kind: 'idle' }

/**
 * 状态转换（纯函数）。
 *
 * 不适用事件的处理规则（明确且稳定）：返回原状态，不重置、不抛异常。
 * 判别联合保证任意时刻只有一个 kind，不会出现矛盾的状态组合。
 */
export function transition(state: PetState, event: PetEvent): PetState {
  switch (event.type) {
    case 'WALK_START': {
      // 仅待机时可开始行走；paused 阻止自动行为；dragging 期间忽略自动行为。
      if (state.kind === 'idle') {
        return { kind: 'walking' }
      }
      return state
    }

    case 'WALK_END': {
      if (state.kind === 'walking') {
        return { kind: 'idle' }
      }
      return state
    }

    case 'TURN_START': {
      // 待机或行走中均可开始转向；paused / dragging 期间忽略。
      if (state.kind === 'idle' || state.kind === 'walking') {
        return { kind: 'turning' }
      }
      return state
    }

    case 'TURN_END': {
      if (state.kind === 'turning') {
        return { kind: 'idle' }
      }
      return state
    }

    case 'DRAG_START': {
      // 拖动优先级最高：从任何非 dragging 状态进入 dragging，
      // 记录拖动前的状态（含 paused）用于恢复。
      if (state.kind === 'dragging') {
        return state
      }
      return { kind: 'dragging', restore: state }
    }

    case 'DRAG_END': {
      // 仅 dragging 状态下有效；恢复到拖动前状态
      // （拖动前已暂停则回到 paused，不会无条件进入 walking）。
      if (state.kind === 'dragging') {
        return state.restore
      }
      return state
    }

    case 'PAUSE': {
      switch (state.kind) {
        case 'idle':
        case 'walking':
        case 'turning': {
          return { kind: 'paused', restore: state }
        }
        case 'dragging': {
          // 拖动期间暂停：拖动结束后应回到 paused 而不是恢复自动行为。
          if (state.restore.kind === 'paused') {
            return state
          }
          return { kind: 'dragging', restore: { kind: 'paused', restore: state.restore } }
        }
        case 'paused': {
          return state
        }
      }
      return state
    }

    case 'RESUME': {
      switch (state.kind) {
        case 'paused': {
          return state.restore
        }
        case 'dragging': {
          // 拖动期间继续：解除挂起的暂停标记，仍保持 dragging。
          if (state.restore.kind === 'paused') {
            return { kind: 'dragging', restore: state.restore.restore }
          }
          return state
        }
        default: {
          return state
        }
      }
    }
  }
}

/** 判断当前是否处于自动行为进行中（walking / turning）。 */
export function isAutoActive(state: PetState): boolean {
  return state.kind === 'walking' || state.kind === 'turning'
}

/** 判断当前是否处于拖动中。 */
export function isDragging(state: PetState): boolean {
  return state.kind === 'dragging'
}

/** 判断当前是否处于暂停（含拖动中挂起的暂停）。 */
export function isPaused(state: PetState): boolean {
  if (state.kind === 'paused') {
    return true
  }
  return state.kind === 'dragging' && state.restore.kind === 'paused'
}
