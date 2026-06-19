#!/usr/bin/env bash
# scripts/check-branding.sh
#
# Verify POUNDING branding is preserved across all key files.
# Run this before pushing or as part of CI.
#
# Exit 0 = all checks pass, Exit 1 = branding violations found.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
ERRORS=()

check() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  local context="${4:-}"

  if [ ! -f "$file" ]; then
    echo -e "${RED}FAIL${NC} $label: file not found — $file"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: file not found: $file")
    return
  fi

  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "${GREEN}PASS${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $label — expected pattern not found in $file"
    if [ -n "$context" ]; then
      echo -e "  ${YELLOW}context: $context${NC}"
    fi
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: pattern '$pattern' not found in $file")
  fi
}

check_not() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  local context="${4:-}"

  if [ ! -f "$file" ]; then
    echo -e "${RED}FAIL${NC} $label: file not found — $file"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: file not found: $file")
    return
  fi

  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "${RED}FAIL${NC} $label — forbidden pattern found in $file"
    grep -n "$pattern" "$file" | while read -r line; do
      echo -e "  ${YELLOW}$line${NC}"
    done
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: forbidden pattern '$pattern' found in $file")
  else
    echo -e "${GREEN}PASS${NC} $label"
    PASS=$((PASS + 1))
  fi
}

check_exists() {
  local label="$1"
  local path="$2"

  if [ -e "$path" ]; then
    echo -e "${GREEN}PASS${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $label: not found — $path"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: not found: $path")
  fi
}

echo "=== POUNDING Branding Check ==="
echo ""

# ---- App Identity ----
check "electron-builder: productName"           'productName:[[:space:]]*POUNDING'     "$ROOT/packages/desktop/electron-builder.yml"
check "electron-builder: appId"                  'appId:[[:space:]]*com\.pounding\.app'  "$ROOT/packages/desktop/electron-builder.yml"
check "electron-builder: detectUpdateChannel"    'detectUpdateChannel:[[:space:]]*false' "$ROOT/packages/desktop/electron-builder.yml"
check "electron-builder: owner halojerry"        'owner:[[:space:]]*halojerry'           "$ROOT/packages/desktop/electron-builder.yml"

# ---- Locale Branding ----
for locale_file in "$ROOT/packages/desktop/src/renderer/services/i18n/locales/"*/login.json; do
  lang=$(basename "$(dirname "$locale_file")")
  check_not "login.json ($lang): brand not AionUi" '"brand":[[:space:]]*"AionUi"' "$locale_file" "should be POUNDING"
done

for locale_file in "$ROOT/packages/desktop/src/renderer/services/i18n/locales/"*/common.json; do
  lang=$(basename "$(dirname "$locale_file")")
  check_not "common.json ($lang): tray not AionUi"  'AionUi' "$locale_file" "tray texts should say POUNDING"
done

# ---- UI Logo ----
check_exists "PoundingInteractiveLogo.tsx exists" "$ROOT/packages/desktop/src/renderer/components/layout/PoundingInteractiveLogo.tsx"

# ---- NSIS Installer ----
for nsh in "$ROOT/resources/"windows-installer-*.nsh; do
  if [ -f "$nsh" ]; then
    check "NSIS: $(basename "$nsh") halojerry" 'halojerry/AionUi/releases' "$nsh"
  fi
done

# ---- No iOfficeAI references ----
IOFFICE_FILES=$(grep -rl "iOfficeAI" "$ROOT/packages/desktop/src/" --include="*.ts" --include="*.tsx" 2>/dev/null || true)
if [ -z "$IOFFICE_FILES" ]; then
  echo -e "${GREEN}PASS${NC} no iOfficeAI references in source"
  PASS=$((PASS + 1))
else
  echo -e "${RED}FAIL${NC} iOfficeAI references found:"
  echo "$IOFFICE_FILES" | while read -r f; do echo -e "  ${YELLOW}$f${NC}"; done
  FAIL=$((FAIL + 1))
  ERRORS+=("iOfficeAI references found in source")
fi

# ---- COS Auto-Update ----
check "electron-builder: COS publish"  'pounding/releases' "$ROOT/packages/desktop/electron-builder.yml"
check "build-and-release: COS path"    'pounding/releases' "$ROOT/.github/workflows/build-and-release.yml"

# ---- install-web.sh ----
check "install-web.sh: pounding prefix" 'pounding/releases' "$ROOT/scripts/install-web.sh"
check "install-web.sh: halojerry repo"  'halojerry'         "$ROOT/scripts/install-web.sh"

# ---- Dealer Kit ----
check "pack-usb-zip.sh: dealer-kit" '"aff":' "$ROOT/scripts/pack-usb-zip.sh"

# ---- Portable Mode ----
check "configureChromium.ts: PORTABLE" 'PORTABLE' "$ROOT/packages/desktop/src/process/utils/configureChromium.ts"

# ---- Sentry ----
check "sentry.ts: POUNDING brand" "brand.*'POUNDING'" "$ROOT/packages/desktop/src/common/config/sentry.ts"
# Verify Sentry DSN is injected at build time (not just runtime process.env).
# Without this, CI secrets never reach the packaged app and Sentry is silently broken.
check "electron.vite.config: SENTRY_DSN injected" "process.env.SENTRY_DSN.*JSON.stringify" "$ROOT/packages/desktop/electron.vite.config.ts"
check "electron.vite.config: POUNDING_SENTRY_DSN injected" "process.env.POUNDING_SENTRY_DSN.*JSON.stringify" "$ROOT/packages/desktop/electron.vite.config.ts"
check "electron.vite.config: SENTRY_ENVIRONMENT injected" "process.env.POUNDING_SENTRY_ENVIRONMENT.*JSON.stringify" "$ROOT/packages/desktop/electron.vite.config.ts"

# ---- Build Scripts ----
check_not "afterPack.js: no AionUi.exe"   'AionUi\.exe'   "$ROOT/scripts/afterPack.js"
check_not "build-with-builder.js: no AionUi" 'AionUi\.exe' "$ROOT/scripts/build-with-builder.js"

# ---- CLI Mirrors ----
check "managedCliInstallerBridge.ts: npmmirror"  'npmmirror'  "$ROOT/packages/desktop/src/process/bridge/managedCliInstallerBridge.ts"
check "managedCliInstallerBridge.ts: tsinghua"   'tsinghua'   "$ROOT/packages/desktop/src/process/bridge/managedCliInstallerBridge.ts"

# ---- Managed-Resources Branding ----
echo ""
echo "==> Checking managed-resources branding..."
if grep -rq "AionUi" resources/bundled-poundingcore/*/managed-resources/ 2>/dev/null; then
  echo -e "${RED}FAIL${NC} Found 'AionUi' in managed-resources bundle"
  FAIL=$((FAIL + 1))
  ERRORS+=("Found 'AionUi' in managed-resources bundle")
else
  echo -e "${GREEN}PASS${NC} managed-resources branding: OK"
  PASS=$((PASS + 1))
fi

# ── Locale: preview.json (all 9 locales) ──
echo ""
echo "==> Checking locale preview.json files..."
for locale in en-US ja-JP ko-KR pt-BR ru-RU tr-TR uk-UA zh-CN zh-TW; do
  check_not "locales/${locale}/preview.json contains AionUi" \
    '"AionUi"' \
    "$ROOT/packages/desktop/src/renderer/services/i18n/locales/${locale}/preview.json" \
    "    locales/${locale}/preview.json has AionUi branding residue"
done

# ── Locale: pt-BR files with known AionUi residue ──
echo ""
echo "==> Checking pt-BR locale files for AionUi residue..."
for f in cron.json conversation.json settings.json; do
  check_not "locales/pt-BR/${f} contains AionUi" \
    '"AionUi"' \
    "$ROOT/packages/desktop/src/renderer/services/i18n/locales/pt-BR/${f}" \
    "    locales/pt-BR/${f} has AionUi branding residue"
done

# ── All locale JSON files (global scan) ──
echo ""
echo "==> Checking all locale JSON files for AionUi..."
LOCALE_AIONUI=$(grep -rl '"AionUi"' "$ROOT/packages/desktop/src/renderer/services/i18n/locales/" --include="*.json" 2>/dev/null || true)
if [ -z "$LOCALE_AIONUI" ]; then
  echo -e "${GREEN}PASS${NC} no AionUi in locale JSON files"
  PASS=$((PASS + 1))
else
  echo -e "${RED}FAIL${NC} locale JSON files have AionUi branding residue:"
  echo "$LOCALE_AIONUI" | while read -r f; do echo -e "  ${YELLOW}$f${NC}"; done
  FAIL=$((FAIL + 1))
  ERRORS+=("locale JSON files have AionUi branding residue")
fi

# ── Scripts: packaged-launch.mjs ──
echo ""
echo "==> Checking scripts/packaged-launch.mjs..."
check_not "packaged-launch.mjs AionUi.exe" \
  'AionUi\.exe' \
  "$ROOT/scripts/packaged-launch.mjs" \
  "    packaged-launch.mjs has AionUi.exe"
check_not "packaged-launch.mjs AionUi binary" \
  "'AionUi'" \
  "$ROOT/scripts/packaged-launch.mjs" \
  "    packaged-launch.mjs has 'AionUi'"
check_not "packaged-launch.mjs aionui lower" \
  "'aionui'" \
  "$ROOT/scripts/packaged-launch.mjs" \
  "    packaged-launch.mjs has 'aionui'"
check_not "packaged-launch.mjs AIONUI_EXTENSIONS" \
  'AIONUI_EXTENSIONS_PATH' \
  "$ROOT/scripts/packaged-launch.mjs" \
  "    packaged-launch.mjs has AIONUI_EXTENSIONS_PATH"

# ── Scripts: dev-bootstrap.mjs ──
echo ""
echo "==> Checking scripts/dev-bootstrap.mjs..."
check_not "dev-bootstrap.mjs aionui" \
  "'aionui'" \
  "$ROOT/scripts/dev-bootstrap.mjs" \
  "    dev-bootstrap.mjs has 'aionui'"
check_not "dev-bootstrap.mjs AionUi" \
  "'AionUi'" \
  "$ROOT/scripts/dev-bootstrap.mjs" \
  "    dev-bootstrap.mjs has 'AionUi'"

# ── Scripts: pack-web-cli.js ──
echo ""
echo "==> Checking scripts/pack-web-cli.js..."
check_not "pack-web-cli.js aionui-web" \
  'aionui-web' \
  "$ROOT/scripts/pack-web-cli.js" \
  "    pack-web-cli.js has aionui-web"

# ── Scripts: install-web.sh ──
echo ""
echo "==> Checking scripts/install-web.sh..."
check_not "install-web.sh aionui-web" \
  'aionui-web' \
  "$ROOT/scripts/install-web.sh" \
  "    install-web.sh has aionui-web"
check_not "install-web.sh AionUi-2.0.2" \
  'AionUi-2\.0\.2' \
  "$ROOT/scripts/install-web.sh" \
  "    install-web.sh has old AionUi-2.0.2 version reference"

# ── Tests directory ──
echo ""
echo "==> Checking tests/ for iOfficeAI references..."
TESTS_IOFFICE=$(grep -rl 'iOfficeAI' "$ROOT/tests/" --include="*.ts" --include="*.tsx" 2>/dev/null || true)
if [ -z "$TESTS_IOFFICE" ]; then
  echo -e "${GREEN}PASS${NC} no iOfficeAI references in tests"
  PASS=$((PASS + 1))
else
  echo -e "${RED}FAIL${NC} test files have iOfficeAI references:"
  echo "$TESTS_IOFFICE" | while read -r f; do echo -e "  ${YELLOW}$f${NC}"; done
  FAIL=$((FAIL + 1))
  ERRORS+=("test files have iOfficeAI references")
fi

# ── Scripts: global aionui scan for remaining files ──
echo ""
echo "==> Checking scripts/ for AionUi in bin/log paths..."
SCRIPTS_AIONUI_FIX=$(grep -rl '\.aionui-fix' "$ROOT/scripts/" --include="*.sh" --include="*.js" --include="*.mjs" 2>/dev/null | grep -v 'check-branding.sh' || true)
if [ -z "$SCRIPTS_AIONUI_FIX" ]; then
  echo -e "${GREEN}PASS${NC} no .aionui-fix paths in scripts"
  PASS=$((PASS + 1))
else
  echo -e "${RED}FAIL${NC} scripts have .aionui-fix paths:"
  echo "$SCRIPTS_AIONUI_FIX" | while read -r f; do echo -e "  ${YELLOW}$f${NC}"; done
  FAIL=$((FAIL + 1))
  ERRORS+=("scripts have .aionui-fix paths")
fi

SCRIPTS_AIONUI_DEV=$(grep -rl 'AionUi-Dev' "$ROOT/scripts/" --include="*.ts" --include="*.mjs" 2>/dev/null || true)
if [ -z "$SCRIPTS_AIONUI_DEV" ]; then
  echo -e "${GREEN}PASS${NC} no AionUi-Dev log paths in scripts"
  PASS=$((PASS + 1))
else
  echo -e "${RED}FAIL${NC} scripts have AionUi-Dev log paths:"
  echo "$SCRIPTS_AIONUI_DEV" | while read -r f; do echo -e "  ${YELLOW}$f${NC}"; done
  FAIL=$((FAIL + 1))
  ERRORS+=("scripts have AionUi-Dev log paths")
fi

# ── GitHub workflows ──
echo ""
echo "==> Checking GitHub workflows for branding..."
WF_IOFFICE=$(grep -rl "org: 'iOfficeAI'" "$ROOT/.github/workflows/" --include="*.yml" 2>/dev/null || true)
if [ -z "$WF_IOFFICE" ]; then
  echo -e "${GREEN}PASS${NC} no iOfficeAI project org in workflows"
  PASS=$((PASS + 1))
else
  echo -e "${RED}FAIL${NC} CI workflow has iOfficeAI project org reference:"
  echo "$WF_IOFFICE" | while read -r f; do echo -e "  ${YELLOW}$f${NC}"; done
  FAIL=$((FAIL + 1))
  ERRORS+=("CI workflow has iOfficeAI project org reference")
fi

check_not "bump-homebrew.yml has aionui cask" \
  'aionui' \
  "$ROOT/.github/workflows/bump-homebrew.yml" \
  "    bump-homebrew.yml has aionui cask name"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo -e "${RED}Branding violations found:${NC}"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}•${NC} $err"
  done
  exit 1
fi

echo -e "${GREEN}All branding checks passed.${NC}"
