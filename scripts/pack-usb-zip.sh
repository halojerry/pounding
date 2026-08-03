#!/usr/bin/env bash
# scripts/pack-usb-zip.sh
#
# Inject PORTABLE + (optional) dealer-config.json into an existing platform zip.
# The platform zip is produced by electron-builder (zip target in electron-builder.yml).
#
# 经销商绑定仅支持 zip（U盘/便携分发）：
#   - 注入 PORTABLE 标记 + dealer-config.json（exe 同目录读取，portableUpdater 更新时保留）
#   - NSIS 安装器（exe）与 dmg 不支持经销商改配置：安装包签名后无法注入
#     （macOS 往 .app 里写文件会破坏签名直接打不开），需要经销商绑定请走
#     官方定制渠道（workflow_dispatch 传 aff_code 预埋）。
#
# PORTABLE 标记对所有平台 zip 无条件注入（便携语义 + userData 隔离）：
#   - configureChromium 检测到 PORTABLE → userData 落到 exe 同目录 data/，
#     单实例锁自动按 exe 目录隔离，不再与安装版（%APPDATA%\POUNDING）互踢。
#   - 没有 PORTABLE 的 zip 会把数据写进 %APPDATA% 并与安装版共享单实例锁，
#     用户解压后双击"没反应"（进程静默退出）。
# dealer-config.json 仅当 AFF_CODE 非空时注入（避免空 aff 污染）。
#
# Usage:
#   bash scripts/pack-usb-zip.sh <PLATFORM_ZIP> [AFF_CODE]
#
# Example:
#   bash scripts/pack-usb-zip.sh out/POUNDING-2.1.5-win-x64.zip MY_AFF_CODE
#   bash scripts/pack-usb-zip.sh out/POUNDING-2.1.5-win-x64.zip  # PORTABLE only

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

# PORTABLE marker: always injected (portable semantics + userData isolation).
touch "$TEMP_DIR/PORTABLE"
INJECT_FILES="PORTABLE"

# dealer-config.json only when an affiliate code is provided.
if [ -n "$AFF_CODE" ]; then
  echo '{"aff": "'"${AFF_CODE}"'"}' > "$TEMP_DIR/dealer-config.json"
  INJECT_FILES="$INJECT_FILES dealer-config.json"
fi

echo "==> Injecting ${INJECT_FILES} into ${ZIP_NAME}"

# Append the markers with Python's zipfile (append mode). `zip -qr` / `7z a`
# update mode SILENTLY no-ops on the large electron-builder/ditto platform zips
# (verified on the 450-500MB mac/win zips: the step reported "Done" in <50ms
# and the file mtime/size never changed — PORTABLE was never actually written).
# zipfile append only touches the central directory, so existing entries
# (including .app symlinks and unix permissions) are preserved byte-for-byte.
# python3 is present on every build runner via the setup-python step.
python3 - "$PLATFORM_ZIP" "$TEMP_DIR" $INJECT_FILES <<'PY'
import os
import sys
import zipfile

zip_path, temp_dir = sys.argv[1], sys.argv[2]
inject_names = sys.argv[3:]

with zipfile.ZipFile(zip_path, 'a', compression=zipfile.ZIP_DEFLATED) as zout:
    for name in inject_names:
        info = zipfile.ZipInfo(name)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        with open(os.path.join(temp_dir, name), 'rb') as f:
            zout.writestr(info, f.read())
PY

echo "==> Done: ${ZIP_NAME}"
ls -lh "$PLATFORM_ZIP"
