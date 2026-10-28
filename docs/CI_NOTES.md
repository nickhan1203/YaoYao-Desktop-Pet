# CI 模板启用说明

`.github/workflows/ci.yml` 是可选模板，不能在没有核对项目脚本时直接视为可用。

在 Task 0 中先检查 `package.json`，然后按实际脚本调整：
- `npm test -- --run`：若项目 Vitest 脚本不同，应改为真实命令。
- `npm run typecheck --if-present`：若脚本不存在，`--if-present` 会跳过；建议在项目成熟后明确配置。
- `npm run build`：必须与脚手架的生产构建脚本一致。
- `npx electron-builder --publish never`：仅当已安装并配置 electron-builder 时启用；若尚未配置，应先删除该步骤，或先完成打包任务。
- `node-version: 22`：需与项目 Electron/electron-vite 版本兼容，最终以 lockfile 和官方要求为准。

CI 用于两种 OS runner 上的自动化回归和构建，不代表实际桌面交互已经验收。发布前仍需在用户的 Apple Silicon Mac 和独立 Windows 电脑上手动测试窗口、托盘/菜单栏、输入、多显示器和安装流程。
