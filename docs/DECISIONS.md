# 架构决策记录（ADR）

## ADR-001：采用 Electron + TypeScript
状态：Accepted
原因：需要透明桌面窗口、置顶、平台托盘入口与安装包；同一代码库支持 macOS 和 Windows，Web 技术栈适合 CodeBuddy 辅助开发。
代价：运行时体积与资源占用高于轻量原生方案；窗口与托盘行为需要分平台实机验证。

## ADR-002：小型透明窗口承载角色
状态：Accepted
原因：降低鼠标拦截和渲染开销，不覆盖整个桌面。
约束：必须验证窗口移动、拖动、边界与多显示器坐标。

## ADR-003：PixiJS 负责角色渲染
状态：Proposed
原因：支持 2D 精灵、纹理与动画。先实现最小透明角色，再判断是否需要更复杂方案；Canvas 也可作为后续备选。

## ADR-004：MVP 不接入 AI 服务
状态：Accepted
原因：先验证桌面行为与动画，降低 API Key、网络、隐私和成本风险。

## ADR-005：Mac 主开发、Windows 原生验收
状态：Accepted
原因：用户日常开发设备为 Apple Silicon Mac，同时拥有独立 Windows 电脑。Mac 负责主开发与 macOS 包；Windows 电脑拉取同一 commit 进行原生构建和实机验收。
约束：双端结果必须独立记录；CI 不能替代窗口/托盘实机测试；Windows 发现的问题先回 Mac 修复，再推送同一代码线回归。

## ADR-006：首期 CPU 架构目标
状态：Accepted with assumption
macOS 首期目标为 arm64（Apple Silicon）。Windows 首期默认按独立验收电脑的实际架构构建，若为常见 x64 则发布 x64。支持 Intel Mac 或 Windows ARM64 前，需明确目标并增加对应构建与实机验收。
