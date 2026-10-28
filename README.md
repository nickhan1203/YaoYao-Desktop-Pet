# 幺幺桌面宠物：CodeBuddy 跨平台 AI 开发文档包

本项目以 **macOS（Apple Silicon）作为主开发环境**，使用 **CodeBuddy IDE** 辅助开发；使用一台独立 Windows 电脑进行 Windows 实机验收。目标是同一代码库维护 macOS 与 Windows 两个平台，而不是维护两套分叉代码。

## 文档与配置

- `docs/PRD.md`：产品需求、MVP 范围与验收指标
- `docs/ARCHITECTURE.md`：Electron 架构、安全边界与平台适配原则
- `docs/IMPLEMENTATION_PLAN.md`：分阶段实施任务
- `docs/CROSS_PLATFORM_WORKFLOW.md`：Mac ↔ Windows 日常协作、Git、CI 与发布流程
- `docs/TEST_PLAN.md`：自动化测试、双端实机验收矩阵和验收报告
- `docs/ASSET_PIPELINE.md`：幺幺真实照片素材处理与隐私约定
- `docs/AI_WORKFLOW.md`：CodeBuddy AI 协作方法
- `docs/DECISIONS.md`：架构决策记录
- `.codebuddy/rules/`：CodeBuddy 项目规则
- `.codebuddy/skills/yaoyao-task/SKILL.md`：可复用的任务开发流程
- `CODEBUDDY_TASKS.md`：可逐项交给 CodeBuddy 的任务清单
- `MCP_GUIDE.md`：CodeBuddy MCP 选择与安全建议
- `.github/workflows/ci.yml`：可选 GitHub Actions 双平台 CI 模板

## 推荐使用顺序

1. 将本目录内容复制到新建的 `yaoyao-desktop-pet` Git 仓库根目录。
2. 在 CodeBuddy IDE 打开该仓库；确认项目规则已加载。修改/新增规则后，新建对话再验证规则是否生效。
3. 先阅读 `docs/PRD.md`、`docs/ARCHITECTURE.md` 和 `docs/CROSS_PLATFORM_WORKFLOW.md`。
4. 在 Mac 上完成工程基线，运行开发启动、测试和构建，提交初始 Git commit。
5. 按 `CODEBUDDY_TASKS.md` 一次只执行一个任务。
6. 通过 Git 将同一提交同步到 Windows 电脑，运行 Windows 自动化检查、打包与实机验收。
7. 任何一端未实测的系统行为都标记为“待验收”，不得标记为双端通过。

## 重要约定

- 本文档是目标与模板，不假设项目已经初始化。先检查真实 `package.json`、脚手架结构和脚本。
- Mac 主要构建并验收 macOS 应用；Windows 电脑主要构建并验收 Windows 应用。不要依赖在一个平台交叉构建所有平台。
- 原始宠物照片默认只保存在本地，不提交公开仓库，不自动上传第三方服务。
- MVP 不接入 AI 对话、后端、数据库、遥测或云端同步。
- `CODEBUDDY.md` 和 `.codebuddy/` 配置应纳入 Git；本机密钥、私有照片和个人配置不应纳入 Git。
