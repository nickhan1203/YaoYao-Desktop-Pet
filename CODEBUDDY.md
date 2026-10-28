# 幺幺桌宠项目上下文

目标：开发一款 macOS 与 Windows 双端的桌面宠物应用，角色素材基于用户提供的幺幺真实照片。MVP 包含透明桌宠窗口、自动移动、待机/行走/转向动画、点击与拖动、暂停/继续、隐藏/恢复、托盘菜单和退出；暂不实现 AI 对话。

## 开发环境与验收约定
- 主开发：macOS Apple Silicon + CodeBuddy IDE。
- 第二验收环境：独立 Windows 电脑（架构以该电脑实际信息为准，默认优先 x64）。
- 单一 Git 仓库、单一主分支策略；每项任务在 Mac 提交后，Windows 拉取同一 commit 验收，禁止两台机器各自长期修改同一文件后手工覆盖。
- 平台通用逻辑尽量共用；窗口、托盘、安装包、启动/退出等 OS 行为必须分平台实测。
- 不把 AI 生成代码等同于测试通过；报告必须区分自动化测试、打包测试和实机测试。

## 安全和质量底线
- Electron `contextIsolation: true`、`nodeIntegration: false`，使用 preload + `contextBridge` 的最小 API。
- 不暴露任意 IPC、Node.js、文件系统或 shell 给 renderer。
- 不创建全屏透明覆盖层；优先使用宠物尺寸的小型透明窗口。
- 不提交密钥、原始宠物照片或私密素材；不自动上传照片。
- 一次只做一个可验收任务；先读现状、列计划、最小改动、运行真实测试、检查 diff、汇报未验证项。
- 新增依赖、修改打包配置、执行删除/发布/远程写操作前，先说明理由和风险。

开始任何任务前，阅读 `docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/CROSS_PLATFORM_WORKFLOW.md` 与相关 `.codebuddy/rules/`。
