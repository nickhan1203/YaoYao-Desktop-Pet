import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  PET_WINDOW_HEIGHT,
  PET_WINDOW_MIN_HEIGHT,
  PET_WINDOW_MIN_WIDTH,
  PET_WINDOW_TITLE,
  PET_WINDOW_WIDTH
} from '../shared/pet-config'

/**
 * 创建幺幺桌宠窗口。
 * 安全基线：contextIsolation 开启、nodeIntegration 关闭、sandbox 开启，
 * renderer 只能通过 preload 暴露的最小只读 API 访问受限信息。
 */
export function createPetWindow(): BrowserWindow {
  const petWindow = new BrowserWindow({
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    minWidth: PET_WINDOW_MIN_WIDTH,
    minHeight: PET_WINDOW_MIN_HEIGHT,
    title: PET_WINDOW_TITLE,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  petWindow.on('ready-to-show', () => {
    petWindow.show()
  })

  // 拒绝在应用内打开新窗口，外部链接交给系统默认浏览器。
  petWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void petWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void petWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return petWindow
}
