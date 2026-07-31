#!/bin/bash
# POUNDING dev launcher — uses locally-built poundingcore binary
export POUNDING_BACKEND_BIN="/Users/halo/Documents/pounding desktop/AionCore/target/debug/poundingcore"
cd "/Users/halo/Documents/pounding desktop/AionUi"
echo "[dev] using local poundingcore: $POUNDING_BACKEND_BIN"
bun run dev
