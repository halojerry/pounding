# POUNDING 发布链路统一（COS latest/ 单一目录）+ CLI 自助安装落地 PRD

> 日期：2026-08-04 · 目标版本：v2.1.42（poundingcoreVersion **v0.1.53**，含 ozon-probe v0.20.0） · 状态：待评审

## 1. 摘要

v2.1.42 的发布曾经被 OOB 门禁反复卡住，PR #23（CLI 自助服务/解捆绑/OOB 降级）与
PR #24（OOB 非阻断快检）已合入 `main`，但**发布尚未触发**。本 PRD 收口两件事：

1. **COS 发布链路统一**：官网下载页、桌面自动更新、便携 zip 更新当前全部依赖
   `releases/latest/`，但该目录实测为空（404/NoSuchKey），且客户端更新代码与 COS
   目录结构错位（三套路径互不匹配）——统一为 `releases/latest/` 平铺单一目录，
   COS 不再写 `releases/download/{tag}/`，版本归档交给 GitHub Releases。
2. **CLI 自助安装落地**：按已确认的方向 A/3A，改为**用户手动一键安装**（不自动
   安装），移除登录后静默自动安装残留，安装入口放到**助手页**（设置→Agent 已隐藏）。

## 2. 背景与根因

### 2.1 COS 现状（2026-08-04 实测）

| 路径                                                    | 结果      | 用途                               |
| ------------------------------------------------------- | --------- | ---------------------------------- |
| `releases/download/v2.1.41/latest.yml`                  | 200       | 版本归档（现有流程在写）           |
| `releases/download/v2.1.41/POUNDING-2.1.41-win-x64.exe` | 200       | 版本归档                           |
| `releases/latest/latest.yml`                            | NoSuchKey | 官网下载页 + 便携更新 feed（空）   |
| `releases/latest/POUNDING-2.1.41-win-x64.exe`           | 404       | 官网直链（空）                     |
| `releases/latest.yml`                                   | 404       | 自动更新 feed（代码指向此处，空）  |
| `releases/v2.1.41/POUNDING-2.1.41-win-x64.exe`          | 404       | 自动更新安装包（代码指向此处，空） |

结论：**上传侧一直在写 `download/{tag}/`，而读取侧（官网/自动更新/便携更新）全部
在等 `latest/`（或 `releases/` 根），两边从未对齐。** 且 build-and-release /
cos-mirror 的 COS 步骤均为 `continue-on-error: true`，latest 同步失败会被吞掉，
release 照常成功，无人发现。

### 2.2 客户端更新读取路径（现状梳理）

| 路径                | 代码                                  | 当前指向                                                                      | 状态                                     |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| 安装版自动更新 feed | `updateFeed.ts` `CDN_UPDATE_BASE_URL` | `.../pounding/releases`（无 /latest）→ 请求 `releases/latest*.yml`            | 404                                      |
| 自动更新安装包      | `cdnGenericProvider.ts` resolveFiles  | `${base}/${version}/POUNDING-...`                                             | 404                                      |
| 便携 zip 更新 feed  | `portableUpdater.ts` `COS_LATEST_YML` | `releases/latest/latest.yml`                                                  | NoSuchKey                                |
| 便携 zip 下载       | `portableUpdater.ts`                  | `releases/download/v${version}/${zip}`                                        | feed 404 走不到                          |
| 手动更新弹窗        | `updateBridge.ts`                     | GitHub Releases API + CDN 重写（多一层 `/releases` 笔误，有 GitHub fallback） | 部分可用                                 |
| 打包配置            | `electron-builder.yml` publish        | generic `.../releases/latest` + github                                        | 与代码不一致（运行时被 setFeedURL 覆盖） |

### 2.3 CLI 自助安装现状

- 设计（`docs/prds/2026-08-03-cli-self-service-design.md` §3A，已确认）：停自动
  安装 + 自助 UI + 环境检测 + OOB 降非阻断。
- 实现残留：`NewApiAccountContext.tsx` 的 `runAutoInstall` 在**登录成功后自动
  触发**（`useEffect` + `login()` 两处），静默安装 hermes/openclaw/claude；
  `prepStatus` 无任何 UI 消费（cli-prep 页路由已删），失败还会"下次启动再试"。
- 安装能力已就绪：`RuntimeEnvironmentPanel`（来源徽章/路径/版本/安装按钮）、
  `cliDetection`（来源/冲突检测）、`managedCliInstallerBridge` IPC（超时+互斥）、
  装完自动同步模型配置。
- 入口问题：设置弹窗内置 Tab **不含 agent**（`SettingsModal` 注释明确），
  `/settings/agent` 路由无 UI 入口；可见入口是顶级**助手页 `/assistants`**
  （侧边栏 SiderAssistantEntry），检测状态（`agent_status` missing/unavailable）
  也在助手页卡片上展示。

## 3. 决策记录（已确认）

| 编号 | 决策                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | CLI 安装方式 = **按需自动安装（2026-08-04 修订）**：用户首次使用未装 CLI 的助手时，自动安装对应 CLI（带进度、可取消、可重试），不做启动/登录全量自动安装；设置页保留手动安装按钮 |
| D2   | 安装入口放在**助手页（/assistants）**；设置→Agent 页已隐藏，不再作为入口                                                                                                         |
| D3   | COS 只发布 `releases/latest/`（平铺：latest\*.yml + 各平台安装包 + blockmap）；不再写 `releases/download/{tag}/`；版本归档 = GitHub Releases                                     |
| D4   | 客户端更新路径统一指向 `releases/latest/` 平铺；更新语义 = 下载新版本安装包（win exe / mac dmg+zip）覆盖安装                                                                     |
| D5   | 每次 release：清空 `latest/` → 重传 → yml/blockmap 设 no-cache → **硬校验 `latest/latest.yml` 200**（去掉 `continue-on-error`）                                                  |
| D6   | 全部工作完成、四平台验证通过后才手动触发发布 v2.1.42；本次先不 release                                                                                                           |
| D7   | Linux 不进 release/COS（不补 .deb 构建），官网不显示 Linux 下载项                                                                                                                |
| D8   | latest/ 存量不单独补刷，随 v2.1.42 发布一起刷新                                                                                                                                  |
| D9   | workflow 重叠收敛：保留 `cos-mirror.yml`，移除 `release-distribute.yml`                                                                                                          |

## 4. 实施范围

### 4.1 poundingcore（独立仓库）

| 项                | 内容                                                                                                                                                 | 状态                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| ozon-probe assets | 内置 skill `pounding-ozon-probe` 升级 v0.12.0 → v0.20.0：新增 `bootstrap_update.py`（旧包一键升级迁移）、`cloud_probe.py` 扩展、SKILL.md 等 7 个文件 | PR #6 已创建，待 CI 绿合并 |

poundingcore 仅此一项，无 workflow/后端代码改动。

### 4.2 pounding PR-1：COS latest/ 统一 + 客户端更新路径对齐

**工作流侧**

- `_build-reusable.yml`：无改动（产物由 `prepare-release-assets.sh` 平铺生成）。
- `build-and-release.yml` / `cos-mirror.yml` / `release-distribute.yml`：
  - 删除 versioned 上传步骤（`releases/download/${TAG}/`）；
  - 保留 latest 同步步骤（rm `latest/` → cp 平铺 → yml/blockmap no-cache）；
  - 去掉 `continue-on-error: true`，改为失败即 fail；
  - 上传后新增硬校验：`curl -sI ${COS}/pounding/releases/latest/latest.yml` 必须 200，否则 release fail。
- `release-distribute.yml` 删除，收敛到 `cos-mirror.yml`（D9）。

**客户端读取侧**

| 文件                                                          | 改动                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/desktop/src/process/services/updateFeed.ts`         | `CDN_UPDATE_BASE_URL` → `.../pounding/releases/latest`                          |
| `packages/desktop/src/process/services/cdnGenericProvider.ts` | `resolveFiles` 去掉 `${updateInfo.version}/` 前缀，平铺解析                     |
| `packages/desktop/src/process/services/portableUpdater.ts`    | zip URL → `.../pounding/releases/latest/${zipFileName}`（feed 已是 latest.yml） |
| `packages/desktop/src/process/bridge/updateBridge.ts`         | 修复 CDN 重写多出的 `/releases` 段（或直接使用 GitHub fallback URL）            |
| `packages/desktop/electron-builder.yml`                       | publish generic url 保持 `.../pounding/releases/latest`，与代码一致             |
| `scripts/install-web.sh`                                      | `MIRROR` 默认值改为 `.../pounding/releases/latest`（平铺）                      |

**测试**

- 单测：`updateFeed` / `cdnGenericProvider` / `portableUpdater` / `updateBridge`
  的 URL 断言改为 latest/ 平铺；新增 latest.yml 校验相关测试。
- 存量不补刷：`latest/` 随 v2.1.42 发布时一起刷新（D8）；`cos-mirror.yml`
  仅作为发布后失败重跑入口。

### 4.3 pounding PR-2：CLI 自助安装落地（助手页入口）

| 文件                       | 改动                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NewApiAccountContext.tsx` | 删除登录后自动触发 `runAutoInstall` 的两处（useEffect + login()），`runAutoInstall` 保留为按钮 handler；`prepStatus` 仅在用户触发时产生                 |
| 助手页 `/assistants`       | 增加"运行环境"区块（复用 `RuntimeEnvironmentPanel`），展示 claude/hermes/openclaw 来源徽章/路径/版本/状态 + [安装][升级][卸载][诊断]                    |
| 会话内按需自动安装         | 选择未装 CLI 的助手时（guid 页），自动安装该 CLI（`useCliOnDemandInstall` + `CliAutoInstallBanner` 进度横幅，可取消/重试），装完刷新 agent 目录立即可用 |
| i18n                       | 9 个 locale 文件同步新增 keys                                                                                                                           |

**测试**

- 单测：`RuntimeEnvironmentPanel.dom.test.tsx` 扩展、`NewApiAccountContext`
  状态机（登录不再触发安装、按钮触发安装）；
- 手动验收：全新机器首启/登录零打扰；未装 CLI 可用应用；助手页一键安装后
  模型配置正确生成。

### 4.4 发布计划（全部完成后才执行）

1. poundingcore PR #6（ozon-probe）CI 绿 → 合并；
2. pounding PR-1、PR-2 按序合并到 `main`；
3. 手动触发 `build-and-release.yml`（`workflow_dispatch` on main）；
4. 四平台 OOB（macos-arm64/x64、windows-x64/arm64）全绿 → Create Release v2.1.42；
5. `cos-mirror.yml`（或 release 内建步骤）刷新 `latest/`，验证：
   - `releases/latest/latest.yml` 200 且 version = 2.1.42；
   - 官网直链 `POUNDING-2.1.42-{platform}-{arch}.{exe|dmg}` 200；
   - 自动更新 feed `latest-mac.yml` / `latest-win-arm64.yml` 指向 2.1.42 资产。

## 5. 验收标准

| 场景           | 验收                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| 官网下载页     | fetch `releases/latest/latest.yml` 200，直链可下载                       |
| 安装版自动更新 | feed 200；按 yml 下载对应平台安装包覆盖安装（win exe / mac dmg/zip）     |
| 便携 zip 更新  | `latest/latest.yml` 200 → 下载 `latest/{zip}` 原地更新                   |
| 手动更新弹窗   | GitHub 资产列表正常，CDN 重写 URL 无 `/releases` 笔误                    |
| release 流程   | COS 步骤不再静默失败；latest.yml 硬校验通过才允许发版                    |
| CLI 安装       | 登录/首启不自动安装；助手页一键安装可装/可卸/可诊断；未装 CLI 不阻断使用 |
| 四平台         | PR 构建测试（mac arm/x64、win x64/arm64）全绿                            |

## 6. 待确认问题（2026-08-04 已确认）

1. **Linux 下载**：不补 Linux 构建，release 不发 Linux 到 COS，官网不显示
   Linux 下载项（D7）。
2. **存量 latest/ 补刷**：不单独补刷 v2.1.41，等 v2.1.42 发布时一起刷新（D8）。
3. **workflow 重叠**：保留 `cos-mirror.yml`，移除 `release-distribute.yml`（D9）。

## 7. 参考

- `docs/prds/2026-08-03-cli-self-service-design.md`（方向 A/3A 原设计）
- `docs/guides/pounding-release-update.md`（更新链路文档）
- 已合入：pounding PR #23（CLI 自助服务）、PR #24（OOB 非阻断快检）
- 关键文件：`updateFeed.ts` / `cdnGenericProvider.ts` / `portableUpdater.ts` /
  `updateBridge.ts` / `electron-builder.yml` / `build-and-release.yml` /
  `cos-mirror.yml` / `release-distribute.yml` / `NewApiAccountContext.tsx` /
  `RuntimeEnvironmentPanel.tsx` / `AgentModalContent.tsx` / `Router.tsx`
