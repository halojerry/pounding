#!/usr/bin/env bash
# scripts/pack-usb-zip.sh
#
# Inject PORTABLE + dealer-config.json into an existing platform zip.
# The platform zip is produced by electron-builder (zip target in electron-builder.yml).
#
# 经销商绑定仅支持 zip（U盘/便携分发）：
#   - 注入 PORTABLE 标记 + dealer-config.json（exe 同目录读取，portableUpdater 更新时保留）
#   - NSIS 安装器（exe）与 dmg 不支持经销商改配置：安装包签名后无法注入
#     （macOS 往 .app 里写文件会破坏签名直接打不开），需要经销商绑定请走
#     官方定制渠道（workflow_dispatch 传 aff_code 预埋）。
#
# Usage:
#   bash scripts/pack-usb-zip.sh <PLATFORM_ZIP> <AFF_CODE>
#
# Example:
#   bash scripts/pack-usb-zip.sh out/POUNDING-2.1.5-win-x64.zip MY_AFF_CODE
#
# If AFF_CODE is empty, the script still writes {"aff": ""} — dealers can
# replace the file in the zip manually (kept for backwards compat).

set -euo pipefail

PLATFORM_ZIP="$1"
AFF_CODE="${2:-}"

if [ ! -f "$PLATFORM_ZIP" ]; then
  echo "ERROR: Platform zip not found: $PLATFORM_ZIP" >&2
  echo "Usage: bash scripts/pack-usb-zip.sh <PLATFORM_ZIP> [AFF_CODE]" >&2
  exit 1
fi

ZIP_DIR="$(dirname "$PLATFORM_ZIP")"
ZIP_NAME="$(basename "$PLATFORM_ZIP")"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Create dealer files in temp dir
echo '{"aff": "'"${AFF_CODE}"'"}' > "$TEMP_DIR/dealer-config.json"
touch "$TEMP_DIR/PORTABLE"

echo "==> Injecting PORTABLE + dealer-config.json (aff=${AFF_CODE}) into ${ZIP_NAME}"

# Add files to the existing zip (modifies in-place)
if command -v 7z &>/dev/null; then
  (cd "$TEMP_DIR" && 7z a "$PLATFORM_ZIP" PORTABLE dealer-config.json -tzip -mx=5 -bso0 -bsp0 > /dev/null)
else
  (cd "$TEMP_DIR" && zip -qr "$PLATFORM_ZIP" PORTABLE dealer-config.json)
fi

echo "==> Done: ${ZIP_NAME}"
ls -lh "$PLATFORM_ZIP"
