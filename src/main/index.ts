import { app, BrowserWindow, screen } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createPetWindow } from './pet-window'
import { registerPetIpcHandlers } from './ipc-handlers'
import { PetBehaviorRuntime, type RuntimeWindow } from './pet-behavior-runtime'
import { PET_WINDOW_HEIGHT, PET_WINDOW_WIDTH } from '../shared/pet-config'
import type { MovementBounds } from '../shared/movement-controller'

// 将主进程未捕获异常输出为可读日志，便于定位问题（替代默认的系统弹窗）。
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})

let petWindow: BrowserWindow | null = null
let behaviorRuntime: PetBehaviorRuntime | null = null

/** 窗口适配器：把 BrowserWindow 的位置能力收敛为运行时所需的最小接口 */
function createRuntimeWindow(): RuntimeWindow {
  return {
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    getPosition: (): { x: number; y: number } => {
      const [x, y] = petWindow?.getPosition() ?? [0, 0]
      return { x, y }
    },
    setPosition: (x, y): void => {
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

  behaviorRuntime = new PetBehaviorRuntime({
    window: createRuntimeWindow(),
    getBounds: getWalkBounds
  })

  registerPetIpcHandlers(
    () => petWindow,
    {
      onDragStart: () => behaviorRuntime?.handleDragStart(),
      onDragEnd: () => behaviorRuntime?.handleDragEnd()
    }
  )

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
      behaviorRuntime = new PetBehaviorRuntime({
        window: createRuntimeWindow(),
        getBounds: getWalkBounds
      })
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
