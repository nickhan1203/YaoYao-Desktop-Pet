# macOS ↔ Windows 跨平台开发与验收工作流

## 1. 角色分工
- **Mac（Apple Silicon）**：主开发、CodeBuddy、日常调试、macOS `.app`/DMG 构建与实机验收。
- **独立 Windows 电脑**：拉取 Mac 已提交的 commit，运行自动化测试、原生构建 Windows 安装包并完成 Windows 实机验收。
- **Git 仓库**：唯一事实来源；不通过聊天软件手动传源码压缩包来同步日常代码。
- **GitHub Actions（可选）**：在 macOS 和 Windows runner 上做自动化回归、构建和保存产物；CI 不能替代桌面交互实机测试。

## 2. 一次性准备

### Mac
1. 安装 Git、Node.js LTS（以项目依赖和 Electron 版本要求为准）、CodeBuddy IDE。
2. 创建 Git 仓库，放入项目和 `.codebuddy/`、`CODEBUDDY.md`、`docs/`。
3. 配置 `.gitignore`：至少排除 `node_modules/`、构建输出、`.env*`、签名证书/密钥、个人照片源文件和本地设置。
4. `npm ci`（项目已有 lockfile 时）或按项目初始化方案安装依赖。
5. 运行实际存在的测试、类型检查和构建脚本。
6. 创建初始 commit 并推送远程仓库。

### Windows
1. 安装 Git、Node.js 对应版本；不需要安装 CodeBuddy 才能验收。
2. 克隆同一仓库，执行 `npm ci`。
3. 检查 `git rev-parse HEAD` 与 Mac 提交的 SHA 一致。
4. 运行项目自动化测试和 Windows 开发启动。
5. 将平台环境信息写入验收报告：Windows 版本、CPU 架构、Node/npm 版本、显示器布局和缩放比例。

## 3. 每项功能的日常闭环
1. Mac 开始任务前执行 `git status`，确认工作区状态；不要覆盖未提交的用户改动。
2. CodeBuddy 先读规则和相关源码，列计划，然后只实现一个小任务。
3. Mac 运行与任务相关的单元测试、类型检查、lint（若有）和生产构建。
4. 检查 diff，确认没有照片、密钥、无关重构或安全配置回退。
5. Mac 对受影响的 macOS 行为实测；记录通过/失败/未验证。
6. 提交有意义的 commit，推送远程仓库。
7. Windows 执行 `git fetch` 后切换/拉取对应提交，确认 SHA 一致；运行相同自动化测试。
8. Windows 构建并实测 Windows 应用；如果本次改动影响共享逻辑或系统窗口行为，必须重跑相关回归测试。
9. 在同一验收报告中记录两个平台的结果；未测一端不能标记双端通过。

## 3.1 常用命令示例（先确认仓库状态）

以下命令是流程示例。执行前先确认当前目录是项目根目录，并根据真实 `package.json` 调整脚本名称。

### Mac：开发、测试、提交

```bash
git status --short
node --version
npm --version
npm ci
npm test -- --run
npm run build
git diff --check
git diff
# 确认 diff 后再提交
git add .
git commit -m "feat: describe the completed task"
git push
```

如果项目没有 `test` 或 `build` 这类脚本，不要照抄命令；先读取 `package.json` 并使用项目真实脚本。不要在未检查 diff 的情况下盲目执行 `git add .`。

### Windows：拉取同一提交并验收

PowerShell 示例：

```powershell
git status --short
git fetch origin
git pull --ff-only
git rev-parse HEAD
node --version
npm --version
npm ci
npm test -- --run
npm run build
```

将 `git rev-parse HEAD` 的输出与 Mac 交付的 commit SHA 比较。若 Windows 工作区有未提交改动，先停下检查，不要强制覆盖。

### 原生打包命令示例

仅当项目已安装并配置 `electron-builder`、且 `package.json` 中的入口和打包资源配置正确时使用：

```bash
# Mac Apple Silicon：本地 arm64 包
npx electron-builder --mac --arm64 --publish never
```

```powershell
# Windows x64：在 Windows 原生环境构建
npx electron-builder --win --x64 --publish never
```

命令是否输出 `.app`、DMG 或 NSIS 安装包取决于项目的 electron-builder target 配置。打包后需检查实际输出目录，并安装/启动验证；命令成功本身不等于安装包验收通过。

## 4. Git 分支与同步建议
- 单人 MVP 可以使用 `main` + 小任务提交；较大功能用短期 feature branch。
- 一次任务尽量一个主题一个 commit，例如 `feat: add pet movement state machine`。
- 不要在 Mac 与 Windows 同时修改同一功能后互相覆盖；Windows 主要验收，发现问题时记录问题并在 Mac 修复，再推送新 commit 回 Windows 回归。
- `.env`、签名密钥、个人照片源文件、用户设置与构建输出不得提交。
- 如果有本地未提交修改，切换分支/拉取前先检查并妥善保存；不要使用 `git reset --hard` 等破坏性命令来“清理环境”。

## 5. 构建原则
- Mac 原生构建 macOS 应用；Windows 原生构建 Windows 安装包。
- electron-builder 支持多平台目标，但跨平台构建受原生依赖和签名工具限制；不把 Mac 交叉构建的 Windows 包作为最终验收包。
- Apple Silicon 首期先构建 `arm64`。只有明确要支持 Intel Mac 时，再增加 `x64` 或 `universal` 构建与对应实机测试。
- Windows 首期按独立 Windows 电脑架构构建；若设备为常见 x64，先交付 x64 安装包。Windows ARM64 属于额外目标，需明确设备需求再加入。
- 未配置 Apple Developer ID/公证或 Windows 代码签名时，开发阶段可以生成本地测试包，但分发时可能出现系统安全提示；不要声称已签名/公证。

## 6. 自动化 CI 与手动验收边界
CI 可执行：安装依赖、单元测试、类型检查、lint、各平台构建、上传构建产物。

必须实机验证：透明/置顶、鼠标命中、拖动、菜单栏/托盘、Dock/任务栏行为、多显示器、休眠唤醒、安装/卸载，以及实际用户桌面上的视觉效果。

CI 绿灯代表自动化步骤通过，不代表桌面交互和安装包已实机验收通过。

## 7. 双端验收完成定义
- 同一 commit SHA 在两端都完成对应自动化检查。
- macOS `.app` 启动、窗口行为、菜单栏/托盘替代入口和退出通过。
- Windows 安装包安装、启动、窗口行为、系统托盘、退出和卸载通过。
- 资源加载、拖动/暂停优先级、边界和多显示器相关项目按支持范围验证。
- 两端各完成稳定性测试；未完成项明确记录。
- 报告含操作系统版本、架构、commit SHA、产物路径、测试命令、手动步骤和未验证项。
