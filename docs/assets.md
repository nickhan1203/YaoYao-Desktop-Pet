# 素材资源规范

说明原始素材与运行时素材的关系、目录约定与保留原则。配套 `docs/ASSET_PIPELINE.md`（照片处理管线）。

## 原始素材与运行时素材的区别

- **素材源包**（`yaoyao-animation-v2/`、`yaoyao-animation-v3/`、`yaoyao-animation-v4/`、`yaoyao-icons/`）：整包交付物，含原始大图（sources）、图集（atlases）、预览（webp）与校验文件。体积大（v4 约 92MB）且含原始照片，**仅保存在本地，不入库**（`.gitignore` 已覆盖）。
- **运行时素材**（`src/renderer/src/assets/pet/`）：正式使用的帧 PNG，按需从源包复制，是仓库中唯一的美术资源，随 Git 跟踪（约 5MB）。
- **应用图标**（`build/icon.icns`、`build/icon.ico`、`build/icon.png` 母版）与托盘图标（`resources/tray/`）来自 `yaoyao-icons/` 源包，已复制入库；源包本地保留作为再生成依据。

## 当前运行时素材目录

| 目录 | 帧数 | 用途 | 引用方 |
|---|---|---|---|
| `assets/pet/v2/walk/` | 8 | 侧面行走（含 idle 共用首帧） | `pet-animation.ts` |
| `assets/pet/v2/run/` | 8 | 侧面跑步 | `pet-animation.ts` |
| `assets/pet/v3/front/sit/` | 8 | 正面坐下（含眨眼） | `pet-posture.ts` |
| `assets/pet/v3/front/lie/` | 8 | 正面趴卧 | `pet-posture.ts` |
| `assets/pet/v4/front-idle-01.png` | 1 | 正面待机（与交互 01 共用） | `pet-animation.ts` / `pet-interaction.ts` |
| `assets/pet/v4/front/interaction/` | 7 | 正面点击 / 拎起反馈 | `pet-interaction.ts` |
| `assets/pet/v4/side-right/interaction/` | 8 | 侧面交互反馈 | `pet-interaction.ts` |

## 左右镜像策略

- 行走 / 跑步 / 交互的 side-left 不保存源帧：运行时经角色容器负 scaleX 镜像（翻转轴穿过脚底参考点，见 `PetCanvas.tsx`），镜像由显示命令统一处理
- 因此 `assets/pet/` 下只有 side-right 方向源帧；**不应因"能镜像"而认定 side-right 源帧冗余**

## 历史版本与清理原则

- v1（`idle/`、`walk/`）、v2 姿态（`v2/sit/`、`v2/lie/`）已被 v2 行走 / v3 正面姿态替代，Task 12D 审计确认无引用后删除（历史提交仍可找回）
- **源包永不删除**：即使运行时只用部分帧，源包是再生成与回溯的唯一依据；新增素材版本时复制所需帧到 `assets/pet/<版本>/` 并在本表登记
- 帧引用必须经模块 import（可静态分析），不使用运行时拼接路径，保证审计可交叉确认

## 来源追踪

- 各源包内的 `README.md` / `manifest` / `validation.json` 记录生成方式与校验（本地保留）
- 图标源：`yaoyao-icons/source/original.png`（用户提供的最终设计 PNG，SHA-256 记录于包内 `validation.json`）
