/**
 * Task 11F 开发预览控制（仅开发环境加载）。
 *
 * 本模块只允许通过 PetCanvas 中的 `import.meta.env.DEV` 动态导入加载：
 * 生产构建时该分支为死代码，Vite 会整段剔除（已用产物检索验证），
 * 因此不会在发行版本中出现任何预览入口。
 *
 * 交互：点击桌宠窗口取得焦点后按键：
 * - S 或 1：预览坐下
 * - L 或 2：预览趴卧
 * - U 或 3：起身（恢复站立）
 * - R 或 4：重播当前姿态的进入动画
 *
 * 隔离机制（Task 11F-B 更新）：
 * - 预览通过 PetCanvas 注入的 request 回调触发姿态播放；PetCanvas 在
 *   姿态真正开始时经开发专用窄 IPC 暂停主进程自动行为（坐下/趴卧期间
 *   窗口不再自动移动），恢复站立/真实状态接管/卸载时恢复；
 * - 真实视觉状态优先：walking/turning/dragging/paused 时 PetCanvas 会
 *   立即 interrupt() 姿态播放并呈现真实状态；
 * - 状态标签 pointer-events:none，不影响拖动；仅显示在窗口内角落。
 */

import type { PostureKind } from './pet-posture'

export interface PosturePreviewOptions {
  /** 请求进入姿态 / 恢复站立（null） */
  request: (kind: PostureKind | null) => void
  /** 重播进入动画 */
  replayEnter: () => void
  /** 状态文本（真实状态与预览状态并排展示） */
  getStatus: () => string
}

type PreviewAction = 'sit' | 'lie' | 'stand' | 'replay'

const KEY_MAP: Readonly<Record<string, PreviewAction>> = {
  s: 'sit',
  '1': 'sit',
  l: 'lie',
  '2': 'lie',
  u: 'stand',
  '3': 'stand',
  r: 'replay',
  '4': 'replay'
}

const HINT = '预览 S 坐下 / L 趴卧 / U 起身 / R 重播'

/**
 * 在宿主元素内挂载预览控制（键盘监听 + 状态角标）。
 * 返回卸载函数：移除监听器、定时器与 DOM；恢复宿主样式。
 */
export function mountPosturePreview(host: HTMLElement, options: PosturePreviewOptions): () => void {
  const previousPosition = host.style.position
  host.style.position = 'relative'

  const label = document.createElement('div')
  label.dataset.posturePreview = 'true'
  label.textContent = HINT
  Object.assign(label.style, {
    position: 'absolute',
    left: '2px',
    bottom: '2px',
    maxWidth: '236px',
    padding: '1px 4px',
    fontSize: '9px',
    lineHeight: '1.4',
    color: '#333',
    background: 'rgba(255,255,255,0.55)',
    borderRadius: '3px',
    pointerEvents: 'none',
    userSelect: 'none',
    zIndex: '10'
  } satisfies Partial<CSSStyleDeclaration>)
  host.appendChild(label)

  const updateLabel = (): void => {
    label.textContent = `${HINT}｜${options.getStatus()}`
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const action = KEY_MAP[event.key.toLowerCase()]
    if (action === undefined) {
      return
    }
    event.preventDefault()
    if (action === 'sit') {
      options.request('sit')
    } else if (action === 'lie') {
      options.request('lie')
    } else if (action === 'stand') {
      options.request(null)
    } else {
      options.replayEnter()
    }
    updateLabel()
  }

  window.addEventListener('keydown', onKeyDown)
  const timer = window.setInterval(updateLabel, 250)

  return (): void => {
    window.removeEventListener('keydown', onKeyDown)
    window.clearInterval(timer)
    label.remove()
    host.style.position = previousPosition
  }
}
