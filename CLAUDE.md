@AGENTS.md

# POUNDING Upstream Sync — Patchset 体系

## 核心原则

**POUNDING = 上游 v2.1.34 + 3 类独立改动。** 品牌化由脚本自动维护，渠道和登录系统由 `.patch` 文件管理。三类改动互不依赖，各自独立应用。

## POUNDING 改动分类

```
POUNDING vs 上游差异
├── 类别 A: 品牌化 (~90 files)
│   纯文本替换，apply-branding.sh 自动处理
│   locale JSON × 13 语言 + CSS + 图标 + binary name + log prefix
│
├── 类别 B: 发行渠道 (~19 files)
│   飞书文档链接 + COS 更新 + mxou.cn API + Sentry DSN + 经销商码 + USB 便携 + 功能隐藏
│
└── 类别 C: NewApi 桌面登录 + 自动模型配置 (~58 files)
   POUNDING 独有的完整登录链条。上游桌面客户端无登录系统。
   登录 → CLI 安装 → 模型配置 → reconcileModel
```

## Patch 文件

```
scripts/patches/
├── README.md                   # 完整说明 + 工作流程
├── 001-files.txt               # 品牌化文件清单 (apply-branding.sh 自动维护)
├── 002-files.txt               # 发行渠道文件清单
├── 002-pound-channels.patch    # 发行渠道 diff
├── 003-files.txt               # NewApi 登录文件清单
└── 003-pound-login.patch       # NewApi 登录 diff
```

### 为什么是 3 类而不是 13 个 patch？

多个 patch 之间会产生人造依赖——共享文件（如 `ipcBridge.ts`）被多个 patch 修改时，`git am` 按序应用会导致后续 patch 冲突。解决方法：共享文件归到"最重"的类别，整个文件一次性 diff。

### 共享文件归属

| 共享文件 | 归属 | 原因 |
|----------|------|------|
| `ipcBridge.ts` | 类别 C | NewApi 通道是主要改动 |
| `SiderFooter.tsx` | 类别 C | 登录/余额 UI 是大头 |
| `configKeys.ts` | 类别 C | NewApi 密钥占多数 |
| `storage.ts` | 类别 C | NewApi 存储类型占多数 |
| `index.ts` | 类别 C | CodexProxy + PATH 启动逻辑 |

### 已知限制：7 个共享文件需手动验证

这 7 个文件同时被品牌化（001）和逻辑 patch（002/003）修改，`git apply --3way` 有时需要手动解决：

| 文件 | 归属 | 风险 |
|------|------|------|
| `autoUpdaterService.ts` | 002 | MEDIUM |
| `AboutModalContent.tsx` | 002 | LOW |
| `sentry.ts` | 002 | LOW |
| `ipcBridge.ts` | 003 | **HIGH** |
| `index.ts` | 003 | **HIGH** |
| `webuiConfig.ts` | 003 | MEDIUM |
| `backend-launcher.ts` | 003 | MEDIUM |

### 高危 drift：main.tsx 的 NewApiAccountProvider（已丢过两次！）

`-X theirs` merge 会覆盖 `main.tsx` 的 AppProviders 链，剥掉 `NewApiAccountProvider`。
症状：**app 白屏 + console 报 `useNewApiAccount must be used within a NewApiAccountProvider`**（Layout.tsx 调用处崩溃）。
单元测试**不能**发现这个问题（测试 mock 了 context）——必须真机冒烟。
修复：在 `AppProviders` 里 `AuthProvider` 之下插入 `NewApiAccountProvider`（见 `003-pound-login.patch` 的 main.tsx 部分）。

## 追上游流程

### 标准流程（小版本更新，如 v2.1.34 → v2.1.35）

```bash
# 1. 从上游 tag 创建干净分支
git checkout v2.1.35
git checkout -b feature/upstream-sync-v2.1.35-v1

# 2. 复制 POUNDING scripts/ + patches/ 到新分支（上游没有这些文件）

# 3. 应用品牌化
bash scripts/apply-branding.sh
git add -A && git commit -m "chore: apply POUNDING branding"

# 4. 应用发行渠道（可能需手动解决 3 个共享文件）
git apply --3way scripts/patches/002-pound-channels.patch
git add -A && git commit -m "chore: apply POUNDING distribution channels"

# 5. 应用 NewApi 登录（可能需手动解决 4 个共享文件）
git apply --3way scripts/patches/003-pound-login.patch
git add -A && git commit -m "feat: apply POUNDING NewApi login system"

# 6. 验证
bunx tsc --noEmit
bash scripts/check-branding.sh
bun run test
bash dev.sh
```

### 大版本更新（v2.x → v3.0）

```bash
# 放弃旧 patchset，从零开始
# 在上游 v3.0 tag 上重新实现 POUNDING 功能
# 从新代码重新生成 patch 文件
```

### 降级方案（patch 全面冲突时）

```bash
git merge v2.1.35 -X theirs --no-commit
# 解决冲突 → 从结果重新生成 patchset
```

## 如何新增 POUNDING 功能

改代码前先问：**这个改动属于哪个类别？**

```
A (品牌化) → 更新 apply-branding.sh + 001-files.txt
B (渠道)   → 改代码 + 重新生成: git diff v2.1.34 -- $(cat 002-files.txt) > 002-pound-channels.patch
C (登录)   → 改代码 + 重新生成: git diff v2.1.34 -- $(cat 003-files.txt) > 003-pound-login.patch
新类别     → 创建 004-files.txt + 004-xxx.patch
```

## 版本记录

| 上游版本 | POUNDING 分支 | 方法 | 结果 |
|---------|--------------|------|------|
| v2.1.34 | feature/upstream-sync-v2.1.34-v5 | `git merge v2.1.34 -X theirs` | 0 tsc errors, 274/294 tests, 19 pending |
| v2.1.31 | feature/upstream-sync-v2.1.31 | squash merge (已废弃) | — |
| v2.1.12 | origin/main | fork 点 | — |
