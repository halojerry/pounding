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

python_target_triple() {
  case "$1" in
    darwin-arm64)  echo 'aarch64-apple-darwin' ;;
    darwin-x64)    echo 'x86_64-apple-darwin' ;;
    linux-x64)     echo 'x86_64-unknown-linux-gnu' ;;
    linux-arm64)   echo 'aarch64-unknown-linux-gnu' ;;
    win32-x64)     echo 'x86_64-pc-windows-msvc' ;;
    win32-arm64)   echo 'aarch64-pc-windows-msvc' ;;
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

# ── 1. Python (portable build) ───────────────────────────────────────────

PYTHON_VERSION="${PYTHON_VERSION:-3.12.9}"
PYTHON_RELEASE="${PYTHON_RELEASE:-20250324}"

vendor_python() {
  local triple dest
  triple="$(python_target_triple "${TARGET}")"
  dest="${OUT_DIR}/runtimes/python"

  if [ -f "${dest}/.version" ] && [ "$(cat "${dest}/.version")" = "${PYTHON_VERSION}" ]; then
    echo "  python: already vendored (v${PYTHON_VERSION})"
    return 0
  fi

  local archive="cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${triple}-install_only.tar.gz"
  local url="https://github.com/indygreg/python-build-standalone/releases/download/${PYTHON_RELEASE}/${archive}"
  local tmp="/tmp/${archive}"

  echo "  python: downloading ${archive}"
  download "${url}" "${tmp}" || return 0  # non-fatal

  echo "  python: extracting"
  rm -rf "${dest}"
  mkdir -p "${dest}"
  tar -xzf "${tmp}" -C "${dest}" --strip-components=1
  rm -f "${tmp}"
  echo "${PYTHON_VERSION}" > "${dest}/.version"
  echo "  python: done"
}

# ── 2. uv (standalone binary) ────────────────────────────────────────────

UV_VERSION="${UV_VERSION:-0.7.16}"

vendor_uv() {
  local triple uv_name dest_dir dest
  triple="$(python_target_triple "${TARGET}")"
  dest_dir="${OUT_DIR}/runtimes/uv"
  dest="${dest_dir}/uv"
  [ "${TARGET#win32}" != "${TARGET}" ] && dest="${dest_dir}/uv.exe"

  if [ -f "${dest}" ] && [ -f "${dest_dir}/.version" ] && [ "$(cat "${dest_dir}/.version")" = "${UV_VERSION}" ]; then
    echo "  uv: already vendored (v${UV_VERSION})"
    return 0
  fi

  case "${TARGET}" in
    win32-*) uv_name="uv-${triple}.zip" ;;
    *)       uv_name="uv-${triple}.tar.gz" ;;
  esac

  local url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_name}"
  local tmp="/tmp/${uv_name}"

  echo "  uv: downloading ${uv_name}"
  download "${url}" "${tmp}" || return 0  # non-fatal

  echo "  uv: extracting"
  rm -rf "${dest_dir}"
  mkdir -p "${dest_dir}"
  if [ "${TARGET#win32}" != "${TARGET}" ]; then
    unzip -qo "${tmp}" -d "${dest_dir}/"
    find "${dest_dir}" -name 'uv.exe' -type f -exec mv {} "${dest}" \;
  else
    tar -xzf "${tmp}" -C "${dest_dir}/"
    find "${dest_dir}" -name 'uv' -type f -exec mv {} "${dest}" \;
  fi
  rm -f "${tmp}"
  chmod +x "${dest}" 2>/dev/null || true
  echo "${UV_VERSION}" > "${dest_dir}/.version"
  echo "  uv: done"
}

# ── 3. chrome-devtools-mcp ───────────────────────────────────────────────

CHROME_DEVTOOLS_MCP_VERSION="${CHROME_DEVTOOLS_MCP_VERSION:-1.4.0}"

vendor_chrome_devtools_mcp() {
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
    echo "  chrome-devtools-mcp: npm install FAILED (non-fatal)"
    rm -rf "${work}"
    return 0
  }

  rm -rf "${dest}"
  mkdir -p "${dest}"
  cp -R "${work}/project/node_modules/." "${dest}/"

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
}

# ── 4. ACP tools ─────────────────────────────────────────────────────────

CLAUDE_ACP_VERSION="${CLAUDE_ACP_VERSION:-0.52.0}"

vendor_acp_one() {
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
    echo "  ${slug}: npm install FAILED (non-fatal)"
    rm -rf "${work}"
    return 0
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
  cp -R "${work}/project/node_modules/." "${dest}/"

  cat > "${dest}/manifest.json" <<MANIFEST
{
  "entrypoint": "${entrypoint}",
  "path_entries": ["node_modules/.bin"]
}
MANIFEST

  rm -rf "${work}"
  echo "  ${slug}: done"
}

vendor_acp() {
  vendor_acp_one "claude-agent-acp" "@agentclientprotocol/claude-agent-acp" "${CLAUDE_ACP_VERSION}"
}

# ── 5. CLI tools ─────────────────────────────────────────────────────────

OPENCLAW_VERSION="${OPENCLAW_VERSION:-0.1.0}"
HERMES_VERSION="${HERMES_VERSION:-0.1.0}"

vendor_cli_one() {
  local cli_name="$1" pkg="$2" version="$3"
  local meta plat arch platdir
  meta="$(target_meta "${TARGET}")"
  IFS='|' read -r plat arch platdir <<<"${meta}"

  local dest="${OUT_DIR}/cli/${cli_name}/${version}/${platdir}"
  if [ -f "${dest}/manifest.json" ]; then
    echo "  ${cli_name}: already vendored"
    return 0
  fi

  local work="/tmp/vendor-cli-${cli_name}-${TARGET}"
  rm -rf "${work}"
  mkdir -p "${work}/project"

  cat > "${work}/project/package.json" <<PKGJSON
{
  "name": "vendor-${cli_name}",
  "private": true,
  "dependencies": {
    "${pkg}": "${version}"
  }
}
PKGJSON

  echo "  ${cli_name}: npm install"
  cd "${work}/project"
  npm install --cpu "${arch}" --os "${plat}" --no-audit --no-fund --silent 2>&1 | tail -3 || {
    echo "  ${cli_name}: npm install FAILED (non-fatal)"
    rm -rf "${work}"
    return 0
  }

  rm -rf "${dest}"
  mkdir -p "${dest}"
  cp -R "${work}/project/node_modules/." "${dest}/"

  local bin_rel
  bin_rel="$(node - "${pkg}" "${work}/project" <<'NODESCRIPT'
const fs = require('node:fs');
const path = require('node:path');
const [, , pkgName, projectDir] = process.argv;
const segs = pkgName.split('/');
const pkgDir = path.join(projectDir, 'node_modules', ...segs);
const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
function resolveBin(bin, name) {
  if (typeof bin === 'string' && bin.length > 0) return bin;
  if (!bin || typeof bin !== 'object') return [name.startsWith('@') ? name.split('/')[1] : name, Object.values(bin)[0]];
  const short = name.startsWith('@') ? name.split('/')[1] : name;
  for (const k of [name, short]) if (typeof bin[k] === 'string' && bin[k].length > 0) return bin[k];
  return Object.values(bin)[0];
}
const ep = resolveBin(pj.bin, pj.name);
console.log(typeof ep === 'string' ? ep.replace(/\\/g, '/') : ep.replace(/\\/g, '/'));
NODESCRIPT
)"

  cat > "${dest}/manifest.json" <<MANIFEST
{
  "entrypoint": "${bin_rel}",
  "path_entries": [".bin"]
}
MANIFEST

  rm -rf "${work}"
  echo "  ${cli_name}: done"
}

vendor_clis() {
  vendor_cli_one "openclaw" "openclaw" "${OPENCLAW_VERSION}"
}

# ── 6. Hermes (Python wheel offline bundle) ──────────────────────────────

vendor_hermes() {
  local dest="${OUT_DIR}/runtimes/hermes"
  if [ -f "${dest}/.version" ] && [ "$(cat "${dest}/.version")" = "${HERMES_VERSION}" ]; then
    echo "  hermes: already vendored (v${HERMES_VERSION})"
    return 0
  fi

  echo "  hermes: downloading wheels"

  # Strategy 1: vendored or system uv (preferred)
  local uv_bin=""
  for candidate in \
    "${OUT_DIR}/runtimes/uv/uv" \
    "${OUT_DIR}/runtimes/uv/uv.exe" \
    "${HOME}/.local/bin/uv" \
    "${HOME}/.cargo/bin/uv"; do
    if [ -x "${candidate}" ]; then
      uv_bin="${candidate}"
      break
    fi
  done
  if [ -z "${uv_bin}" ] && command -v uv >/dev/null 2>&1; then
    uv_bin="uv"
  fi

  if [ -n "${uv_bin}" ]; then
    if "${uv_bin}" pip download --help >/dev/null 2>&1; then
      echo "    using uv: ${uv_bin}"
      rm -rf "${dest}"
      mkdir -p "${dest}"

      "${uv_bin}" pip download "hermes-agent[acp]>=${HERMES_VERSION}" \
        --dest "${dest}" 2>&1 | tail -3 || {
        echo "    uv pip download FAILED (will try pip)"
        rm -rf "${dest}"
        uv_bin=""
      }

      if [ -n "${uv_bin}" ] && [ -d "${dest}" ] && ls "${dest}"/*.whl >/dev/null 2>&1; then
        echo "${HERMES_VERSION}" > "${dest}/.version"
        echo "  hermes: done via uv ($(ls "${dest}"/*.whl 2>/dev/null | wc -l) wheels)"
        return 0
      fi
    else
      echo "    uv too old (no pip download), will try pip"
    fi
  fi

  # Strategy 2: system Python + pip
  local python_bin=""
  for candidate in python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      python_bin="${candidate}"
      break
    fi
  done

  if [ -n "${python_bin}" ]; then
    local plat_tag=""
    case "${TARGET}" in
      darwin-arm64) plat_tag="macosx_11_0_arm64" ;;
      darwin-x64)   plat_tag="macosx_10_9_x86_64" ;;
      linux-x64)    plat_tag="manylinux2014_x86_64" ;;
      linux-arm64)  plat_tag="manylinux2014_aarch64" ;;
      win32-x64)    plat_tag="win_amd64" ;;
      win32-arm64)  plat_tag="win_arm64" ;;
    esac

    echo "    using pip (${python_bin}), platform=${plat_tag}"
    rm -rf "${dest}"
    mkdir -p "${dest}"

    "${python_bin}" -m pip download "hermes-agent[acp]>=${HERMES_VERSION}" \
      --dest "${dest}" \
      --python-version 3.12 \
      --platform "${plat_tag}" \
      --only-binary :all: 2>&1 | tail -5 || {
      echo "    pip download FAILED (non-fatal)"
      rm -rf "${dest}"
      echo "${HERMES_VERSION}" > "${dest}/.version"
      return 0
    }

    if [ -d "${dest}" ] && ls "${dest}"/*.whl >/dev/null 2>&1; then
      echo "${HERMES_VERSION}" > "${dest}/.version"
      echo "  hermes: done via pip ($(ls "${dest}"/*.whl 2>/dev/null | wc -l) wheels)"
      return 0
    fi
  fi

  echo "  hermes: no working Python/uv found (non-fatal)"
  rm -rf "${dest}"
  echo "${HERMES_VERSION}" > "${dest}/.version"
  return 0
}

# ── Main ─────────────────────────────────────────────────────────────────

echo ""
vendor_python
echo ""
vendor_uv
echo ""
vendor_chrome_devtools_mcp
echo ""
vendor_acp
echo ""
vendor_clis
echo ""
vendor_hermes
echo ""

echo "==> Vendor done: ${OUT_DIR}"
du -sh "${OUT_DIR}" 2>/dev/null || true
