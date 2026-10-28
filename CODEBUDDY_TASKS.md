# CodeBuddy 任务清单（按顺序执行）

> 每次只执行一个任务。任务验收后再继续。主开发在 Mac；Windows 在同一 commit 上做独立验证。

## Task 0 — 检查基线（不改代码）
阅读 `package.json`、lockfile、electron-vite 配置、main/preload/renderer 入口、测试与文档。报告 Node/npm 版本要求、项目脚本、依赖版本、现有架构差异、Mac/Windows 验收计划。不要假设文件存在，不运行破坏性命令。

## Task 1 — CodeBuddy 项目配置与 Git 隐私边界
检查 `CODEBUDDY.md`、`.codebuddy/rules/`、`.codebuddy/skills/` 是否被识别；检查 `.gitignore` 是否排除 `.env*`、签名文件、原始照片与构建产物。只提出最小修改。确认规则加载后再开始功能开发。

## Task 2 — 安全边界与工程结构
检查 main/preload/renderer 职责；确保 `contextIsolation: true`、`nodeIntegration: false`。使用最小、类型化的 contextBridge API，不暴露任意 IPC。先给计划再修改，运行实际存在的测试和构建。

## Task 3 — 透明桌宠窗口
实现约 240×240 CSS px 的透明无边框窗口，设计置顶与鼠标命中行为；使用占位符。增加显示、隐藏、移动接口。Mac 实测透明、置顶、点击、焦点和退出；列出 Windows 对应清单，不提前声称 Windows 通过。

## Task 4 — 状态机
实现 idle/walk/turn/sit/lie/drag/paused 纯 TypeScript 状态机。为暂停、拖动优先级和非法转换编写 Vitest 测试，不实现 AI。

## Task 5 — 移动控制器
实现基于 delta time 的移动控制器；目标受 Electron screen workArea 约束；考虑负坐标、多显示器与工作区变化。为边界、目标到达、暂停、拖动恢复添加测试。先说明坐标假设。

## Task 6 — PixiJS 角色动画
先验证单帧透明角色，再接入 idle/walk/sit/lie。支持朝向、帧率、循环与 fallback。清理 ticker、监听器和资源。不伪造不存在的幺幺素材；原始照片不上传。

## Task 7 — 点击、拖动与平台菜单
实现点击/拖动阈值、右键菜单和平台托盘/菜单栏入口。菜单包含暂停/继续、显示/隐藏、退出。分别列出并执行 Mac/Windows 手动验收。

## Task 8 — 双端构建与验收
先检查真实 package scripts 和 electron-builder 配置。Mac 构建 arm64 `.app`，需要时构建 DMG；Windows 原生电脑拉取同一 commit 并构建 NSIS 安装包（若项目配置适用）。两端分别安装/启动/隐藏/恢复/退出/卸载并运行 30 分钟稳定性测试。输出 commit SHA、构建产物、命令与结果、两端未验证项。

## 通用要求
- 先读规则与源码，再计划，再改动。
- 一次只做本任务范围内的最小修改。
- 不引入 AI 对话、后端、数据库、遥测或云服务。
- 不为让测试通过而删除测试。
- 不使用 `any` 或 `@ts-ignore` 掩盖类型问题。
- 完成时区分自动化测试、macOS 实测、Windows 实测和未验证项。
