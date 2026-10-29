import { lazy } from 'react'
import PetCanvas from './pet/PetCanvas'
import { SettingsPanel } from './pet/SettingsPanel'
import { PET_WINDOW_TITLE } from '../../shared/pet-config'

/**
 * 开发调试面板路由（Task 11H-C）：主进程在开发构建中创建的独立面板窗口
 * 加载 `#dev-panel` 哈希，本组件据此挂载 DevBehaviorPanel；桌宠窗口
 *（无该哈希）照常渲染 PetCanvas。
 *
 * 生产隔离：import.meta.env.DEV 在生产构建被替换为 false，三元分支连同
 * 动态 import 一起被死代码消除（与 posture-preview 移除前同一模式），
 * 面板组件不会进入生产产物，也不存在可操作的调试入口。
 */
const DevBehaviorPanel =
  import.meta.env.DEV && window.location.hash === '#dev-panel'
    ? lazy(() => import('./pet/DevBehaviorPanel').then((m) => ({ default: m.DevBehaviorPanel })))
    : null

/**
 * 设置窗口路由（Task 12B，正式用户功能，生产构建同样生效）：
 * 主进程创建的设置窗口加载 `#settings` 哈希，挂载 SettingsPanel；
 * 桌宠窗口（无该哈希）照常渲染 PetCanvas。
 */
function App(): React.JSX.Element {
  if (window.location.hash === '#settings') {
    return (
      <main className="app" aria-label="幺幺设置">
        <SettingsPanel />
      </main>
    )
  }
  if (DevBehaviorPanel !== null) {
    return (
      <main className="app" aria-label="幺幺开发调试面板">
        <DevBehaviorPanel />
      </main>
    )
  }
  return (
    <main className="app" aria-label={PET_WINDOW_TITLE}>
      <PetCanvas />
    </main>
  )
}

export default App
