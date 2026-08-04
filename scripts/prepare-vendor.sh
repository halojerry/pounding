#!/usr/bin/env bash
# prepare-vendor.sh — download managed runtimes for the CURRENT platform.
#
# Called during CI build. Unlike vendor-managed-resources.sh (which
# vendors all 6 platforms for git commit), this script only downloads
# what the current build target needs. Output goes directly into the
# managed-resources bundle directory.
#
# Usage:
#   bash scripts/prepare-vendor.sh <OUT_DIR> [TARGET]
#
#   OUT_DIR  — output root (will contain runtimes/, mcp/, cli/, acp/)
#   TARGET   — platform key, e.g. darwin-arm64 (default: detect from uname)

set -euo pipefail

OUT_DIR="${1:?Usage: prepare-vendor.sh <OUT_DIR> [TARGET]}"
TARGET="${2:-}"

# Detect platform from host if not specified
if [ -z "$TARGET" ]; then
  case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*) OS="win32" ;;
    *) echo "ERROR: unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  ARCH="$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/;s/aarch64/arm64/')"
  TARGET="${OS}-${ARCH}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Shared version pins (single source of truth) ─────────────────────────
# Canonical values live in vendor-versions.env. Env vars / CLI args still
# override after sourcing (keep both in sync; check-version-consistency.sh).
if [ -f "${SCRIPT_DIR}/vendor-versions.env" ]; then
  . "${SCRIPT_DIR}/vendor-versions.env"
fi

# ── Helpers ──────────────────────────────────────────────────────────────

target_meta() {
  case "$1" in
    darwin-arm64)  echo 'darwin|arm64|darwin-arm64' ;;
    darwin-x64)    echo 'darwin|x64|darwin-x64' ;;
    linux-x64)     echo 'linux|x64|linux-x64' ;;
    linux-arm64)   echo 'linux|arm64|linux-arm64' ;;
    win32-x64)     echo 'win32|x64|win32-x64' ;;
    win32-arm64)   echo 'win32|arm64|win32-arm64' ;;
    *) echo "ERROR: unsupported target $1" >&2; exit 1 ;;
  esac
}

download() {
  local url="$1" output="$2"
  echo "    curl ${url}"
  mkdir -p "$(dirname "${output}")"
  curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 -o "${output}" "${url}" || {
    echo "    ERROR: failed to download ${url}" >&2
    return 1
  }
}

echo "==> prepare-vendor ${TARGET} -> ${OUT_DIR}"
mkdir -p "${OUT_DIR}"
# Make OUT_DIR absolute: vendor functions cd into npm staging dirs, so any
# relative dest path would resolve against the wrong CWD afterwards.
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"

# ── 0. Python 3.12 runtime (hermes offline install) ──────────────────────

PYTHON_VERSION="${PYTHON_VERSION:-3.12.13}"
PYTHON_RELEASE="${PYTHON_RELEASE:-20260728}"

python_platform_key() {
  case "$1" in
    darwin-arm64)  echo 'aarch64-apple-darwin' ;;
    darwin-x64)    echo 'x86_64-apple-darwin' ;;
    linux-x64)     echo 'x86_64-unknown-linux-gnu' ;;
    linux-arm64)   echo 'aarch64-unknown-linux-gnu' ;;
    win32-x64)     echo 'x86_64-pc-windows-msvc' ;;
    win32-arm64)   echo 'aarch64-pc-windows-msvc' ;;
    *) echo "ERROR: unsupported python target $1" >&2; exit 1 ;;
  esac
}

vendor_python() {
  local py_plat filename url tmp dest
  py_plat="$(python_platform_key "${TARGET}")"
  dest="${OUT_DIR}/runtimes/python"
  if [ -f "${dest}/bin/python3" ] || [ -f "${dest}/python.exe" ]; then
    echo "  python: already vendored"
    return 0
  fi
  filename="cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${py_plat}-install_only.tar.gz"
  url="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${filename}"
  tmp="/tmp/${filename}"
  echo "  python: downloading ${url}"
  download "${url}" "${tmp}" || return 1
  echo "  python: extracting"
  rm -rf "${dest}"
  mkdir -p "${dest}"
  tar -xzf "${tmp}" -C "${dest}" --strip-components=1
  rm -f "${tmp}"
  echo "  python: done (${dest})"
}

# ── 1. chrome-devtools-mcp ───────────────────────────────────────────────

CHROME_DEVTOOLS_MCP_VERSION="${CHROME_DEVTOOLS_MCP_VERSION:-1.4.0}"

vendor_chrome_devtools_mcp() {
(
  local meta plat arch platdir
  meta="$(target_meta "${TARGET}")"
  IFS='|' read -r plat arch platdir <<<"${meta}"

  local dest="${OUT_DIR}/mcp/chrome-devtools-mcp/${CHROME_DEVTOOLS_MCP_VERSION}/${platdir}"
  if [ -f "${dest}/manifest.json" ]; then
    echo "  chrome-devtools-mcp: already vendored"
    return 0
  fi

  local work="/tmp/vendor-cdt-${TARGET}"
  rm -rf "${work}"
  mkdir -p "${work}/project"

  cat > "${work}/project/package.json" <<PKGJSON
{
  "name": "vendor-cdt",
  "private": true,
  "dependencies": {
    "chrome-devtools-mcp": "${CHROME_DEVTOOLS_MCP_VERSION}"
  }
}
PKGJSON

  echo "  chrome-devtools-mcp: npm install"
  cd "${work}/project"
  npm install --cpu "${arch}" --os "${plat}" --no-audit --no-fund --silent 2>&1 | tail -3 || {
    echo "  chrome-devtools-mcp: npm install FAILED"
    rm -rf "${work}"
    return 1  # 关键组件：失败向主流程报告
  }

  rm -rf "${dest}"
  mkdir -p "${dest}"
  cp -R "${work}/project/node_modules" "${dest}/node_modules"

  # Resolve entrypoint from package.json bin field
  local entrypoint
  entrypoint="$(node - "chrome-devtools-mcp" "${work}/project" <<'NODESCRIPT'
const fs = require('node:fs');
const path = require('node:path');
const [, , pkgName, projectDir] = process.argv;
const segs = pkgName.split('/');
const pkgDir = path.join(projectDir, 'node_modules', ...segs);
const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const bin = pj.bin || {};
const binRel = (typeof bin === 'string' ? bin : (bin[pkgName] || bin['chrome-devtools'] || Object.values(bin)[0] || '')).replace(/\\/g, '/');
console.log(path.posix.join('node_modules', ...segs, binRel));
NODESCRIPT
)"

  cat > "${dest}/manifest.json" <<MANIFEST
{
  "entrypoint": "${entrypoint}",
  "path_entries": []
}
MANIFEST

  rm -rf "${work}"
  echo "  chrome-devtools-mcp: done"
  )

}

# ── 2. ACP tools ─────────────────────────────────────────────────────────

CLAUDE_ACP_VERSION="${CLAUDE_ACP_VERSION:-0.52.0}"

vendor_acp_one() {
(
  local slug="$1" pkg="$2" version="$3"
  local meta plat arch platdir
  meta="$(target_meta "${TARGET}")"
  IFS='|' read -r plat arch platdir <<<"${meta}"

  local dest="${OUT_DIR}/acp/${slug}/${version}/${platdir}"
  if [ -f "${dest}/manifest.json" ]; then
    echo "  ${slug}: already vendored"
    return 0
  fi

  local work="/tmp/vendor-acp-${slug}-${TARGET}"
  rm -rf "${work}"
  mkdir -p "${work}/project"

  cat > "${work}/project/package.json" <<PKGJSON
{
  "name": "vendor-${slug}",
  "private": true,
  "dependencies": {
    "${pkg}": "${version}"
  }
}
PKGJSON

  echo "  ${slug}: npm install"
  cd "${work}/project"
  npm install --cpu "${arch}" --os "${plat}" --no-audit --no-fund --silent 2>&1 | tail -3 || {
    echo "  ${slug}: npm install FAILED"
    rm -rf "${work}"
    return 1  # 关键组件：失败向主流程报告
  }

  local entrypoint
  entrypoint="$(node - "${pkg}" "${work}/project" <<'NODESCRIPT'
const fs = require('node:fs');
const path = require('node:path');
const [, , pkgName, projectDir] = process.argv;
const segs = pkgName.split('/');
const pkgDir = path.join(projectDir, 'node_modules', ...segs);
const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
function resolveBin(bin, name) {
  if (typeof bin === 'string' && bin.length > 0) return bin;
  if (!bin || typeof bin !== 'object') throw new Error('no bin');
  const short = name.startsWith('@') ? name.split('/')[1] : name;
  for (const k of [name, short]) if (typeof bin[k] === 'string' && bin[k].length > 0) return bin[k];
  const first = Object.values(bin).find(v => typeof v === 'string' && v.length > 0);
  if (!first) throw new Error('empty bin');
  return first;
}
const ep = resolveBin(pj.bin, pj.name).replace(/\\/g, '/');
console.log(path.posix.join('node_modules', ...segs, ep));
NODESCRIPT
)"

  rm -rf "${dest}"
  mkdir -p "${dest}"
  cp -R "${work}/project/node_modules" "${dest}/node_modules"

  cat > "${dest}/manifest.json" <<MANIFEST
{
  "entrypoint": "${entrypoint}",
  "path_entries": ["node_modules/.bin"]
}
MANIFEST

  rm -rf "${work}"
  echo "  ${slug}: done"
  )

}

vendor_acp() {
  vendor_acp_one "claude-agent-acp" "@agentclientprotocol/claude-agent-acp" "${CLAUDE_ACP_VERSION}"
}

# ── Main ─────────────────────────────────────────────────────────────────

# 关键组件（chrome-devtools-mcp / ACP bridges）失败 → 非零退出。
# CI release 构建会硬失败，防止 shipping 残缺 bundle；pr-checks / 手动构建
# 仍可经 workflow 的 strict_vendor 开关保持 warning。
FAILED=0

echo ""
vendor_python || FAILED=1
echo ""
vendor_chrome_devtools_mcp || FAILED=1
echo ""
vendor_acp || FAILED=1
echo ""

echo "==> Vendor done: ${OUT_DIR}"
du -sh "${OUT_DIR}" 2>/dev/null || true

if [ "${FAILED}" = "1" ]; then
  echo "==> ERROR: one or more critical vendor components failed (see above)" >&2
  exit 1
fi
exit 0
