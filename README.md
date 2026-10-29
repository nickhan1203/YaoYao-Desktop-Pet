# 幺幺桌宠（YaoYao-Desktop-Pet）

跨平台桌面宠物应用：基于用户提供的幺幺（博美犬）照片制作的角色，在桌面上自主活动、可与用户交互。同一代码库支持 macOS（Apple Silicon）与 Windows x64。

## 当前功能

- 透明无边框桌宠窗口，自动行走 / 跑步 / 坐下 / 趴卧 / 转身，正面待机形象
- 点击反馈、拎起、悬空保持、放下落地动画；真实鼠标拖动（窗口跟随 + 屏幕边界约束）
- 系统托盘菜单 + 桌宠右键菜单：暂停 / 继续、隐藏 / 显示、始终置顶、鼠标穿透、重置位置、设置、退出
- 设置窗口（现代卡片式 UI）：宠物大小、行走速度、跑步 / 休息频率、自动活动、置顶、穿透；schema v2 持久化（含 v1 显式迁移）
- 鼠标穿透开启时托盘始终保留关闭入口；拖动中开启穿透自动受控取消，不卡死交互
- 首轮性能优化：单一 PixiJS ticker（60fps 封顶）、纹理按 URL 去重、DOM 观测属性记忆化
- 正式应用图标与独立托盘轮廓图标（macOS Template 模板图自动适配深浅菜单栏）

## 技术栈

Electron 44 + electron-vite / React 19 + TypeScript（strict）/ PixiJS 8 / Vitest

## 开发与验证命令

```bash
npm install        # 首次安装依赖（唯一 lockfile：package-lock.json）
npm run dev        # 开发模式启动（electron-vite，renderer HMR）
npm test           # Vitest 全量单元测试（纯逻辑层，541 项）
npm run lint       # ESLint 检查
npm run typecheck  # TypeScript 类型检查（node + web 两侧）
npm run build      # 类型检查 + electron-vite 生产构建
npm run build:mac  # macOS arm64 安装包（本机执行，输出 dist/）
npm run build:win  # Windows x64 NSIS 安装包（在 Windows 原生环境执行）
```

说明：`build:win` 不在 macOS 交叉构建；Windows 安装包必须由独立 Windows 电脑拉取同一 commit 原生构建并实机验收。

## 项目结构

```
src/
├── main/          # Electron 主进程：窗口/托盘/生命周期/设置持久化/行为运行时
├── preload/       # contextBridge 暴露的最小窄 IPC API
├── renderer/      # React 渲染进程：PetCanvas（PixiJS 画布）+ SettingsPanel
│   └── src/pet/   # 动画/姿态/交互纯逻辑模块与 React hooks
└── shared/        # main 与 renderer 共享的纯逻辑模型（可被 Vitest 直接测试）
tests/             # Vitest 单元测试（纯逻辑层与可注入端口）
build/             # electron-builder 打包资源（正式图标 icns/ico/png、entitlements）
resources/         # 运行时资源（托盘模板图标等）
docs/              # 产品/架构/测试/素材管线等文档
```

行为状态机、移动控制器、决策器、设置模型均为纯逻辑模块，与 Electron 窗口 / IPC 解耦，经可注入端口测试。

## 设置与托盘

- 设置经设置窗口修改，主进程为唯一权威：防抖落盘 `userData/settings.json`，广播各窗口同步；置顶 / 穿透先行应用到窗口，失败回滚字段
- 托盘菜单含勾选项（置顶 / 穿透），与右键菜单共享同一权威状态推导
- 鼠标穿透开启后桌宠窗口忽略鼠标事件，托盘与设置窗口不受影响

## 素材与隐私

- 原始照片与素材源包（`yaoyao-animation-*/`、`yaoyao-icons/`）仅保存在本地，不入库（见 `.gitignore` 与 `docs/assets.md`）；运行时帧位于 `src/renderer/src/assets/pet/`
- 左右行走 / 交互素材仅保存 side-right 源帧，side-left 经容器镜像实现（见 `docs/assets.md`）
- 不提交密钥、`.env`、遥测与云端同步

## 已知限制与待验收

- macOS 已完成自动化测试与实机验收（含置顶 / 穿透 / 迁移 / 性能采样）；**Windows 全部实机验收尚未执行**（EXE / 任务栏 / 开始菜单 / NSIS 安装包图标、托盘点击行为、窗口标志在 Win32 的实际效果）
- macOS 安装包未做 Developer ID 签名与公证（本机无有效证书，运行未签名 .app 需右键打开）
- 置顶为普通 always-on-top 层级，不承诺覆盖全屏游戏 / 系统安全界面
- 高刷新率屏下渲染循环已封顶 60fps；长驻稳定性采样已完成 11 分钟（无泄漏趋势）

## 文档索引

- `docs/PRD.md` 产品需求与验收指标
- `docs/ARCHITECTURE.md` 架构与安全边界
- `docs/IMPLEMENTATION_PLAN.md` 分阶段任务
- `docs/CROSS_PLATFORM_WORKFLOW.md` Mac ↔ Windows 协作流程
- `docs/TEST_PLAN.md` 测试与验收矩阵
- `docs/ASSET_PIPELINE.md` / `docs/assets.md` 素材管线与资源规范
- `docs/DECISIONS.md` 决策记录
- `MCP_GUIDE.md` / `OFFICIAL_DOCS.md` AI 协作辅助文档
- `.codebuddy/rules/` 项目规则；`.github/workflows/ci.yml` 可选 CI 模板
