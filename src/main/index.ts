import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { createPetWindow } from './pet-window'
import {
  registerPetIpcHandlers,
  registerDevDebugHandlers,
  registerContextMenuHandler,
  registerSettingsHandlers
} from './ipc-handlers'
import { PetBehaviorRuntime, type RuntimeWindow } from './pet-behavior-runtime'
import { AppLifecycleController } from './app-lifecycle-controller'
import { AppTrayController } from './app-tray'
import { createSettingsWindow } from './settings-window'
import { PetSettingsStore, type SettingsFileAdapter } from './settings-store'
import { PetSettingsController } from './settings-controller'
import { PetWindowFlagsController } from './pet-window-flags'
import {
  PET_WINDOW_HEIGHT,
  PET_WINDOW_POSITION_MARGIN,
  PET_WINDOW_WIDTH
} from '../shared/pet-config'
import { isPaused } from '../shared/pet-state-machine'
import { INTERACTION_CANCEL_CHANNEL } from '../shared/interaction-cancel'
import {
  DEFAULT_PET_SETTINGS,
  SETTINGS_CHANGED_CHANNEL,
  SETTINGS_SAVE_ERROR_CHANNEL,
  SETTINGS_SAVED_CHANNEL,
  type PetSettings
} from '../shared/pet-settings'
import { DEV_INTERACTION_PREVIEW_CHANNEL } from '../shared/dev-debug'
import type { AppControlCommand, AppControlState } from '../shared/app-menu-model'
import type { PetVisualState } from '../shared/pet-visual-state'
import type { MovementBounds } from '../shared/movement-controller'

/** 视觉状态广播通道（主进程 → renderer 单向，载荷为 PetVisualState） */
const VISUAL_STATE_CHANNEL = 'pet:visual-state-changed'

// 将主进程未捕获异常输出为可读日志，便于定位问题（替代默认的系统弹窗）。
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})

let petWindow: BrowserWindow | null = null
let behaviorRuntime: PetBehaviorRuntime | null = null
/** 开发调试面板窗口（Task 11H-C，仅开发构建创建；生产为 null） */
let devPanelWindow: BrowserWindow | null = null
/** 系统托盘（Task 12A，单一实例） */
const trayController = new AppTrayController()
/** 应用生命周期控制器（Task 12A，托盘/右键菜单共用） */
let lifecycle: AppLifecycleController | null = null
/** 应用退出进行中（放行窗口 close，托盘/菜单停止响应） */
let quitting = false
/** 设置窗口（Task 12B，单例；关闭仅置空引用，不退出应用） */
let settingsWindow: BrowserWindow | null = null
/** 设置控制器（Task 12B，主进程配置唯一权威） */
let settingsController: PetSettingsController | null = null

/**
 * 创建行为运行时：视觉状态变化时向 renderer 广播（单向），
 * 窗口销毁/renderer 不存在时不发送（isDestroyed 防御，不抛异常）。
 * Task 11H-C：开发调试面板窗口同样接收广播（面板显示实时状态）。
 */
function createBehaviorRuntime(): PetBehaviorRuntime {
  return new PetBehaviorRuntime({
    window: createRuntimeWindow(),
    getBounds: getWalkBounds,
    onVisualStateChange: (state: PetVisualState): void => {
      for (const win of [petWindow, devPanelWindow]) {
        if (win && !win.isDestroyed()) {
          win.webContents.send(VISUAL_STATE_CHANNEL, state)
        }
      }
    }
  })
}

/** 窗口适配器：把 BrowserWindow 的位置能力收敛为运行时所需的最小接口 */
function createRuntimeWindow(): RuntimeWindow {
  return {
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    getPosition: (): { x: number; y: number } => {
      const [x, y] = petWindow?.getPosition() ?? [0, 0]
      return { x, y }
    },
    setPosition: (x: number, y: number): void => {
      petWindow?.setPosition(x, y, false)
    },
    isDestroyed: (): boolean => !petWindow || petWindow.isDestroyed()
  }
}

/**
 * 活动范围：宠物中心所在显示器的工作区（workArea）。
 * 使用工作区而非完整显示区域，避免桌宠走到 Dock/菜单栏/任务栏下方；
 * 宠物被拖到哪块显示器，就在哪块显示器的活动范围内行走；
 * 显示器布局变化时边界随之更新（不会把桌宠拉回主显示器，
 * 超出新边界的部分会在下一步行走计算中被渐进约束回来）。
 */
function getWalkBounds(): MovementBounds {
  const windowRef = petWindow
  if (!windowRef || windowRef.isDestroyed()) {
    // 窗口不可用时返回退化边界（不产生任何移动）；运行时随后会自行停止。
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const [x, y] = windowRef.getPosition()
  const display = screen.getDisplayNearestPoint({
    x: x + PET_WINDOW_WIDTH / 2,
    y: y + PET_WINDOW_HEIGHT / 2
  })
  return display.workArea
}

/**
 * 创建开发调试面板窗口（Task 11H-C）：仅开发构建调用。
 * - 独立小窗口，不遮挡桌宠；加载同一 renderer 入口的 #dev-panel 路由
 *   （App 按 hash 动态挂载 DevBehaviorPanel，import.meta.env.DEV 门控，
 *   生产构建死代码剔除）；
 * - 安全基线与桌宠窗口一致（sandbox 开启、contextIsolation 开启、
 *   nodeIntegration 关闭），仅通过 preload 暴露的最小 API 通信；
 * - 面板关闭仅置空引用，不影响桌宠窗口与行为运行时。
 */
function createDevPanelWindow(): void {
  if (devPanelWindow && !devPanelWindow.isDestroyed()) {
    devPanelWindow.focus()
    return
  }
  if (!is.dev || !process.env['ELECTRON_RENDERER_URL']) {
    return
  }
  devPanelWindow = new BrowserWindow({
    width: 360,
    height: 430,
    title: '幺幺调试面板（仅开发）',
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  devPanelWindow.on('closed', () => {
    devPanelWindow = null
  })
  void devPanelWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#dev-panel`)
}

/**
 * 设置文件适配器（Task 12B）：userData 下应用专属 settings.json，
 * 读取失败按"文件不存在"处理；写入为临时文件 + rename 原子替换。
 */
function createSettingsFileAdapter(): SettingsFileAdapter {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  return {
    read: (): string | null => {
      try {
        return readFileSync(settingsPath, 'utf-8')
      } catch {
        return null
      }
    },
    writeAtomic: (content: string): void => {
      const tmpPath = `${settingsPath}.tmp`
      writeFileSync(tmpPath, content, 'utf-8')
      renameSync(tmpPath, settingsPath)
    }
  }
}

/**
 * 打开设置窗口（Task 12B，单例）：已存在时聚焦，不重复创建；
 * 关闭仅置空引用（不退出应用，桌宠继续运行）。
 */
function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = createSettingsWindow()
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

/**
 * 托盘/右键菜单的命令执行入口（Task 12A）：菜单命令 → 生命周期控制器。
 * toggle-* 依据控制器权威状态取反；执行后刷新托盘菜单（状态同步）。
 */
function executeControlCommand(command: AppControlCommand): void {
  if (!lifecycle) {
    return
  }
  switch (command) {
    case 'toggle-pause': {
      if (lifecycle.getControlState().paused) {
        lifecycle.resumeActivity()
      } else {
        lifecycle.pauseActivity()
      }
      break
    }
    case 'toggle-visibility': {
      if (lifecycle.getControlState().hidden) {
        lifecycle.showPet()
      } else {
        lifecycle.hidePet()
      }
      break
    }
    case 'toggle-always-on-top': {
      // Task 12C：托盘勾选项 → 现有设置更新链路（含失败回滚与广播同步）。
      const current = settingsController?.getSettings().alwaysOnTop ?? false
      settingsController?.updateSettings({ alwaysOnTop: !current })
      break
    }
    case 'toggle-mouse-passthrough': {
      // Task 12C：穿透恢复入口——穿透开启期间右键菜单不可用，
      // 托盘是唯一的窗口侧恢复入口（设置窗口亦可）。
      const current = settingsController?.getSettings().mousePassthrough ?? false
      settingsController?.updateSettings({ mousePassthrough: !current })
      break
    }
    case 'reset-position': {
      lifecycle.resetPetPosition()
      break
    }
    case 'open-settings': {
      openSettingsWindow()
      break
    }
    case 'quit-application': {
      lifecycle.quitApplication()
      break
    }
  }
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (lifecycle) {
    trayController.updateMenu(getCompositeControlState())
  }
}

/**
 * 组合菜单权威状态（Task 12C）：生命周期状态 + 用户设置的窗口标志。
 * 托盘菜单与桌宠右键菜单共用，保证勾选状态与实际一致。
 */
function getCompositeControlState(): AppControlState {
  const settings = settingsController?.getSettings()
  return {
    ...(lifecycle?.getControlState() ?? { paused: false, hidden: false }),
    alwaysOnTop: settings?.alwaysOnTop ?? false,
    mousePassthrough: settings?.mousePassthrough ?? false
  }
}

/**
 * 创建生命周期控制器（Task 12A）：端口全部经闭包读取模块级变量，
 * activate 重建窗口/运行时后无需重建控制器。
 */
function createLifecycleController(): AppLifecycleController {
  return new AppLifecycleController({
    runtime: {
      pause: (): void => behaviorRuntime?.pause(),
      resume: (): void => behaviorRuntime?.resume(),
      isPaused: (): boolean => behaviorRuntime !== null && isPaused(behaviorRuntime.currentState),
      isDragging: (): boolean => behaviorRuntime?.currentState.kind === 'dragging',
      stop: (): void => behaviorRuntime?.stop(),
      syncWindowPosition: (): void => behaviorRuntime?.handleExternalPositionChange()
    },
    window: {
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
      hide: (): void => petWindow?.hide(),
      showInactive: (): void => petWindow?.showInactive(),
      isVisible: (): boolean => petWindow?.isVisible() ?? false,
      isDestroyed: (): boolean => !petWindow || petWindow.isDestroyed(),
      getPosition: (): { x: number; y: number } => {
        const [x, y] = petWindow?.getPosition() ?? [0, 0]
        return { x, y }
      },
      setPosition: (x: number, y: number): void => {
        petWindow?.setPosition(x, y, false)
      }
    },
    displays: {
      getNearestWorkArea: (point): MovementBounds | null => {
        const display = screen.getDisplayNearestPoint(point)
        return display ? display.workArea : null
      },
      getPrimaryWorkArea: (): MovementBounds => screen.getPrimaryDisplay().workArea
    },
    onBeforeQuit: (): void => {
      // 进入退出状态：放行窗口 close 拦截，并销毁托盘（幂等）。
      quitting = true
      trayController.destroy()
    },
    quit: (): void => {
      void app.quit()
    },
    positionMargin: PET_WINDOW_POSITION_MARGIN
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.yaoyao.desktoppet')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  petWindow = createPetWindow()

  behaviorRuntime = createBehaviorRuntime()

  // Task 12A：生命周期控制器 + 系统托盘（单一实例，幂等创建）。
  lifecycle = createLifecycleController()
  // Task 12C：托盘/右键菜单统一使用组合状态（含置顶/穿透勾选）。
  // 此处 settingsController 尚未创建，窗口标志回退默认 false。
  trayController.ensureTray(getCompositeControlState(), executeControlCommand)

  // Task 12A：桌宠右键菜单请求（无载荷窄通道），与托盘菜单共用控制器。
  registerContextMenuHandler(() => {
    if (lifecycle) {
      trayController.popupPetContextMenu(getCompositeControlState())
    }
  })

  // Task 12B：用户设置——读取（缺失/损坏回退默认）、应用初始值到行为
  // 运行时、注册设置 IPC（载荷主进程全量校验）。
  const settingsStore = new PetSettingsStore(createSettingsFileAdapter())
  const loadedSettings = settingsStore.load()
  if (loadedSettings.degraded) {
    console.warn('[settings] 配置文件损坏或非法，已安全回退默认设置')
  }
  settingsController = new PetSettingsController(
    {
      store: settingsStore,
      runtime: {
        applyConfig: (config): void => {
          behaviorRuntime?.applyRuntimeConfig(config)
        },
        setAutoActivityEnabled: (enabled): void => {
          behaviorRuntime?.setAutoActivityEnabled(enabled)
        }
      },
      // Task 12C：窗口标志（置顶/穿透）只作用于桌宠窗口；端口经闭包
      // 读取模块级变量，activate 重建窗口后无需重建控制器。
      windowFlags: new PetWindowFlagsController({
        window: {
          setAlwaysOnTop: (enabled): void => {
            petWindow?.setAlwaysOnTop(enabled)
          },
          setIgnoreMouseEvents: (ignore): void => {
            petWindow?.setIgnoreMouseEvents(ignore)
          },
          isDestroyed: (): boolean => !petWindow || petWindow.isDestroyed()
        },
        runtime: {
          isDragging: (): boolean => behaviorRuntime?.currentState.kind === 'dragging',
          handleDragEnd: (): void => {
            behaviorRuntime?.handleDragEnd()
          }
        },
        notifier: {
          notifyInteractionCancel: (): void => {
            if (petWindow && !petWindow.isDestroyed()) {
              petWindow.webContents.send(INTERACTION_CANCEL_CHANNEL)
            }
          }
        }
      }),
      broadcast: (settings: PetSettings): void => {
        for (const win of [petWindow, settingsWindow]) {
          if (win && !win.isDestroyed()) {
            win.webContents.send(SETTINGS_CHANGED_CHANNEL, settings)
          }
        }
        // Task 12C：设置变化后同步托盘菜单（勾选状态与设置一致）。
        refreshTrayMenu()
      },
      broadcastSaved: (): void => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send(SETTINGS_SAVED_CHANNEL)
        }
      },
      onSaveError: (error: unknown): void => {
        console.error('[settings] 设置保存失败:', error)
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send(SETTINGS_SAVE_ERROR_CHANNEL)
        }
      },
      onWindowFlagsError: (error): void => {
        console.error('[settings] 窗口标志应用失败（已回滚）:', error.setting, error.requested)
      }
    },
    loadedSettings
  )
  settingsController.applyToRuntime()
  registerSettingsHandlers({
    getSettings: (): PetSettings =>
      settingsController?.getSettings() ?? { ...DEFAULT_PET_SETTINGS },
    updateSettings: (payload: unknown): PetSettings | null =>
      settingsController?.updateSettings(payload) ?? null
  })

  registerPetIpcHandlers(
    () => petWindow,
    {
      onDragStart: () => behaviorRuntime?.handleDragStart(),
      onDragEnd: () => behaviorRuntime?.handleDragEnd()
    },
    {
      getVisualState: (): PetVisualState | null => behaviorRuntime?.currentVisualState ?? null
    }
  )

  // 开发调试控制（Task 11H-C）：仅开发构建注册（主进程强制校验，不依赖
  // renderer 的 DEV 判断）。命令载荷经白名单校验后触发行为运行时的调试
  // 方法（合成决策走状态机，主进程仍是行为与窗口运动的唯一权威）；
  // 同时打开开发调试面板窗口（按钮控制，替代已移除的键盘姿态预览）。
  if (!app.isPackaged) {
    registerDevDebugHandlers({
      forceBehavior: (target, facing): void => {
        behaviorRuntime?.debugForceBehavior(target, facing)
      },
      resumeAutoBehavior: (): void => {
        behaviorRuntime?.debugResumeAutoBehavior()
      },
      isDebugControlled: (): boolean => behaviorRuntime?.isDebugControlled ?? false,
      // Task 11J：交互动画预览转发给桌宠 renderer（纯视觉，
      // 不触发行为状态机、不伪造 dragging）。
      previewInteraction: (kind): void => {
        if (petWindow && !petWindow.isDestroyed()) {
          petWindow.webContents.send(DEV_INTERACTION_PREVIEW_CHANNEL, kind)
        }
      },
      // Task 12B-UI：打开设置窗口（开发工具，与托盘/右键菜单同一入口）。
      openSettings: (): void => {
        openSettingsWindow()
      }
    })
    createDevPanelWindow()
  }

  // Task 12A：关闭拦截——非退出路径关闭窗口等同"隐藏到托盘"（窗口不销毁，
  // 可从托盘找回，不会进入不可恢复状态）；退出时（quitting）放行销毁。
  petWindow.on('close', (event) => {
    if (!quitting && lifecycle) {
      event.preventDefault()
      lifecycle.hidePet()
    }
  })

  // 窗口销毁时停止运行循环，避免访问已销毁的 BrowserWindow。
  petWindow.on('closed', () => {
    behaviorRuntime?.stop()
    behaviorRuntime = null
    petWindow = null
  })

  behaviorRuntime.start()

  app.on('activate', () => {
    // macOS Dock 点击：窗口存在（含隐藏态）→ 恢复显示（含边界修正）；
    // 仅在窗口不存在（异常销毁）时重建窗口与运行时。
    if (petWindow && !petWindow.isDestroyed()) {
      lifecycle?.showPet()
      return
    }
    if (BrowserWindow.getAllWindows().length === 0 || petWindow === null) {
      petWindow = createPetWindow()
      petWindow.on('closed', () => {
        behaviorRuntime?.stop()
        behaviorRuntime = null
        petWindow = null
      })
      if (behaviorRuntime) {
        behaviorRuntime.stop()
      }
      behaviorRuntime = createBehaviorRuntime()
      // Task 12B：重建的运行时持有默认参数——重新应用当前用户设置。
      settingsController?.applyToRuntime()
      behaviorRuntime.start()
    }
  })
})

// Task 12A：任何退出路径（菜单退出 / Cmd+Q / window-all-closed）统一
// 在 before-quit 进入退出状态并销毁托盘——窗口 close 拦截随即放行，
// 保证应用真正结束而不是停留在"无窗口有托盘"的隐藏状态。
app.on('before-quit', () => {
  // Task 12B：退出前同步落盘设置（防抖未到期的最新值不丢失）。
  settingsController?.flush()
  quitting = true
  trayController.destroy()
})

// 应用退出前可靠停止运行循环，清理定时器。
app.on('will-quit', () => {
  behaviorRuntime?.stop()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
