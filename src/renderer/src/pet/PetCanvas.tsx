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
import { usePetInteraction, type PetInteractionHandlers } from './use-pet-interaction'
import { usePetScale } from './use-pet-scale'
import {
  CHARACTER_SCALE,
  DisplayCommand,
  FRONT_IDLE_FRAME_URL,
  IDLE_FRAME_URL,
  PetDisplayController,
  resolveAssetLoadOutcome,
  RUN_FPS,
  RUN_FRAME_URLS,
  scaleDisplayCommand,
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
import {
  INTERACTION_FRAME_URLS,
  PetInteractionController,
  type InteractionOrientation,
  type InteractionSnapshot
} from './pet-interaction'

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
 * - 基础显示：idle/paused 正面静态待机帧（Task 11I，独立 front-idle 缩放，
 *   加载失败回退侧面 idle）+ 8 帧行走 AnimatedSprite（8 FPS 循环）
 *   + 8 帧跑步 AnimatedSprite（12 FPS 循环，Task 11H；run 整组加载
 *   失败时跑步视觉回退 walk，行为不受影响）；autoUpdate=false，
 *   由 app.ticker 统一驱动，单一时间源，不重复初始化 Application；
 * - 姿态播放（Task 11F；Task 11I 起素材为 v3 front 正面坐/趴，面向
 *   用户、不随 facing 镜像）：sit/lie 的进入/保持（sit 含眨眼）/退出由
 *   纯逻辑层 pet-posture 驱动，本组件只按 snapshot 设置纹理与可见性；
 *   姿态素材按需懒加载，失败时该姿态不可用（回退基础 idle，
 *   sitting/lying 的 front 命令下显示正面待机帧），
 *   不影响 walk 的加载与展示；
 * - 开发调试（Task 11H-C）：键盘姿态预览（11F 的 posture-preview）已
 *   移除，替代为独立开发调试面板（主进程在开发构建创建面板窗口，
 *   经白名单窄 IPC 触发真实行为；见 DevBehaviorPanel）；
 * - 交互动画（Task 11J）：点击反馈 / 拎起 / 悬空保持 / 放下过渡由
 *   纯逻辑层 pet-interaction 驱动（renderer 视觉阶段，不是主进程行为
 *   状态）；真实拖动仍由 usePetInteraction → 窄 IPC → 主进程锚点
 *   轮询控制（窗口跟手，不为等待动画延迟）；抓取开始时锁定显示朝向
 *   （lockedCommand，拖动期间不随旧方向广播切换图像），放下完成恢复
 *   最新权威命令；悬空位移（上移 12px）仅作用于角色容器内部 Y，
 *   不移动 Electron 窗口；交互素材组失败 → 整组降级（点击无反馈、
 *   拎起无动画，拖动行为不受影响）；
 * - 状态映射与朝向镜像完全由纯逻辑层决定（镜像通过角色容器负 scaleX，
 *   翻转轴穿过脚底参考点，不做窗口位置补偿）；
 * - 真实视觉状态优先：非 idle 状态（walking/turning/dragging/paused）
 *   立即中断姿态播放并呈现真实状态；姿态播放不改变主进程行为；
 * - 素材异步加载期间状态变化：以 ref 保存最新状态，加载完成后
 *   应用最新状态（最新状态胜出）；
 * - 降级：walk 任一帧失败 → 整组不播放（行走退回静态 idle）；
 *   idle 失败 → 占位圆形（沿用 Task 9B 降级链）。
 *
 * renderer 不实现任何行为决策或窗口移动逻辑；
 * 容器同时承载指针交互（usePetInteraction：意图识别 + 拖动 IPC）。
 */
function PetCanvas(): React.JSX.Element {
  /** 意图事件 → 交互动画接线（主效果初始化完成后注入） */
  const interactionHandlersRef = useRef<PetInteractionHandlers | null>(null)
  const containerRef = usePetInteraction(interactionHandlersRef)
  /** 用户宠物倍率（Task 12B）：主进程权威设置订阅，每 tick 读取即时应用 */
  const petScaleRef = usePetScale()
  const [visualState, setVisualState] = useState<PetVisualState | null>(null)
  const visualStateRef = useRef<PetVisualState | null>(null)
  const controllerRef = useRef<PetDisplayController | null>(null)
  const postureControllerRef = useRef<PetPostureController | null>(null)
  /** 正式视觉状态 → 姿态播放映射入口（主效果初始化完成后注入） */
  const realStatePostureHandlerRef = useRef<
    ((state: PetVisualState, prevKind: PetVisualState['kind'] | null) => void) | null
  >(null)
  /** 最近一次收到的真实状态 kind（区分"休息后回 idle"与普通 idle） */
  const prevRealKindRef = useRef<PetVisualState['kind'] | null>(null)

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
    /** DEV 交互预览订阅的退订函数（Task 11J；仅开发构建订阅） */
    let devPreviewUnsubscribe: (() => void) | null = null

    // 姿态素材状态与待处理请求（懒加载期间最新请求胜出）。
    const postureStatus: Record<PostureKind, PostureAssetStatus> = {
      sit: 'unloaded',
      lie: 'unloaded'
    }
    const postureTextures: Partial<Record<PostureKind, Texture[]>> = {}
    const postureSprites: Partial<Record<PostureKind, Sprite>> = {}
    let pendingPosture: PostureKind | null = null
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
        // Task 12C ticker 节能：封顶 60fps（TICKER_FPS 语义基准）。
        // 未封顶时高刷新率屏（如 ProMotion 120Hz）会以 2 倍速率空转
        // 渲染循环，且 animationSpeed 换算（帧/tick）导致动画时长失真。
        app.ticker.maxFPS = TICKER_FPS

        // 降级占位：素材全部加载失败时保持画布非空，不破坏窗口与行为系统。
        const showPlaceholder = (): void => {
          const placeholder = new Graphics()
            .circle(PET_CANVAS_WIDTH / 2, PET_CANVAS_HEIGHT / 2, PET_PLACEHOLDER_RADIUS)
            .fill(PET_PLACEHOLDER_COLOR)
          app.stage.addChild(placeholder)
        }

        // idle（侧面）+ 正面待机（Task 11I）+ 8 帧 walk + 8 帧 run
        // + front/side 交互各 8 帧（Task 11J）并行加载（按 URL 去重：
        // v2 idle 与 walk-01、front 交互 01 与正面待机帧均同 URL 只加载
        // 一次），任一失败不拖垮其余资源（allSettled）。run 为独立素材组
        //（Task 11H）：整组失败仅跑步视觉回退 walk；正面待机失败仅
        // idle/paused 回退侧面 idle；交互组失败仅交互动画降级（拖动行为
        // 不受影响），均不影响行为与姿态/休息功能。
        const loadImage = createMemoizedImageLoader()
        return Promise.allSettled([
          loadImage(IDLE_FRAME_URL),
          loadImage(FRONT_IDLE_FRAME_URL),
          ...WALK_FRAME_URLS.map(loadImage),
          ...RUN_FRAME_URLS.map(loadImage),
          ...INTERACTION_FRAME_URLS.front.map(loadImage),
          ...INTERACTION_FRAME_URLS.side.map(loadImage)
        ]).then((results) => {
          if (cancelled) {
            return
          }
          const [idleResult, frontResult, ...restResults] = results
          const walkResults = restResults.slice(0, WALK_FRAME_URLS.length)
          const runResults = restResults.slice(
            WALK_FRAME_URLS.length,
            WALK_FRAME_URLS.length + RUN_FRAME_URLS.length
          )
          const frontInteractionResults = restResults.slice(
            WALK_FRAME_URLS.length + RUN_FRAME_URLS.length,
            WALK_FRAME_URLS.length + RUN_FRAME_URLS.length + INTERACTION_FRAME_URLS.front.length
          )
          const sideInteractionResults = restResults.slice(
            WALK_FRAME_URLS.length + RUN_FRAME_URLS.length + INTERACTION_FRAME_URLS.front.length
          )
          const outcome = resolveAssetLoadOutcome(
            idleResult,
            walkResults,
            runResults,
            frontResult,
            frontInteractionResults,
            sideInteractionResults
          )
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

          // 正面待机视觉（Task 11I）：idle/paused 的 front 命令显示；
          // 加载失败时不创建——front 命令自动回退侧面 idle 视觉（见
          // applyVisibility），不产生占位、不影响 walk/run/sit/lie。
          let frontIdleVisual: Sprite | null = null
          if (outcome.frontIdle !== null) {
            const frontIdleSprite = new Sprite(Texture.from(outcome.frontIdle))
            frontIdleSprite.visible = false
            character.addChild(frontIdleSprite)
            frontIdleVisual = frontIdleSprite
          }

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

          // 跑步动画（Task 11H）：独立素材组，仅当 8 帧全部成功才创建；
          // 失败时 running 状态由 applyVisibility 回退播放 walk 视觉，
          // 行为（主进程速度/时长）不受影响。与 walk 共用同一角色容器
          //（镜像由容器统一处理），不重新初始化 Application。
          let runSprite: AnimatedSprite | null = null
          if (outcome.run !== null) {
            const runAnimated = new AnimatedSprite(outcome.run.map((image) => Texture.from(image)))
            runAnimated.animationSpeed = toAnimationSpeed(RUN_FPS, TICKER_FPS)
            runAnimated.loop = true
            runAnimated.autoUpdate = false
            runAnimated.visible = false
            character.addChild(runAnimated)
            runSprite = runAnimated
          }

          // ---- 姿态显示（Task 11F；Task 11I 起使用 v3 front 正面素材，
          // 坐/趴面向用户，容器随 front 命令使用 FRONT_IDLE_SCALE）----

          // ---- 交互显示（Task 11J）：front / side 两组静态精灵，
          // 纹理随交互快照帧切换；与 walk 共用角色容器（side 组镜像
          // 由容器统一处理）。整组失败不创建 → 交互动画降级。----
          const interactionTextures: Partial<Record<InteractionOrientation, Texture[]>> = {}
          const interactionSprites: Partial<Record<InteractionOrientation, Sprite>> = {}
          const interactionGroups: ReadonlyArray<
            readonly [InteractionOrientation, readonly HTMLImageElement[] | null]
          > = [
            ['front', outcome.frontInteraction],
            ['side', outcome.sideInteraction]
          ]
          for (const [orientation, frames] of interactionGroups) {
            if (frames === null) {
              continue
            }
            const textures = frames.map((image) => Texture.from(image))
            const sprite = new Sprite(textures[0])
            sprite.visible = false
            character.addChild(sprite)
            interactionTextures[orientation] = textures
            interactionSprites[orientation] = sprite
          }
          const interactionController = new PetInteractionController()

          let lastCommand: DisplayCommand | null = null
          let lastPostureLabel: string | null = null
          let lastOrientationLabel: string | null = null
          let lastInteractionLabel: string | null = null
          /** Task 12C 性能优化：倍率观测值缓存（避免每帧字符串分配与 DOM 写） */
          let lastPetScaleLabel: string | null = null
          /**
           * 抓取开始时锁定的容器 transform（Task 11J）：交互期间容器
           * 不随旧方向广播切换（dragging 命令是 side 基底，抓取自正面
           * 待机时应保持正面）。交互结束（放下/点击反馈完成）后清空，
           * 恢复最新权威命令。
           */
          let lockedCommand: DisplayCommand | null = null

          /**
           * 依据最新显示命令、交互动画快照与姿态快照刷新容器 transform
           * 与可见性（唯一的显隐翻译点；每帧由 ticker 调用，幂等）。
           *
           * 容器 transform 统一在此设置：交互激活时用 lockedCommand 并
           * 附加悬空位移（上移，仅容器内部 Y，不移动 Electron 窗口）；
           * 其余时间用最新权威命令（liftOffsetPx 为 0，恢复接地位置）。
           */
          const applyVisibility = (
            interaction: InteractionSnapshot,
            posture: PostureSnapshot | null
          ): void => {
            const command = lastCommand
            if (command === null) {
              return
            }
            const activeTransform = lockedCommand ?? command
            // Task 12B：用户倍率叠加（脚底锚点重算，等比无拉伸）。
            const scaledTransform = scaleDisplayCommand(activeTransform, petScaleRef.current)
            character.position.set(
              scaledTransform.positionX,
              scaledTransform.positionY - interaction.liftOffsetPx
            )
            character.scale.set(scaledTransform.scaleX, scaledTransform.scaleY)
            // 观测属性（验收/调试用，与 data-interaction 同一模式）；
            // Task 12C：值未变化时跳过（每帧无条件写会持续产生
            // 字符串分配与 DOM 属性写，长驻运行累积无谓开销）。
            const petScaleLabel = String(petScaleRef.current)
            if (petScaleLabel !== lastPetScaleLabel) {
              lastPetScaleLabel = petScaleLabel
              container.dataset.petScale = petScaleLabel
            }
            // 交互精灵（最高优先级）：纹理随帧切换，至多一个组可见。
            const interactionActive =
              interaction.phase !== 'normal' && interaction.frameIndex !== null
            const interactionGroup = interaction.orientation
            let interactionVisible = false
            for (const orientation of ['front', 'side'] as const) {
              const sprite = interactionSprites[orientation]
              if (sprite === undefined) {
                continue
              }
              const active =
                interactionActive &&
                interactionGroup === orientation &&
                interaction.frameIndex !== null
              if (active && interaction.frameIndex !== null) {
                const texture = interactionTextures[orientation]?.[interaction.frameIndex]
                if (texture !== undefined && sprite.texture !== texture) {
                  sprite.texture = texture
                }
              }
              sprite.visible = active
              if (active) {
                interactionVisible = true
              }
            }
            // 交互激活但素材组不可用（interactionVisible false）时，
            // 基础显示链在锁定 transform 下照常降级（如正面待机帧）。
            // 姿态精灵：纹理随帧切换，同一时刻至多一个姿态可见。
            let postureVisible = false
            for (const kind of ['sit', 'lie'] as const) {
              const sprite = postureSprites[kind]
              if (sprite === undefined) {
                continue
              }
              const active =
                !interactionVisible &&
                posture !== null &&
                posture.kind === kind &&
                posture.frameIndex !== null
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
            // walk 整组降级时行走状态退回静态 idle（walkSprite 为 null）；
            // run 整组降级时跑步状态回退播放 walk（runSprite 为 null，
            // Task 11H：视觉降级不影响主进程跑步行为）。
            // 优先级：交互（Task 11J）> 姿态 > 跑步 > 行走 > 正面/侧面
            // 静态 idle（Task 11I：front 命令显示正面待机；正面帧缺失时
            // 回退侧面 idle 视觉）。
            const wantRun =
              !interactionVisible && !postureVisible && command.showRun && runSprite !== null
            const wantWalk =
              !interactionVisible &&
              !postureVisible &&
              !wantRun &&
              (command.showWalk || command.showRun) &&
              walkSprite !== null
            const staticIdle = !interactionVisible && !postureVisible && !wantRun && !wantWalk
            const wantFrontIdle =
              staticIdle && command.orientation === 'front' && frontIdleVisual !== null
            idleVisual.visible = staticIdle && !wantFrontIdle
            if (frontIdleVisual !== null) {
              frontIdleVisual.visible = wantFrontIdle
            }
            if (runSprite !== null) {
              runSprite.visible = wantRun
              if (wantRun) {
                // 进入 running 的重新开始：从头播放；
                // 重复广播被控制器幂等拦截，不会走到这里重置帧序号。
                if (!runSprite.playing) {
                  runSprite.gotoAndPlay(0)
                }
              } else if (runSprite.playing) {
                runSprite.stop()
              }
            }
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
            // 显示朝向可观测性（Task 11I 实机验收）：写入 DOM 属性（值变化时才写）。
            if (command.orientation !== lastOrientationLabel) {
              lastOrientationLabel = command.orientation
              container.setAttribute('data-orientation', command.orientation)
            }
            // 交互阶段可观测性（Task 11J 实机验收）：写入 DOM 属性（值变化时才写）。
            const interactionLabel =
              interaction.phase === 'normal'
                ? null
                : `${interaction.phase}:${interaction.frameIndex}`
            if (interactionLabel !== lastInteractionLabel) {
              lastInteractionLabel = interactionLabel
              if (interactionLabel === null) {
                container.removeAttribute('data-interaction')
              } else {
                container.setAttribute('data-interaction', interactionLabel)
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
                postureController.request(kind)
                applyVisibility(interactionController.snapshot, postureController.snapshot)
              }
            })
          }

          /**
           * 姿态播放核心入口（正式状态驱动）：
           * 素材就绪立即请求；未就绪挂起最新请求并懒加载；失败忽略（降级
           * 基础 idle，主进程行为不受影响）。kind=null 请求优雅起身
           *（播放退出动画后回站立）。
           */
          const startPosturePlayback = (kind: PostureKind | null): void => {
            if (kind === null) {
              pendingPosture = null
              postureController.request(null)
              applyVisibility(interactionController.snapshot, postureController.snapshot)
              return
            }
            const status = postureStatus[kind]
            if (status === 'ready') {
              postureController.request(kind)
              applyVisibility(interactionController.snapshot, postureController.snapshot)
              return
            }
            if (status === 'failed') {
              console.warn(`[PetCanvas] ${kind} 姿态素材不可用，忽略请求（回退基础 idle）`)
              return
            }
            // unloaded / loading：只保留最新请求，加载完成后应用。
            pendingPosture = kind
            if (status === 'unloaded') {
              startPostureLoad(kind)
            }
          }

          /**
           * Task 11G 正式视觉状态 → 姿态播放映射（主进程权威状态驱动）：
           * - sitting / lying → 请求对应姿态（主进程已保证窗口静止）；
           * - 从休息回到 idle → 优雅起身（播放退出动画，主进程的退出保护
           *   时长保证起身完成前不会开始行走）；
           * - 其他非 idle（walking/running/dragging/paused）→ 立即中断姿态
           *   并清除挂起请求（真实状态优先）。
           */
          const handleRealStatePosture = (
            state: PetVisualState,
            prevKind: PetVisualState['kind'] | null
          ): void => {
            if (state.kind === 'sitting' || state.kind === 'lying') {
              startPosturePlayback(state.kind === 'sitting' ? 'sit' : 'lie')
              return
            }
            if (state.kind === 'idle') {
              if (prevKind === 'sitting' || prevKind === 'lying') {
                startPosturePlayback(null)
              }
              return
            }
            pendingPosture = null
            postureController.interrupt()
            applyVisibility(interactionController.snapshot, postureController.snapshot)
          }
          realStatePostureHandlerRef.current = handleRealStatePosture

          // 显示命令 → Pixi 属性的唯一翻译点（transform 统一由
          // applyVisibility 每帧应用；交互激活时容器保持锁定 transform，
          // lastCommand 始终保存最新权威命令供交互结束后恢复）。
          const applyCommand = (command: DisplayCommand): void => {
            lastCommand = command
            applyVisibility(interactionController.snapshot, postureController.snapshot)
          }

          /**
           * 交互动画视觉入口（Task 11J；真实流程与 DEV 预览共用）：
           * - 拎起：锁定抓取开始时的实际显示朝向（含镜像/缩放）并进入
           *   lifting——真实拖动的 IPC（dragStart）由 usePetInteraction
           *   在 onLift 中已发送，此处只做视觉；
           * - 放下：进入 dropping（窗口已停在释放位置，由主进程
           *   dragEnd 决定；拖动后的 idle 保护 ≥2s 覆盖 480ms 落地动画，
           *   主进程不会在放下完成前移动窗口）；
           * - 点击：播放正面/侧面反馈序列（朝向取当前显示朝向）。
           */
          const doLiftVisual = (): void => {
            const command = lastCommand
            if (command === null) {
              return
            }
            lockedCommand = command
            interactionController.requestPickup(command.orientation)
            applyVisibility(interactionController.snapshot, postureController.snapshot)
          }

          const doDropVisual = (): void => {
            interactionController.requestDrop()
            applyVisibility(interactionController.snapshot, postureController.snapshot)
          }

          const doClickVisual = (): void => {
            const command = lastCommand
            if (command === null) {
              return
            }
            // 姿态进行中（sit/lie 显示中）忽略点击反馈：反馈帧为站立
            // 素材，播放会造成坐姿↔站姿闪跳（规格六：优先 idle 验证，
            // 姿态中不适用反馈）。拎起流程中由 controller 内部忽略。
            if (postureController.snapshot.phase !== 'standing') {
              return
            }
            lockedCommand = command
            interactionController.requestClick(command.orientation)
            applyVisibility(interactionController.snapshot, postureController.snapshot)
          }

          interactionHandlersRef.current = {
            onLift: doLiftVisual,
            onDrop: doDropVisual,
            onClick: doClickVisual
          }

          // DEV 交互预览（Task 11J）：面板按钮 → 主进程 dev handler →
          // 窄通道转发 → 此处播放纯 renderer 视觉（不触碰行为状态机、
          // 不伪造 dragging）。仅开发构建订阅（生产 bundle 剔除）。
          if (import.meta.env.DEV) {
            const unsubscribePreview = window.yaoyao?.onDevInteractionPreview((kind) => {
              if (kind === 'click') {
                doClickVisual()
              } else if (kind === 'pickup') {
                doLiftVisual()
              } else if (kind === 'release') {
                doDropVisual()
              }
            })
            devPreviewUnsubscribe = unsubscribePreview ?? null
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

          // 单一 ticker：驱动 walk / run 帧推进、姿态与交互动画时间轴
          //（单一时间源，pointermove 不重置动画；不重复创建计时器）。
          const onTick = (ticker: Ticker): void => {
            // Pixi 8 语义：update 接收 Ticker；未播放时自身早退，安全。
            if (walkSprite !== null) {
              walkSprite.update(ticker)
            }
            if (runSprite !== null) {
              runSprite.update(ticker)
            }
            postureController.update(ticker.deltaMS)
            const wasInteractionActive = interactionController.isActive
            interactionController.update(ticker.deltaMS)
            if (wasInteractionActive && !interactionController.isActive) {
              // 交互结束（点击反馈 / 放下完成）：清除朝向锁定，
              // applyVisibility 用最新权威命令恢复容器 transform
              //（悬空位移同时归零，回到接地位置）。
              lockedCommand = null
            }
            applyVisibility(interactionController.snapshot, postureController.snapshot)
          }
          app.ticker.add(onTick)
          detachTicker = (): void => {
            app.ticker.remove(onTick)
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
      interactionHandlersRef.current = null
      devPreviewUnsubscribe?.()
      devPreviewUnsubscribe = null
      detachTicker?.()
      if (initialised) {
        // 销毁应用与 stage 拥有的显示对象（含 Sprite 与纹理源）。
        app.destroy(true, { children: true })
      }
    }
  }, [containerRef, petScaleRef])

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
