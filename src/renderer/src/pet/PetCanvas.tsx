import { useEffect, useState } from 'react'
// Electron sandbox renderer 禁用 eval：PixiJS 默认 shader 编译需要
// unsafe-eval 支持，必须改用官方 CSP-safe 入口（不放松 sandbox）。
import 'pixi.js/unsafe-eval'
import { Application, Graphics, Sprite, Texture } from 'pixi.js'
import {
  PET_CANVAS_HEIGHT,
  PET_CANVAS_WIDTH,
  PET_PLACEHOLDER_COLOR,
  PET_PLACEHOLDER_RADIUS
} from '../../../shared/pet-config'
import type { PetVisualState } from '../../../shared/pet-visual-state'
import { usePetDrag } from './use-pet-drag'
import idleAssetUrl from '../assets/pet/idle/idle-01.png'

/**
 * 加载图片元素（onload 路径）。
 * 不用 PixiJS Assets.load：其在 Electron sandbox + file:// 组合环境下
 * promise 既不 resolve 也不 reject（已实测挂起，见任务报告已知问题）；
 * HTMLImageElement 的 onload/onerror 路径在同一环境完全稳定。
 */
function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = (): void => resolve(image)
    image.onerror = (): void => reject(new Error(`图片加载失败: ${url}`))
    image.src = url
  })
}

/**
 * 幺幺桌宠画布容器（动画系统的扩展点）。
 * 静态角色渲染：加载透明 PNG 后以 Sprite 显示，
 * 按画布尺寸等比缩放（不拉伸变形）、中心锚点定位；
 * 图片加载失败时降级为占位圆形（素材缺失优雅降级），
 * 不影响窗口透明配置与既有行为系统；容器同时承载拖动交互（usePetDrag）。
 *
 * 视觉状态订阅：经 preload 窄接口接收主进程广播的当前状态与朝向，
 * 本任务仅建立链路（data 属性可观察），动画接入留给后续任务；
 * renderer 不实现任何行为决策或窗口移动逻辑。
 */
function PetCanvas(): React.JSX.Element {
  const containerRef = usePetDrag()
  const [visualState, setVisualState] = useState<PetVisualState | null>(null)

  useEffect(() => {
    const unsubscribe = window.yaoyao?.subscribeVisualState((state) => {
      setVisualState(state)
    })
    return (): void => {
      unsubscribe?.()
    }
  }, [])

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

        // 降级占位：素材加载失败时保持画布非空，不破坏窗口与行为系统。
        const showPlaceholder = (): void => {
          const placeholder = new Graphics()
            .circle(PET_CANVAS_WIDTH / 2, PET_CANVAS_HEIGHT / 2, PET_PLACEHOLDER_RADIUS)
            .fill(PET_PLACEHOLDER_COLOR)
          app.stage.addChild(placeholder)
        }

        void loadImageElement(idleAssetUrl)
          .then((image) => {
            // 图片加载期间组件已卸载：不再操作已销毁的 stage。
            if (cancelled) {
              return
            }
            const texture = Texture.from(image)
            const sprite = new Sprite(texture)
            // 等比缩放到画布内（当前 480×480 原图 → 240×240 显示，
            // 按纹理实际尺寸计算，任意尺寸原图均不变形）。
            const scale = Math.min(
              PET_CANVAS_WIDTH / texture.width,
              PET_CANVAS_HEIGHT / texture.height
            )
            sprite.scale.set(scale)
            sprite.anchor.set(0.5)
            sprite.position.set(PET_CANVAS_WIDTH / 2, PET_CANVAS_HEIGHT / 2)
            app.stage.addChild(sprite)
          })
          .catch((error: unknown) => {
            console.error('[PetCanvas] 角色图片加载失败，降级为占位圆形:', idleAssetUrl, error)
            if (!cancelled) {
              showPlaceholder()
            }
          })
      })
      .catch((error: unknown) => {
        console.error('[PetCanvas] PixiJS 初始化失败，界面降级为空白占位', error)
      })

    return () => {
      cancelled = true
      if (initialised) {
        // 销毁应用与 stage 拥有的显示对象（含 Sprite 与纹理源）。
        app.destroy(true, { children: true })
      }
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="pet-canvas"
      aria-label="幺幺画布"
      data-visual-state={visualState ? `${visualState.kind}:${visualState.facing}` : undefined}
    />
  )
}

export default PetCanvas
