/**
 * Task 11J：交互动画播放器纯逻辑层测试。
 *
 * 覆盖任务规格的测试点：
 * 1.  短点击识别与正确帧序（01→02→01，70/200/120ms → normal）；
 * 2.  拎起帧序（03→04→05，100/140/180ms → held）；
 * 3.  悬空保持循环（05→06→05，320ms×3）；
 * 4.  放下帧序（07→08→01，140/180/160ms → normal）；
 * 5.  悬空位移曲线（lifting 线性上升 → held 恒定 → dropping 线性回落）；
 * 6.  朝向锁定与释放恢复（snapshot.orientation 语义）；
 * 7.  快速连续操作：click 重播、lifting 中 drop、dropping 中再 pickup、
 *     拎起流程中 click 忽略；
 * 8.  interrupt 复位（真实状态接管 / 卸载）；
 * 9.  大步长时间推进（卡顿补偿）跨帧正确；
 * 10. 非法时间增量安全；
 * 11. 素材帧序完整性（front 8 帧含复用的待机帧、side 8 帧）；
 * 12. 悬空位移上限与画布适配（front interaction-05 topGap=17px 实测）。
 */

import { describe, expect, it } from 'vitest'
import {
  INTERACTION_FRAME_URLS,
  INTERACTION_LIFT_OFFSET_PX,
  PetInteractionController
} from '../src/renderer/src/pet/pet-interaction'
import { FRONT_IDLE_FRAME_URL } from '../src/renderer/src/pet/pet-animation'

/** 时间推进辅助：按毫步长推进（模拟 ticker 逐帧；步长 5ms 整除全部帧时长） */
function tick(controller: PetInteractionController, ms: number, step = 5): void {
  let remaining = ms
  while (remaining > 0) {
    const dt = Math.min(step, remaining)
    controller.update(dt)
    remaining -= dt
  }
}

describe('Task 11J：素材帧序完整性', () => {
  it('front 组 8 帧：01 复用正面待机帧 URL（同文件单份打包），02..08 为 interaction 帧', () => {
    expect(INTERACTION_FRAME_URLS.front).toHaveLength(8)
    expect(INTERACTION_FRAME_URLS.front[0]).toBe(FRONT_IDLE_FRAME_URL)
    INTERACTION_FRAME_URLS.front.forEach((url, index) => {
      if (index === 0) {
        return
      }
      expect(url).toContain(`/v4/front/interaction/interaction-0${index + 1}.png`)
    })
  })

  it('side 组 8 帧（side-right 素材，左侧由容器镜像实现，不复制 side-left）', () => {
    expect(INTERACTION_FRAME_URLS.side).toHaveLength(8)
    INTERACTION_FRAME_URLS.side.forEach((url, index) => {
      expect(url).toContain(`/v4/side-right/interaction/interaction-0${index + 1}.png`)
    })
  })

  it('front 与 side 组 URL 无交集（除共享的待机帧外互不混用）', () => {
    const sideSet = new Set(INTERACTION_FRAME_URLS.side)
    INTERACTION_FRAME_URLS.front.forEach((url) => {
      // front-01（待机帧）不在 side 组中，其余也不应重合。
      expect(sideSet.has(url)).toBe(false)
    })
  })
})

describe('Task 11J：短点击反馈（01→02→01，70/200/120ms）', () => {
  it('requestClick → clickFeedback 帧 01 开始，按帧时长推进，结束后回 normal', () => {
    const c = new PetInteractionController()
    c.requestClick('front')
    expect(c.snapshot).toEqual({
      phase: 'clickFeedback',
      frameIndex: 0,
      orientation: 'front',
      liftOffsetPx: 0
    })
    tick(c, 70) // 第一帧完成
    expect(c.snapshot.frameIndex).toBe(1) // 02
    tick(c, 200)
    expect(c.snapshot.frameIndex).toBe(0) // 回到 01（反馈结束帧）
    tick(c, 120)
    expect(c.snapshot.phase).toBe('normal')
    expect(c.snapshot.frameIndex).toBeNull()
    expect(c.snapshot.orientation).toBeNull()
  })

  it('点击反馈期间 liftOffsetPx 恒为 0（点击不悬空）', () => {
    const c = new PetInteractionController()
    c.requestClick('side')
    tick(c, 300)
    expect(c.snapshot.liftOffsetPx).toBe(0)
  })

  it('短按后立即再次点击：重新播放反馈（最新事件优先）', () => {
    const c = new PetInteractionController()
    c.requestClick('front')
    tick(c, 100) // 在 02 帧
    expect(c.snapshot.frameIndex).toBe(1)
    c.requestClick('front') // 再次点击 → 重播
    expect(c.snapshot.frameIndex).toBe(0)
    tick(c, 70)
    expect(c.snapshot.frameIndex).toBe(1)
  })
})

describe('Task 11J：拎起（03→04→05，100/140/180ms → held）', () => {
  it('requestPickup → lifting 从 03 开始，序列推进到 05 后进入 held', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    expect(c.snapshot.phase).toBe('lifting')
    expect(c.snapshot.frameIndex).toBe(2) // 03
    tick(c, 100)
    expect(c.snapshot.frameIndex).toBe(3) // 04
    tick(c, 140)
    expect(c.snapshot.frameIndex).toBe(4) // 05
    tick(c, 180)
    expect(c.snapshot.phase).toBe('held')
    expect(c.snapshot.frameIndex).toBe(4)
  })

  it('拎起期间悬空位移线性上升至 12px（420ms 总时长）', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    expect(c.snapshot.liftOffsetPx).toBe(0)
    tick(c, 210) // 半程
    expect(c.snapshot.liftOffsetPx).toBeCloseTo(6, 1)
    tick(c, 210) // 完成
    expect(c.snapshot.liftOffsetPx).toBe(INTERACTION_LIFT_OFFSET_PX)
  })

  it('朝向锁定：snapshot.orientation 保持拎起时传入的朝向', () => {
    const c = new PetInteractionController()
    c.requestPickup('side')
    tick(c, 420)
    expect(c.snapshot.orientation).toBe('side')
  })
})

describe('Task 11J：悬空保持（05→06→05，320ms×3 循环）', () => {
  it('held 阶段循环 05→06→05，位移恒定 12px，pointermove 类推进不重置', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    tick(c, 420)
    expect(c.snapshot.phase).toBe('held')
    expect(c.snapshot.frameIndex).toBe(4) // 05（循环第一步）
    tick(c, 320)
    expect(c.snapshot.frameIndex).toBe(5) // 06
    expect(c.snapshot.liftOffsetPx).toBe(INTERACTION_LIFT_OFFSET_PX)
    tick(c, 320)
    expect(c.snapshot.frameIndex).toBe(4) // 回到 05（循环第三步）
    tick(c, 320)
    expect(c.snapshot.frameIndex).toBe(4) // 循环回绕：新一轮从 05 开始
    tick(c, 320)
    expect(c.snapshot.frameIndex).toBe(5) // 新一轮的 06
    expect(c.snapshot.liftOffsetPx).toBe(INTERACTION_LIFT_OFFSET_PX)
  })

  it('长时间悬空保持在循环内，不回到进入帧', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    tick(c, 420 + 10_000)
    expect(c.snapshot.phase).toBe('held')
    expect([4, 5]).toContain(c.snapshot.frameIndex)
  })
})

describe('Task 11J：放下（07→08→01，140/180/160ms → normal）', () => {
  it('requestDrop → dropping 从 07 开始，序列完成后回 normal', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    tick(c, 420)
    c.requestDrop()
    expect(c.snapshot.phase).toBe('dropping')
    expect(c.snapshot.frameIndex).toBe(6) // 07
    tick(c, 140)
    expect(c.snapshot.frameIndex).toBe(7) // 08
    tick(c, 180)
    expect(c.snapshot.frameIndex).toBe(0) // 01（落地缓冲）
    tick(c, 160)
    expect(c.snapshot.phase).toBe('normal')
    expect(c.snapshot.orientation).toBeNull()
  })

  it('放下期间悬空位移线性回落至 0（480ms 总时长）', () => {
    const c = new PetInteractionController()
    c.requestPickup('side')
    tick(c, 420)
    c.requestDrop()
    expect(c.snapshot.liftOffsetPx).toBe(INTERACTION_LIFT_OFFSET_PX)
    tick(c, 240) // 半程
    expect(c.snapshot.liftOffsetPx).toBeCloseTo(INTERACTION_LIFT_OFFSET_PX / 2, 1)
    tick(c, 240)
    expect(c.snapshot.liftOffsetPx).toBe(0)
    expect(c.snapshot.phase).toBe('normal')
  })

  it('放下期间朝向保持锁定（07→08→01 用锁定朝向素材组）', () => {
    const c = new PetInteractionController()
    c.requestPickup('side')
    tick(c, 420)
    c.requestDrop()
    tick(c, 300)
    expect(c.snapshot.orientation).toBe('side')
  })

  it('未拎起时 requestDrop 为无操作（短点击不产生放下动画）', () => {
    const c = new PetInteractionController()
    c.requestDrop()
    expect(c.snapshot.phase).toBe('normal')
    c.requestClick('front')
    c.requestDrop() // clickFeedback 中也不进入 dropping
    expect(c.snapshot.phase).toBe('clickFeedback')
  })

  it('拎起途中松开（lifting 未完成）：直接进入 dropping（不卡悬空）', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    tick(c, 120) // 在 04 帧
    expect(c.snapshot.phase).toBe('lifting')
    c.requestDrop()
    expect(c.snapshot.phase).toBe('dropping')
    expect(c.snapshot.frameIndex).toBe(6) // 从 07 开始
  })
})

describe('Task 11J：快速连续操作（最新交互事件优先）', () => {
  it('放下途中再次抓取：打断 dropping 重新进入 lifting（新朝向生效）', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    tick(c, 420)
    c.requestDrop()
    tick(c, 100) // dropping 进行中
    c.requestPickup('side')
    expect(c.snapshot.phase).toBe('lifting')
    expect(c.snapshot.orientation).toBe('side')
    expect(c.snapshot.frameIndex).toBe(2)
    expect(c.snapshot.liftOffsetPx).toBe(0) // 重新从地面拎起
  })

  it('悬空保持中再次 requestPickup：重新播放拎起序列（位移归零重来）', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    tick(c, 420 + 1000)
    c.requestPickup('front')
    expect(c.snapshot.phase).toBe('lifting')
    expect(c.snapshot.frameIndex).toBe(2)
    expect(c.snapshot.liftOffsetPx).toBe(0)
  })

  it('拎起流程中（lifting/held/dropping）requestClick 被忽略', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    tick(c, 100)
    c.requestClick('front')
    expect(c.snapshot.phase).toBe('lifting')
    tick(c, 320) // 进入 held
    c.requestClick('front')
    expect(c.snapshot.phase).toBe('held')
    c.requestDrop()
    c.requestClick('front')
    expect(c.snapshot.phase).toBe('dropping')
  })

  it('interrupt：任意阶段立即复位（真实状态接管 / 卸载）', () => {
    for (const setup of [
      (): void => {
        /* normal */
      },
      (c: PetInteractionController): void => {
        c.requestClick('front')
      },
      (c: PetInteractionController): void => {
        c.requestPickup('front')
      },
      (c: PetInteractionController): void => {
        c.requestPickup('front')
        tick(c, 420)
      },
      (c: PetInteractionController): void => {
        c.requestPickup('front')
        tick(c, 420)
        c.requestDrop()
      }
    ]) {
      const c = new PetInteractionController()
      setup(c)
      c.interrupt()
      expect(c.snapshot).toEqual({
        phase: 'normal',
        frameIndex: null,
        orientation: null,
        liftOffsetPx: 0
      })
      expect(c.isActive).toBe(false)
    }
  })
})

describe('Task 11J：时间推进健壮性', () => {
  it('大步长（卡顿补偿）一次跨越全部帧并停在正确阶段', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    c.update(10_000) // 越过 lifting 直接进入 held 循环深处
    expect(c.snapshot.phase).toBe('held')
    expect([4, 5]).toContain(c.snapshot.frameIndex)
    expect(c.snapshot.liftOffsetPx).toBe(INTERACTION_LIFT_OFFSET_PX)
  })

  it('大步长跨越整个放下序列回到 normal', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    c.update(5000)
    c.requestDrop()
    c.update(5000)
    expect(c.snapshot.phase).toBe('normal')
    expect(c.snapshot.liftOffsetPx).toBe(0)
  })

  it('非法时间增量（NaN/负数/0）不推进状态', () => {
    const c = new PetInteractionController()
    c.requestPickup('front')
    for (const bad of [Number.NaN, -100, 0]) {
      c.update(bad)
    }
    expect(c.snapshot.phase).toBe('lifting')
    expect(c.snapshot.frameIndex).toBe(2)
  })
})

describe('Task 11J：悬空位移与画布适配（240×240，实测 alpha 边界）', () => {
  it('位移上限 12px：front interaction-05（topGap=17px）上移后不出画布', () => {
    // front interaction-05 素材可见顶 y=17（512 画布实测），锚点 y=464，
    // FRONT_IDLE_SCALE=0.467：显示顶部 = 227.5 − 0.467×(464−17) ≈ 18.8px；
    // 上移 12px 后顶部 ≥ 6.8px，不截断耳朵。
    const FRONT_SCALE = 0.467
    const topGap = 17
    const displayTop = 227.5 - FRONT_SCALE * (464 - topGap)
    expect(displayTop).toBeGreaterThanOrEqual(INTERACTION_LIFT_OFFSET_PX)
    expect(displayTop - INTERACTION_LIFT_OFFSET_PX).toBeGreaterThanOrEqual(6)
  })

  it('位移上限 12px：side interaction-04（topGap=132px，0.625）上移后不出画布', () => {
    const SIDE_SCALE = 0.625
    const topGap = 132
    const displayTop = 227.5 - SIDE_SCALE * (464 - topGap)
    expect(displayTop - INTERACTION_LIFT_OFFSET_PX).toBeGreaterThanOrEqual(6)
  })
})
