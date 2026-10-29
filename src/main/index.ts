import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { createPetWindow } from './pet-window'
import { registerPetIpcHandlers, registerDevDebugHandlers } from './ipc-handlers'
import { PetBehaviorRuntime, type RuntimeWindow } from './pet-behavior-runtime'
import { PET_WINDOW_HEIGHT, PET_WINDOW_WIDTH } from '../shared/pet-config'
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
    height: 340,
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

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// This method will be called when Electron has finished initialization
// and is ready to create browser windows.
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
      forceBehavior: (target): void => {
        behaviorRuntime?.debugForceBehavior(target)
      },
      resumeAutoBehavior: (): void => {
        behaviorRuntime?.debugResumeAutoBehavior()
      },
      isDebugControlled: (): boolean => behaviorRuntime?.isDebugControlled ?? false
    })
    createDevPanelWindow()
  }

  // 窗口销毁时停止运行循环，避免访问已销毁的 BrowserWindow。
  petWindow.on('closed', () => {
    behaviorRuntime?.stop()
    behaviorRuntime = null
    petWindow = null
  })

  behaviorRuntime.start()

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
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
      behaviorRuntime.start()
    }
  })
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
