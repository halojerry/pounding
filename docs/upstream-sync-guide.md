# POUNDING 追上游方法论

## 核心原则

1. **逐版本 cherry-pick** — 不能跳跃版本，不能 squash merge
2. **POUNDING 代码为基准** — 上游改动选择性合并，品牌永远优先
3. **跟随上游逻辑** — 上游有更好方案时，POUNDING 去适配上游
4. **三类保护** — 品牌化、经销商邀请码、USB 便携更新不可覆盖

## 准备工作

### 1. 确保完整历史

```bash
git fetch --unshallow origin   # 修复 shallow clone
git fetch upstream             # 获取上游最新
git tag -l 'v*' | sort -V      # 确认 tag 完整
```

### 2. 找到 fork 点

```bash
# POUNDING fork 于 upstream v2.1.12
git merge-base origin/main v2.1.12
# 应返回: 2dbf20e65 (v2.1.12 tag)
```

### 3. 创建同步分支

```bash
git checkout origin/main
git checkout -b feature/upstream-sync-vX.Y.Z-vN
```

## 同步策略

### 自动合并（优先尝试）

```bash
git merge v2.1.XX -X theirs --no-commit
```

如果 merge-base 存在（共享历史），这是最可靠的方式。

### 降级方案（merge 失败时）

```bash
git diff v2.1.XX..v2.1.YY -- . ':!binary-files/*' > /tmp/upstream.patch
git apply --3way /tmp/upstream.patch
```

## 冲突解决规则

### 按文件类型

| 文件类型 | 策略 |
|---------|------|
| `locales/*/common.json`, `login.json` | POUNDING 品牌永远优先 |
| `backend-launcher.ts`, `backendStartupFailure.ts` | 取上游，改 `aioncore→poundingcore` |
| `electron-builder.yml` | POUNDING productName/appId/COS |
| `package.json`, `CHANGELOG.md` | POUNDING 版本体系 |
| 上游新文件 (ADD/ADD) | 取上游 |
| POUNDING 独有文件 (MODIFY/DELETE) | 保留 POUNDING |

### 品牌字符串速查

| 上游值 | POUNDING 值 |
|--------|------------|
| `AionUi` | `POUNDING` |
| `aionui` | `pounding` |
| `AionCore` / `aioncore` | `poundingcore` |
| `com.aionui.app` | `com.pounding.app` |
| `AIONCORE_LISTENING` | `POUNDINGCORE_LISTENING` |
| `.aionui-modal-*` | `.pounding-modal-*` |

## TypeScript 修复顺序

1. 恢复 POUNDING config keys（configKeys.ts + storage.ts + configMigration.ts）
2. 恢复 POUNDING types（newApiAccount.ts, managedCliInstaller.ts 等）
3. 修复 ipcBridge.ts（添加 POUNDING 方法 + 更新 team emitter 名称）
4. 修复 POUNDING 组件中的类型引用
5. 删除过时的 POUNDING stub 文件

## 验证

### 三级检查体系

| 层级 | 触发条件 | 检查内容 |
|------|---------|---------|
| L1 | 关键版本 (v2.1.18, v2.1.31, v2.1.34) | tsc + branding + test + 冒烟 |
| L2 | 大功能版本 | tsc + branding |
| L3 | 所有版本 | tsc only |

### 冒烟清单

- [ ] 登录页 PoundingInteractiveLogo
- [ ] Dock 图标 POUNDING
- [ ] 侧边栏 NewApi 客户端登录
- [ ] 模型选择器两级菜单
- [ ] 发送框 Send Draft Box
- [ ] Team 页队友管理
- [ ] 经销商邀请码注入正常
- [ ] 法语 locale 可选
- [ ] 日志前缀 `[POUNDING]` / `[poundingcore]`
