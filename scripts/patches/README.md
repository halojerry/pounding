# POUNDING Patchset

## Architecture

```
Upstream v2.1.34 (clean)
    │
    ├─ Step 1: bash scripts/apply-branding.sh     (Patch 001 — auto)
    ├─ Step 2: git apply 002-pound-channels.patch (Patch 002 — channels)
    └─ Step 3: git apply 003-pound-login.patch    (Patch 003 — login)
```

## Patch 001: Branding (auto-maintained)

**This is NOT a `.patch` file.** Run:

```bash
bash scripts/apply-branding.sh
```

Covers ~90 files: locale JSONs, CSS, icons (binary), binary name, log prefix, electron-builder identity fields.

## Patch 002: Distribution Channels

`002-pound-channels.patch` — ~19 files.

- Feishu wiki documentation links
- COS (Tencent Cloud) update infrastructure
- mxou.cn API URLs
- Sentry DSN → POUNDING project
- Dealer invite codes (CI injection → dealer-config.json)
- USB portable update (COS-based)
- Feature hiding (pet in production)

## Patch 003: NewApi Desktop Login

`003-pound-login.patch` — ~58 files.

POUNDING-unique desktop login → auto CLI install → model config chain.

## Known Gap: 7 Shared Files

These 7 files are modified by BOTH branding (001) and logic patches (002/003).
Their context lines differ between clean v2.1.34+script and the v5 branch.
They need MANUAL verification during each sync:

| File                    | Owned By                 | Risk     |
| ----------------------- | ------------------------ | -------- |
| `autoUpdaterService.ts` | 002 (COS update)         | MEDIUM   |
| `AboutModalContent.tsx` | 002 (Feishu URLs)        | LOW      |
| `sentry.ts`             | 002 (Sentry DSN)         | LOW      |
| `ipcBridge.ts`          | 003 (NewApi channels)    | **HIGH** |
| `index.ts`              | 003 (CodexProxy startup) | **HIGH** |
| `webuiConfig.ts`        | 003 (reconcile config)   | MEDIUM   |
| `backend-launcher.ts`   | 003 (listening prefix)   | MEDIUM   |

## Standard Upstream Sync Workflow

```bash
# 1. Start from upstream tag
git checkout v2.1.XX
git checkout -b feature/upstream-sync-v2.1.XX-v1

# 2. Copy POUNDING scripts + patches into the branch
# (these don't exist in upstream)

# 3. Apply branding
bash scripts/apply-branding.sh
git add -A && git commit -m "chore: apply POUNDING branding"

# 4. Apply channel + login patches
git apply --3way scripts/patches/002-pound-channels.patch
# ↑ may need manual fix for the 3 shared files in Known Gap
git add -A && git commit -m "chore: apply POUNDING distribution channels"

git apply --3way scripts/patches/003-pound-login.patch
# ↑ may need manual fix for the 4 shared files in Known Gap
git add -A && git commit -m "feat: apply POUNDING NewApi login system"

# 5. Copy binary assets (not in patches)
cp <pounding-repo>/packages/desktop/src/renderer/assets/logos/brand/*.png \
   packages/desktop/src/renderer/assets/logos/brand/

# 6. Verify
bunx tsc --noEmit
bash scripts/check-branding.sh
bun run test
```

## Binary Assets

These must be copied from the POUNDING repo (binary diffs excluded from patches):

```
packages/desktop/src/renderer/assets/logos/brand/pounding-heart-solid.png
packages/desktop/src/renderer/assets/logos/brand/pounding-nose-dot.png
packages/desktop/src/renderer/assets/logos/brand/eyes-component-transparent.png
resources/app.icns
resources/app.ico
resources/app.png
resources/app_dev.png
public/pwa/icon-180.png
public/pwa/icon-192.png
public/pwa/icon-512.png
```

## Patch Maintenance

When POUNDING adds/modifies features:

1. **Branding**: update `apply-branding.sh` + `001-files.txt`
2. **Channels**: modify code → regenerate: `git diff v2.1.34 -- $(cat 002-files.txt) > 002-pound-channels.patch`
3. **Login**: modify code → regenerate: `git diff v2.1.34 -- $(cat 003-files.txt) > 003-pound-login.patch`
