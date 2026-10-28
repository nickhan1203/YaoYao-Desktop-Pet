import { useEffect, useRef } from 'react'
import { Application, Graphics } from 'pixi.js'
import {
  PET_CANVAS_BACKGROUND,
  PET_CANVAS_HEIGHT,
  PET_CANVAS_WIDTH,
  PET_PLACEHOLDER_COLOR,
  PET_PLACEHOLDER_RADIUS
} from '../../../shared/pet-config'

/**
 * 幺幺桌宠画布容器（Task 6 动画系统的扩展点）。
 * 当前仅做最小 PixiJS Application 挂载与占位圆形，
 * 验证 PixiJS 依赖集成与资源生命周期清理。
 */
function PetCanvas(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

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
        background: PET_CANVAS_BACKGROUND,
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
