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
import {
  PetPostureController,
  POSTURE_FRAME_URLS,
  type PostureKind,
  type PostureSnapshot
} from './pet-posture'

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
 * 按 URL 记忆化的加载器（Task 11E-v2）：
 * v2 的 idle 静止帧与 walk 首帧共用同一 URL，同一 URL 只加载一次、
 * 只创建一个 Image 元素（Texture.from 以 image 元素为缓存键，
 * 元素唯一即纹理唯一，避免重复解码与重复纹理）。
 */
function createMemoizedImageLoader(): (url: string) => Promise<HTMLImageElement> {
  const cache = new Map<string, Promise<HTMLImageElement>>()
  return (url: string): Promise<HTMLImageElement> => {
    let pending = cache.get(url)
    if (!pending) {
      pending = loadImageElement(url)
      cache.set(url, pending)
    }
    return pending
  }
}

/** 姿态素材加载状态（按需懒加载：不影响初始 walk 展示） */
type PostureAssetStatus = 'unloaded' | 'loading' | 'ready' | 'failed'

/**
 * 幺幺桌宠画布容器（行为渲染层）。
 *
 * 职责：
 * - 基础显示：idle 静态帧 + 8 帧行走 AnimatedSprite（8 FPS 循环，
 *   autoUpdate=false，由 app.ticker 统一驱动，单一时间源）；
 * - 姿态播放（Task 11F）：sit/lie 的进入/保持（sit 含眨眼）/退出由
 *   纯逻辑层 pet-posture 驱动，本组件只按 snapshot 设置纹理与可见性；
 *   姿态素材按需懒加载，失败时该姿态不可用（回退基础 idle），
 *   不影响 walk 的加载与展示；
 * - 开发预览移动隔离（Task 11F-B）：姿态真正开始播放时经开发专用窄
 *   IPC 暂停主进程自动行为（主进程仅 !app.isPackaged 注册 handler，
 *   renderer 调用点生产构建死代码剔除），恢复站立/真实状态接管/卸载时
 *   恢复；请求姿态前校验真实状态为 idle，避免姿态叠加在自动行走上；
 * - 状态映射与朝向镜像完全由纯逻辑层决定（镜像通过角色容器负 scaleX，
 *   翻转轴穿过脚底参考点，不做窗口位置补偿）；
 * - 真实视觉状态优先：非 idle 状态（walking/turning/dragging/paused）
 *   立即中断姿态播放并呈现真实状态；姿态播放不改变主进程行为；
 * - 素材异步加载期间状态变化：以 ref 保存最新状态，加载完成后
 *   应用最新状态（最新状态胜出）；
 * - 降级：walk 任一帧失败 → 整组不播放（行走退回静态 idle）；
 *   idle 失败 → 占位圆形（沿用 Task 9B 降级链）；
 * - 开发预览：仅 import.meta.env.DEV 下动态挂载（posture-preview），
 *   生产构建整段剔除，不出现预览入口。
 *
 * renderer 不实现任何行为决策或窗口移动逻辑；
 * 容器同时承载拖动交互（usePetDrag）。
 */
function PetCanvas(): React.JSX.Element {
  const containerRef = usePetDrag()
  const [visualState, setVisualState] = useState<PetVisualState | null>(null)
  const visualStateRef = useRef<PetVisualState | null>(null)
  const controllerRef = useRef<PetDisplayController | null>(null)
  const postureControllerRef = useRef<PetPostureController | null>(null)
  /** 开发预览期间是否已暂停主进程自动行为（防重复发送挂起/恢复信号） */
  const previewAutoSuspendedRef = useRef(false)
  /** 正式视觉状态 → 姿态播放映射入口（主效果初始化完成后注入） */
  const realStatePostureHandlerRef = useRef<
    ((state: PetVisualState, prevKind: PetVisualState['kind'] | null) => void) | null
  >(null)
  /** 最近一次收到的真实状态 kind（区分"休息后回 idle"与普通 idle） */
  const prevRealKindRef = useRef<PetVisualState['kind'] | null>(null)

  /**
   * 开发预览专用（Task 11F-B）：姿态播放期间暂停/恢复主进程自动行为，
   * 解决"坐下/趴卧后窗口仍自动移动"。安全边界：
   * - 调用点在生产构建为死代码（import.meta.env.DEV 门控）；
   * - 主进程仅在 !app.isPackaged 时注册对应 handler，生产环境发送为无操作；
   * - ref 标志保证 suspend/resume 幂等，不产生重复暂停或错误恢复。
   */
  const suspendPreviewAutoBehavior = (): void => {
    if (!import.meta.env.DEV || previewAutoSuspendedRef.current) {
      return
    }
    previewAutoSuspendedRef.current = true
    window.yaoyao?.suspendAutoBehaviorForDevPreview()
  }

  const resumePreviewAutoBehavior = (): void => {
    if (!import.meta.env.DEV || !previewAutoSuspendedRef.current) {
      return
    }
    previewAutoSuspendedRef.current = false
    window.yaoyao?.resumeAutoBehaviorForDevPreview()
  }

  useEffect(() => {
    const unsubscribe = window.yaoyao?.subscribeVisualState((state) => {
      // ref 始终保存最新状态：素材异步加载完成后应用的就是最新值。
      visualStateRef.current = state
      // 重复广播（相同命令）由控制器幂等跳过，不重启动画、不重置帧序号。
      controllerRef.current?.apply(state)
      // Task 11G：正式状态 → 姿态播放映射（sitting/lying 播放姿态、
      // 休息后回 idle 优雅起身、其他非 idle 立即中断）。
      // 主效果未就绪（或已卸载）时兜底：非 idle 立即中断姿态播放。
      const handler = realStatePostureHandlerRef.current
      if (handler !== null) {
        handler(state, prevRealKindRef.current)
      } else if (state.kind !== 'idle') {
        postureControllerRef.current?.interrupt()
        resumePreviewAutoBehavior()
      }
      prevRealKindRef.current = state.kind
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
    let detachPreview: (() => void) | null = null

    // 姿态素材状态与待处理请求（懒加载期间最新请求胜出）。
    const postureStatus: Record<PostureKind, PostureAssetStatus> = {
      sit: 'unloaded',
      lie: 'unloaded'
    }
    const postureTextures: Partial<Record<PostureKind, Texture[]>> = {}
    const postureSprites: Partial<Record<PostureKind, Sprite>> = {}
    let pendingPosture: PostureKind | null = null
    /** 挂起请求的来源：预览来源在真正开始播放时才暂停主进程自动行为 */
    let pendingPostureSource: 'real' | 'preview' | null = null
    const postureController = new PetPostureController(
      (kind): boolean => postureStatus[kind] === 'ready'
    )
    postureControllerRef.current = postureController

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

        // idle + 8 帧 walk 并行加载（按 URL 去重：v2 idle 与 walk-01 同 URL
        // 只加载一次），任一失败不拖垮其余资源（allSettled）。
        const loadImage = createMemoizedImageLoader()
        return Promise.allSettled([
          loadImage(IDLE_FRAME_URL),
          ...WALK_FRAME_URLS.map(loadImage)
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

          // idle 视觉：素材优先，缺失时以占位圆形充当（在 512 本地坐标系绘制）。
          const idleVisual: Sprite | Graphics =
            outcome.idle !== null
              ? new Sprite(Texture.from(outcome.idle))
              : new Graphics()
                  .circle(256, 256, PET_PLACEHOLDER_RADIUS / CHARACTER_SCALE)
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
          }

          // ---- 姿态显示（Task 11F）----

          let lastCommand: DisplayCommand | null = null
          let lastPostureLabel: string | null = null

          /** 依据最新显示命令与姿态快照刷新可见性（唯一的显隐翻译点）。 */
          const applyVisibility = (posture: PostureSnapshot | null): void => {
            const command = lastCommand
            if (command === null) {
              return
            }
            // 姿态精灵：纹理随帧切换，同一时刻至多一个姿态可见。
            let postureVisible = false
            for (const kind of ['sit', 'lie'] as const) {
              const sprite = postureSprites[kind]
              if (sprite === undefined) {
                continue
              }
              const active =
                posture !== null && posture.kind === kind && posture.frameIndex !== null
              if (active && posture !== null && posture.frameIndex !== null) {
                const texture = postureTextures[kind]?.[posture.frameIndex]
                if (texture !== undefined && sprite.texture !== texture) {
                  sprite.texture = texture
                }
              }
              sprite.visible = active
              if (active) {
                postureVisible = true
              }
            }
            // walk 整组降级时行走状态退回静态 idle（walkSprite 为 null）。
            const wantWalk = !postureVisible && command.showWalk && walkSprite !== null
            idleVisual.visible = !postureVisible && !wantWalk
            if (walkSprite !== null) {
              walkSprite.visible = wantWalk
              if (wantWalk) {
                // idle → walking 的重新开始：从头播放；
                // 重复广播被控制器幂等拦截，不会走到这里重置帧序号。
                if (!walkSprite.playing) {
                  walkSprite.gotoAndPlay(0)
                }
              } else if (walkSprite.playing) {
                walkSprite.stop()
              }
            }
            // 姿态可观测性：写入 DOM 属性（值变化时才写）。
            const label =
              posture !== null && posture.kind !== null && posture.frameIndex !== null
                ? `${posture.kind}:${posture.phase}:${posture.frameIndex}`
                : null
            if (label !== lastPostureLabel) {
              lastPostureLabel = label
              if (label === null) {
                container.removeAttribute('data-posture')
              } else {
                container.setAttribute('data-posture', label)
              }
            }
          }

          /** 姿态素材按需懒加载：成功创建隐藏 Sprite；失败标记不可用。 */
          const startPostureLoad = (kind: PostureKind): void => {
            postureStatus[kind] = 'loading'
            const urls = POSTURE_FRAME_URLS[kind]
            void Promise.allSettled(urls.map(loadImage)).then((settled) => {
              if (cancelled) {
                return
              }
              const textures: Texture[] = []
              const failures: string[] = []
              settled.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                  textures.push(Texture.from(result.value))
                } else {
                  failures.push(`${kind}-0${index + 1}.png`)
                }
              })
              if (failures.length > 0 || textures.length !== urls.length) {
                postureStatus[kind] = 'failed'
                console.warn(`[PetCanvas] ${kind} 姿态素材加载失败，该姿态不可用:`, failures)
                if (pendingPosture === kind) {
                  pendingPosture = null
                }
                return
              }
              postureTextures[kind] = textures
              const sprite = new Sprite(textures[0])
              sprite.visible = false
              character.addChild(sprite)
              postureSprites[kind] = sprite
              postureStatus[kind] = 'ready'
              // 加载完成时应用挂起的最新请求（最新状态胜出）。
              if (pendingPosture === kind) {
                pendingPosture = null
                const source = pendingPostureSource
                pendingPostureSource = null
                if (source === 'preview') {
                  suspendPreviewAutoBehavior()
                }
                postureController.request(kind)
                applyVisibility(postureController.snapshot)
              }
            })
          }

          /**
           * 姿态播放核心入口（正式状态与预览共用）：
           * 素材就绪立即请求；未就绪挂起最新请求并懒加载；失败忽略（降级
           * 基础 idle，主进程行为不受影响）。kind=null 请求优雅起身
           *（播放退出动画后回站立）。预览来源在真正开始播放时暂停主进程
           * 自动行为（正式来源不需要：主进程 sitting/lying 本就不移动窗口）。
           */
          const startPosturePlayback = (
            kind: PostureKind | null,
            source: 'real' | 'preview'
          ): void => {
            if (kind === null) {
              pendingPosture = null
              pendingPostureSource = null
              postureController.request(null)
              applyVisibility(postureController.snapshot)
              return
            }
            const status = postureStatus[kind]
            if (status === 'ready') {
              if (source === 'preview') {
                suspendPreviewAutoBehavior()
              }
              postureController.request(kind)
              applyVisibility(postureController.snapshot)
              return
            }
            if (status === 'failed') {
              console.warn(`[PetCanvas] ${kind} 姿态素材不可用，忽略请求（回退基础 idle）`)
              return
            }
            // unloaded / loading：只保留最新请求，加载完成后应用。
            pendingPosture = kind
            pendingPostureSource = source
            if (status === 'unloaded') {
              startPostureLoad(kind)
            }
          }

          /**
           * Task 11G 正式视觉状态 → 姿态播放映射（主进程权威状态驱动）：
           * - sitting / lying → 请求对应姿态（主进程已保证窗口静止）；
           * - 从休息回到 idle → 优雅起身（播放退出动画，主进程的退出保护
           *   时长保证起身完成前不会开始行走）；
           * - 其他非 idle（walking/turning/dragging/paused）→ 立即中断姿态
           *   并清除挂起请求（真实状态优先），同时释放开发预览暂停。
           */
          const handleRealStatePosture = (
            state: PetVisualState,
            prevKind: PetVisualState['kind'] | null
          ): void => {
            if (state.kind === 'sitting' || state.kind === 'lying') {
              startPosturePlayback(state.kind === 'sitting' ? 'sit' : 'lie', 'real')
              return
            }
            if (state.kind === 'idle') {
              if (prevKind === 'sitting' || prevKind === 'lying') {
                startPosturePlayback(null, 'real')
              }
              return
            }
            pendingPosture = null
            pendingPostureSource = null
            postureController.interrupt()
            applyVisibility(postureController.snapshot)
            resumePreviewAutoBehavior()
          }
          realStatePostureHandlerRef.current = handleRealStatePosture

          /**
           * 预览专用入口（Task 11F/11F-B）：真实状态非 idle 时全部拒绝，
           * 不与正式行为争夺状态（正式休息进行中预览完全失效）。
           */
          const requestPreviewPosture = (kind: PostureKind | null): void => {
            const realKind = visualStateRef.current?.kind
            if (realKind === 'sitting' || realKind === 'lying') {
              console.info('[PetCanvas] 正式休息行为进行中，预览请求被忽略')
              return
            }
            if (kind !== null && realKind !== undefined && realKind !== 'idle') {
              console.info(`[PetCanvas] 真实状态为 ${realKind}，忽略姿态预览请求`)
              return
            }
            if (kind === null) {
              startPosturePlayback(null, 'preview')
              resumePreviewAutoBehavior()
              return
            }
            startPosturePlayback(kind, 'preview')
          }

          // 显示命令 → Pixi 属性的唯一翻译点（可见性统一由 applyVisibility 处理）。
          const applyCommand = (command: DisplayCommand): void => {
            lastCommand = command
            character.position.set(command.positionX, command.positionY)
            character.scale.set(command.scaleX, command.scaleY)
            applyVisibility(postureController.snapshot)
          }

          const controller = new PetDisplayController(applyCommand)
          // 应用加载期间累积的最新状态（最新状态胜出）。
          controller.apply(visualStateRef.current)
          controllerRef.current = controller
          // Task 11G：renderer 重建后同步当前正式状态的姿态
          //（sitting/lying 状态下重新进入姿态播放，进入动画从头播放）。
          if (visualStateRef.current !== null) {
            handleRealStatePosture(visualStateRef.current, prevRealKindRef.current)
          }

          // 单一 ticker：驱动 walk 帧推进与姿态时间轴。
          const onTick = (ticker: Ticker): void => {
            // Pixi 8 语义：update 接收 Ticker；未播放时自身早退，安全。
            if (walkSprite !== null) {
              walkSprite.update(ticker)
            }
            postureController.update(ticker.deltaMS)
            applyVisibility(postureController.snapshot)
          }
          app.ticker.add(onTick)
          detachTicker = (): void => {
            app.ticker.remove(onTick)
          }

          // 开发预览：动态导入保证生产构建整段剔除（死代码消除）。
          if (import.meta.env.DEV) {
            void import('./posture-preview').then(({ mountPosturePreview }) => {
              if (cancelled) {
                return
              }
              detachPreview = mountPosturePreview(container, {
                request: requestPreviewPosture,
                replayEnter: (): void => {
                  // 正式休息进行中不重播（预览不干扰正式行为）。
                  const realKind = visualStateRef.current?.kind
                  if (realKind === 'sitting' || realKind === 'lying') {
                    return
                  }
                  postureController.replayEnter()
                  applyVisibility(postureController.snapshot)
                },
                getStatus: (): string => {
                  const real = visualStateRef.current
                  const snap = postureController.snapshot
                  const postureText =
                    snap.kind === null
                      ? '站立'
                      : `${snap.kind}/${snap.phase}/帧${(snap.frameIndex ?? 0) + 1}`
                  return `真实:${real ? `${real.kind}:${real.facing}` : '未知'}｜预览:${postureText}`
                }
              })
            })
          }
        })
      })
      .catch((error: unknown) => {
        console.error('[PetCanvas] PixiJS 初始化失败，界面降级为空白占位', error)
      })

    return () => {
      cancelled = true
      controllerRef.current = null
      postureControllerRef.current = null
      realStatePostureHandlerRef.current = null
      // 卸载时释放开发预览的自动行为暂停（安全释放，不遗留冻结状态）。
      resumePreviewAutoBehavior()
      detachPreview?.()
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
