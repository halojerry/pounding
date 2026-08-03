# CLI 自助管理（助手页运行环境）与去捆绑瘦身 — 设计规格

> 日期：2026-08-03 · 分支：`feat/cli-self-service` · 目标版本：v2.1.42（poundingcoreVersion 保持 v0.1.52）

## 1. 背景与根因

当前 v2.1.42 发布被 Build and Release 的 OOB 门禁反复卡住，根因是我们 fork 自创的
"离线捆绑 CLI" 复杂度链：

- 安装器捆绑 python 运行时 + uv + hermes wheels + claude/openclaw 离线包（324MB NSIS），
  慢盘/杀软下解压"卡一半"；
- hermes 依赖 wheel 平台缺口（darwin-x64 pyyaml 标签、win32-arm64 cryptography 无 wheel），
  补丁一个接一个；
- macos-x64 在 arm64 runner（macos-14）上用 Rosetta 跑 x64 包，后端冷启动 >120s，
  OOB 门禁超时；
- OOB 门禁把 CLI 可用性设为 release 硬断言，任何平台 CLI 安装抖动都阻断发布。

上游（iOfficeAI/AionUi、AionCore）不捆绑、不安装任何 CLI：Agent = 检测用户已装 CLI
（`cli_path` / PATH）+ 远程代理（gateway）。本设计回归该模型，同时保留我们的国内网络优势
（npm/pip 镜像 + COS 兜底制品）。

## 2. 目标

- 用户到"助手页 → 运行环境"自助安装/升级/卸载 claude、hermes、openclaw，支持环境检测
  （来源徽章、路径、版本、可用性、冲突）；
- 首启零打扰：移除 cli-prep 强制安装页，未装 CLI 也能正常使用应用；
- 移除安装器内 CLI/python/uv/wheels 捆绑，安装器从 ~324MB 瘦身到 ~80–110MB；
- OOB release 门禁对 CLI 降为非阻断，只保留：应用启动 + 后端就绪 + 内置 MCP 启用 +
  zip PORTABLE 断言；
- **保留现有 claude/hermes/openclaw 模型配置能力**（`NewApiDesktopAccountService` 写
  settings.json / openclaw.json / hermes 配置 / CC-Switch DB / 模型列表同步 全部不动）；
- pr-checks 构建测试覆盖四平台（macos-arm64、macos-x64、windows-x64、windows-arm64），
  全部通过才合 main。

## 3. 范围

**本 repo（pounding）单仓库实施，poundingcore 零改动**（已核实：后端 agent 可用性为纯
PATH 解析 `which()`，doctor/repair 仅快照/重探测；`cli_path` 覆盖通过前端注入 spawn PATH
实现）。poundingcore 的 workflow 不动，无需发 v0.1.53。

### 3.1 运行环境检测（对齐 cc-switch）

- 桌面侧新增 CLI 枚举检测：对 claude / hermes / openclaw 枚举真实 PATH（登录 shell）+
  已知托管目录（`~/.local/bin`、`~/.bun/bin`、`~/.hermes` venv），每项返回：
  `path`、`version`（`--version`）、`runnable`、`source`（nvm/homebrew/bun/pip/system/managed）、
  `isDefault`、`conflict`（多处安装/版本分歧）；
- 数据源：现有 `verifyAllClisAvailable()` / `isManagedCliInstalled()` 扩展为枚举式，
  结果经 IPC 提供给 UI；后端 `/api/doctor/diagnose` 保持原样作为后端 spawn 视角；
- `cli_path` 覆盖：用户可对每个 CLI 指定可执行路径/目录，存储到本地配置；
  桌面 spawn poundingcore 时（`buildSpawnEnv`）把该目录前置注入 PATH（复用现有
  `~/.local/bin`、`~/.bun/bin` 注入逻辑，改为按配置追加）。

### 3.2 自助 UI

- 删除首启 `cli-prep` 页面与路由，首启直接进应用（无强制安装）；
- 设置 → Agent 页新增 **"运行环境"** 区块：每行一个 CLI —— 来源徽章 + 路径 + 版本 +
  状态（可用/未装/损坏/冲突）+ 按钮 [安装] [升级] [卸载] [诊断] [选择路径/设为默认]；
- 交互复用 `AgentHubModal` 的 install/installing/installed/retry 状态模式；
- 对话中使用未装 CLI 的助手时，显示内联"未安装 → 去安装"入口（跳转运行环境区块）；
- 新增 i18n keys（9 个 locale 文件同步）。

### 3.3 安装执行（官方命令 + COS 兜底）

- `managedCliInstallerBridge` 保留 install/uninstall/status IPC、超时、同目标互斥；
- 安装链改为：
  1. **官方命令**：claude 官方安装脚本或 `npm i -g @anthropic-ai/claude-code`；
     openclaw `npm i -g openclaw`；hermes `pip install hermes-agent[acp]`（venv，系统
     python3；保留 npm/pip 镜像回退与既有超时）；
  2. **COS 兜底**：官方命令失败/网络不通时，从 COS 按需下载离线制品（hermes =
     python-build-standalone 运行时 + wheels，或预置 venv 包；claude/openclaw = 按平台
     打包的 npm 包/二进制），复用现有 COS 下载与 `d.officecli.ai` 式回退链；
- 安装完成后照旧调用 `syncAfterInstall`（`reconcileManagedRuntimeState`）写模型配置；
- **删除** `markBackendReady` 中的 `installManagedCliBatch(['hermes','openclaw','claude'])`
  启动自动安装。

### 3.4 拆捆绑 + 安装器瘦身

- `scripts/prepare-vendor.sh` / `vendor-managed-resources.sh`：移除 python 运行时、uv、
  hermes wheels、claude/openclaw 离线包的 vendor 逻辑（保留 node runtime 与内置 MCP
  依赖，如 chrome-devtools-mcp）；
- 删除 `scripts/build-missing-hermes-wheels.sh` 及 `_build-reusable.yml` 中
  "Setup Rust (Windows ARM64 only)" 步骤（不再需要源码构建 wheel）；
- `scripts/afterPack.js` 硬校验从 "bundled python + openclaw" 收紧为仅
  "后端二进制 + managed node runtime"；
- `electron-builder.yml`：保留 nsis include（进度文案）与签名配置注释；
  `pack-usb-zip.sh` 的 Python append 注入保持不变；
- COS 兜底制品按平台/版本维护（复用 `upload-binaries-to-cos.sh` 体系）。

### 3.5 OOB 门禁降级 + CI 四平台

- `tests/e2e/specs/oob-cli-install.e2e.ts`：CLI 可用性（claude/hermes/openclaw）从硬断言
  降为 warn（非阻断）；保留 120s 后端等待、300s 全局超时；
- OOB 门禁保留硬校验：应用启动、内置 MCP 默认启用、zip PORTABLE 断言、NSIS 静默安装
  时长断言（Windows）；
- `pr-checks.yml` build-test 矩阵增加 `macos-x64`（macos-14）与 `windows-arm64`
  （windows-11-arm）；Windows 构建步骤改为使用 `matrix.build_args` 通用化；windows-arm64
  增加 "Install MSVC ARM64 toolchain" 步骤；`timeout-minutes` 45→60；
- 发布矩阵维持 4 平台（macos-arm64/x64、windows-x64/arm64），OOB 仅对应用+MCP 硬断言。

## 4. 不做的事（Out of Scope）

- 不引入云端/远程 agent 服务（方向 A 的长期形态，本轮只做本地自助安装）；
- 不改 poundingcore 任何代码、不发 v0.1.53；
- 不在本轮实现在线安装器（.NET/Web 安装器）；
- 不动模型配置同步链路（settings.json / openclaw.json / CC-Switch / 模型列表）。

## 5. 测试与验收

- 单元：CLI 枚举检测（来源/版本/冲突/默认）、安装链（官方→COS 回退、超时、互斥）、
  `buildSpawnEnv` 的 cli_path 注入、运行环境 UI 状态机、i18n keys；
- e2e：移除 cli-prep 后首启不阻塞；助手页检测/安装按钮流程；OOB 门禁在 CLI 未装时通过；
- CI：pr-checks 四平台构建测试全绿；Build and Release 四平台 OOB（应用+MCP）全绿；
- 手工验收：全新机器首启直接进应用；未装 CLI 可用应用；安装一个 CLI 后模型配置正确生成；
  安装器 ≤110MB；Windows 静默安装 <300s。

## 6. 发布计划

1. 单一 `feat/cli-self-service` 分支，按 检测 → UI → 安装链 → 拆捆绑 → 门禁/CI 顺序提交；
2. 本地全量验证（lint/format/tsc/vitest）→ PR → pr-checks 四平台全绿 → merge main；
3. 手动触发 Build and Release（main）→ 四平台 OOB（应用+MCP）绿 → Create Release
   **v2.1.42**（poundingcoreVersion 保持 v0.1.52）；
4. `cos-mirror.yml` 同步 latest/ 并验证。

## 7. 假设与决策（已确认）

- 1A：官方命令为主 + COS 兜底；2B：完全移除首启 cli-prep；3A：停自动安装 + 自助 UI +
  OOB 降非阻断，**拆捆绑 + 安装器瘦身本轮一并做**；
- 模型配置能力保留（claude/hermes/openclaw 的配置与模型列表仍由 POUNDING 管理）；
- 四平台（mac arm / mac x86 / win x64 / win arm64）PR 阶段构建测试全绿才合 main；
- 单仓库实施，poundingcore 零改动（若实施中发现后端必须改，先暂停并回报，不擅自发版）。
