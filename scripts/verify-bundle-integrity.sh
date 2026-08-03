#!/usr/bin/env bash
# scripts/verify-bundle-integrity.sh
#
# Verify managed-resources bundle has correct structure and all manifest entries are valid.
#
# Usage:
#   ./scripts/verify-bundle-integrity.sh [OPTIONS] [MANAGED_RESOURCES_DIR]
#
# Arguments:
#   MANAGED_RESOURCES_DIR   Path to managed-resources directory (default: /tmp/macos-managed)
#
# Options:
#   --platform PLATFORM     Expected platform key (e.g., darwin-arm64, win32-x64)
#   --help                  Show this help message
#
# Exit 0 = all checks pass, Exit 1 = one or more checks failed.

set -euo pipefail

# ---------------------------------------------------------------------------
# Colour helpers (disabled when stdout is not a terminal)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' NC=''
fi

PASS=0
FAIL=0
ERRORS=()

pass() {
  echo -e "${GREEN}✅${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "${RED}❌${NC} $1"
  FAIL=$((FAIL + 1))
  ERRORS+=("$1")
}

# ---------------------------------------------------------------------------
# JSON parser — prefer jq, fall back to python3, then node
# ---------------------------------------------------------------------------
json_query() {
  local file="$1"
  local query="$2"

  if command -v jq >/dev/null 2>&1; then
    if [[ "${query}" == ".path_entries" ]]; then
      jq -r '.path_entries[]? // empty' "${file}" 2>/dev/null
    else
      jq -r "${query}" "${file}" 2>/dev/null
    fi
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
with open('${file}') as f:
    d = json.load(f)
# Simple queries only
q = '${query}'
if q == '.entrypoint':
    print(d.get('entrypoint', ''))
elif q == '.version':
    print(d.get('version', ''))
elif q == '.platform':
    print(d.get('platform', ''))
elif q == '.path_entries':
    for e in d.get('path_entries', []):
        print(e)
elif q == '.entrypoint // empty':
    print(d.get('entrypoint', '') or '')
elif q == '.version // empty':
    print(d.get('version', '') or '')
elif q == '.platform // empty':
    print(d.get('platform', '') or '')
else:
    print(json.dumps(d))
" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node - "${file}" "${query}" <<'NODEOF'
const fs = require('node:fs');
const [,, filePath, query] = process.argv;
const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
if (query === '.entrypoint') process.stdout.write(d.entrypoint || '');
else if (query === '.version') process.stdout.write(d.version || '');
else if (query === '.platform') process.stdout.write(d.platform || '');
else if (query === '.path_entries') { (d.path_entries || []).forEach(e => process.stdout.write(e + '\n')); }
else if (query === '.entrypoint // empty') process.stdout.write(d.entrypoint || '');
else if (query === '.version // empty') process.stdout.write(d.version || '');
else if (query === '.platform // empty') process.stdout.write(d.platform || '');
else process.stdout.write(JSON.stringify(d));
NODEOF
  else
    echo "ERROR: no JSON parser available (jq, python3, or node required)" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
EXPECTED_PLATFORM=""
# --vendor-only: only check components produced by scripts/prepare-vendor.sh
# (openclaw / python / hermes / uv). claude and node come from the poundingcore
# release asset (prepare-managed-resources), so a bare vendor directory would
# false-positive on them.
VENDOR_ONLY=false

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \?//'
  exit 0
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --platform requires a value" >&2
        exit 1
      fi
      EXPECTED_PLATFORM="$2"
      shift 2
      ;;
    --vendor-only)
      VENDOR_ONLY=true
      shift
      ;;
    --help|-h)
      usage
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

MANAGED_RESOURCES="${POSITIONAL[0]:-/tmp/macos-managed}"

echo ""
echo "Bundle integrity verification"
echo "=============================="
echo "Target directory: ${MANAGED_RESOURCES}"
if [[ -n "${EXPECTED_PLATFORM}" ]]; then
  echo "Expected platform: ${EXPECTED_PLATFORM}"
fi
echo ""

# ---------------------------------------------------------------------------
# Pre-flight: target directory must exist
# ---------------------------------------------------------------------------
if [[ ! -d "${MANAGED_RESOURCES}" ]]; then
  fail "Target directory does not exist: ${MANAGED_RESOURCES}"
  echo ""
  TOTAL=$((PASS + FAIL))
  echo "Summary: ${PASS}/${TOTAL} checks passed"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Directory structure checks
# ---------------------------------------------------------------------------
echo "--- 1. Directory structure ---"

# Use parallel arrays for compatibility with bash 3.2 (macOS default)
# CLI runtimes (claude/hermes/openclaw) are no longer vendored; only the node
# runtime (full bundle) and prepare-vendor.sh outputs (mcp/acp) are expected.
EXPECTED_DIR_PATHS=("node")
EXPECTED_DIR_LABELS=("Node runtime")
if [[ "${VENDOR_ONLY}" == true ]]; then
  EXPECTED_DIR_PATHS=("mcp/chrome-devtools-mcp" "acp")
  EXPECTED_DIR_LABELS=("MCP: chrome-devtools-mcp" "ACP bridges")
fi

for idx in "${!EXPECTED_DIR_PATHS[@]}"; do
  relpath="${EXPECTED_DIR_PATHS[$idx]}"
  label="${EXPECTED_DIR_LABELS[$idx]}"
  if [[ -d "${MANAGED_RESOURCES}/${relpath}" ]]; then
    pass "Directory exists: ${relpath} (${label})"
  else
    fail "Directory missing: ${relpath} (${label})"
  fi
done

echo ""

# ---------------------------------------------------------------------------
# 2. Node runtime check (skipped in --vendor-only mode: node ships in the
#    poundingcore release asset, not in the prepare-vendor.sh output)
# ---------------------------------------------------------------------------
if [[ "${VENDOR_ONLY}" == true ]]; then
  echo "--- 2. Node runtime (skipped: --vendor-only) ---"
else
  echo "--- 2. Node runtime ---"
fi

if [[ "${VENDOR_ONLY}" == false ]]; then
node_dir="${MANAGED_RESOURCES}/node"
if [[ -d "${node_dir}" ]]; then
  found_node=false
  # Look for versioned directories (e.g. node-v24.11.0-darwin-arm64)
  for versioned_dir in "${node_dir}"/node-v* "${node_dir}"/v*; do
    if [[ ! -d "${versioned_dir}" ]]; then
      continue
    fi
    dir_name="$(basename "${versioned_dir}")"
    for bin in node node.exe; do
      # Check direct or bin/ subdirectory
      if [[ -f "${versioned_dir}/${bin}" ]]; then
        found_node=true
        pass "Node runtime: binary '${bin}' found in ${dir_name}/"
        break 2
      elif [[ -f "${versioned_dir}/bin/${bin}" ]]; then
        found_node=true
        pass "Node runtime: binary '${bin}' found in ${dir_name}/bin/"
        break 2
      fi
    done
  done
  if [[ "${found_node}" == false ]]; then
    # Broader search as fallback
    nested_node="$(find "${node_dir}" -maxdepth 3 \( -name 'node' -o -name 'node.exe' \) -type f 2>/dev/null | head -1)"
    if [[ -n "${nested_node}" ]]; then
      pass "Node runtime: binary found at ${nested_node#${MANAGED_RESOURCES}/}"
    else
      fail "Node runtime: no versioned directory with a 'node' or 'node.exe' binary found"
    fi
  fi
else
  fail "Node directory missing: node/"
fi

fi

if [[ "${VENDOR_ONLY}" == false ]]; then
echo ""

# ---------------------------------------------------------------------------
# 5. ACP tools check (skipped in --vendor-only mode: acp is not copied into
#    the app bundle — prepare-poundingcore.js only copies cli/runtimes/mcp)
# ---------------------------------------------------------------------------
echo "--- 5. ACP tools ---"

acp_dir="${MANAGED_RESOURCES}/acp"
if [[ -d "${acp_dir}" ]]; then
  for acp_tool in claude-agent-acp; do
    if [[ -d "${acp_dir}/${acp_tool}" ]]; then
      pass "ACP tool directory exists: acp/${acp_tool}"
    else
      fail "ACP tool directory missing: acp/${acp_tool}"
    fi
  done
else
  fail "ACP directory missing: acp/"
fi

echo ""
fi

# ---------------------------------------------------------------------------
# 6. Deep manifest validation (entrypoint + path_entries existence)
# ---------------------------------------------------------------------------
echo "--- 6. Manifest deep validation ---"

deep_manifest_count=0
while IFS= read -r manifest_path; do
  deep_manifest_count=$((deep_manifest_count + 1))
  manifest_dir="$(dirname "${manifest_path}")"
  rel_manifest="${manifest_path#${MANAGED_RESOURCES}/}"

  entrypoint="$(json_query "${manifest_path}" '.entrypoint' | tr -d '[:space:]')"
  if [[ -n "${entrypoint}" ]]; then
    if [[ -f "${manifest_dir}/${entrypoint}" ]]; then
      pass "Deep check ${rel_manifest}: entrypoint file verified"
    else
      fail "Deep check ${rel_manifest}: entrypoint file '${entrypoint}' does not exist at expected path"
    fi
  fi

  path_entries_raw="$(json_query "${manifest_path}" '.path_entries')"
  if [[ -n "${path_entries_raw}" ]]; then
    while IFS= read -r entry; do
      entry="$(echo "${entry}" | tr -d '[:space:]')"
      [[ -z "${entry}" ]] && continue
      if [[ -d "${manifest_dir}/${entry}" ]]; then
        pass "Deep check ${rel_manifest}: path_entries '${entry}' verified"
      else
        fail "Deep check ${rel_manifest}: path_entries '${entry}' does not exist at expected path"
      fi
    done <<< "${path_entries_raw}"
  fi

  # For JS CLIs with node_modules, verify .bin link directory
  if [[ -d "${manifest_dir}/node_modules" ]]; then
    if [[ -d "${manifest_dir}/node_modules/.bin" ]]; then
      pass "Deep check ${rel_manifest}: node_modules/.bin verified"
    else
      fail "Deep check ${rel_manifest}: node_modules/.bin missing"
    fi
  fi

done < <(find "${MANAGED_RESOURCES}" -name 'manifest.json' -type f -not -path '*/node_modules/*' 2>/dev/null)

if [[ ${deep_manifest_count} -eq 0 ]]; then
  fail "Deep validation: no manifest.json files found anywhere in the bundle"
fi

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$((PASS + FAIL))
echo "=============================="
echo "Summary: ${PASS}/${TOTAL} checks passed"

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}❌${NC} ${err}"
  done
fi

echo ""
if [[ ${FAIL} -eq 0 ]]; then
  echo -e "${GREEN}All checks passed.${NC}"
  exit 0
else
  echo -e "${RED}${FAIL} check(s) failed.${NC}"
  exit 1
fi
