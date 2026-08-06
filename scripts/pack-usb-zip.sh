#!/usr/bin/env bash
# scripts/pack-usb-zip.sh
#
# Inject PORTABLE + dealer-config.json into an existing platform zip.
# The platform zip is produced by electron-builder (zip target in electron-builder.yml).
#
# Usage:
#   bash scripts/pack-usb-zip.sh <PLATFORM_ZIP> <AFF_CODE>
#
# Example:
#   bash scripts/pack-usb-zip.sh out/POUNDING-2.1.5-win-x64.zip MY_AFF_CODE
#
# If AFF_CODE is "YOUR_AFF_CODE" (the template placeholder), the script
# still writes it — dealers can replace the file in the zip manually.

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
