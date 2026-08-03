#!/usr/bin/env bash
# scripts/build-missing-hermes-wheels.sh
#
# Hermes offline-bundle completeness fallback: build any binary dependency that
# lacks a wheel for the target platform from source, then finish the `pip
# download` for the remaining pure-Python wheels.
#
# Known gaps (verified against PyPI, 2026-08-03):
#   - darwin-x64: pyyaml==6.0.3 only ships macosx_10_13_x86_64 (the old
#     macosx_10_9_x86_64 tag made pip reject it) — fixed by the platform tag
#     below; no build needed.
#   - win32-arm64: cryptography==46.0.7 ships no cp312 win_arm64 wheel at all
#     (win32/win_amd64 only) → built from source on the windows-11-arm runner
#     (MSVC ARM64 toolchain + Rust, both preinstalled on the runner).
#
# Usage:
#   bash scripts/build-missing-hermes-wheels.sh <TARGET> <DEST> <PYTHON_BIN> <HERMES_VERSION>
#
#   TARGET       — platform key: darwin-arm64|darwin-x64|win32-x64|win32-arm64|...
#   DEST         — output dir that already contains partially downloaded wheels
#   PYTHON_BIN   — bundled python3 / python.exe used for pip
#   HERMES_VERSION — hermes-agent pin (e.g. 0.19.0)
#
# Exit 0 when the full dependency set (all wheels) is present in DEST,
# non-zero otherwise (caller keeps the warning-level "network fallback" path).

set -euo pipefail

TARGET="${1:?Usage: build-missing-hermes-wheels.sh <TARGET> <DEST> <PYTHON_BIN> <HERMES_VERSION>}"
DEST="${2:?}"
PYTHON_BIN="${3:?}"
HERMES_VERSION="${4:?}"

plat_tag() {
  case "$1" in
    darwin-arm64) echo "macosx_11_0_arm64" ;;
    # pyyaml==6.0.3 ships macosx_10_13_x86_64 wheels; the legacy 10_9 tag is
    # rejected by pip → offline bundle was never produced for Intel macs.
    darwin-x64)   echo "macosx_10_13_x86_64" ;;
    linux-x64)    echo "manylinux2014_x86_64" ;;
    linux-arm64)  echo "manylinux2014_aarch64" ;;
    win32-x64)    echo "win_amd64" ;;
    win32-arm64)  echo "win_arm64" ;;
    *) echo "ERROR: unsupported target ${TARGET}" >&2; exit 1 ;;
  esac
}

PLAT="$(plat_tag "${TARGET}")"

download_all() {
  "${PYTHON_BIN}" -m pip download "hermes-agent[acp]==${HERMES_VERSION}" \
    --dest "${DEST}" \
    --python-version 3.12 \
    --platform "${PLAT}" \
    --only-binary :all: \
    --find-links "${DEST}" \
    2>&1 | tail -8
}

echo "==> build-missing-hermes-wheels: target=${TARGET} platform=${PLAT} dest=${DEST}"

# 1. Try the plain offline download first (may already succeed after a tag fix).
if download_all; then
  echo "  all hermes wheels downloaded for ${TARGET} (no source build needed)"
  exit 0
fi

# 2. Identify binary-only deps that have no wheel for this platform and build
#    them from source into DEST. pip reports them as
#    "No matching distribution found for <pkg>==<ver>" or
#    "Could not find a version that satisfies the requirement <pkg>==<ver>".
echo "  full download failed; inspecting missing binary wheels..."
DOWNLOAD_LOG="$(mktemp "${TMPDIR:-/tmp}/hermes-download.XXXXXX")"
set +e
"${PYTHON_BIN}" -m pip download "hermes-agent[acp]==${HERMES_VERSION}" \
  --dest "${DEST}" \
  --python-version 3.12 \
  --platform "${PLAT}" \
  --only-binary :all: 2>&1 | tee "${DOWNLOAD_LOG}" >/dev/null
set -e

MISSING=$(grep -oE 'requirement [A-Za-z0-9_.-]+==[0-9][A-Za-z0-9_.-]*' "${DOWNLOAD_LOG}" | awk '{print $2}' | sort -u || true)
if [ -z "${MISSING}" ]; then
  echo "  could not determine the missing wheels from pip output; giving up (network fallback)"
  rm -f "${DOWNLOAD_LOG}"
  exit 1
fi

echo "  missing binary wheels: ${MISSING}"
for spec in ${MISSING}; do
  pkg="${spec%%==*}"
  echo "  building ${spec} from source for ${TARGET} ..."
  # Build isolation pulls the build backend (setuptools-rust / maturin) from
  # PyPI automatically; only the final wheel is kept (--no-deps).
  "${PYTHON_BIN}" -m pip wheel --no-deps --no-binary "${pkg}" "${spec}" -w "${DEST}" 2>&1 | tail -6
done
rm -f "${DOWNLOAD_LOG}"

# 3. Re-run the full download using the built wheels as find-links.
if download_all; then
  echo "  hermes wheel set complete for ${TARGET} after source builds"
  exit 0
fi

echo "  still incomplete after source builds; keeping runtime network fallback"
exit 1
