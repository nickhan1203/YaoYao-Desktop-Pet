/**
 * Task 11B：行走动画纯逻辑层测试（状态映射 / 镜像数学 / 播放速度 /
 * 幂等控制 / 素材降级）。
 *
 * 覆盖任务规格的 12 个场景：
 * 1.  状态映射表：walking → 播放 walk；idle/turning/paused/dragging → 静态 idle；
 * 2.  facing right → 非镜像（scaleX 为正）；facing left → 水平镜像（scaleX 为负）；
 * 3.  镜像前后脚底参考点落点稳定（翻转轴数学验证）；
 * 4.  8 FPS 目标帧率换算 animationSpeed（8/60）；
 * 5.  重复广播（相同命令）不再次应用——不重启动画、不重置帧序号；
 * 6.  状态切换（walking → 非行走）产生新命令并停止播放；
 * 7.  朝向切换（right → left）产生新命令（镜像生效）；
 * 8.  walk 任一帧失败 → 整组 walk 为 null（不部分播放）；
 * 9.  idle 失败 → idle 为 null（占位降级链）；全部失败 → 双 null + 完整 failures；
 * 10. failures 记录失败资源的正确序号；
 * 11. toAnimationSpeed 非法输入安全回退为 0；
 * 12. 帧序列完整性：WALK_FRAME_URLS 为 8 帧（播放顺序载体）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CHARACTER_SCALE,
  DisplayCommand,
  FOOT_REFERENCE,
  FOOT_TARGET,
  FRONT_IDLE_FRAME_URL,
  FRONT_IDLE_SCALE,
  IDLE_FRAME_URL,
  isSameCommand,
  PetDisplayController,
  resolveAssetLoadOutcome,
  resolveDisplayCommand,
  toAnimationSpeed,
  scaleDisplayCommand,
  WALK_FRAME_URLS,
  WALK_FPS,
  RUN_FRAME_URLS,
  RUN_FPS,
  TICKER_FPS
} from '../src/renderer/src/pet/pet-animation'
import type { PetVisualState } from '../src/shared/pet-visual-state'

function state(kind: PetVisualState['kind'], facing: PetVisualState['facing']): PetVisualState {
  return { kind, facing }
}

/** 验证命令的脚底参考点落点：position + scale × FOOT_REFERENCE === FOOT_TARGET */
function expectFootAnchorStable(command: DisplayCommand): void {
  expect(command.positionX + command.scaleX * FOOT_REFERENCE.x).toBeCloseTo(FOOT_TARGET.x, 10)
  expect(command.positionY + command.scaleY * FOOT_REFERENCE.y).toBeCloseTo(FOOT_TARGET.y, 10)
}

describe('resolveDisplayCommand 状态映射（场景 1）', () => {
  it('walking → 播放行走动画', () => {
    const command = resolveDisplayCommand(state('walking', 'right'))
    expect(command.showWalk).toBe(true)
    expect(command.walkPlaying).toBe(true)
  })

  it.each(['idle', 'turning', 'paused', 'dragging'] as const)(
    '%s → 静态 idle（不播放动画）',
    (kind) => {
      const command = resolveDisplayCommand(state(kind, 'right'))
      expect(command.showWalk).toBe(false)
      expect(command.walkPlaying).toBe(false)
    }
  )

  it.each(['sitting', 'lying'] as const)(
    'Task 11I：%s → 正面姿态素材基底（姿态精灵由 posture 层叠加显示，不镜像）',
    (kind) => {
      const command = resolveDisplayCommand(state(kind, 'right'))
      expect(command.showWalk).toBe(false)
      expect(command.walkPlaying).toBe(false)
      expect(command.orientation).toBe('front')
      expect(command.mirrored).toBe(false)
      // 正面素材组缩放与定位（FRONT_IDLE_SCALE，见其注释）
      expect(command.scaleY).toBe(FRONT_IDLE_SCALE)
      expect(command.positionY).toBeCloseTo(227.5 - FRONT_IDLE_SCALE * 464, 10)
    }
  )

  it('null 状态（订阅建立前/素材加载完成前）→ 默认 idle 朝右', () => {
    const command = resolveDisplayCommand(null)
    expect(command.showWalk).toBe(false)
    expect(command.mirrored).toBe(false)
  })
})

describe('朝向镜像（场景 2）', () => {
  it('facing right → 原始朝向，scaleX 为正', () => {
    const command = resolveDisplayCommand(state('walking', 'right'))
    expect(command.mirrored).toBe(false)
    expect(command.scaleX).toBe(CHARACTER_SCALE)
    expect(command.scaleY).toBe(CHARACTER_SCALE)
  })

  it('facing left → 水平镜像，scaleX 为负且绝对值等比', () => {
    const command = resolveDisplayCommand(state('walking', 'left'))
    expect(command.mirrored).toBe(true)
    expect(command.scaleX).toBe(-CHARACTER_SCALE)
    expect(command.scaleY).toBe(CHARACTER_SCALE)
  })

  it('up/down → 沿用原始朝向（不镜像，本阶段无对应方向动画）', () => {
    for (const facing of ['up', 'down'] as const) {
      expect(resolveDisplayCommand(state('walking', facing)).mirrored).toBe(false)
    }
  })

  it('Task 11I：idle 显示正面待机，不随历史 facing 镜像（朝向与显示素材分离）', () => {
    for (const facing of ['left', 'right'] as const) {
      const command = resolveDisplayCommand(state('idle', facing))
      expect(command.orientation).toBe('front')
      expect(command.mirrored).toBe(false)
      expect(command.scaleX).toBe(FRONT_IDLE_SCALE)
    }
  })
})

describe('镜像脚底稳定性（场景 3）', () => {
  it('翻转轴穿过脚底参考点：镜像前后参考点落点均在 FOOT_TARGET', () => {
    const right = resolveDisplayCommand(state('walking', 'right'))
    const left = resolveDisplayCommand(state('walking', 'left'))
    expectFootAnchorStable(right)
    expectFootAnchorStable(left)
  })

  it('镜像命令与非镜像命令仅镜像相关字段不同（位置随翻转轴平移）', () => {
    const right = resolveDisplayCommand(state('walking', 'right'))
    const left = resolveDisplayCommand(state('walking', 'left'))
    expect(left.positionY).toBe(right.positionY)
    expect(left.scaleX).toBe(-right.scaleX)
    // 镜像位置 = 2×FOOT_TARGET.x − 非镜像位置（绕轴翻转的解析关系）。
    expect(left.positionX + right.positionX).toBeCloseTo(2 * FOOT_TARGET.x, 10)
  })
})

describe('播放速度换算（场景 4 / 11）', () => {
  it('8 FPS / 60 ticker FPS → animationSpeed = 8/60', () => {
    expect(toAnimationSpeed(WALK_FPS, TICKER_FPS)).toBeCloseTo(8 / 60, 12)
  })

  it('常量约定：8 帧、8 FPS、60 ticker FPS、0.625 缩放（v2 512 画布）', () => {
    expect(WALK_FPS).toBe(8)
    expect(TICKER_FPS).toBe(60)
    expect(CHARACTER_SCALE).toBe(0.625)
  })

  it('Task 11E-v2：脚底锚点与目标点符合 v2 素材规格', () => {
    // FOOT_REFERENCE = manifest anchor normalized [0.5, 0.90625] → (256, 464)
    expect(FOOT_REFERENCE).toEqual({ x: 256, y: 464 })
    // x 取窗口水平中心（v2 角色相对锚点对称），y 沿用 v1 已验收脚底高度
    expect(FOOT_TARGET).toEqual({ x: 120, y: 227.5 })
    // 显示命令落点：非镜像 (-40, -62.5)；镜像 (280, -62.5)
    const right = resolveDisplayCommand(state('walking', 'right'))
    expect(right.positionX).toBeCloseTo(120 - 0.625 * 256, 10)
    expect(right.positionY).toBeCloseTo(227.5 - 0.625 * 464, 10)
    const left = resolveDisplayCommand(state('walking', 'left'))
    expect(left.positionX).toBeCloseTo(120 + 0.625 * 256, 10)
    // v2 角色相对锚点横向对称（11F 像素实测最大半宽约 190px）：
    // 0.625 × 190 = 118.75 ≤ FOOT_TARGET.x = 120 → 镜像前后角色均不出画布
    expect(CHARACTER_SCALE * 190).toBeLessThanOrEqual(FOOT_TARGET.x)
  })

  it.each([
    ['tickerFps 为 0', 8, 0],
    ['tickerFps 为负', 8, -60],
    ['tickerFps 非有限', 8, Number.NaN],
    ['fps 非有限', Number.POSITIVE_INFINITY, 60]
  ])('%s → 安全回退 0', (_label, fps, tickerFps) => {
    expect(toAnimationSpeed(fps, tickerFps)).toBe(0)
  })
})

describe('PetDisplayController 幂等控制（场景 5 / 6 / 7）', () => {
  it('相同命令的重复广播只应用一次（不重启动画、不重置帧序号）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    const walking = state('walking', 'right')
    controller.apply(walking)
    controller.apply(walking)
    controller.apply({ ...walking })
    expect(applyCommand).toHaveBeenCalledTimes(1)
  })

  it('walking → idle 产生新命令（停止播放）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(state('walking', 'right'))
    controller.apply(state('idle', 'right'))
    expect(applyCommand).toHaveBeenCalledTimes(2)
    expect(applyCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ showWalk: false, walkPlaying: false })
    )
  })

  it('right → left 产生新命令（镜像生效）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(state('walking', 'right'))
    controller.apply(state('walking', 'left'))
    expect(applyCommand).toHaveBeenCalledTimes(2)
    expect(applyCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ mirrored: true, scaleX: -CHARACTER_SCALE })
    )
  })

  it('null → 合法状态同样产生新命令（加载完成后应用最新状态）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(null)
    controller.apply(state('walking', 'left'))
    expect(applyCommand).toHaveBeenCalledTimes(2)
  })
})

describe('isSameCommand', () => {
  it('字段完全一致 → true；任一字段不同 → false', () => {
    const a = resolveDisplayCommand(state('walking', 'right'))
    expect(isSameCommand(a, a)).toBe(true)
    expect(isSameCommand(a, resolveDisplayCommand(state('walking', 'left')))).toBe(false)
    expect(isSameCommand(a, resolveDisplayCommand(state('idle', 'right')))).toBe(false)
    const tweaked: DisplayCommand = { ...a, positionX: a.positionX + 1 }
    expect(isSameCommand(a, tweaked)).toBe(false)
  })
})

describe('resolveAssetLoadOutcome 素材降级（场景 8 / 9 / 10）', () => {
  const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
  const rejected = <T>(reason = 'load error'): PromiseSettledResult<T> => ({
    status: 'rejected',
    reason
  })
  const idleImage = 'idle-image' as unknown as HTMLImageElement
  const walkImages = Array.from(
    { length: 8 },
    (_, i) => `walk-${i + 1}` as unknown as HTMLImageElement
  )

  it('全部成功 → idle 与 8 帧 walk 完整返回，无失败记录', () => {
    const outcome = resolveAssetLoadOutcome(fulfilled(idleImage), walkImages.map(fulfilled))
    expect(outcome.idle).toBe(idleImage)
    expect(outcome.walk).toEqual(walkImages)
    expect(outcome.failures).toEqual([])
  })

  it('walk 任一帧失败 → 整组 walk 为 null（不部分播放），idle 不受影响', () => {
    const walkResults = walkImages.map((image, index) =>
      index === 5 ? rejected<HTMLImageElement>() : fulfilled(image)
    )
    const outcome = resolveAssetLoadOutcome(fulfilled(idleImage), walkResults)
    expect(outcome.walk).toBeNull()
    expect(outcome.idle).toBe(idleImage)
    expect(outcome.failures).toEqual(['v2/walk/walk-06.png'])
  })

  it('多帧失败 → failures 逐一记录正确序号', () => {
    const walkResults = walkImages.map((image, index) =>
      index === 0 || index === 6 ? rejected<HTMLImageElement>() : fulfilled(image)
    )
    const outcome = resolveAssetLoadOutcome(fulfilled(idleImage), walkResults)
    expect(outcome.walk).toBeNull()
    expect(outcome.failures).toEqual(['v2/walk/walk-01.png', 'v2/walk/walk-07.png'])
  })

  it('idle 失败 → idle 为 null（占位降级链），walk 不受影响', () => {
    const outcome = resolveAssetLoadOutcome(rejected<HTMLImageElement>(), walkImages.map(fulfilled))
    expect(outcome.idle).toBeNull()
    expect(outcome.walk).toEqual(walkImages)
    expect(outcome.failures).toEqual(['v2/walk/walk-01.png（idle 静止帧）'])
  })

  it('全部失败 → 双 null + 完整失败清单（完全降级）', () => {
    const outcome = resolveAssetLoadOutcome(
      rejected<HTMLImageElement>(),
      walkImages.map(() => rejected<HTMLImageElement>())
    )
    expect(outcome.idle).toBeNull()
    expect(outcome.walk).toBeNull()
    expect(outcome.failures).toEqual([
      'v2/walk/walk-01.png（idle 静止帧）',
      'v2/walk/walk-01.png',
      'v2/walk/walk-02.png',
      'v2/walk/walk-03.png',
      'v2/walk/walk-04.png',
      'v2/walk/walk-05.png',
      'v2/walk/walk-06.png',
      'v2/walk/walk-07.png',
      'v2/walk/walk-08.png'
    ])
  })
})

describe('帧序列完整性（场景 1 / 12，Task 11E-v2）', () => {
  it('WALK_FRAME_URLS 恰为 8 帧', () => {
    expect(WALK_FRAME_URLS).toHaveLength(8)
  })

  it('帧序与 v2 素材包 manifest 一致（walk-01..08 顺序）', () => {
    WALK_FRAME_URLS.forEach((url, index) => {
      expect(url).toContain(`/v2/walk/walk-0${index + 1}.png`)
    })
  })

  it('idle 静止帧 = v2 walk-01（同 URL 复用，渲染层按 URL 去重共享纹理）', () => {
    expect(IDLE_FRAME_URL).toBe(WALK_FRAME_URLS[0])
  })
})

describe('Task 11H：跑步动画（状态映射 / 帧率 / 素材降级）', () => {
  it('running → 播放跑步动画（showRun / runPlaying 为 true，showWalk 为 false）', () => {
    const command = resolveDisplayCommand(state('running', 'right'))
    expect(command.showRun).toBe(true)
    expect(command.runPlaying).toBe(true)
    expect(command.showWalk).toBe(false)
    expect(command.walkPlaying).toBe(false)
  })

  it('walking → 不播放跑步动画（行走与跑步互斥）', () => {
    const command = resolveDisplayCommand(state('walking', 'right'))
    expect(command.showRun).toBe(false)
    expect(command.runPlaying).toBe(false)
  })

  it.each(['idle', 'turning', 'sitting', 'lying', 'paused', 'dragging'] as const)(
    'Task 11H：%s → 不播放跑步动画（静态/姿态基底）',
    (kind) => {
      const command = resolveDisplayCommand(state(kind, 'right'))
      expect(command.showRun).toBe(false)
      expect(command.runPlaying).toBe(false)
    }
  )

  it('running 的缩放与定位与 walking 完全一致（同一容器，不因状态改变形象参数）', () => {
    const walking = resolveDisplayCommand(state('walking', 'right'))
    const running = resolveDisplayCommand(state('running', 'right'))
    expect(running.scaleX).toBe(walking.scaleX)
    expect(running.scaleY).toBe(walking.scaleY)
    expect(running.positionX).toBe(walking.positionX)
    expect(running.positionY).toBe(walking.positionY)
    expectFootAnchorStable(running)
  })

  it('running 朝左同样水平镜像（与 walk 共用容器镜像逻辑）', () => {
    const command = resolveDisplayCommand(state('running', 'left'))
    expect(command.mirrored).toBe(true)
    expect(command.scaleX).toBe(-CHARACTER_SCALE)
    expectFootAnchorStable(command)
  })

  it('RUN_FRAME_URLS 恰为 8 帧，帧序与 v3 素材包 manifest 一致（run-01..08）', () => {
    expect(RUN_FRAME_URLS).toHaveLength(8)
    RUN_FRAME_URLS.forEach((url, index) => {
      expect(url).toContain(`/v2/run/run-0${index + 1}.png`)
    })
  })

  it('RUN_FPS = 12（manifest run fps，高于 walk 的 8），animationSpeed = 12/60', () => {
    expect(RUN_FPS).toBe(12)
    expect(RUN_FPS).toBeGreaterThan(WALK_FPS)
    expect(toAnimationSpeed(RUN_FPS, TICKER_FPS)).toBeCloseTo(12 / 60, 12)
  })

  it('isSameCommand 识别 showRun 差异（walking 与 running 是不同命令）', () => {
    const walking = resolveDisplayCommand(state('walking', 'right'))
    const running = resolveDisplayCommand(state('running', 'right'))
    expect(isSameCommand(walking, running)).toBe(false)
    const tweaked: DisplayCommand = { ...running, showRun: false }
    expect(isSameCommand(running, tweaked)).toBe(false)
  })

  it('PetDisplayController 幂等：running 重复广播只应用一次', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(state('running', 'right'))
    controller.apply(state('running', 'right'))
    expect(applyCommand).toHaveBeenCalledTimes(1)
  })

  it('run 全部帧成功 → run 组完整返回，与 walk 互不影响', () => {
    const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
    const walkImages = Array.from(
      { length: 8 },
      (_, i) => `walk-${i + 1}` as unknown as HTMLImageElement
    )
    const runImages = Array.from(
      { length: 8 },
      (_, i) => `run-${i + 1}` as unknown as HTMLImageElement
    )
    const outcome = resolveAssetLoadOutcome(
      fulfilled(walkImages[0]),
      walkImages.map(fulfilled),
      runImages.map(fulfilled)
    )
    expect(outcome.run).toEqual(runImages)
    expect(outcome.walk).toEqual(walkImages)
    expect(outcome.failures).toEqual([])
  })

  it('run 任一帧失败 → run 整组为 null（渲染层回退 walk 视觉），walk 不受影响', () => {
    const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
    const rejected = <T>(): PromiseSettledResult<T> => ({
      status: 'rejected',
      reason: 'load error'
    })
    const walkImages = Array.from(
      { length: 8 },
      (_, i) => `walk-${i + 1}` as unknown as HTMLImageElement
    )
    const runResults = Array.from({ length: 8 }, (_, i) =>
      i === 3
        ? rejected<HTMLImageElement>()
        : fulfilled(`run-${i + 1}` as unknown as HTMLImageElement)
    )
    const outcome = resolveAssetLoadOutcome(
      fulfilled(walkImages[0]),
      walkImages.map(fulfilled),
      runResults
    )
    expect(outcome.run).toBeNull()
    expect(outcome.walk).toEqual(walkImages)
    expect(outcome.failures).toEqual(['v2/run/run-04.png'])
  })

  it('省略 runResults（旧调用方）→ run 为 null（不产生失败记录）', () => {
    const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
    const walkImages = Array.from(
      { length: 8 },
      (_, i) => `walk-${i + 1}` as unknown as HTMLImageElement
    )
    const outcome = resolveAssetLoadOutcome(fulfilled(walkImages[0]), walkImages.map(fulfilled))
    expect(outcome.run).toBeNull()
    expect(outcome.failures).toEqual([])
  })
})

describe('Task 11I：正面待机与朝向自动切换', () => {
  it('idle 显示正面静态帧（orientation=front，不播放任何动画）', () => {
    const command = resolveDisplayCommand(state('idle', 'right'))
    expect(command.orientation).toBe('front')
    expect(command.showWalk).toBe(false)
    expect(command.showRun).toBe(false)
  })

  it('idle + facing left / right 均不错误镜像正面图（mirrored 恒 false）', () => {
    for (const facing of ['left', 'right'] as const) {
      const command = resolveDisplayCommand(state('idle', facing))
      expect(command.orientation).toBe('front')
      expect(command.mirrored).toBe(false)
      // 等比正面缩放（非镜像负号）
      expect(command.scaleX).toBe(FRONT_IDLE_SCALE)
      expect(command.scaleY).toBe(FRONT_IDLE_SCALE)
    }
  })

  it('null 状态（加载完成前默认待机）同样显示正面', () => {
    const command = resolveDisplayCommand(null)
    expect(command.orientation).toBe('front')
    expect(command.mirrored).toBe(false)
  })

  it('paused 属无动作静止显示 → 正面 idle；turning 属过渡期 → 保持侧面', () => {
    const paused = resolveDisplayCommand(state('paused', 'left'))
    expect(paused.orientation).toBe('front')
    expect(paused.mirrored).toBe(false)
    const turning = resolveDisplayCommand(state('turning', 'left'))
    expect(turning.orientation).toBe('side')
    expect(turning.mirrored).toBe(true)
  })

  it('walking left → 左向 walk（side + 镜像）；walking right → 右向 walk（side 不镜像）', () => {
    const left = resolveDisplayCommand(state('walking', 'left'))
    expect(left.orientation).toBe('side')
    expect(left.mirrored).toBe(true)
    expect(left.showWalk).toBe(true)
    expect(left.scaleX).toBe(-CHARACTER_SCALE)
    const right = resolveDisplayCommand(state('walking', 'right'))
    expect(right.orientation).toBe('side')
    expect(right.mirrored).toBe(false)
    expect(right.showWalk).toBe(true)
    expect(right.scaleX).toBe(CHARACTER_SCALE)
  })

  it('running left/right → 对应方向的 run（side + 镜像规则与 walk 一致）', () => {
    const left = resolveDisplayCommand(state('running', 'left'))
    expect(left.orientation).toBe('side')
    expect(left.mirrored).toBe(true)
    expect(left.showRun).toBe(true)
    const right = resolveDisplayCommand(state('running', 'right'))
    expect(right.orientation).toBe('side')
    expect(right.mirrored).toBe(false)
    expect(right.showRun).toBe(true)
  })

  it('dragging 沿用侧面静态帧（拖动视觉不回归，随 facing 镜像规则不变）', () => {
    const left = resolveDisplayCommand(state('dragging', 'left'))
    expect(left.orientation).toBe('side')
    expect(left.mirrored).toBe(true)
    expect(left.showWalk).toBe(false)
    expect(left.scaleY).toBe(CHARACTER_SCALE)
    const right = resolveDisplayCommand(state('dragging', 'right'))
    expect(right.orientation).toBe('side')
    expect(right.mirrored).toBe(false)
  })

  it('sitting/lying 使用正面姿态素材（Task 11I 坐/趴面向用户，不镜像、正面缩放）', () => {
    for (const kind of ['sitting', 'lying'] as const) {
      for (const facing of ['left', 'right'] as const) {
        const command = resolveDisplayCommand(state(kind, facing))
        expect(command.orientation).toBe('front')
        expect(command.mirrored).toBe(false)
        expect(command.scaleY).toBe(FRONT_IDLE_SCALE)
        expect(command.positionY).toBeCloseTo(227.5 - FRONT_IDLE_SCALE * 464, 10)
      }
    }
  })

  it('walking → idle 切换产生新命令（side 行走 → front 正面）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(state('walking', 'right'))
    controller.apply(state('idle', 'right'))
    expect(applyCommand).toHaveBeenCalledTimes(2)
    const last = applyCommand.mock.calls[1][0] as DisplayCommand
    expect(last.orientation).toBe('front')
    expect(last.showWalk).toBe(false)
    expect(last.mirrored).toBe(false)
  })

  it('running → idle 切换产生新命令（side 跑步 → front 正面）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(state('running', 'left'))
    controller.apply(state('idle', 'left'))
    expect(applyCommand).toHaveBeenCalledTimes(2)
    const last = applyCommand.mock.calls[1][0] as DisplayCommand
    expect(last.orientation).toBe('front')
    expect(last.mirrored).toBe(false)
  })

  it('idle → walking 切换产生新命令（front 正面 → side 行走，镜像随方向）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(state('idle', 'right'))
    controller.apply(state('walking', 'left'))
    expect(applyCommand).toHaveBeenCalledTimes(2)
    const last = applyCommand.mock.calls[1][0] as DisplayCommand
    expect(last.orientation).toBe('side')
    expect(last.mirrored).toBe(true)
    expect(last.showWalk).toBe(true)
  })

  it('正面帧的脚底锚点与侧面帧一致（同一参考点，切换无脚底跳动）', () => {
    const front = resolveDisplayCommand(state('idle', 'right'))
    const side = resolveDisplayCommand(state('walking', 'right'))
    expectFootAnchorStable(front)
    expectFootAnchorStable(side)
  })

  it('front-idle 独立缩放：显示高度与侧面 idle 一致，顶部不溢出画布', () => {
    // 计算依据（素材 alpha 实测）：front 帧可见高 438px（y 26..463），
    // side walk-01 可见高 327px；统一脚底锚点 y=464。
    const frontTopY = 26
    const sideTopY = 134
    const frontHeight = 438
    const sideHeight = 327
    // 显示高度一致（±2px 内），切换时角色整体大小无明显跳变
    const frontDisplayHeight = FRONT_IDLE_SCALE * frontHeight
    const sideDisplayHeight = CHARACTER_SCALE * sideHeight
    expect(Math.abs(frontDisplayHeight - sideDisplayHeight)).toBeLessThanOrEqual(2)
    // 顶部不越出画布（脚底目标 227.5 向上不超过显示高度）
    expect(FOOT_TARGET.y - FRONT_IDLE_SCALE * (464 - frontTopY)).toBeGreaterThanOrEqual(0)
    expect(FOOT_TARGET.y - CHARACTER_SCALE * (464 - sideTopY)).toBeGreaterThanOrEqual(0)
    // 等比：水平垂直缩放一致，无拉伸
    expect(FRONT_IDLE_SCALE).toBeGreaterThan(0)
  })

  it('正面帧与侧面帧 URL 独立（正面静态帧不与 walk 首帧共用）', () => {
    expect(FRONT_IDLE_FRAME_URL).not.toBe(IDLE_FRAME_URL)
    expect(FRONT_IDLE_FRAME_URL).toContain('/v4/front-idle-01.png')
  })

  it('isSameCommand 识别 orientation 差异（idle 与 dragging 是不同命令）', () => {
    const idle = resolveDisplayCommand(state('idle', 'right'))
    const dragging = resolveDisplayCommand(state('dragging', 'right'))
    expect(idle.orientation).toBe('front')
    expect(dragging.orientation).toBe('side')
    expect(isSameCommand(idle, dragging)).toBe(false)
    const tweaked: DisplayCommand = { ...idle, orientation: 'side' }
    expect(isSameCommand(idle, tweaked)).toBe(false)
  })

  it('重复 idle 广播只应用一次（不重复触发纹理/动画应用）', () => {
    const applyCommand = vi.fn()
    const controller = new PetDisplayController(applyCommand)
    controller.apply(state('idle', 'left'))
    controller.apply(state('idle', 'left'))
    controller.apply(state('idle', 'right')) // facing 变化不改变 front 命令 → 幂等
    expect(applyCommand).toHaveBeenCalledTimes(1)
  })

  it('素材加载竞态使用最新状态（迟到旧状态被最新命令覆盖）', () => {
    const applied: DisplayCommand[] = []
    const controller = new PetDisplayController((command): void => {
      applied.push(command)
    })
    controller.apply(state('walking', 'right'))
    controller.apply(state('idle', 'right'))
    controller.apply(state('idle', 'right')) // 重复广播幂等
    expect(applied).toHaveLength(2)
    expect(applied[applied.length - 1].orientation).toBe('front')
  })

  describe('resolveAssetLoadOutcome：正面帧降级（Task 11I）', () => {
    const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
    const rejected = <T>(reason = 'load error'): PromiseSettledResult<T> => ({
      status: 'rejected',
      reason
    })
    const idleImage = 'idle-image' as unknown as HTMLImageElement
    const frontImage = 'front-image' as unknown as HTMLImageElement
    const walkImages = Array.from(
      { length: 8 },
      (_, i) => `walk-${i + 1}` as unknown as HTMLImageElement
    )

    it('正面帧成功 → frontIdle 返回，无失败记录', () => {
      const outcome = resolveAssetLoadOutcome(
        fulfilled(idleImage),
        walkImages.map(fulfilled),
        undefined,
        fulfilled(frontImage)
      )
      expect(outcome.frontIdle).toBe(frontImage)
      expect(outcome.failures).toEqual([])
    })

    it('正面帧失败 → frontIdle 为 null（渲染层回退侧面 idle），walk/run/idle 不受影响', () => {
      const outcome = resolveAssetLoadOutcome(
        fulfilled(idleImage),
        walkImages.map(fulfilled),
        undefined,
        rejected<HTMLImageElement>()
      )
      expect(outcome.frontIdle).toBeNull()
      expect(outcome.idle).toBe(idleImage)
      expect(outcome.walk).toEqual(walkImages)
      expect(outcome.failures).toEqual(['v4/front-idle-01.png（正面待机帧）'])
    })

    it('省略 frontResult（旧调用方）→ frontIdle 为 null（不产生失败记录）', () => {
      const outcome = resolveAssetLoadOutcome(fulfilled(idleImage), walkImages.map(fulfilled))
      expect(outcome.frontIdle).toBeNull()
      expect(outcome.failures).toEqual([])
    })

    it('Task 11J：交互组（front/side）全部成功 → 两组完整返回', () => {
      const frontImages = Array.from(
        { length: 8 },
        (_, i) => `front-int-${i + 1}` as unknown as HTMLImageElement
      )
      const sideImages = Array.from(
        { length: 8 },
        (_, i) => `side-int-${i + 1}` as unknown as HTMLImageElement
      )
      const outcome = resolveAssetLoadOutcome(
        fulfilled(idleImage),
        walkImages.map(fulfilled),
        undefined,
        fulfilled(frontImage),
        frontImages.map(fulfilled),
        sideImages.map(fulfilled)
      )
      expect(outcome.frontInteraction).toEqual(frontImages)
      expect(outcome.sideInteraction).toEqual(sideImages)
      expect(outcome.failures).toEqual([])
    })

    it('Task 11J：front 交互组任一帧失败 → 整组 null（交互动画降级，拖动行为不受影响）', () => {
      const frontResults = Array.from({ length: 8 }, (_, i) =>
        i === 4
          ? rejected<HTMLImageElement>()
          : fulfilled(`front-int-${i + 1}` as unknown as HTMLImageElement)
      )
      const outcome = resolveAssetLoadOutcome(
        fulfilled(idleImage),
        walkImages.map(fulfilled),
        undefined,
        fulfilled(frontImage),
        frontResults,
        Array.from({ length: 8 }, (_, i) =>
          fulfilled(`side-int-${i + 1}` as unknown as HTMLImageElement)
        )
      )
      expect(outcome.frontInteraction).toBeNull()
      expect(outcome.sideInteraction).not.toBeNull()
      expect(outcome.idle).toBe(idleImage)
      expect(outcome.frontIdle).toBe(frontImage)
      expect(outcome.failures).toEqual(['v4/front/interaction/interaction-05.png'])
    })

    it('Task 11J：side 交互组失败 → 整组 null 且记录正确序号', () => {
      const sideResults = Array.from({ length: 8 }, (_, i) =>
        i === 7
          ? rejected<HTMLImageElement>()
          : fulfilled(`side-int-${i + 1}` as unknown as HTMLImageElement)
      )
      const outcome = resolveAssetLoadOutcome(
        fulfilled(idleImage),
        walkImages.map(fulfilled),
        undefined,
        fulfilled(frontImage),
        Array.from({ length: 8 }, (_, i) =>
          fulfilled(`front-int-${i + 1}` as unknown as HTMLImageElement)
        ),
        sideResults
      )
      expect(outcome.sideInteraction).toBeNull()
      expect(outcome.failures).toEqual(['v4/side-right/interaction/interaction-08.png'])
    })

    it('Task 11J：省略交互组参数（旧调用方）→ 两组 null（不产生失败记录）', () => {
      const outcome = resolveAssetLoadOutcome(
        fulfilled(idleImage),
        walkImages.map(fulfilled),
        undefined,
        fulfilled(frontImage)
      )
      expect(outcome.frontInteraction).toBeNull()
      expect(outcome.sideInteraction).toBeNull()
      expect(outcome.failures).toEqual([])
    })
  })
})

describe('scaleDisplayCommand（Task 12B：用户宠物倍率）', () => {
  const sideRight = resolveDisplayCommand({ kind: 'walking', facing: 'right' } as PetVisualState)
  const sideLeft = resolveDisplayCommand({ kind: 'walking', facing: 'left' } as PetVisualState)
  const frontIdle = resolveDisplayCommand({ kind: 'idle', facing: 'right' } as PetVisualState)

  it('等比缩放：scaleX/scaleY 绝对值 = 基础缩放 × 倍率（不非等比拉伸）', () => {
    const scaled = scaleDisplayCommand(sideRight, 0.8)
    expect(Math.abs(scaled.scaleX)).toBeCloseTo(CHARACTER_SCALE * 0.8)
    expect(scaled.scaleY).toBeCloseTo(CHARACTER_SCALE * 0.8)
    // 符号（镜像语义）保留
    expect(Math.sign(scaled.scaleX)).toBe(Math.sign(sideRight.scaleX))
  })

  it('脚底锚点重算：缩放后脚底落点恒定（正面/侧面/镜像均稳定）', () => {
    for (const command of [sideRight, sideLeft, frontIdle]) {
      for (const petScale of [0.7, 0.85, 1.0]) {
        const scaled = scaleDisplayCommand(command, petScale)
        // 脚底参考点经缩放后必须仍落在 FOOT_TARGET：
        // 非镜像：positionX + scaleX'×REF.x = TARGET.x（scaleX'>0）
        // 镜像：positionX + scaleX'×REF.x = TARGET.x（scaleX'<0，等价右侧展开）
        expect(scaled.positionX + scaled.scaleX * FOOT_REFERENCE.x).toBeCloseTo(FOOT_TARGET.x)
        expect(scaled.positionY + scaled.scaleY * FOOT_REFERENCE.y).toBeCloseTo(FOOT_TARGET.y)
      }
    }
  })

  it('倍率 1：命令原样返回（已验收标准尺寸不受影响）', () => {
    expect(scaleDisplayCommand(sideRight, 1)).toBe(sideRight)
  })

  it('非法倍率（非有限/非正）：命令原样返回（防御）', () => {
    expect(scaleDisplayCommand(sideRight, 0)).toBe(sideRight)
    expect(scaleDisplayCommand(sideRight, -0.5)).toBe(sideRight)
    expect(scaleDisplayCommand(sideRight, Number.NaN)).toBe(sideRight)
  })

  it('镜像稳定：左右镜像缩放后关于中轴对称（脚底落点一致）', () => {
    const a = scaleDisplayCommand(sideRight, 0.75)
    const b = scaleDisplayCommand(sideLeft, 0.75)
    expect(a.positionX + a.scaleX * FOOT_REFERENCE.x).toBeCloseTo(
      b.positionX + b.scaleX * FOOT_REFERENCE.x
    )
    expect(a.positionY).toBeCloseTo(b.positionY)
    expect(Math.abs(a.scaleX)).toBeCloseTo(Math.abs(b.scaleX))
  })

  it('正面与侧面基础缩放独立倍乘（不硬编码覆盖任何常量）', () => {
    expect(Math.abs(scaleDisplayCommand(frontIdle, 0.7).scaleX)).toBeCloseTo(FRONT_IDLE_SCALE * 0.7)
    expect(Math.abs(scaleDisplayCommand(sideRight, 0.7).scaleX)).toBeCloseTo(CHARACTER_SCALE * 0.7)
  })

  it('缩放在安全范围内不超出画布：side 最宽帧 ±190px × 缩放 ≤ 120', () => {
    // 素材横向最大跨度 ±190px（相对中线），显示半宽 = 190 × |scaleX'|
    const maxHalfWidth = 190 * CHARACTER_SCALE * 0.7
    expect(maxHalfWidth).toBeLessThanOrEqual(FOOT_TARGET.x)
  })
})
