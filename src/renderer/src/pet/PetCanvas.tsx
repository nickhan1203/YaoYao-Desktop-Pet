import { useEffect, useRef, useState } from 'react'
// Electron sandbox renderer 禁用 eval：PixiJS 默认 shader 编译需要
// unsafe-eval 支持，必须改用官方 CSP-safe 入口（不放松 sandbox）。
import 'pixi.js/unsafe-eval'
import { Application, AnimatedSprite, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { Ticker } from 'pixi.js'
import {
  PET_CANVAS_HEIGHT,
  PET_CANVAS_WIDTH,
  PET_PLACEHOLDER_COLOR,
  PET_PLACEHOLDER_RADIUS
} from '../../../shared/pet-config'
import type { PetVisualState } from '../../../shared/pet-visual-state'
import { usePetDrag } from './use-pet-drag'
import {
  CHARACTER_SCALE,
  DisplayCommand,
  IDLE_FRAME_URL,
  PetDisplayController,
  resolveAssetLoadOutcome,
  TICKER_FPS,
  toAnimationSpeed,
  WALK_FPS,
  WALK_FRAME_URLS
} from './pet-animation'

/**
 * 加载图片元素（onload 路径，Task 9B 已验收）。
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
 * 幺幺桌宠画布容器（行为渲染层）。
 *
 * 职责（本任务新增行走动画接入）：
 * - idle 静态帧 + 8 帧行走 AnimatedSprite（8 FPS 循环，autoUpdate=false，
 *   由 app.ticker 统一驱动，避免多 ticker 与后台标签页时间源问题）；
 * - 状态映射与朝向镜像完全由纯逻辑层 pet-animation 决定，
 *   本组件只把 DisplayCommand 翻译为 Pixi 显示对象属性；
 * - 镜像通过角色容器负 scaleX 实现（翻转轴穿过脚底参考点，
 *   不做窗口位置补偿）；
 * - 素材异步加载期间状态变化：以 ref 保存最新状态，加载完成后
 *   应用最新状态（最新状态胜出）；
 * - 降级：walk 任一帧失败 → 整组不播放（行走退回静态 idle）；
 *   idle 失败 → 占位圆形（沿用 Task 9B 降级链）。
 *
 * renderer 不实现任何行为决策或窗口移动逻辑；
 * 容器同时承载拖动交互（usePetDrag）。
 */
function PetCanvas(): React.JSX.Element {
  const containerRef = usePetDrag()
  const [visualState, setVisualState] = useState<PetVisualState | null>(null)
  const visualStateRef = useRef<PetVisualState | null>(null)
  const controllerRef = useRef<PetDisplayController | null>(null)

  useEffect(() => {
    const unsubscribe = window.yaoyao?.subscribeVisualState((state) => {
      // ref 始终保存最新状态：素材异步加载完成后应用的就是最新值。
      visualStateRef.current = state
      // 重复广播（相同命令）由控制器幂等跳过，不重启动画、不重置帧序号。
      controllerRef.current?.apply(state)
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
    let detachTicker: (() => void) | null = null

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

        // 降级占位：素材全部加载失败时保持画布非空，不破坏窗口与行为系统。
        const showPlaceholder = (): void => {
          const placeholder = new Graphics()
            .circle(PET_CANVAS_WIDTH / 2, PET_CANVAS_HEIGHT / 2, PET_PLACEHOLDER_RADIUS)
            .fill(PET_PLACEHOLDER_COLOR)
          app.stage.addChild(placeholder)
        }

        // idle + 8 帧 walk 并行加载，任一失败不拖垮其余资源（allSettled）。
        return Promise.allSettled([
          loadImageElement(IDLE_FRAME_URL),
          ...WALK_FRAME_URLS.map(loadImageElement)
        ]).then((results) => {
          if (cancelled) {
            return
          }
          const [idleResult, ...walkResults] = results
          const outcome = resolveAssetLoadOutcome(idleResult, walkResults)
          if (outcome.failures.length > 0) {
            console.warn('[PetCanvas] 部分角色素材加载失败，按规则降级:', outcome.failures)
          }
          if (outcome.idle === null && outcome.walk === null) {
            showPlaceholder()
            return
          }

          // 角色容器：位置与缩放（含镜像符号）由显示命令唯一决定。
          const character = new Container()
          app.stage.addChild(character)

          // idle 视觉：素材优先，缺失时以占位圆形充当（在 480 本地坐标系绘制）。
          const idleVisual: Sprite | Graphics =
            outcome.idle !== null
              ? new Sprite(Texture.from(outcome.idle))
              : new Graphics()
                  .circle(240, 240, PET_PLACEHOLDER_RADIUS / CHARACTER_SCALE)
                  .fill(PET_PLACEHOLDER_COLOR)
          character.addChild(idleVisual)

          // 行走动画：仅当 8 帧全部加载成功才创建（整组降级语义）。
          let walkSprite: AnimatedSprite | null = null
          if (outcome.walk !== null) {
            const walkAnimated = new AnimatedSprite(
              outcome.walk.map((image) => Texture.from(image))
            )
            walkAnimated.animationSpeed = toAnimationSpeed(WALK_FPS, TICKER_FPS)
            walkAnimated.loop = true
            // 统一时间源：禁用内部 ticker，由 app.ticker 驱动（单一 ticker）。
            walkAnimated.autoUpdate = false
            walkAnimated.visible = false
            character.addChild(walkAnimated)
            walkSprite = walkAnimated

            const onTick = (ticker: Ticker): void => {
              // Pixi 8 语义：update 接收 Ticker；未播放时自身早退，安全。
              walkAnimated.update(ticker)
            }
            app.ticker.add(onTick)
            detachTicker = (): void => {
              app.ticker.remove(onTick)
            }
          }

          // 显示命令 → Pixi 属性的唯一翻译点。
          const applyCommand = (command: DisplayCommand): void => {
            character.position.set(command.positionX, command.positionY)
            character.scale.set(command.scaleX, command.scaleY)
            // walk 整组降级时行走状态退回静态 idle（walkSprite 为 null）。
            const wantWalk = command.showWalk && walkSprite !== null
            idleVisual.visible = !wantWalk
            if (walkSprite !== null) {
              walkSprite.visible = wantWalk
              if (wantWalk) {
                // idle → walking 的重新开始：从头播放；
                // 重复广播被控制器幂等拦截，不会走到这里重置帧序号。
                if (!walkSprite.playing) {
                  walkSprite.gotoAndPlay(0)
                }
              } else {
                walkSprite.stop()
              }
            }
          }

          const controller = new PetDisplayController(applyCommand)
          // 应用加载期间累积的最新状态（最新状态胜出）。
          controller.apply(visualStateRef.current)
          controllerRef.current = controller
        })
      })
      .catch((error: unknown) => {
        console.error('[PetCanvas] PixiJS 初始化失败，界面降级为空白占位', error)
      })

    return () => {
      cancelled = true
      controllerRef.current = null
      detachTicker?.()
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
