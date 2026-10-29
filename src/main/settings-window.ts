import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * 创建设置窗口（Task 12B）：普通非透明窗口，与桌宠透明窗口相互独立。
 *
 * 安全基线与桌宠窗口一致（sandbox 开启、contextIsolation 开启、
 * nodeIntegration 关闭），仅通过 preload 暴露的最小设置 API 通信；
 * renderer 加载同一入口的 #settings 路由（App 按哈希挂载 SettingsPanel）。
 *
 * 窗口生命周期（单例、聚焦已有、关闭不退出）由 index.ts 的
 * openSettingsWindow 管理；本函数只负责创建。
 */
export function createSettingsWindow(): BrowserWindow {
  const settingsWindow = new BrowserWindow({
    width: 460,
    height: 600,
    title: '幺幺设置',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  settingsWindow.on('ready-to-show', () => {
    settingsWindow.show()
  })

  // 拒绝在应用内打开新窗口，外部链接交给系统默认浏览器。
  settingsWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#settings`)
  } else {
    void settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'settings' })
  }

  return settingsWindow
}
