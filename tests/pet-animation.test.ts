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
  IDLE_FRAME_URL,
  isSameCommand,
  PetDisplayController,
  resolveAssetLoadOutcome,
  resolveDisplayCommand,
  toAnimationSpeed,
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
    'Task 11G：%s → 静态 idle 基底（姿态精灵由 posture 层叠加显示）',
    (kind) => {
      const command = resolveDisplayCommand(state(kind, 'right'))
      expect(command.showWalk).toBe(false)
      expect(command.walkPlaying).toBe(false)
      // 缩放与定位与 walk/idle 完全一致（11E-v2 验收参数不回归）
      expect(command.scaleY).toBe(CHARACTER_SCALE)
      expect(command.positionY).toBeCloseTo(227.5 - CHARACTER_SCALE * 464, 10)
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

  it('非行走状态同样按 facing 镜像（idle 也保持朝向一致）', () => {
    expect(resolveDisplayCommand(state('idle', 'left')).mirrored).toBe(true)
    expect(resolveDisplayCommand(state('idle', 'right')).mirrored).toBe(false)
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
