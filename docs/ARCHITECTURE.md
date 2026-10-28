# 技术架构与跨平台模块约定

## 1. 技术栈
- Electron：桌面窗口、生命周期、屏幕信息、托盘/菜单栏入口。
- electron-vite：main、preload 与 renderer 的开发构建。
- TypeScript：主开发语言。
- React：renderer 中的组件化 UI。
- PixiJS：角色贴图、精灵动画与渲染。
- Vitest：纯逻辑单元测试。
- electron-builder：macOS `.app`/DMG 与 Windows NSIS 安装包（以项目脚手架和当前版本支持为准）。

## 2. 进程职责

### Main process
负责创建和管理 BrowserWindow、读取 Electron `screen` 显示器与 workArea、窗口位置更新、托盘/菜单栏入口、应用生命周期及 IPC 输入校验。不负责绘制角色帧或将所有行为状态塞进入口文件。

### Preload
使用 `contextBridge.exposeInMainWorld` 暴露有限、显式、类型化 API。禁止暴露整个 `ipcRenderer`、任意通道、任意文件系统或 shell。

### Renderer
负责 PixiJS 场景、角色 Sprite/动画、点击和拖动意图。不得直接访问 Node.js 或文件系统；避免每帧通过 IPC 发送不必要请求。

## 3. 建议模块边界
- `main/pet-window.ts`：窗口创建、显示、隐藏与位置操作。
- `main/movement-controller.ts`：屏幕坐标、目标位置、工作区约束。
- `main/tray.ts` 或平台菜单模块：系统托盘/菜单栏菜单。
- `main/platform/`：显式的平台差异适配，按实际需要拆分 macOS/Windows。
- `main/ipc-handlers.ts`：输入校验和 IPC handler。
- `preload/index.ts`：安全 API 桥接。
- `renderer/src/pet/PetCanvas.tsx`：渲染容器。
- `renderer/src/pet/PetAnimator.ts`：动作帧与动画播放。
- `renderer/src/pet/PetStateMachine.ts`：状态转换。
- `renderer/src/pet/pet-config.ts`：参数与默认值。
- `tests/`：纯逻辑测试。

目录仅为建议。先沿用脚手架实际结构，不要为了对齐文档而重写构建入口。

## 4. 坐标、窗口和平台差异
- 使用 Electron `screen.getAllDisplays()` 和 `display.workArea`，不假设原点为 `(0, 0)`。
- 处理多显示器、负坐标、显示器增删、分辨率变化与缩放。
- 小型透明窗口承载宠物；不要用全屏透明覆盖层。
- `alwaysOnTop`、窗口焦点、鼠标命中、菜单栏/托盘、Dock/任务栏行为必须在两端实测。
- 避免在 renderer 中散落 `process.platform` 判断；平台特有逻辑收敛到 main/platform 或少量明确的适配函数。
- 拖动期间冻结自动移动；拖动结束后重新规划目标。
- 使用 `position += velocity * deltaSeconds` 的时间差模型，而非每个 interval 固定移动像素。

## 5. 状态机
推荐状态：`idle`、`walk`、`turn`、`sit`、`lie`、`drag`、`paused`。`drag` 与 `paused` 优先于自动行为；暂停期间不推进自动移动；随机行为注入随机源或时钟以确保测试可复现。

## 6. Electron 安全基线
- `contextIsolation: true`，`nodeIntegration: false`。
- preload + 最小化 `contextBridge` API。
- IPC 输入校验；拒绝不可信导航；不使用 `eval`。
- 不将密钥打包进 renderer，不降低安全设置。
- 原始宠物照片不自动上传第三方服务。

## 7. 资源与生命周期
- 素材集中放在明确 assets/resources 目录。
- 验证开发模式与打包模式的资源路径。
- 复用已加载纹理；清理 ticker、事件监听器、临时对象和定时器。
- 缺少素材时显示占位符，不让应用崩溃。
- 退出时清理窗口、托盘/菜单栏对象与监听器。

## 8. 未来 AI 扩展点（仅预留）
未来可新增独立 interaction 层，将自然语言映射到 schema/枚举白名单动作。MVP 不接入 LLM、后端、数据库或云端服务；模型不得直接执行任意系统命令或控制任意窗口坐标。
