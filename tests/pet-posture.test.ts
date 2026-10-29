/**
 * Task 11F / 11F-B：sit/lie 姿态动画控制器测试（纯逻辑层）。
 *
 * 覆盖任务规格要求中的纯逻辑部分：
 * - sit/lie 进入按序播放、停留在保持帧、sit 眨眼循环、退出反向播放；
 * - 重复进入幂等、进入中退出、退出中再进入、sit/lie 互切；
 * - interrupt 立即复位——对应 dragging 中断与 walking 恢复；
 * - 素材不可用降级、可用性竞态；
 * - 配置与素材包 manifest 一致性（帧序、fps、hold 时序）；
 * - Task 11F-B：v3 素材（尺寸归一）在统一 0.625 缩放下逐帧画布适配、
 *   镜像接地稳定性、walk 显示参数不回归。
 *
 * 场景 15（左右镜像）由容器镜像架构与实机验收覆盖；
 * 场景 18（卸载清理）与 19（预览不进生产）为渲染层/构建层职责，
 * 分别以代码审查与产物检索验证；场景 20 为全量回归。
 */

import { describe, expect, it } from 'vitest'
import {
  PetPostureController,
  POSTURE_ASSETS,
  POSTURE_FRAME_URLS,
  type PostureKind
} from '../src/renderer/src/pet/pet-posture'
import {
  CHARACTER_SCALE,
  FRONT_IDLE_SCALE,
  resolveDisplayCommand
} from '../src/renderer/src/pet/pet-animation'
import type { PetVisualState } from '../src/shared/pet-visual-state'

/** sit/lie 进入帧时长（manifest fps=7） */
const FRAME_MS = 1000 / 7

function alwaysAvailable(): boolean {
  return true
}

/** 分步推进时间（默认 16ms 一步，模拟 ticker） */
function tick(controller: PetPostureController, totalMs: number, stepMs = 16): void {
  let remaining = totalMs
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining)
    controller.update(step)
    remaining -= step
  }
}

describe('配置与 manifest 一致性（素材包 v3）', () => {
  it('帧 URL 按 manifest 帧序排列（sit-01..08、lie-01..08，Task 11I 起使用 v3 front 正面素材）', () => {
    for (const kind of ['sit', 'lie'] as const) {
      const urls = POSTURE_FRAME_URLS[kind]
      expect(urls).toHaveLength(8)
      urls.forEach((url, index) => {
        expect(url).toContain(`/v3/front/${kind}/${kind}-0${index + 1}.png`)
      })
    }
  })

  it('sit hold 眨眼循环与 manifest 一致（05:1800 / 07:110 / 05:1400）', () => {
    expect(POSTURE_ASSETS.sit.holdCycle).toEqual([
      { index: 4, durationMs: 1800 },
      { index: 6, durationMs: 110 },
      { index: 4, durationMs: 1400 }
    ])
  })

  it('lie hold 恢复眨眼循环（用户确认保留 v2 效果，偏离 v3 manifest 单帧保持）', () => {
    expect(POSTURE_ASSETS.lie.holdCycle).toEqual([
      { index: 4, durationMs: 1800 },
      { index: 6, durationMs: 110 },
      { index: 4, durationMs: 1400 }
    ])
  })

  it('进入/退出序列：sit 与 lie 均为完整 01..05 / 05..01（v3 尺寸归一，sit-01 恢复）', () => {
    for (const kind of ['sit', 'lie'] as const) {
      expect(POSTURE_ASSETS[kind].enterIndices).toEqual([0, 1, 2, 3, 4])
      expect(POSTURE_ASSETS[kind].exitIndices).toEqual([4, 3, 2, 1, 0])
      expect(POSTURE_ASSETS[kind].transitionFps).toBe(7)
    }
  })
})

describe('sit：进入 / 保持 / 眨眼 / 退出（场景 1–4）', () => {
  it('场景 1：进入阶段按 manifest 顺序完整播放（帧 01→05）', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    for (const expected of [0, 1, 2, 3]) {
      expect(c.snapshot.frameIndex).toBe(expected)
      tick(c, FRAME_MS)
    }
    expect(c.snapshot.frameIndex).toBe(4)
  })

  it('场景 2：进入完成后停留在保持帧，不再循环过渡动画', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 5 + 10)
    expect(c.snapshot).toEqual({ kind: 'sit', phase: 'holding', frameIndex: 4 })
    // 长时间保持：帧序号只在 hold 循环（4/6/4）内变化，不回到进入帧。
    tick(c, 10_000)
    expect(c.snapshot.phase).toBe('holding')
    expect([4, 6]).toContain(c.snapshot.frameIndex)
  })

  it('场景 3：眨眼帧（07）按 110ms 播放后返回保持帧（05）', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 5 + 10)
    tick(c, 1800)
    expect(c.snapshot.frameIndex).toBe(6)
    tick(c, 110)
    expect(c.snapshot.frameIndex).toBe(4)
    expect(c.snapshot.phase).toBe('holding')
  })

  it('场景 4：退出阶段反向播放完整序列（05→01）后回到站立', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 5 + 10)
    expect(c.snapshot.phase).toBe('holding')
    c.request(null)
    expect(c.snapshot.phase).toBe('exiting')
    // 保持帧即退出序列首帧，已显示；下一帧为 03。
    expect(c.snapshot.frameIndex).toBe(3)
    tick(c, FRAME_MS)
    expect(c.snapshot.frameIndex).toBe(2)
    tick(c, FRAME_MS)
    expect(c.snapshot.frameIndex).toBe(1)
    tick(c, FRAME_MS)
    expect(c.snapshot.frameIndex).toBe(0)
    tick(c, FRAME_MS)
    expect(c.snapshot).toEqual({ kind: null, phase: 'standing', frameIndex: null })
  })
})

describe('lie：进入 / 保持 / 退出（场景 5–8）', () => {
  it('场景 5：进入阶段按 manifest 顺序完整播放（帧 01→05）', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('lie')
    for (const expected of [0, 1, 2, 3]) {
      expect(c.snapshot.frameIndex).toBe(expected)
      tick(c, FRAME_MS)
    }
    expect(c.snapshot.frameIndex).toBe(4)
  })

  it('场景 6：lie 正确停留在保持帧（长时间保持不回到进入帧）', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('lie')
    tick(c, FRAME_MS * 5 + 10)
    expect(c.snapshot).toEqual({ kind: 'lie', phase: 'holding', frameIndex: 4 })
    // 长时间保持：帧序号只在 hold 循环（4/6/4）内变化，不回到进入帧。
    tick(c, 10_000)
    expect(c.snapshot.phase).toBe('holding')
    expect([4, 6]).toContain(c.snapshot.frameIndex)
  })

  it('场景 7：lie 眨眼帧（07）按 110ms 播放后返回保持帧（05）', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('lie')
    tick(c, FRAME_MS * 5 + 10)
    tick(c, 1800)
    expect(c.snapshot.frameIndex).toBe(6)
    tick(c, 110)
    expect(c.snapshot).toEqual({ kind: 'lie', phase: 'holding', frameIndex: 4 })
  })

  it('场景 8：lie 退出反向播放完整序列（05→01）后回到站立', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('lie')
    tick(c, FRAME_MS * 5 + 10)
    c.request(null)
    const seen: number[] = []
    seen.push(c.snapshot.frameIndex as number)
    for (let i = 0; i < 4; i++) {
      tick(c, FRAME_MS)
      if (c.snapshot.frameIndex !== null) {
        seen.push(c.snapshot.frameIndex)
      }
    }
    expect(seen).toEqual([3, 2, 1, 0])
    expect(c.snapshot).toEqual({ kind: null, phase: 'standing', frameIndex: null })
  })
})

describe('重复请求与切换（场景 9–12）', () => {
  it('场景 9：重复进入相同姿态不重复初始化（播放进度不重置）', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, 100) // 尚未走完第一帧（142.86ms）
    c.request('sit')
    expect(c.snapshot.frameIndex).toBe(0)
    tick(c, 50) // 累计 150ms 越过第一帧
    expect(c.snapshot.frameIndex).toBe(1)
    // 保持阶段重复请求同样幂等
    tick(c, FRAME_MS * 4 + 10)
    expect(c.snapshot.phase).toBe('holding')
    c.request('sit')
    expect(c.snapshot).toEqual({ kind: 'sit', phase: 'holding', frameIndex: 4 })
  })

  it('场景 10：进入途中收到退出请求：从当前帧反向续播，不闪回站立', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 2) // 已显示到帧 03
    expect(c.snapshot.frameIndex).toBe(2)
    c.request(null)
    expect(c.snapshot.phase).toBe('exiting')
    expect(c.snapshot.frameIndex).toBe(1)
    tick(c, FRAME_MS)
    expect(c.snapshot.frameIndex).toBe(0)
    tick(c, FRAME_MS)
    expect(c.snapshot.phase).toBe('standing')
  })

  it('场景 11：退出途中收到进入请求：从当前帧正向续播', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 5 + 10)
    c.request(null)
    expect(c.snapshot.frameIndex).toBe(3)
    c.request('sit')
    expect(c.snapshot.phase).toBe('entering')
    expect(c.snapshot.frameIndex).toBe(4)
    tick(c, FRAME_MS)
    expect(c.snapshot).toEqual({ kind: 'sit', phase: 'holding', frameIndex: 4 })
  })

  it('场景 12：sit 与 lie 切换：先反向退出当前姿态，再自动进入新姿态', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 5 + 10)
    expect(c.snapshot.kind).toBe('sit')
    c.request('lie')
    // 退出 sit 中
    expect(c.snapshot).toEqual({ kind: 'sit', phase: 'exiting', frameIndex: 3 })
    tick(c, FRAME_MS * 4 + 10) // 退出完成
    expect(c.snapshot).toEqual({ kind: 'lie', phase: 'entering', frameIndex: 0 })
    tick(c, FRAME_MS * 5 + 10) // lie 进入完成
    expect(c.snapshot).toEqual({ kind: 'lie', phase: 'holding', frameIndex: 4 })
  })
})

describe('中断与恢复（场景 13 / 14）', () => {
  it('场景 13：interrupt（如 dragging 接管）立即复位到站立，无反向动画', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 2)
    c.interrupt()
    expect(c.snapshot).toEqual({ kind: null, phase: 'standing', frameIndex: null })
    // 复位后可重新进入
    c.request('sit')
    expect(c.snapshot).toEqual({ kind: 'sit', phase: 'entering', frameIndex: 0 })
  })

  it('场景 14：interrupt 清除互切挂起请求（walking 接管后不残留姿态意图）', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    tick(c, FRAME_MS * 5 + 10)
    c.request('lie') // 挂起 lie
    expect(c.snapshot.phase).toBe('exiting')
    c.interrupt()
    expect(c.snapshot.phase).toBe('standing')
    // 退出序列不会在 interrupt 后把 lie 拉起：时间推进保持站立
    tick(c, 5000)
    expect(c.snapshot).toEqual({ kind: null, phase: 'standing', frameIndex: null })
  })
})

describe('素材可用性降级与竞态（场景 16 / 17）', () => {
  function makeController(available: PostureKind[]): PetPostureController {
    return new PetPostureController((kind) => available.includes(kind))
  }

  it('场景 16：素材不可用的姿态请求被忽略（回退基础 idle），不影响其他姿态', () => {
    const c = makeController(['lie'])
    c.request('sit')
    expect(c.snapshot.phase).toBe('standing')
    c.request('lie')
    expect(c.snapshot).toEqual({ kind: 'lie', phase: 'entering', frameIndex: 0 })
  })

  it('场景 17：可用性动态变化（懒加载完成）后请求正常生效', () => {
    const available: PostureKind[] = []
    const c = new PetPostureController((kind) => available.includes(kind))
    c.request('sit')
    expect(c.snapshot.phase).toBe('standing') // 未就绪：不进入
    available.push('sit') // 模拟懒加载完成
    c.request('sit')
    expect(c.snapshot).toEqual({ kind: 'sit', phase: 'entering', frameIndex: 0 })
  })

  it('互切目标在退出完成时才校验可用性，中途不可用则安全回站立', () => {
    const available: PostureKind[] = ['sit', 'lie']
    const c = new PetPostureController((kind) => available.includes(kind))
    c.request('sit')
    tick(c, FRAME_MS * 5 + 10)
    c.request('lie') // lie 可用：挂起互切，进入退出
    expect(c.snapshot.phase).toBe('exiting')
    available.length = 0 // 退出完成前 lie 变为不可用
    tick(c, FRAME_MS * 4 + 10)
    expect(c.snapshot).toEqual({ kind: null, phase: 'standing', frameIndex: null })
  })
})

describe('Task 11I：v3 front 正面素材画布适配（统一 FRONT_IDLE_SCALE 缩放，无裁剪）', () => {
  /**
   * v3 front sit/lie 全部 8 帧的 alpha≥0.16 可见边界实测
   *（Node zlib PNG 解码像素扫描，512×512 画布坐标；
   * 数据来源见任务报告——用于验证正面缩放下的显示适配）。
   */
  const V3_BOUNDS: Readonly<
    Record<PostureKind, readonly (readonly [number, number, number, number])[]>
  > = {
    sit: [
      [29, 366, 23, 460],
      [45, 366, 36, 459],
      [43, 368, 53, 460],
      [56, 375, 72, 459],
      [78, 392, 66, 459],
      [78, 390, 71, 460],
      [78, 393, 69, 460],
      [81, 390, 71, 460]
    ],
    lie: [
      [129, 405, 73, 460],
      [130, 368, 93, 460],
      [136, 369, 148, 460],
      [107, 372, 189, 460],
      [72, 382, 165, 460],
      [68, 378, 162, 460],
      [74, 376, 169, 459],
      [74, 379, 164, 459]
    ]
  }

  /** walk-01 边界（11E-v2 已验收素材，作对照基准） */
  const WALK01_BOUNDS = [70, 441, 134, 460] as const

  /**
   * 素材像素坐标 → 240×240 显示画布坐标。
   * 与渲染层一致：X = 120 + scale×(x-256)，Y = 227.5 + scale×(y-464)。
   * 姿态默认使用正面素材组缩放 FRONT_IDLE_SCALE（Task 11I）；
   * walk 对照使用侧面 CHARACTER_SCALE（11E-v2 验收值）。
   */
  function toDisplay(x: number, y: number, scale = FRONT_IDLE_SCALE): [number, number] {
    return [120 + scale * (x - 256), 227.5 + scale * (y - 464)]
  }

  it('sit / lie 每一帧（含备用帧）在 240×240 画布内完整显示，边距 ≥ 2px', () => {
    for (const kind of ['sit', 'lie'] as const) {
      V3_BOUNDS[kind].forEach(([minX, maxX, minY, maxY], i) => {
        const [left, top] = toDisplay(minX, minY)
        const [right, bottom] = toDisplay(maxX, maxY)
        expect(left).toBeGreaterThanOrEqual(2)
        expect(240 - right).toBeGreaterThanOrEqual(2)
        expect(top).toBeGreaterThanOrEqual(2)
        expect(240 - bottom).toBeGreaterThanOrEqual(2)
        // 覆盖帧序完整性（8 帧全部参与校验）
        expect(i).toBeLessThan(8)
      })
    }
  })

  it('sit-01（进入起点）与正面待机帧同高：同一缩放下站立→坐姿衔接无大小跳变', () => {
    // 正面待机 interaction-01 与 v3 front sit-01 可见高均为 438px
    //（alpha 实测像素行计数：y 26..463 / 23..460），FRONT_IDLE_SCALE
    // 下显示高一致。
    const sit01 = V3_BOUNDS.sit[0]
    const sitHeight = sit01[3] - sit01[2] + 1
    const frontIdleHeight = 463 - 26 + 1
    expect(sitHeight).toBe(438)
    expect(frontIdleHeight).toBe(438)
    expect(sitHeight * FRONT_IDLE_SCALE).toBeCloseTo(frontIdleHeight * FRONT_IDLE_SCALE, 6)
  })

  it('walk-01（对照基准）在侧面缩放下边距不小于 1px——walk 显示参数不回归', () => {
    const [minX, , minY] = WALK01_BOUNDS
    const [, maxY] = WALK01_BOUNDS
    const [left, top] = toDisplay(minX, minY, CHARACTER_SCALE)
    const [, bottom] = toDisplay(441, maxY, CHARACTER_SCALE)
    expect(left).toBeGreaterThanOrEqual(1)
    expect(240 - left - 0.625 * (441 - 70)).toBeGreaterThanOrEqual(1)
    expect(top).toBeGreaterThanOrEqual(1)
    expect(bottom).toBeLessThanOrEqual(240)
  })

  it('sit / lie 与 walk 接地一致：内容底边显示坐标与 walk-01 差 ≤ 1px', () => {
    const walkBottom = toDisplay(256, 460, CHARACTER_SCALE)[1]
    for (const kind of ['sit', 'lie'] as const) {
      V3_BOUNDS[kind].forEach(([, , , maxY]) => {
        const bottom = toDisplay(256, maxY)[1]
        expect(Math.abs(bottom - walkBottom)).toBeLessThanOrEqual(1)
      })
    }
  })

  it('正面素材不镜像：sitting/lying 显示命令 mirrored 恒为 false（Task 11I）', () => {
    // 正面素材无方向语义，渲染层不随历史 facing 镜像（与 idle 一致）；
    // 侧面素材的镜像包围盒适配校验随素材切换不再适用。
    for (const kind of ['sitting', 'lying'] as const) {
      for (const facing of ['left', 'right'] as const) {
        const command = resolveDisplayCommand({ kind, facing } as PetVisualState)
        expect(command.orientation).toBe('front')
        expect(command.mirrored).toBe(false)
        expect(command.scaleX).toBe(FRONT_IDLE_SCALE)
      }
    }
  })

  it('统一缩放常量未被改动（0.625，walk 视觉参数保持 11E-v2 验收值）', () => {
    expect(CHARACTER_SCALE).toBe(0.625)
    expect(FRONT_IDLE_SCALE).toBe(0.467)
  })
})

describe('健壮性', () => {
  it('大步长时间推进（如卡顿补偿）正确跨越多帧并停在正确阶段', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    c.update(10_000)
    expect(c.snapshot.phase).toBe('holding')
    expect([4, 6]).toContain(c.snapshot.frameIndex)
  })

  it('非法时间增量（NaN/负数/0）不推进状态', () => {
    const c = new PetPostureController(alwaysAvailable)
    c.request('sit')
    for (const bad of [Number.NaN, -100, 0]) {
      c.update(bad)
      expect(c.snapshot.frameIndex).toBe(0)
    }
    tick(c, FRAME_MS)
    expect(c.snapshot.frameIndex).toBe(1)
  })

  it('standing 状态下 update 不产生任何变化', () => {
    const c = new PetPostureController(alwaysAvailable)
    tick(c, 10_000)
    expect(c.snapshot).toEqual({ kind: null, phase: 'standing', frameIndex: null })
  })
})
