import { useEffect, useRef } from 'react'
import { isPetSettings } from '../../../shared/pet-settings'

/**
 * 宠物显示倍率订阅 Hook（Task 12B）。
 *
 * 职责：把主进程权威设置的 petScale 保持在一个可变 ref 中，
 * PetCanvas 每 tick 读取（即时应用，不重建 PixiJS Application、
 * 不重载素材）。
 *
 * 竞态防护：与视觉状态订阅同一模式——广播先于初始查询响应到达时，
 * 旧快照不覆盖（receivedBroadcast 标记）；之后广播始终最新胜出。
 * 清理：卸载时取消订阅。
 */
export function usePetScale(): React.RefObject<number> {
  const petScaleRef = useRef<number>(1)

  useEffect(() => {
    let receivedBroadcast = false
    const unsubscribe = window.yaoyao?.onSettingsChanged((settings) => {
      receivedBroadcast = true
      petScaleRef.current = settings.petScale
    })
    void window.yaoyao
      ?.getSettings()
      .then((payload): void => {
        if (!receivedBroadcast && isPetSettings(payload)) {
          petScaleRef.current = payload.petScale
        }
      })
      .catch((): void => {
        // 主进程未注册 handler 的异常路径：保持默认倍率 1
      })
    return (): void => {
      unsubscribe?.()
    }
  }, [])

  return petScaleRef
}
