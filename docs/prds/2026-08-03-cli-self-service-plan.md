# CLI 自助管理（运行环境）与去捆绑瘦身 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 claude/hermes/openclaw 从"安装器捆绑 + 首启强制安装 + OOB 硬门禁"改为"助手页运行环境自助管理 + 环境检测"，并拆掉安装器内的 CLI/python/uv/wheels 捆绑，让 v2.1.42 可发布。

**Architecture:** 单仓库（pounding）实施，poundingcore 零改动。桌面侧新增 CLI 枚举检测（PATH + 托管目录，路径/版本/来源/冲突），`buildSpawnEnv` 支持按配置注入用户指定 CLI 目录到后端 PATH；`managedCliInstallerBridge` 安装链改为"官方命令 + COS 兜底"并移除启动自动安装；渲染端删除 cli-prep、在设置→Agent 页加"运行环境"区块；vendor 脚本/afterPack/OOB 门禁/pr-checks 矩阵同步收敛。

**Tech Stack:** TypeScript / React / Electron / vitest / oxlint / oxfmt / GitHub Actions（pounding 仓库）。

## Global Constraints

- 目标版本 v2.1.42；poundingcoreVersion 保持 v0.1.52；**不得改动 poundingcore 仓库**。
- 模型配置能力保留：`NewApiDesktopAccountService` 写 settings.json / openclaw.json / CC-Switch DB / 模型列表的链路**不允许改动**（只允许调用其现有 `reconcileManagedRuntimeState`）。
- CLI 目标仅 3 个：`claude`、`hermes`、`openclaw`（opencode 已移除，禁止重新引入）。
- 安装链：官方命令优先（claude 官方安装脚本 / `npm i -g` / `pip install`），失败回退 COS 按需制品；保留既有镜像回退（`NPM_MIRROR_REGISTRY`/`NPM_DEFAULT_REGISTRY`、PyPI tuna/default）与超时（npm 300s、pip 600s、venv 120s、probe 15s）、同目标互斥。
- 现有 IPC 通道 `managedCliInstaller.{install,uninstall,isInstalled}` 保留（UI 复用）；`/api/doctor/*` 后端端点不动。
- OOB release 门禁只对以下项硬断言：应用启动 + 后端 120s 就绪 + 内置 MCP 默认启用 + zip PORTABLE 断言 + Windows NSIS 静默安装 <300s；**CLI 可用性为非阻断 warn**。
- pr-checks build-test 矩阵扩为四平台：macos-arm64(macos-14)、macos-x64(macos-14)、windows-x64(windows-2022)、windows-arm64(windows-11-arm)；windows 构建步骤通用化 + windows-arm64 补 MSVC ARM64 工具链；`timeout-minutes: 45 → 60`。
- 删除启动自动安装 `installManagedCliBatch(['hermes','openclaw','claude'])`（index.ts `markBackendReady`）与首启 `cli-prep` 页面/路由。
- vendor 仅保留：node runtime + 内置 MCP（chrome-devtools-mcp 等）+ ACP bridges；移除 python/uv/hermes wheels/claude/openclaw 离线包与 `build-missing-hermes-wheels.sh`。
- `scripts/check-version-consistency.sh` 继续可用（移除 vendor 路径类检查后仍需通过 CI）。
- 所有新增/修改 TS 通过 `bunx tsc --noEmit`、`bun run lint -- --quiet`（0 errors）、`bun run format:check`；新增行为有单测（TDD：先写失败测试）。
- 所有 i18n 新增 key 需同步 9 个 locale 文件，`bun run i18n:types` + `node scripts/check-i18n.js` 通过。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `packages/desktop/src/process/services/cliDetection.ts`（新建） | 纯函数 CLI 枚举检测：PATH/托管目录扫描、`--version`、来源判定、冲突标记 |
| `packages/web-host/src/backend-launcher.ts` | `buildSpawnEnv` 追加用户配置的 CLI 目录到 PATH |
| `packages/desktop/src/process/bridge/managedCliInstallerBridge.ts` | 安装链改官方+COS、保留互斥/超时/IPC；新增按需 COS 兜底 |
| `packages/desktop/src/index.ts` | 移除 `markBackendReady` 里的自动安装批 |
| `packages/desktop/src/renderer/pages/cli-prep/*` | 删除（页面+路由+样式） |
| `packages/desktop/src/renderer/components/settings/RuntimeEnvironmentPanel.tsx`（新建） | 运行环境 UI（每 CLI 一行：来源/路径/版本/状态/按钮） |
| `packages/desktop/src/renderer/pages/settings/AgentSettings/...` | 挂载运行环境区块入口 |
| `scripts/prepare-vendor.sh`、`scripts/vendor-managed-resources.sh` | 移除 python/uv/hermes/claude/openclaw vendor |
| `scripts/afterPack.js` | 硬校验收紧为 后端二进制 + managed node |
| `scripts/check-version-consistency.sh` | 移除已删 vendor 路径/制品类检查，保留版本 pin 一致性 |
| `.github/workflows/_build-reusable.yml` | 去掉 Setup Rust 步骤；OOB 门禁语义不变（e2e 里降级） |
| `.github/workflows/pr-checks.yml` | build-test 矩阵四平台 + Windows 步骤通用化 + MSVC ARM64 + timeout 60 |
| `tests/e2e/specs/oob-cli-install.e2e.ts` | CLI 断言降 warn，MCP 保持硬断言 |
| `tests/e2e/specs/pounding-portable-mode.e2e.ts` | 保留不动 |
| `tests/unit/...` | 各任务对应单测 |

---

### Task 1: CLI 枚举检测（cliDetection + 单测）

**Files:**
- Create: `packages/desktop/src/process/services/cliDetection.ts`
- Test: `tests/unit/process/services/cliDetection.test.ts`

**Interfaces:**
- Consumes: 无（独立纯模块；复用 `runCommandOutput` 模式，但不强依赖 bridge）。
- Produces:

```ts
export type CliSource = 'nvm' | 'homebrew' | 'bun' | 'pip' | 'system' | 'managed';
export type CliInstallation = {
  binary: string;          // 'claude' | 'hermes' | 'openclaw'
  path: string;            // 绝对路径
  version: string | null;
  runnable: boolean;       // --version 成功
  source: CliSource;
  isDefault: boolean;      // 是否为 PATH 首个命中
};
export type CliTargetStatus = {
  target: 'claude' | 'hermes' | 'openclaw';
  installations: CliInstallation[];
  defaultPath: string | null;
  conflict: boolean;       // 多个来源且版本分歧/多处命中
};
export async function detectCliInstallations(
  targets: Array<'claude' | 'hermes' | 'openclaw'>,
  options?: { managedDirs?: string[]; pathEntries?: string[] }
): Promise<CliTargetStatus[]>;
export function classifySource(path: string, home: string, managedDirs: string[]): CliSource;
export function isRunnableVersionOutput(output: string): boolean;
```

- [ ] **Step 1: 写失败测试**（`cliDetection.test.ts`）：mock `which -a`/`where` 输出与 `--version` 输出，断言多安装枚举、来源分类（`~/.nvm`→nvm、`/opt/homebrew/bin`→homebrew、`~/.bun/bin`→bun、`~/.local/bin`→managed、其余→system）、default 取 PATH 首个、冲突判定。
- [ ] **Step 2: 跑测试确认失败**：`./node_modules/.bin/vitest run tests/unit/process/services/cliDetection.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现 `cliDetection.ts`**：纯函数 + 检测主流程（用 `runCommandOutput('which -a'/'where')` 枚举，对每个命中跑 `--version`，`managedDirs` 注入补充扫描）。
- [ ] **Step 4: 跑测试确认通过**：同 Step 2 命令 → PASS。
- [ ] **Step 5: 提交**：`git add ... && git commit -m "feat(cli): CLI 安装枚举检测（来源/版本/冲突）"`

---

### Task 2: buildSpawnEnv 支持用户 CLI 目录注入

**Files:**
- Modify: `packages/web-host/src/backend-launcher.ts`（`buildSpawnEnv`）
- Modify: `tests/unit/bootstrap/backendLauncherSpawnEnv.test.ts`
- Modify: `packages/web-host/src/backend-launcher.test.ts`（如有 PATH 断言需同步）

**Interfaces:**
- Consumes: 读取配置 `{userData}/cli-paths.json`（不存在返回空）。
- Produces: 新导出纯函数：

```ts
export function resolveManagedPathEntries(
  home: string,
  bunHome: string,
  overrides: Record<string, string> // { claude?: string; hermes?: string; openclaw?: string }，值为目录或 exe 路径
): string[]; // 目录列表（去重、按 claude/hermes/openclaw 顺序、exe 路径取父目录）
```

- [ ] **Step 1: 写失败测试**：`resolveManagedPathEntries` 输入 overrides `{claude:'/opt/claude/bin/claude'}` 返回含 `/opt/claude/bin`；`buildSpawnEnv` 在 `cli-paths.json` 存在时 PATH 前置其目录（沿用现有 HOME stub 方式）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：`buildSpawnEnv` 读取 `cli-paths.json`（fs.readFileSync + try/catch，固定路径 `path.join(os.homedir(), '.pounding', 'cli-paths.json')`），调用 `resolveManagedPathEntries` 合并进现有 managed 目录注入。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(runtime): buildSpawnEnv 按 cli-paths.json 注入用户 CLI 目录"`

---

### Task 3: 安装链改造（官方 + COS 兜底）与移除自动安装

**Files:**
- Modify: `packages/desktop/src/process/bridge/managedCliInstallerBridge.ts`
- Modify: `packages/desktop/src/index.ts`（`markBackendReady` 删 `installManagedCliBatch` 调用与相关注释）
- Modify: `tests/unit/process/managedCliInstallerBridge.test.ts`

**Interfaces:**
- Consumes: 现有 `runCommand`/`runCommandOutput`/`resolveBundledResourcesDir`/`syncAfterInstall`/互斥结构。
- Produces: 内部 `installOfficial(target, descriptor)` 与 `installFromCosFallback(target, descriptor)`：
  - claude 官方：`npm i -g @anthropic-ai/claude-code@2.1.215`（保留镜像循环）；
  - openclaw 官方：`npm i -g openclaw@2026.6.33`；
  - hermes 官方：venv（系统 python3，`--clear`）内 `pip install "hermes-agent[acp]==0.19.0"`；
  - COS 兜底：从 `https://yss-1256275613.cos.ap-guangzhou.myqcloud.com/pounding/cli/<target>/<ver>/<plat>/` 下载制品到托管目录并写 shim（制品 schema 与现有 vendor `cli/<target>/<ver>/<plat>/manifest.json` 一致；下载失败/缺失 → 返回失败并保留错误信息）。

- [ ] **Step 1: 写失败测试**：官方命令路径（execFile mock 断言 `npm install -g @anthropic-ai/claude-code@2.1.215` 被调用且系统 npm 不存在时用托管 npm）；COS 兜底（官方失败 → 下载 URL 构造正确 → 写 shim 后 `isManagedCliInstalled` true）；`markBackendReady` 不再触发 install（grep 断言）。
- [ ] **Step 2: 跑测试确认失败**（当前实现仍是 bundled-first）。
- [ ] **Step 3: 实现**：`installManagedCliInternal` 改为 official-first + COS fallback；删除 bundled 物化分支与 hermes wheels 分支；移除 index.ts 自动安装调用。
- [ ] **Step 4: 跑测试确认通过** + `bunx tsc --noEmit`。
- [ ] **Step 5: 提交**：`git commit -m "feat(cli): 安装链改官方命令 + COS 兜底，移除启动自动安装"`

---

### Task 4: 运行环境 UI（新增面板 + 删除 cli-prep + i18n）

**Files:**
- Create: `packages/desktop/src/renderer/components/settings/RuntimeEnvironmentPanel.tsx`、`.module.css`
- Create: `tests/unit/renderer/RuntimeEnvironmentPanel.dom.test.tsx`
- Modify: `packages/desktop/src/renderer/pages/settings/AgentSettings/home/*`（挂入口）、路由配置（删 `/cli-prep` 路由）、`packages/desktop/src/renderer/services/i18n/locales/*/settings.json`（9 个）、`i18n-keys.d.ts`（生成）
- Delete: `packages/desktop/src/renderer/pages/cli-prep/index.tsx`、`index.module.css` 及引用

**Interfaces:**
- Consumes: Task 1 `detectCliInstallations`（经 IPC 或直接调用）、Task 3 `managedCliInstaller` IPC、现有 `AgentHubModal` 状态模式。
- Produces: 组件 props：`type Props = { compact?: boolean };` 内部状态 `loading | list: CliTargetStatus[]`；操作 `install/upgrade/uninstall/diagnose/selectPath`。

- [ ] **Step 1: 写失败 dom 测试**：渲染三行 CLI、未装显示 Install 按钮、已装显示路径+版本+Uninstall、点击 Install 调用 `managedCliInstaller.install`。
- [ ] **Step 2: 跑测试确认失败**（组件不存在）。
- [ ] **Step 3: 实现组件 + 挂载 + 删 cli-prep + 路由清理 + i18n keys**（9 locale + 生成 d.ts）。
- [ ] **Step 4: 跑测试 + `bun run i18n:types` + `node scripts/check-i18n.js` 通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(ui): 设置→Agent 运行环境区块（CLI 自助管理），移除 cli-prep"`

---

### Task 5: 拆捆绑 + 安装器瘦身

**Files:**
- Modify: `scripts/prepare-vendor.sh`、`scripts/vendor-managed-resources.sh`（删 python/uv/hermes/claude/openclaw vendor 段，保留 node/mcp/acp）
- Delete: `scripts/build-missing-hermes-wheels.sh`
- Modify: `scripts/afterPack.js`（`verifyManagedResources` 收紧为 node + 后端二进制）
- Modify: `.github/workflows/_build-reusable.yml`（删 "Setup Rust (Windows ARM64 only)" 步骤）
- Modify: `scripts/check-version-consistency.sh`（移除对已删制品路径/常量的一致性检查，保留对 `managedCliInstallerBridge` 中 CLAUDE/OPENCLAW/HERMES 版本 pin 的检查）
- 验证：`bash -n` 全部脚本；`bash scripts/check-version-consistency.sh ../poundingcore` 通过

- [ ] **Step 1: 改 prepare-vendor.sh / vendor-managed-resources.sh**：删除 `vendor_hermes`、python/uv vendor 调用与 claude/openclaw 离线包；保留 `vendor_node`/`vendor_mcp`/`vendor_acp`（按脚本现有函数名）。
- [ ] **Step 2: 删 build-missing-hermes-wheels.sh + workflow Rust step**。
- [ ] **Step 3: 改 afterPack.js**：`verifyManagedResources` 只校验 manifest 中 node 与后端二进制；其余硬 gate 同步收紧。
- [ ] **Step 4: 改 check-version-consistency.sh** 并本地跑通。
- [ ] **Step 5: 提交**：`git commit -m "build(vendor): 移除 CLI/python/uv 捆绑，安装器瘦身，收紧 afterPack 校验"`

---

### Task 6: OOB 门禁降级 + pr-checks 四平台

**Files:**
- Modify: `tests/e2e/specs/oob-cli-install.e2e.ts`（CLI 三目标 hard → warn；MCP 保持硬断言；注释同步）
- Modify: `.github/workflows/pr-checks.yml`（build-test 矩阵 + Windows 步骤通用化 + MSVC ARM64 + timeout 60）
- Modify: `.github/workflows/_build-reusable.yml`（如 OOB 步骤注释/变量同步）

- [ ] **Step 1: e2e 降级**：`TARGETS` 数组三目标 `hard: true → false`，保留轮询与 warn 输出；MCP 测试不动；`bunx playwright test --list` 校验语法。
- [ ] **Step 2: pr-checks 矩阵**：build-test matrix 增加 macos-x64 / windows-arm64 条目；Windows 构建步骤 `if: startsWith(matrix.platform,'windows')` 且命令用 `node scripts/build-with-builder.js auto ${{ matrix.build_args }}`（env 用 `${{ matrix.arch }}`）；加 MSVC ARM64 步骤（照抄 `_build-reusable.yml` 的 choco 命令）；`timeout-minutes: 45→60`。
- [ ] **Step 3: YAML 校验**：`ruby -ryaml -e "YAML.load_file('.github/workflows/pr-checks.yml')"` 等。
- [ ] **Step 4: 本地静态验证**（e2e 文件 tsc 通过）。
- [ ] **Step 5: 提交**：`git commit -m "ci: OOB CLI 降非阻断，pr-checks 扩四平台构建测试"`

---

### Task 7: 集成验证与全量回归

**Files:** 无新增（若发现问题回到对应任务修）。

- [ ] **Step 1**: `bunx tsc --noEmit` → 0 错误
- [ ] **Step 2**: `bun run lint -- --quiet` → 0 errors
- [ ] **Step 3**: `bun run format:check` → 通过
- [ ] **Step 4**: `bun run i18n:types && node scripts/check-i18n.js` → 通过
- [ ] **Step 5**: `bun run test` → 全绿（记录新增用例数）
- [ ] **Step 6**: `bash -n` 所有改动的 shell 脚本 + `bash scripts/check-version-consistency.sh ../poundingcore`
- [ ] **Step 7**: `git status` 确认无意外文件；最终提交 `chore: 全量回归通过`
- [ ] **Step 8**: 推分支、开 PR（pr-checks 四平台构建测试全绿后合 main）

## 发布（PR 合并后，非本计划任务）

1. 手动 `Build and Release`（main）→ 四平台 OOB（应用+MCP）绿 → Create Release v2.1.42（poundingcoreVersion v0.1.52 不变）。
2. `cos-mirror.yml` 同步 latest/。
