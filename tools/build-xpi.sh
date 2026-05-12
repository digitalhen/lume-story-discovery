#!/usr/bin/env bash
# Build artifacts for AMO submission:
#   dist/lume.xpi          — the extension package (upload as the addon file)
#   dist/lume-source.zip   — source archive for review (upload as source code)
#
# Mozilla reviewers run the build instructions in SOURCES.md to verify
# that any bundled/minified files are an honest copy of public source.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO/dist"
XPI="$DIST/lume.xpi"
SRC="$DIST/lume-source.zip"

mkdir -p "$DIST"
rm -f "$XPI" "$SRC"

# ---- extension package (.xpi) ----
cd "$REPO/extension"
zip -qr "$XPI" . \
  -x "*.DS_Store" \
  -x "*/node_modules/*" \
  -x "data/*"

# ---- source archive for AMO review ----
SRCDIR="$(mktemp -d)"
trap 'rm -rf "$SRCDIR"' EXIT

# Pull a clean copy of the extension tree (no build artifacts).
mkdir -p "$SRCDIR/lume-source"
( cd "$REPO" && rsync -a \
    --exclude='.DS_Store' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.git' \
    extension/ "$SRCDIR/lume-source/extension/" )

cat > "$SRCDIR/lume-source/SOURCES.md" <<'MD'
# Lume — source bundle for AMO review

This archive contains the complete source for the submitted `lume.xpi`.
Our own code (background, content, homepage, debug) is plain
unminified ES modules — nothing to "build" on our side.

## Vendored third-party files

Two files under `extension/lib/` are vendored from an upstream package
and shipped unmodified.

### `extension/lib/transformers.min.js`

- **Origin**: `@huggingface/transformers` v3.0.2 on npm.
- **Path inside the package**: `dist/transformers.min.js`.
- **How to reproduce**:
  ```sh
  npm pack @huggingface/transformers@3.0.2
  tar -xzf huggingface-transformers-3.0.2.tgz
  diff -q package/dist/transformers.min.js extension/lib/transformers.min.js
  ```
  The `diff` should print nothing (byte-identical).

### `extension/lib/ort-wasm-simd-threaded.jsep.wasm`

- **Origin**: `onnxruntime-web`, bundled with the transformers.js
  package above (`@huggingface/transformers` v3.0.2 in turn pins
  `onnxruntime-web` v1.20.x).
- **Path inside the package**: `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm`
  after `npm install @huggingface/transformers@3.0.2`.
- **How to reproduce**:
  ```sh
  npm install @huggingface/transformers@3.0.2
  diff -q node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm \
          extension/lib/ort-wasm-simd-threaded.jsep.wasm
  ```

## What the extension does

- Captures pages the user dwells on (5+ seconds, at least one scroll).
- Embeds each page locally with Xenova/all-MiniLM-L6-v2 (int8) via
  transformers.js — model is downloaded once from huggingface.co and
  cached in IndexedDB.
- Fetches a news feed from
  `https://story-discovery-feed.digitalhen.workers.dev/feed.json`
  (a Cloudflare Worker we operate; the source for that Worker is at
  `worker/` in the public repo).
- Ranks feed articles against the user's recent history and shows
  recommendations both in an in-page popup and on a Discovery page.

No analytics, no remote logging, no third-party trackers. Embeddings
and page text never leave the device.

Repo: https://github.com/digitalhen/story-discovery-localai
MD

cd "$SRCDIR"
zip -qr "$SRC" lume-source

# ---- report ----
xpi_bytes=$(stat -f%z "$XPI" 2>/dev/null || stat -c%s "$XPI")
src_bytes=$(stat -f%z "$SRC" 2>/dev/null || stat -c%s "$SRC")
xpi_mb=$(awk "BEGIN { printf \"%.1f\", $xpi_bytes/1024/1024 }")
src_mb=$(awk "BEGIN { printf \"%.1f\", $src_bytes/1024/1024 }")
echo "wrote $XPI (${xpi_mb} MB)"
echo "wrote $SRC (${src_mb} MB)"
