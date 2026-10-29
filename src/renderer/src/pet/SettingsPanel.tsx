import { useEffect, useRef, useState } from 'react'
import './SettingsPanel.css'
import {
  DEFAULT_PET_SETTINGS,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  WALK_SPEED_MAX,
  WALK_SPEED_MIN,
  isNoOpSettingsUpdate,
  isPetSettings,
  type FrequencyLevel,
  type PetSettings,
  type PetSettingsUpdate
} from '../../../shared/pet-settings'

/**
 * 幺幺设置面板（Task 12B-UI，Modern Minimal Cards 风格）。
 *
 * 只做布局/视觉/交互升级，业务逻辑与 Task 12B 完全一致：
 * - 主进程仍是配置唯一权威：读写仅经 preload 窄 IPC；
 * - 自动保存 + 底部真实保存状态（saving/saved/error 由主进程
 *   持久化结果驱动，不以 UI 点击伪造"已保存"）；
 * - 恢复默认：确认后经现有 updateSettings 发送 shared 模型的
 *   DEFAULT_PET_SETTINGS（无第二份魔法常量），取消不改动配置；
 * - 值未变化的更新不重复提交（滑块回显/广播回执防抖）；
 * - 卸载时取消全部订阅。
 *
 * 无障碍：开关为原生 button（role=switch，Space/Enter 激活）；滑块为
 * 原生 input[range]（方向键）；频率为原生 radio group（方向键切换，
 * 语义 radiogroup）；保存状态 aria-live 感知。
 */

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: FrequencyLevel; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'normal', label: '标准' },
  { value: 'high', label: '高' }
]

const SAVE_STATUS_TEXT: Readonly<Record<SaveStatus, string>> = {
  idle: '',
  saving: '正在保存…',
  saved: '已保存',
  error: '保存失败，请重试'
}

/** 滑块填充百分比（0–100） */
function sliderFillPercent(value: number, min: number, max: number): number {
  if (max <= min) {
    return 0
  }
  return ((value - min) / (max - min)) * 100
}

export function SettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<PetSettings | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [confirmingReset, setConfirmingReset] = useState(false)
  /** 广播回执去重：与本地最新值一致时不再重复写本地状态 */
  const latestSettingsRef = useRef<PetSettings | null>(null)

  useEffect(() => {
    let receivedBroadcast = false
    const unsubscribeSettings = window.yaoyao?.onSettingsChanged((next) => {
      receivedBroadcast = true
      latestSettingsRef.current = next
      setSettings(next)
    })
    const unsubscribeSaved = window.yaoyao?.onSettingsSaved(() => {
      setSaveStatus('saved')
    })
    const unsubscribeSaveError = window.yaoyao?.onSettingsSaveError(() => {
      setSaveStatus('error')
    })
    void window.yaoyao
      ?.getSettings()
      .then((payload): void => {
        if (!receivedBroadcast && isPetSettings(payload)) {
          latestSettingsRef.current = payload
          setSettings(payload)
        }
      })
      .catch((): void => {
        // 主进程未注册 handler 的异常路径：面板保持空态
      })
    return (): void => {
      unsubscribeSettings?.()
      unsubscribeSaved?.()
      unsubscribeSaveError?.()
    }
  }, [])

  const update = (patch: PetSettingsUpdate): void => {
    const current = latestSettingsRef.current
    if (current === null || isNoOpSettingsUpdate(current, patch)) {
      // 值无变化（滑块回显/广播回执）：不重复提交，状态不变
      return
    }
    const next: PetSettings = { ...current, ...patch }
    latestSettingsRef.current = next
    setSettings(next)
    setConfirmingReset(false)
    setSaveStatus('saving')
    window.yaoyao?.updateSettings(patch)
  }

  /** 恢复默认：确认后发送 shared 模型默认值（去掉 schemaVersion 字段） */
  const resetToDefaults = (): void => {
    const { schemaVersion: _schemaVersion, ...defaults } = DEFAULT_PET_SETTINGS
    void _schemaVersion
    update(defaults)
  }

  if (settings === null) {
    return (
      <div className="settings-app" aria-busy="true">
        <div className="settings-loading">正在读取设置…</div>
      </div>
    )
  }

  return (
    <div className="settings-app">
      <div className="settings-scroll">
        <section className="settings-card" aria-label="自动活动">
          <div className="settings-card-row">
            <div className="settings-card-copy">
              <h2 className="settings-card-title">自动活动</h2>
              <p className="settings-card-desc">
                关闭后幺幺保持可见但不再自主走动，点击与拖动不受影响。
              </p>
            </div>
            <button
              type="button"
              role="switch"
              className="settings-toggle"
              data-setting="autoActivityEnabled"
              aria-checked={settings.autoActivityEnabled}
              aria-label="自动活动"
              onClick={(): void => {
                update({ autoActivityEnabled: !settings.autoActivityEnabled })
              }}
            >
              <span className="settings-toggle-thumb" />
              <span className="settings-toggle-label-sr">
                {settings.autoActivityEnabled ? '已开启' : '已关闭'}
              </span>
            </button>
          </div>
          <p
            className="settings-card-state"
            data-auto-activity-state={settings.autoActivityEnabled}
          >
            {settings.autoActivityEnabled ? '当前：自主行走 / 跑步 / 休息' : '当前：静止陪伴'}
          </p>
        </section>

        <section className="settings-card" aria-label="外观与移动">
          <h2 className="settings-card-title">外观与移动</h2>

          <div className="settings-field">
            <div className="settings-field-head">
              <label className="settings-field-label" htmlFor="setting-pet-scale">
                宠物大小
              </label>
              <output
                className="settings-field-value"
                htmlFor="setting-pet-scale"
                data-pet-scale-value={settings.petScale}
              >
                {Math.round(settings.petScale * 100)}%
              </output>
            </div>
            <input
              id="setting-pet-scale"
              type="range"
              data-setting="petScale"
              min={PET_SCALE_MIN}
              max={PET_SCALE_MAX}
              step={0.05}
              value={settings.petScale}
              style={
                {
                  '--fill': `${sliderFillPercent(settings.petScale, PET_SCALE_MIN, PET_SCALE_MAX)}%`
                } as React.CSSProperties
              }
              onChange={(event): void => {
                update({ petScale: Number(event.target.value) })
              }}
            />
            <p className="settings-field-hint">调整幺幺在桌面上的显示大小。</p>
          </div>

          <div className="settings-field">
            <div className="settings-field-head">
              <label className="settings-field-label" htmlFor="setting-walk-speed">
                行走速度
              </label>
              <output
                className="settings-field-value"
                htmlFor="setting-walk-speed"
                data-walk-speed-value={settings.walkSpeedPxPerSec}
              >
                {settings.walkSpeedPxPerSec} px/s
              </output>
            </div>
            <input
              id="setting-walk-speed"
              type="range"
              data-setting="walkSpeedPxPerSec"
              min={WALK_SPEED_MIN}
              max={WALK_SPEED_MAX}
              step={5}
              value={settings.walkSpeedPxPerSec}
              style={
                {
                  '--fill': `${sliderFillPercent(
                    settings.walkSpeedPxPerSec,
                    WALK_SPEED_MIN,
                    WALK_SPEED_MAX
                  )}%`
                } as React.CSSProperties
              }
              onChange={(event): void => {
                update({ walkSpeedPxPerSec: Number(event.target.value) })
              }}
            />
            <div className="settings-field-scale-marks">
              <span>慢速漫步</span>
              <span>轻快小跑</span>
            </div>
          </div>
        </section>

        <section className="settings-card" aria-label="行为偏好">
          <h2 className="settings-card-title">行为偏好</h2>

          <div className="settings-field">
            <div className="settings-field-head">
              <span className="settings-field-label" id="run-frequency-group-label">
                跑步频率
              </span>
            </div>
            <div
              className="settings-segmented"
              role="radiogroup"
              aria-labelledby="run-frequency-group-label"
            >
              {FREQUENCY_OPTIONS.map(({ value, label }) => (
                <label key={value} className="settings-segmented-option">
                  <input
                    type="radio"
                    name="runFrequency"
                    data-setting={`runFrequency-${value}`}
                    checked={settings.runFrequency === value}
                    onChange={(): void => {
                      update({ runFrequency: value })
                    }}
                  />
                  <span className="settings-segmented-label">{label}</span>
                </label>
              ))}
            </div>
            <p className="settings-field-hint">决定幺幺多久会主动跑起来。</p>
          </div>

          <div className="settings-field">
            <div className="settings-field-head">
              <span className="settings-field-label" id="rest-frequency-group-label">
                休息频率
              </span>
            </div>
            <div
              className="settings-segmented"
              role="radiogroup"
              aria-labelledby="rest-frequency-group-label"
            >
              {FREQUENCY_OPTIONS.map(({ value, label }) => (
                <label key={value} className="settings-segmented-option">
                  <input
                    type="radio"
                    name="restFrequency"
                    data-setting={`restFrequency-${value}`}
                    checked={settings.restFrequency === value}
                    onChange={(): void => {
                      update({ restFrequency: value })
                    }}
                  />
                  <span className="settings-segmented-label">{label}</span>
                </label>
              ))}
            </div>
            <p className="settings-field-hint">影响幺幺坐下和趴卧的频率。</p>
          </div>
        </section>

        <section className="settings-card" aria-label="窗口与交互">
          <h2 className="settings-card-title">窗口与交互</h2>

          <div className="settings-card-row">
            <div className="settings-card-copy">
              <h3 className="settings-field-label">始终置顶</h3>
              <p className="settings-card-desc">让幺幺保持在普通应用窗口上方。</p>
            </div>
            <button
              type="button"
              role="switch"
              className="settings-toggle"
              data-setting="alwaysOnTop"
              aria-checked={settings.alwaysOnTop}
              aria-label="始终置顶"
              onClick={(): void => {
                update({ alwaysOnTop: !settings.alwaysOnTop })
              }}
            >
              <span className="settings-toggle-thumb" />
              <span className="settings-toggle-label-sr">
                {settings.alwaysOnTop ? '已开启' : '已关闭'}
              </span>
            </button>
          </div>

          <div className="settings-card-row">
            <div className="settings-card-copy">
              <h3 className="settings-field-label">鼠标穿透</h3>
              <p className="settings-card-desc">鼠标可以直接操作幺幺下方的窗口。</p>
              {settings.mousePassthrough && (
                <p className="settings-card-hint-alert" data-passthrough-hint="true">
                  鼠标穿透已开启，可从系统托盘关闭。
                </p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              className="settings-toggle"
              data-setting="mousePassthrough"
              aria-checked={settings.mousePassthrough}
              aria-label="鼠标穿透"
              onClick={(): void => {
                update({ mousePassthrough: !settings.mousePassthrough })
              }}
            >
              <span className="settings-toggle-thumb" />
              <span className="settings-toggle-label-sr">
                {settings.mousePassthrough ? '已开启' : '已关闭'}
              </span>
            </button>
          </div>
        </section>
      </div>

      <footer className="settings-footer">
        {confirmingReset ? (
          <div className="settings-reset-confirm" role="alertdialog" aria-label="恢复默认设置确认">
            <p className="settings-reset-confirm-text">
              将重置宠物大小、行走速度、跑步/休息频率与自动活动为默认值。
            </p>
            <div className="settings-reset-confirm-actions">
              <button
                type="button"
                className="settings-button-primary"
                data-reset-confirm="confirm"
                onClick={(): void => {
                  resetToDefaults()
                }}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="settings-button-ghost"
                data-reset-confirm="cancel"
                onClick={(): void => {
                  setConfirmingReset(false)
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-footer-row">
            <p
              className="settings-save-status"
              role="status"
              aria-live="polite"
              data-save-status={saveStatus}
            >
              {SAVE_STATUS_TEXT[saveStatus]}
            </p>
            <button
              type="button"
              className="settings-button-ghost"
              data-reset-request="true"
              onClick={(): void => {
                setConfirmingReset(true)
              }}
            >
              恢复默认设置
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
