#!/usr/bin/env bash
# Package the extension as a .xpi (zip) for sharing.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/dist/local-discovery.xpi"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

cd "$REPO/extension"
zip -qr "$OUT" . \
  -x "*.DS_Store" \
  -x "*/node_modules/*" \
  -x "data/*"

bytes=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
mb=$(awk "BEGIN { printf \"%.1f\", $bytes/1024/1024 }")
echo "wrote $OUT (${mb} MB)"
