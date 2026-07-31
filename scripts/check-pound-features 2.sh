#!/usr/bin/env bash
# scripts/check-pound-features.sh
#
# Verify POUNDING-specific features are preserved after upstream sync.
# Checks that key POUNDING custom files and code patterns still exist.
# Run this after every upstream merge.
#
# Exit 0 = all checks pass, Exit 1 = features missing.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
ERRORS=()

check_file() {
  local label="$1"
  local file="$ROOT/$2"

  if [ -f "$file" ]; then
    echo -e "${GREEN}PASS${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $label: file not found — $file"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: file not found: $file")
  fi
}

check_grep() {
  local label="$1"
  local pattern="$2"
  local file="$ROOT/$3"

  if [ ! -f "$file" ]; then
    echo -e "${RED}FAIL${NC} $label: file not found — $file"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: file not found: $file")
    return
  fi

  if grep -q "$pattern" "$file"; then
    echo -e "${GREEN}PASS${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $label not found in $(basename "$file")"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label not found in $file")
  fi
}

check_grep_no() {
  local label="$1"
  local pattern="$2"
  local file="$ROOT/$3"

  if [ ! -f "$file" ]; then
    echo -e "${RED}FAIL${NC} $label: file not found — $file"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label: file not found: $file")
    return
  fi

  if grep -q "$pattern" "$file"; then
    echo -e "${RED}FAIL${NC} $label found in $(basename "$file") — should not exist"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label found in $file")
  else
    echo -e "${GREEN}PASS${NC} $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== POUNDING Feature Existence Check ==="
echo ""

# --- Renderer: NewApi Account System ---
echo "== NewApi Desktop Account =="
check_file "DesktopLoginGate" "packages/desktop/src/renderer/components/layout/DesktopLoginGate.tsx"
check_file "NewApiAccountContext" "packages/desktop/src/renderer/hooks/context/NewApiAccountContext.tsx"
check_file "EnvConflictBanner" "packages/desktop/src/renderer/components/settings/EnvConflictBanner.tsx"
check_file "AionrsSettings" "packages/desktop/src/renderer/pages/settings/AionrsSettings.tsx"
check_file "useDealerConfig" "packages/desktop/src/renderer/hooks/useDealerConfig.ts"
check_file "PoundingInteractiveLogo" "packages/desktop/src/renderer/components/layout/PoundingInteractiveLogo.tsx"

# --- Process: NewApi Backend Services ---
echo ""
echo "== NewApi Backend Services =="
check_file "NewApiDesktopAccountService" "packages/desktop/src/process/bridge/services/NewApiDesktopAccountService.ts"
check_file "newApiAccountBridge" "packages/desktop/src/process/bridge/newApiAccountBridge.ts"
check_file "managedCliInstallerBridge" "packages/desktop/src/process/bridge/managedCliInstallerBridge.ts"
check_file "CodexProxyManager" "packages/desktop/src/process/services/CodexProxyManager.ts"

# --- Key Imports / Integrations ---
echo ""
echo "== Integration Points =="
check_grep "Layout imports DesktopLoginGate"     "DesktopLoginGate"     "packages/desktop/src/renderer/components/layout/Layout.tsx"
check_grep "Layout imports useNewApiAccount"      "useNewApiAccount"     "packages/desktop/src/renderer/components/layout/Layout.tsx"
check_grep "Layout shows DesktopGate or EnvBanner" "shouldShowDesktopGate\|EnvConflictBanner" "packages/desktop/src/renderer/components/layout/Layout.tsx"
check_grep "SiderFooter imports useNewApiAccount"    "useNewApiAccount"     "packages/desktop/src/renderer/components/layout/Sider/SiderFooter.tsx"
check_grep "SiderFooter has desktopAccountStatus"     "desktopAccountStatus" "packages/desktop/src/renderer/components/layout/Sider/SiderFooter.tsx"
check_grep "Sider imports useNewApiAccount"           "useNewApiAccount"     "packages/desktop/src/renderer/components/layout/Sider/index.tsx"
check_grep "Router has AionrsSettings route"          "AionrsSettings"       "packages/desktop/src/renderer/components/layout/Router.tsx"
check_grep "main.tsx has NewApiAccountProvider"       "NewApiAccountProvider" "packages/desktop/src/renderer/main.tsx"

# --- Common Types ---
echo ""
echo "== Common Types =="
check_file "newApiAccount types" "packages/desktop/src/common/types/newApiAccount.ts"
check_file "managedRuntimeCli types" "packages/desktop/src/common/types/agent/managedRuntimeCli.ts"

# --- Branding: Agent Labels & Logos ---
echo ""
echo "== Branding: Labels & Logos =="
check_grep "agentLogo uses pounding-heart" "pounding-heart-solid" "packages/desktop/src/renderer/utils/model/agentLogo.ts"
check_grep_no "agentLogo has no aion.svg"  "aion\.svg" "packages/desktop/src/renderer/utils/model/agentLogo.ts"
check_grep_no "no Aion CLI in config forms" "'Aion CLI'" "packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/DingTalkConfigForm.tsx"
check_grep_no "no Aion CLI in WeChat" "'Aion CLI'" "packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/WeixinConfigForm.tsx"
check_grep_no "no Aion CLI in WeCom" "'Aion CLI'" "packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/WecomConfigForm.tsx"
check_grep_no "no Aion CLI in Telegram" "'Aion CLI'" "packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/TelegramConfigForm.tsx"
check_grep_no "no Aion CLI in Lark" "'Aion CLI'" "packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/LarkConfigForm.tsx"

# --- Branding: UI Hides (pet in release) ---
echo ""
echo "== Branding: Hidden Features =="
check_grep "SettingsSider hides pet in production" "isProduction.*pet" "packages/desktop/src/renderer/pages/settings/components/SettingsSider.tsx"
check_grep_no "QuickActionButtons has no star button" "quickActionStar" "packages/desktop/src/renderer/pages/guid/components/QuickActionButtons.tsx"
check_grep_no "QuickActionButtons has no repo type" "'repo'" "packages/desktop/src/renderer/pages/guid/components/QuickActionButtons.tsx"

# --- Branding: Feishu Links ---
echo ""
echo "== Branding: Feishu Docs =="
check_grep "AboutModal uses Feishu for docs" "feishu\.cn/wiki/Zsr9wqyHHi3e5IkQYtwcQu6Knab" "packages/desktop/src/renderer/components/settings/SettingsModal/contents/AboutModalContent.tsx"
check_grep "WebuiModal uses Feishu" "feishu\.cn/wiki/MKMSwCUE0ii7Itkv71ScJCdOniI" "packages/desktop/src/renderer/components/settings/SettingsModal/contents/WebuiModalContent.tsx"
check_grep "RemoteAgentMgmt uses Feishu" "feishu\.cn/wiki/MKMSwCUE0ii7Itkv71ScJCdOniI" "packages/desktop/src/renderer/pages/settings/AgentSettings/RemoteAgentManagement.tsx"
check_grep "Sider help center uses Feishu" "feishu\.cn/wiki/Zsr9wqyHHi3e5IkQYtwcQu6Knab" "packages/desktop/src/renderer/components/layout/Sider/index.tsx"

# --- Branding: Hero Page PoundingInteractiveLogo ---
echo ""
echo "== Branding: Hero Logo =="
check_grep "GuidPage imports PoundingInteractiveLogo" "PoundingInteractiveLogo" "packages/desktop/src/renderer/pages/guid/GuidPage.tsx"

# --- Branding: Model Switching CLI Prefs ---
echo ""
echo "== Branding: Model Switching =="
check_grep "useAcpModelInfo has NEW_API_CLI_MODEL_PREFS_KEY" "NEW_API_CLI_MODEL_PREFS_KEY" "packages/desktop/src/renderer/hooks/agent/useAcpModelInfo.ts"
check_grep "useAcpModelInfo has reconcileModel" "reconcileModel" "packages/desktop/src/renderer/hooks/agent/useAcpModelInfo.ts"
check_grep "useAcpModelInfo has mapBackendToCliTarget" "mapBackendToCliTarget" "packages/desktop/src/renderer/hooks/agent/useAcpModelInfo.ts"

# --- Bridge Registration ---
echo ""
echo "== Bridge Registration =="
check_grep "Bridge index calls initNewApiAccountBridge" "initNewApiAccountBridge" "packages/desktop/src/process/bridge/index.ts"
check_grep "Bridge index calls initManagedCliInstaller" "initManagedCliInstallerBridge" "packages/desktop/src/process/bridge/index.ts"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo -e "${RED}POUNDING features are MISSING! The following were not found:${NC}"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${NC} $err"
  done
  echo ""
  echo "To restore: sync from halojerry/pounding release repo or cherry-pick from chore/pounding-frontend-rebrand branch."
  echo "Or run: bash scripts/check-pound-features.sh to see which files are missing."
  exit 1
else
  echo -e "${GREEN}All POUNDING features present.${NC}"
  exit 0
fi
