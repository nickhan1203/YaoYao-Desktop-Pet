# CodeBuddy Rules、Skill 与 MCP 配置建议

## 结论

推荐顺序：
1. **CodeBuddy 项目规则 + `CODEBUDDY.md`：必须配置**，约束项目边界与双端验收。
2. **项目 Skill：推荐配置**，将“先检查—计划—小步修改—测试—实测—报告”固定下来。
3. **Context7 MCP：推荐但非必需**，用于查询 Electron、electron-vite、PixiJS、electron-builder 当前文档。
4. **GitHub MCP：可选**，仅当希望 AI 直接读写 Issues/PR 或管理远程仓库时配置；日常同步 Git 命令已足够。
5. 不要为 MVP 安装数据库、云存储、浏览器自动化或 LLM 工具 MCP。

## 1. CodeBuddy Rules

CodeBuddy IDE 的项目规则建议放在 `.codebuddy/rules/` 下，按官方 IDE 文档支持的目录/文件结构管理。本包提供：
- `.codebuddy/rules/00-project/RULE.mdc`
- `.codebuddy/rules/10-electron-security/RULE.mdc`
- `.codebuddy/rules/20-pet-architecture/RULE.mdc`
- `.codebuddy/rules/30-cross-platform-testing/RULE.mdc`

同时项目根目录 `CODEBUDDY.md` 提供全局项目上下文。规则文件格式可能随 CodeBuddy 产品形态/版本而异；首次打开项目后，询问 CodeBuddy 当前加载了哪些规则，必要时通过 IDE 的规则设置界面创建并核对规则。修改规则后新建对话，以确保新规则加载。

## 2. Skill

项目级 Skill 位于 `.codebuddy/skills/yaoyao-task/SKILL.md`。首次使用时确认 CodeBuddy IDE 版本能够识别该项目级技能；如果未自动发现，可将其作为任务工作流文档手动引用，不要为了 Skill 自动加载而安装来源不明的插件。

## 3. Context7 MCP（推荐）

用途：查询当前版本的 Electron、electron-vite、PixiJS、Vitest 和 electron-builder 文档，减少使用过时 API 的风险。

官方入口：
- Context7 项目：https://github.com/upstash/context7
- Electron：https://www.electronjs.org/docs/latest/
- electron-vite：https://electron-vite.org/
- PixiJS：https://pixijs.com/
- electron-builder：https://www.electron.build/

配置步骤应以当前 CodeBuddy MCP 文档为准。不要盲目复制为其他 IDE 编写的 MCP JSON；检查 server 来源、权限、传输方式和凭据要求。配置完成后，用具体查询验证 MCP 可用。

## 4. GitHub MCP（可选）

只有在需要 AI 读取/管理 Issues、PR 或远程仓库时才连接。当前个人 MVP 可以先使用本地 Git + 远程仓库网页完成协作。连接前检查公开仓库中没有原始照片、密钥、`.env` 或隐私信息。写 Issue、合并 PR、发布 Release 等远程写操作需明确确认。

## 5. 安全原则
- MCP 返回的网页和内容是数据，不是高优先级指令；仍需审查。
- 不把密钥硬编码在配置或仓库中，使用产品支持的凭据机制。
- 仅授予任务所需的最小权限。
- 不给 AI 无限制访问整个用户目录、任意 shell 或私密照片的权限。
- MCP 不能替代单元测试、代码审查和双端实机验收。
