#!/usr/bin/env bash
# Builds native/ax-helper/main.swift -> apps/desktop/resources/bin/pointy-ax (macOS only).
# Never fails the calling npm script: a missing helper only degrades Pointy to screenshot-only.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/ax-helper/main.swift"
OUT_DIR="$ROOT/apps/desktop/resources/bin"
OUT="$OUT_DIR/pointy-ax"
if [ "$(uname)" != "Darwin" ]; then echo "[ax-helper] not macOS, skipping"; exit 0; fi
if ! command -v swiftc >/dev/null 2>&1; then echo "[ax-helper] swiftc not found (install Xcode CLT); AX disabled" >&2; exit 0; fi
if [ -x "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then echo "[ax-helper] up to date"; exit 0; fi
mkdir -p "$OUT_DIR"
if swiftc -O -swift-version 5 -o "$OUT" "$SRC" -framework Cocoa -framework ApplicationServices; then
  echo "[ax-helper] built $OUT"
else
  echo "[ax-helper] build failed; AX disabled" >&2
fi
exit 0
