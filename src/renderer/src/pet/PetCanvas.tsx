import { useEffect } from 'react'
import { Application, Graphics } from 'pixi.js'
import {
  PET_CANVAS_HEIGHT,
  PET_CANVAS_WIDTH,
  PET_PLACEHOLDER_COLOR,
  PET_PLACEHOLDER_RADIUS
} from '../../../shared/pet-config'
import { usePetDrag } from './use-pet-drag'

/**
 * 幺幺桌宠画布容器（Task 6 动画系统的扩展点）。
 * 当前仅做最小 PixiJS Application 挂载与占位圆形，
 * 验证 PixiJS 依赖集成与资源生命周期清理；
 * 容器同时承载拖动交互（usePetDrag）。
 */
function PetCanvas(): React.JSX.Element {
  const containerRef = usePetDrag()

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const app = new Application()
    let initialised = false
    let cancelled = false

    void app
      .init({
        width: PET_CANVAS_WIDTH,
        height: PET_CANVAS_HEIGHT,
        // 画布背景完全透明，与透明窗口配合；否则画布底色会覆盖窗口透明效果。
        backgroundAlpha: 0,
        antialias: true
      })
      .then(() => {
        // 组件在异步初始化期间被卸载时，直接销毁实例，不再挂载到 DOM。
        if (cancelled) {
          app.destroy(true, { children: true })
          return
        }
        initialised = true
        container.appendChild(app.canvas)

        const placeholder = new Graphics()
          .circle(PET_CANVAS_WIDTH / 2, PET_CANVAS_HEIGHT / 2, PET_PLACEHOLDER_RADIUS)
          .fill(PET_PLACEHOLDER_COLOR)
        app.stage.addChild(placeholder)
      })
      .catch((error: unknown) => {
        console.error('[PetCanvas] PixiJS 初始化失败，界面降级为空白占位', error)
      })

    return () => {
      cancelled = true
      if (initialised) {
        app.destroy(true, { children: true })
      }
    }
  }, [])

  return <div ref={containerRef} className="pet-canvas" aria-label="幺幺占位画布" />
}

export default PetCanvas
