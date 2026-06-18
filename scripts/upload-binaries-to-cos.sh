#!/usr/bin/env bash
set -euo pipefail
VERSION="${1:?Usage: $0 <version>}"
BUNDLED_DIR="resources/bundled-poundingcore"
COS_PATH="cos://yss-1256275613/pounding/binaries/${VERSION}"

echo "Uploading ${BUNDLED_DIR} to ${COS_PATH} ..."
for dir in "${BUNDLED_DIR}"/*/; do
  platform_arch=$(basename "$dir")
  coscli cp -r "${BUNDLED_DIR}/${platform_arch}" "${COS_PATH}/${platform_arch}/" || {
    echo "Failed to upload ${platform_arch}"
    exit 1
  }
  echo "  ${platform_arch} done"
done
echo "Upload complete: ${COS_PATH}"
