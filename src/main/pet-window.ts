import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  PET_WINDOW_HEIGHT,
  PET_WINDOW_MIN_HEIGHT,
  PET_WINDOW_MIN_WIDTH,
  PET_WINDOW_POSITION_MARGIN,
  PET_WINDOW_TITLE,
  PET_WINDOW_WIDTH
} from '../shared/pet-config'
import { computePetPlacement } from '../shared/pet-placement'

/**
 * 计算窗口初始位置：停靠在主显示器工作区右下角并留出边距，
 * 避免默认出现在屏幕中央遮挡主要工作区域。
 * Task 12A：与"重置位置"共用纯函数 computePetPlacement（同一停靠语义）。
 */
function computeInitialPosition(): { x: number; y: number } {
  return computePetPlacement(
    screen.getPrimaryDisplay().workArea,
    PET_WINDOW_WIDTH,
    PET_WINDOW_HEIGHT,
    PET_WINDOW_POSITION_MARGIN
  )
}

/**
 * 创建幺幺桌宠透明无边框窗口。
 * 安全基线：contextIsolation 开启、nodeIntegration 关闭、sandbox 开启，
 * renderer 只能通过 preload 暴露的最小只读 API 访问受限信息。
 *
 * 窗口说明：
 * - frame: false + transparent: true 实现无边框透明桌宠外观；
 * - hasShadow: false 避免 macOS 在透明窗口内容周围绘制阴影；
 * - alwaysOnTop 暂不启用（保守默认值，待托盘/菜单任务中双端实测后再定层级）；
 * - resizable: false 桌宠窗口不需要用户手动调整尺寸；
 * - skipTaskbar: true（Task 12E-B）：桌宠窗口不显示 Windows 任务栏图标——
 *   任务栏入口会让"关闭任务栏窗口"触发 close 拦截转隐藏，造成"幺幺消失
 *   但进程存活"的困惑；显示/隐藏/退出的唯一入口是系统托盘。仅作用于
 *   桌宠窗口（设置窗口保持正常任务栏切换），不影响 close→hide 语义、
 *   置顶、穿透与拖动；activate 重建走本构造自动保持。
 */
export function createPetWindow(): BrowserWindow {
  const { x, y } = computeInitialPosition()

  const petWindow = new BrowserWindow({
    x,
    y,
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    minWidth: PET_WINDOW_MIN_WIDTH,
    minHeight: PET_WINDOW_MIN_HEIGHT,
    title: PET_WINDOW_TITLE,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
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
