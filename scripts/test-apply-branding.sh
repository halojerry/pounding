#!/usr/bin/env bash
# scripts/test-apply-branding.sh
#
# Test that apply-branding.sh correctly restores POUNDING branding (Category 1 text replacements).
# Full Category 2 & 3 verification requires the complete repo — run check-branding.sh separately.
#
# Usage:
#   bash scripts/test-apply-branding.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR=$(mktemp -d /tmp/pounding-branding-test-XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Test: apply-branding.sh (AionUi) ===${NC}"
echo ""

# Step 1: Copy key branding files
echo "Step 1: Copying source files..."
mkdir -p "$TMPDIR/packages/desktop"
mkdir -p "$TMPDIR/packages/desktop/src/process/utils"
mkdir -p "$TMPDIR/packages/desktop/src/process/backend"
mkdir -p "$TMPDIR/packages/desktop/src/process/startup"
mkdir -p "$TMPDIR/packages/desktop/src/common/config"
mkdir -p "$TMPDIR/packages/desktop/src/common/adapter"
mkdir -p "$TMPDIR/packages/desktop/src/renderer/services/i18n/locales"
mkdir -p "$TMPDIR/resources"
mkdir -p "$TMPDIR/public"
mkdir -p "$TMPDIR/scripts"
mkdir -p "$TMPDIR/.github/workflows"

cp "$ROOT/packages/desktop/electron-builder.yml"        "$TMPDIR/packages/desktop/" 2>/dev/null || true
cp "$ROOT/packages/desktop/package.json"                 "$TMPDIR/packages/desktop/" 2>/dev/null || true
cp "$ROOT/packages/desktop/electron.vite.config.ts"      "$TMPDIR/packages/desktop/" 2>/dev/null || true
cp "$ROOT/packages/desktop/src/process/utils/tray.ts"    "$TMPDIR/packages/desktop/src/process/utils/" 2>/dev/null || true
cp "$ROOT/packages/desktop/src/process/utils/deepLink.ts" "$TMPDIR/packages/desktop/src/process/utils/" 2>/dev/null || true
cp "$ROOT/packages/desktop/src/process/backend/binaryResolver.ts" "$TMPDIR/packages/desktop/src/process/backend/" 2>/dev/null || true
cp "$ROOT/packages/desktop/src/process/startup/backendStartup.ts" "$TMPDIR/packages/desktop/src/process/startup/" 2>/dev/null || true
cp "$ROOT/packages/desktop/src/common/config/constants.ts" "$TMPDIR/packages/desktop/src/common/config/" 2>/dev/null || true
cp "$ROOT/packages/desktop/src/common/config/appEnv.ts"   "$TMPDIR/packages/desktop/src/common/config/" 2>/dev/null || true
cp "$ROOT/packages/desktop/src/common/adapter/ipcBridge.ts" "$TMPDIR/packages/desktop/src/common/adapter/" 2>/dev/null || true
cp "$ROOT/public/manifest.webmanifest"                     "$TMPDIR/public/" 2>/dev/null || true
cp "$ROOT/readme.md"                                       "$TMPDIR/" 2>/dev/null || true
cp "$ROOT/resources/windows-installer-x64.nsh"             "$TMPDIR/resources/" 2>/dev/null || true
cp "$ROOT/resources/windows-installer-arm64.nsh"           "$TMPDIR/resources/" 2>/dev/null || true
cp "$ROOT/scripts/install-web.sh"                          "$TMPDIR/scripts/" 2>/dev/null || true
cp "$ROOT/scripts/afterPack.js"                            "$TMPDIR/scripts/" 2>/dev/null || true
cp "$ROOT/scripts/build-with-builder.js"                   "$TMPDIR/scripts/" 2>/dev/null || true
cp "$ROOT/scripts/check-branding.sh"                       "$TMPDIR/scripts/" 2>/dev/null || true
cp -r "$ROOT/packages/desktop/src/renderer/services/i18n/locales" "$TMPDIR/packages/desktop/src/renderer/services/i18n/" 2>/dev/null || true
cp "$ROOT/.github/workflows/build-and-release.yml"         "$TMPDIR/.github/workflows/" 2>/dev/null || true

echo "  Files copied to $TMPDIR"

# Step 2: Revert to upstream branding
echo ""
echo "Step 2: Reverting to upstream branding..."
find "$TMPDIR" -type f \( -name "*.json" -o -name "*.ts" -o -name "*.tsx" -o -name "*.md" -o -name "*.js" -o -name "*.yml" -o -name "*.nsh" -o -name "*.webmanifest" \) | while IFS= read -r f; do
  sed -i '' \
    -e 's|POUNDING|AionUi|g' \
    -e 's|poundingcore|aioncore|g' \
    -e 's|pounding|aionui|g' \
    -e 's|halojerry|iOfficeAI|g' \
    "$f" 2>/dev/null || true
done

# Verify reversion on a key file
if grep -q 'productName:[[:space:]]*AionUi' "$TMPDIR/packages/desktop/electron-builder.yml" 2>/dev/null; then
  echo -e "  ${GREEN}OK${NC}   reverted electron-builder"
else
  echo -e "  ${RED}FAIL${NC} could not revert electron-builder"
  exit 1
fi

# Step 3: Run apply-branding.sh
echo ""
echo "Step 3: Running apply-branding.sh..."
cp "$ROOT/scripts/apply-branding.sh" "$TMPDIR/scripts/"
(cd "$TMPDIR" && bash "$TMPDIR/scripts/apply-branding.sh" 2>&1 | grep -E "DONE|N/A|FIX|MISS|NOTE|Results|PASS|FAIL|Branding|Applied|Dry-run") || true

# Step 4: Verify text replacements that matter
echo ""
echo "Step 4: Verifying key text replacements..."
FAILS=0

check_str() {
  local file="$1" pattern="$2" label="$3"
  if [ -f "$file" ] && grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} $label"
  else
    echo -e "  ${RED}FAIL${NC} $label"
    FAILS=$((FAILS + 1))
  fi
}

EB="$TMPDIR/packages/desktop/electron-builder.yml"
check_str "$EB" 'productName:[[:space:]]*POUNDING'    "productName → POUNDING"
check_str "$EB" 'appId:[[:space:]]*com\.pounding\.app' "appId → com.pounding.app"
check_str "$EB" 'executableName:[[:space:]]*POUNDING'  "executableName → POUNDING"
check_str "$EB" 'POUNDING Protocol'                    "protocol → POUNDING"
check_str "$EB" '\- pounding'                          "protocol scheme → pounding"

PM="$TMPDIR/public/manifest.webmanifest"
check_str "$PM" '"name": "POUNDING"'   "PWA name → POUNDING"
check_str "$PM" '"short_name": "POUNDING"' "PWA short → POUNDING"

# Locale check
LOCALE_TMP="$TMPDIR/packages/desktop/src/renderer/services/i18n/locales"
if grep -rq '"POUNDING"' "$LOCALE_TMP" --include="*.json" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${NC} locale files → POUNDING"
else
  echo -e "  ${RED}FAIL${NC} locale files"
  FAILS=$((FAILS + 1))
fi

# check-branding.sh on temp (optional, may fail on missing feature files)
echo ""
echo "Step 5: Running check-branding.sh (text checks only)..."
(cd "$TMPDIR" && bash "$TMPDIR/scripts/check-branding.sh" 2>&1 | tail -3) || true

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo -e "${GREEN}=== PASS: apply-branding.sh correctly restored Category 1 branding ===${NC}"
  echo -e "${BLUE}(Category 2 & 3 require full repo — run check-branding.sh directly)${NC}"
else
  echo -e "${RED}=== FAIL: $FAILS text check(s) failed ===${NC}"
  exit 1
fi
