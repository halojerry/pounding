#!/usr/bin/env bash
# scripts/apply-branding.sh
#
# One-click POUNDING branding restore for AionUi.
# Run after upstream sync to re-apply all POUNDING branding.
#
# Categories:
#   1. Text replacements (AionUi→POUNDING, aionui→pounding, AionCore→poundingcore)
#   2. Feature file existence checks
#   3. Config value verification (delegates to check-branding.sh)
#
# Usage:
#   bash scripts/apply-branding.sh          # apply all branding
#   bash scripts/apply-branding.sh --check  # dry-run, report what would change

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="apply"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--dry-run) MODE="check"; shift ;;
    --help|-h) echo "Usage: bash scripts/apply-branding.sh [--check]"; exit 0 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

COUNT=0

# ----------------------------------------------------------------
# Helper: replace pattern in a single file
# ----------------------------------------------------------------
replace() {
  local file="$1" pattern="$2" replacement="$3" label="$4"
  if [ ! -f "$file" ]; then
    echo -e "  ${RED}SKIP${NC} $label: not found"
    return 0
  fi
  if [ "$MODE" = "check" ]; then
    if grep -q "$replacement" "$file" 2>/dev/null; then
      echo -e "  ${GREEN}OK${NC}   $label"
    elif grep -q "$pattern" "$file" 2>/dev/null; then
      echo -e "  ${YELLOW}FIX${NC}  $label"
    else
      echo -e "  ${BLUE}N/A${NC}  $label"
    fi
  else
    if grep -q "$pattern" "$file" 2>/dev/null; then
      sed -i '' "s|$pattern|$replacement|g" "$file"
      echo -e "  ${GREEN}DONE${NC} $label"
      COUNT=$((COUNT + 1))
    else
      echo -e "  ${BLUE}N/A${NC}  $label"
    fi
  fi
}

# Helper: replace pattern across directory of source files
replace_in_dir() {
  local dir="$1" pattern="$2" replacement="$3" label="$4"
  if [ ! -d "$dir" ]; then echo -e "  ${RED}SKIP${NC} $label: $dir"; return 1; fi
  if [ "$MODE" = "check" ]; then
    if grep -rq "$pattern" "$dir" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" --include="*.html" --include="*.js" 2>/dev/null; then
      echo -e "  ${YELLOW}FIX${NC}  $label"
    else
      echo -e "  ${GREEN}OK${NC}   $label"
    fi
  else
    local files
    files=$(grep -rl "$pattern" "$dir" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" --include="*.html" --include="*.js" 2>/dev/null || true)
    if [ -n "$files" ]; then
      echo "$files" | while IFS= read -r f; do sed -i '' "s|$pattern|$replacement|g" "$f"; done
      echo -e "  ${GREEN}DONE${NC} $label"
      COUNT=$((COUNT + 1))
    else
      echo -e "  ${BLUE}N/A${NC}  $label"
    fi
  fi
}

file_exists() {
  if [ -e "$1" ]; then echo -e "  ${GREEN}OK${NC}   $2"; else echo -e "  ${RED}MISS${NC} $2: $1"; fi
}

# ----------------------------------------------------------------
# Category 1: Text Replacements
# ----------------------------------------------------------------
apply_text_replacements() {
  echo ""
  echo -e "${BLUE}== Category 1: Text Replacements ==${NC}"

  local EB="$ROOT/packages/desktop/electron-builder.yml"
  local SRC="$ROOT/packages/desktop/src"

  # --- electron-builder.yml ---
  replace "$EB" 'productName:[[:space:]]*AionUi'    'productName: POUNDING'     "productName"
  replace "$EB" 'appId:[[:space:]]*com\.aionui\.app' 'appId: com.pounding.app'   "appId"
  replace "$EB" 'executableName:[[:space:]]*AionUi'  'executableName: POUNDING'  "executableName"
  replace "$EB" 'Copyright.*AionUi'                  'Copyright © 2024 POUNDING' "copyright"
  replace "$EB" 'AionUi Protocol'                   'POUNDING Protocol'         "protocol name"
  replace "$EB" '\- aionui$'                        '- pounding'                "protocol scheme"
  replace "$EB" 'owner:[[:space:]]*iOfficeAI'        'owner: halojerry'          "owner"
  replace "$EB" 'aionui/releases'                   'pounding/releases'         "COS path"

  # --- package.json ---
  local PJ="$ROOT/packages/desktop/package.json"
  replace "$PJ" '"name":[[:space:]]*"aionui"'       '"name": "pounding"'        "package name"
  replace "$PJ" '"productName":[[:space:]]*"AionUi"' '"productName": "POUNDING"' "productName"

  # --- sentry.ts ---
  replace "$SRC/sentry.ts" "brand.*'AionUi'"        "brand: 'POUNDING'"         "sentry brand"
  replace "$SRC/sentry.ts" 'aionui\.failure'          'pounding.failure'          "sentry tag"

  # --- electron.vite.config.ts ---
  replace "$ROOT/packages/desktop/electron.vite.config.ts" \
    "AIONUI_SENTRY_DSN" "POUNDING_SENTRY_DSN" "SENTRY_DSN env"

  # --- tray.ts ---
  replace "$SRC/process/utils/tray.ts" "setToolTip('AionUi')" "setToolTip('POUNDING')" "tray tooltip"

  # --- deepLink.ts ---
  replace "$SRC/process/utils/deepLink.ts" "'aionui'" "'pounding'" "deepLink scheme"

  # --- binaryResolver.ts ---
  replace "$SRC/process/backend/binaryResolver.ts" "'aioncore'"    "'poundingcore'"    "binary name"
  replace "$SRC/process/backend/binaryResolver.ts" "bundled-aioncore" "bundled-poundingcore" "bundled dir"

  # --- constants.ts ---
  replace "$SRC/common/config/constants.ts" "'_aionui_'" "'_pounding_'" "timestamp sep"
  replace "$SRC/common/config/constants.ts" 'AION_FILES' 'POUNDING_FILES' "files marker"

  # --- appEnv.ts ---
  replace "$SRC/common/config/appEnv.ts" "'.aionui'" "'.pounding'" "config dir"

  # --- AIONUI_* env vars → POUNDING_* ---
  replace_in_dir "$SRC" "AIONUI_MULTI_INSTANCE" "POUNDING_MULTI_INSTANCE" "env: AIONUI_MULTI_INSTANCE"
  replace_in_dir "$SRC" "AIONUI_E2E_TEST"       "POUNDING_E2E_TEST"       "env: AIONUI_E2E_TEST"
  replace_in_dir "$SRC" "AIONUI_PORT"            "POUNDING_PORT"            "env: AIONUI_PORT"
  replace_in_dir "$SRC" "AIONUI_ALLOW_REMOTE"   "POUNDING_ALLOW_REMOTE"   "env: AIONUI_ALLOW_REMOTE"
  replace_in_dir "$SRC" "AIONUI_REMOTE"          "POUNDING_REMOTE"          "env: AIONUI_REMOTE"
  replace_in_dir "$SRC" "AIONUI_HOST"            "POUNDING_HOST"            "env: AIONUI_HOST"
  replace_in_dir "$SRC" "AIONUI_FORCE_DEV_AUTO_UPDATE" "POUNDING_FORCE_DEV_AUTO_UPDATE" "env: FORCE_DEV"
  replace_in_dir "$SRC" "AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION" "POUNDING_DEBUG_AUTO_UPDATE_CURRENT_VERSION" "env: DEBUG_AUTO"
  replace_in_dir "$SRC" "AIONUI_DEBUG_BACKEND_STARTUP_FAILURE" "POUNDING_DEBUG_BACKEND_STARTUP_FAILURE" "env: BACKEND_STARTUP"

  # --- autoUpdaterService.ts ---
  replace "$SRC/process/services/autoUpdaterService.ts" "com\.aionui\.app" "com.pounding.app" "updater cache"

  # --- initStorage.ts ---
  local IS="$SRC/process/utils/initStorage.ts"
  replace "$IS" 'aionui-config'  'pounding-config'   "storage config"
  replace "$IS" 'aionui-chat'    'pounding-chat'     "storage chat"
  replace "$IS" '\.aionui-env'   '.pounding-env'      "storage env"

  # --- backend startup files ---
  replace "$SRC/process/startup/backendStartup.ts"       "failed to start aioncore" "failed to start poundingcore" "backend err"
  replace "$SRC/process/startup/backendStartupFailure.ts" "bundled-aioncore" "bundled-poundingcore" "backend failure dir"
  replace "$SRC/process/startup/backendStartupFailure.ts" "aioncore" "poundingcore" "backend failure name"

  # --- ipcBridge.ts ---
  replace "$SRC/common/adapter/ipcBridge.ts" "routed to aioncore" "routed to poundingcore" "ipcBridge comment"

  # --- webuiConfig.ts ---
  replace "$SRC/process/utils/webuiConfig.ts" "aioncore is not running" "poundingcore is not running" "webui err"

  # --- index.ts ---
  replace "$SRC/index.ts" "\[AionUi\]" "[AionUi]" "index log prefix" || true

  # --- public/manifest.webmanifest ---
  local PM="$ROOT/public/manifest.webmanifest"
  replace "$PM" '"name":[[:space:]]*"AionUi"'      '"name": "POUNDING"'      "PWA name"
  replace "$PM" '"short_name":[[:space:]]*"AionUi"' '"short_name": "POUNDING"' "PWA short"
  replace "$PM" "AionUi WebUI"                     "POUNDING WebUI"           "PWA desc"

  # --- readme.md / CICD_SETUP.md / CHANGELOG.md ---
  replace_in_dir "$ROOT" "AionUi" "POUNDING" "root md: AionUi→POUNDING"
  # Undo collateral damage: upstream GitHub URLs must keep the AionUi repo name
  # (iOfficeAI org has no POUNDING repo — those links would 404).
  replace_in_dir "$ROOT" "iOfficeAI/POUNDING" "iOfficeAI/AionUi" "restore upstream URLs"

  # --- iOfficeAI → halojerry ---
  replace_in_dir "$SRC" "iOfficeAI/AionUi"   "halojerry/pounding"   "URL: iOfficeAI/AionUi"
  replace_in_dir "$SRC" "iOfficeAI/AionCore" "halojerry/poundingcore" "URL: iOfficeAI/AionCore"

  # --- Locale files ---
  # Two-pass sed: quoted patterns match JSON values that ARE exactly the brand name;
  # unquoted patterns catch mid-sentence occurrences (e.g. "Afficher AionUi" in fr-FR).
  local LOCALE_DIR="$SRC/renderer/services/i18n/locales"
  if [ "$MODE" = "apply" ]; then
    while IFS= read -r -d '' f; do
      sed -i '' \
        -e 's|"AionUi"|"POUNDING"|g' \
        -e 's|"AionCore"|"poundingcore"|g' \
        -e 's|"aionui"|"pounding"|g' \
        -e 's|"aioncore"|"poundingcore"|g' \
        -e 's|AionUi|POUNDING|g' \
        -e 's|AionCore|poundingcore|g' \
        "$f" 2>/dev/null || true
    done < <(find "$LOCALE_DIR" -name "*.json" -print0)
    echo -e "  ${GREEN}DONE${NC} Locale files: AionUi/AionCore→POUNDING/poundingcore (quoted + inline)"
    COUNT=$((COUNT + 1))
  else
    if grep -rqE '"AionUi"|AionUi[^"]' "$LOCALE_DIR" --include="*.json" 2>/dev/null; then
      echo -e "  ${YELLOW}FIX${NC}  Locale files: AionUi references remain"
    else
      echo -e "  ${GREEN}OK${NC}   Locale files: clean"
    fi
  fi

  # --- NSIS installers ---
  for nsh in "$ROOT/resources/"windows-installer-*.nsh; do
    [ -f "$nsh" ] || continue
    replace "$nsh" "iOfficeAI" "halojerry"  "NSIS $(basename "$nsh"): iOfficeAI"
    replace "$nsh" '"AionUi"' '"POUNDING"'  "NSIS $(basename "$nsh"): name"
  done

  # --- COS / CI paths ---
  replace "$ROOT/.github/workflows/build-and-release.yml" 'aionui/releases' 'pounding/releases' "CI COS path"

  # --- install-web.sh ---
  local IW="$ROOT/scripts/install-web.sh"
  replace "$IW" 'aionui/releases' 'pounding/releases' "install-web COS"
  replace "$IW" 'iOfficeAI'       'halojerry'         "install-web repo"

  # --- Build scripts ---
  replace "$ROOT/scripts/afterPack.js"          'AionUi\.exe' 'POUNDING.exe' "afterPack exe"
  replace "$ROOT/scripts/build-with-builder.js" 'AionUi\.exe' 'POUNDING.exe' "build-with-builder exe"

  # --- Layout.tsx logo hint ---
  local LO="$SRC/renderer/components/layout/Layout.tsx"
  if [ "$MODE" = "apply" ]; then
    if ! grep -q "PoundingInteractiveLogo" "$LO" 2>/dev/null; then
      echo -e "  ${YELLOW}NOTE${NC} Layout.tsx: PoundingInteractiveLogo not imported (manual code change)"
    fi
  fi
}

# ----------------------------------------------------------------
# Category 2: Feature File Existence
# ----------------------------------------------------------------
check_feature_files() {
  echo ""
  echo -e "${BLUE}== Category 2: Feature File Existence ==${NC}"

  local BASE="$ROOT/packages/desktop/src"

  file_exists "$BASE/renderer/components/layout/PoundingInteractiveLogo.tsx" "PoundingInteractiveLogo.tsx"
  file_exists "$BASE/renderer/assets/logos/brand/pounding-heart-solid.png"   "pounding-heart-solid.png"
  file_exists "$BASE/renderer/assets/logos/brand/eyes-component-transparent.png" "eyes-component.png"
  file_exists "$BASE/renderer/assets/logos/brand/pounding-nose-dot.png"      "pounding-nose-dot.png"
  file_exists "$ROOT/resources/app.icns" "app.icns"
  file_exists "$ROOT/resources/app.ico"  "app.ico"
  file_exists "$ROOT/resources/app.png"  "app.png"
  file_exists "$BASE/process/services/CodexProxyManager.ts" "CodexProxyManager.ts"
  file_exists "$ROOT/codex-api-proxy.mjs"                   "codex-api-proxy.mjs"
  file_exists "$BASE/renderer/hooks/system/useDealerConfig.ts" "useDealerConfig.ts"
  file_exists "$ROOT/scripts/pack-usb-zip.sh"                  "pack-usb-zip.sh"
  file_exists "$BASE/process/utils/configureChromium.ts"       "configureChromium.ts"
  file_exists "$ROOT/resources/bundled-poundingcore"           "bundled-poundingcore/"
}

# ----------------------------------------------------------------
# Category 3: Config Value Verification
# ----------------------------------------------------------------
check_config_values() {
  echo ""
  echo -e "${BLUE}== Category 3: Config Verification (check-branding.sh) ==${NC}"
  if [ -f "$ROOT/scripts/check-branding.sh" ]; then
    echo ""
    bash "$ROOT/scripts/check-branding.sh"
  else
    echo -e "  ${RED}MISS${NC} scripts/check-branding.sh not found"
  fi
}

# ================================================================
# Main
# ================================================================
echo -e "=== POUNDING Branding: $( [ "$MODE" = "check" ] && echo "DRY-RUN" || echo "APPLY" ) ==="
apply_text_replacements
check_feature_files
check_config_values
echo ""
if [ "$MODE" = "check" ]; then
  echo -e "${BLUE}Dry-run complete. Run without --check to apply.${NC}"
elif [ "$COUNT" -gt 0 ]; then
  echo -e "${GREEN}Applied $COUNT branding replacements.${NC}"
else
  echo -e "${BLUE}Branding already applied — nothing to do.${NC}"
fi
