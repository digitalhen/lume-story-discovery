# Semantic search over Reuters — POCs

Two related demos of fully on-device semantic search and content discovery
over a corpus of ~1000 Reuters news articles, using
[`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
embeddings via [transformers.js](https://github.com/huggingface/transformers.js).

After a one-time model download from HuggingFace, **no further network
calls leave the machine** — articles, embeddings, and similarity search
all run in the browser.

The repo contains two artifacts on two branches:

| Branch | What it is |
|---|---|
| `main` | A browser POC: search box → top-N hits, with side-by-side semantic / BM25 / RRF-hybrid columns. |
| `firefox-extension` | A Firefox WebExtension that captures pages as you browse, embeds them locally, and recommends related Reuters stories — both as an in-page popup and a "Discovery" page. |

## `main` — the browser POC

A single HTML page that loads `articles.json` (995 Reuters articles) and
embeds each one in the browser the first time you open the page. Embeddings
are cached in IndexedDB so reloads are instant.

The query box runs three retrieval methods over the same corpus and shows
results side by side:

- **Semantic** — cosine similarity over MiniLM embeddings.
- **BM25** — pure lexical baseline, in-memory inverted index.
- **Hybrid (RRF)** — Reciprocal Rank Fusion over the top-100 from each
  side, no score normalization needed.

Articles that appear in both the semantic and BM25 top-20 get a red
left-border so it's easy to see where the two methods agree.

### Run

```sh
python3 -m http.server 9876
# open http://localhost:9876
```

First load takes a couple of minutes to encode the corpus
(~995 docs × 384 dims). After that, search is instant.

### Files

```
index.html              # UI shell, three result columns
app.js                  # corpus loading, MiniLM encoder, BM25, RRF, render
articles.json           # 995 trimmed Reuters articles (~3 MB)
prepare_articles.py     # flattens raw paginated JSON dump into articles.json
```

## `firefox-extension` — the discovery extension

A Manifest V2 Firefox extension that demonstrates fully-local content
discovery as you browse the regular web.

- A **content script** detects when you've dwelled on a page (5+ seconds
  with at least one scroll) and extracts a lightweight signal: title,
  H1s, description, og:title, og:description.
- A **background page** loads `Xenova/all-MiniLM-L6-v2` once on startup
  (cached in IndexedDB after first download), embeds the captured text,
  stores the page record, and looks up the nearest Reuters article from
  a pre-loaded corpus.
- An **in-page popup** slides in bottom-right and walks through three
  visible states — *Reading this page locally → Embedding → Read next* —
  with a "Nothing leaves your device" caption. The visible local-processing
  state is intentional: it's the demo, not a loading spinner.
- A **Discovery page** (toolbar icon) shows 10 Reuters stories matched
  to your recent browsing, diversified with greedy MMR (λ=0.7) and
  annotated *"Because you read X"*.

CSP allows only `huggingface.co` and `*.hf.co` (HuggingFace's Xet storage
backend) — the model download is the only outbound traffic.

### Layout

```
extension/
├── manifest.json                 # MV2, CSP, permissions
├── background/
│   ├── background.html           # ESM entry for module imports
│   ├── background.js             # message router, capture handler
│   ├── embedder.js               # transformers.js wrapper, q8 model
│   ├── storage.js                # IndexedDB: pages + blocklist
│   └── recommender.js            # corpus loading, top-1, MMR
├── content/
│   ├── content-script.js         # dwell + scroll detection, extraction
│   ├── popup.js                  # in-page popup (closed shadow DOM)
│   └── popup.css                 # (also inlined in popup.js for reliability)
├── homepage/
│   ├── homepage.html             # Discovery page
│   ├── homepage.js
│   └── homepage.css
├── debug/
│   ├── debug.html                # dev-only: inspect captured pages
│   └── debug.js
├── data/
│   └── reuters-corpus.json       # 995 articles + 384-dim embeddings (~4 MB)
├── lib/
│   ├── transformers.min.js       # vendored
│   └── ort-wasm-simd-threaded.jsep.wasm   # vendored ONNX runtime WASM
└── icons/icon-{16,32,48,128}.png
```

### Try it locally

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Pick `extension/manifest.json`
3. Open the Browser Console (Cmd+Shift+J) or Inspect the background page.
   Watch for `[disco] model ready (...)` — first load is ~25 MB from
   `huggingface.co`, cached after.
4. Browse a normal article (BBC, NYT, Wikipedia), dwell 5+ seconds, scroll once.
   Popup slides in.
5. Click the toolbar icon → Discovery page. After ~5 captures, the grid
   populates with recommendations.

### Build a shareable XPI

```sh
./tools/build-xpi.sh
# → dist/local-discovery.xpi
# → dist/INSTALL.md (instructions for the recipient)
```

The XPI is unsigned, so it loads as a *temporary* add-on (auto-removes on
Firefox restart). For permanent install you'd need to sign through AMO.

## Tools

```
tools/
├── build-corpus/                 # node script — embeds articles.json into
│   ├── build.mjs                 # extension/data/reuters-corpus.json,
│   └── package.json              # using @huggingface/transformers v3.0.2
└── build-xpi.sh                  # zips extension/ into dist/local-discovery.xpi
```

To regenerate the corpus (only needed if `articles.json` changes):

```sh
cd tools/build-corpus && npm install && node build.mjs
```

## Tech notes

- **Embedding model**: `Xenova/all-MiniLM-L6-v2`, int8 quantization
  (`dtype: 'q8'`), ~25 MB, 384-dim, mean-pooled and unit-normalized.
- **Cosine similarity** = dot product (vectors are normalized), no vector
  DB library — just a tight loop over a single Float32Array.
- **transformers.js v3.0.2** vendored alongside the ONNX runtime WASM blob.
  No CDN dependency at runtime except the model itself.
- **No build step**, no React, no TypeScript, no bundler. Vanilla files
  end-to-end.

## Caveats

- The **`main`-branch POC** was built with `articles.json` only and does
  in-browser encoding (fp32 by default in transformers.js v3). The
  **extension** uses int8 (`dtype: 'q8'`) for ~3-4× faster cold start.
  The corpus on disk was built with fp32; query/doc cosine drift between
  fp32 and q8 is small (~<0.02 for related items) but they're not
  guaranteed identical. Rebuild the corpus with `dtype: 'q8'` for clean
  methodology if it matters.
- **CSP** allows `https://*.hf.co` because HuggingFace serves model blobs
  through a separate `cas-bridge.xethub.hf.co` (Xet storage) — the
  original `huggingface.co`-only CSP blocked the redirect.
- The XPI is unsigned. For non-developer users, signing through AMO is the
  right path for a real release.
