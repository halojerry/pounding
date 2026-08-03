#!/usr/bin/env bash
# scripts/check-version-consistency.sh
#
# Verify all pinned CLI/runtime versions across the repo agree with
# scripts/vendor-versions.env (the single source of truth).
#
# Usage:
#   bash scripts/check-version-consistency.sh [POUNDINGCORE_DIR]
#
#   POUNDINGCORE_DIR   path to poundingcore repo (default: ../poundingcore)
#                      — only checked when the directory exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
ENV_FILE="${SCRIPT_DIR}/vendor-versions.env"
POUNDINGCORE_DIR="${1:-${PROJECT_DIR}/../poundingcore}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found" >&2
  exit 1
fi

# Load canonical versions
# shellcheck disable=SC1090
. "${ENV_FILE}"

failures=0

check_grep() {
  local label="$1" file="$2" pattern="$3" expected="$4"
  if [ ! -f "${file}" ]; then
    echo "SKIP: ${label} — ${file} not found"
    return 0
  fi
  if grep -qE "${pattern}" "${file}"; then
    echo "OK:   ${label} (${expected})"
  else
    echo "FAIL: ${label} — expected ${expected} not found in ${file} (pattern: ${pattern})"
    failures=$((failures + 1))
  fi
}

echo "==> Version consistency check (vendor-versions.env as source of truth)"

# 1. TS bridge constants (official-install pins used by managedCliInstallerBridge)
BRIDGE="${PROJECT_DIR}/packages/desktop/src/process/bridge/managedCliInstallerBridge.ts"
check_grep "bridge CLAUDE_CLI_VERSION" "${BRIDGE}" \
  "CLAUDE_CLI_VERSION = '${CLAUDE_CLI_VERSION}'" "${CLAUDE_CLI_VERSION}"
check_grep "bridge OPENCLAW_VERSION" "${BRIDGE}" \
  "OPENCLAW_VERSION = '${OPENCLAW_VERSION}'" "${OPENCLAW_VERSION}"
check_grep "bridge HERMES_VERSION" "${BRIDGE}" \
  "HERMES_VERSION = '${HERMES_VERSION}'" "${HERMES_VERSION}"

# 2. poundingcore Rust consts (optional — only when the repo is present)
if [ -d "${POUNDINGCORE_DIR}/crates" ]; then
  TYPES="${POUNDINGCORE_DIR}/crates/aionui-runtime/src/native_cli_runtime/types.rs"
  if [ -f "${TYPES}" ]; then
    check_grep "Rust native_cli_runtime Hermes" "${TYPES}" \
      "\"${HERMES_VERSION}\"" "${HERMES_VERSION}"
    check_grep "Rust native_cli_runtime OpenClaw" "${TYPES}" \
      "\"${OPENCLAW_VERSION}\"" "${OPENCLAW_VERSION}"
  else
    echo "SKIP: Rust native_cli_runtime/types.rs not found"
  fi
  CLAUDE_MOD="${POUNDINGCORE_DIR}/crates/aionui-runtime/src/managed_cli/mod.rs"
  if [ -f "${CLAUDE_MOD}" ]; then
    check_grep "Rust CLAUDE_CLI_VERSION" "${CLAUDE_MOD}" \
      "CLAUDE_CLI_VERSION.*\"${CLAUDE_CLI_VERSION}\"" "${CLAUDE_CLI_VERSION}"
  fi
else
  echo "SKIP: poundingcore repo not found at ${POUNDINGCORE_DIR}"
fi

echo ""
if [ "${failures}" -gt 0 ]; then
  echo "✗ Version consistency check FAILED (${failures} mismatch(es))"
  exit 1
fi
echo "✓ Version consistency check passed"
