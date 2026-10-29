import { useEffect, useState } from 'react'
import type { PetVisualState } from '../../../shared/pet-visual-state'
import { PET_RUN_SPEED_PX_PER_SEC, PET_WALK_SPEED_PX_PER_SEC } from '../../../shared/pet-config'
import { isDevDebugState, type DevDebugCommand } from '../../../shared/dev-debug'

/**
 * 幺幺开发调试面板（Task 11H-C，仅开发构建加载）。
 *
 * 架构与安全边界：
 * - 主进程是行为状态与窗口运动的唯一权威：本面板不直接操作 DOM/PixiJS
 *   伪造行为，只通过 preload 暴露的窄 IPC（devDebugCommand / getDevDebugState）
 *   向主进程发送白名单命令；真实移动由主进程行为运行时完成；
 * - 状态显示来自真实视觉状态广播/查询（与桌宠窗口同一数据源）；
 * - 调试控制模式期间主进程跳过自动决策（窗口仍按当前状态真实移动）；
 *   "恢复自动行为"按钮释放调试控制，自动决策从当前状态继续；
 * - 清理：卸载时取消订阅与轮询定时器，不遗留监听器/计时器；
 * - 生产构建本组件不参与打包（App.tsx 的 DEV 门控动态导入）。
 */

const COMMAND_BUTTONS: ReadonlyArray<{ command: DevDebugCommand; label: string }> = [
  { command: 'idle', label: '站立/待机' },
  { command: 'walk', label: '行走' },
  { command: 'run', label: '跑步' },
  { command: 'sit', label: '坐下' },
  { command: 'lie', label: '趴卧' },
  { command: 'resume-auto', label: '恢复自动行为' }
]

const POLL_INTERVAL_MS = 500

const FACING_LABELS: Readonly<Record<PetVisualState['facing'], string>> = {
  left: '左',
  right: '右',
  up: '上（保留字）',
  down: '下（保留字）'
}

function speedForKind(kind: PetVisualState['kind'] | '未知'): number {
  if (kind === 'walking') {
    return PET_WALK_SPEED_PX_PER_SEC
  }
  if (kind === 'running') {
    return PET_RUN_SPEED_PX_PER_SEC
  }
  return 0
}

export function DevBehaviorPanel(): React.JSX.Element {
  const [visualState, setVisualState] = useState<PetVisualState | null>(null)
  const [debugControlled, setDebugControlled] = useState(false)

  useEffect(() => {
    // 真实状态订阅：立即回调当前状态，之后每次变化回调（与桌宠同源）。
    const unsubscribe = window.yaoyao?.subscribeVisualState((state) => {
      setVisualState(state)
    })
    // 调试控制状态轮询：invoke 查询（生产环境无 handler 时 reject，忽略）。
    const timer = window.setInterval(() => {
      void window.yaoyao
        ?.getDevDebugState()
        .then((payload): void => {
          if (isDevDebugState(payload)) {
            setDebugControlled(payload.debugControlled)
          }
        })
        .catch((): void => {
          // 生产环境（无 handler）或面板关闭竞态：忽略
        })
    }, POLL_INTERVAL_MS)
    return (): void => {
      unsubscribe?.()
      window.clearInterval(timer)
    }
  }, [])

  const kind = visualState?.kind ?? '未知'
  const facing = visualState?.facing ?? null

  return (
    <section
      className="dev-panel"
      aria-label="幺幺开发调试面板"
      data-debug-controlled={debugControlled}
    >
      <h1>幺幺调试面板（仅开发）</h1>
      <ul className="dev-panel-status">
        <li>
          当前行为状态：<strong data-status-kind={kind}>{kind}</strong>
        </li>
        <li>
          当前朝向：
          <strong data-status-facing={facing ?? '未知'}>
            {facing !== null ? FACING_LABELS[facing] : '未知'}
          </strong>
        </li>
        <li>
          当前移动速度：<strong>{speedForKind(kind)} px/s</strong>
        </li>
        <li>
          调试控制模式：
          <strong>{debugControlled ? '是（自动决策已挂起）' : '否'}</strong>
        </li>
      </ul>
      <div className="dev-panel-buttons">
        {COMMAND_BUTTONS.map(({ command, label }) => (
          <button
            key={command}
            type="button"
            data-debug-command={command}
            onClick={(): void => {
              window.yaoyao?.devDebugCommand(command)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="dev-panel-note">
        主进程为行为与窗口运动唯一权威；调试命令经白名单窄 IPC 触发真实状态机转换。
      </p>
    </section>
  )
}
