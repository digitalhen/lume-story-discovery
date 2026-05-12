# Lume — story discovery, local AI

A Firefox extension that watches what you read on the web, embeds those
pages locally on your device using a small sentence-transformer model
([`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
via [transformers.js](https://github.com/huggingface/transformers.js)),
and recommends related stories from a live news feed — with similarity
scoring and ranking that never leaves your browser.

After a one-time model download, everything involving your browsing —
page text, embeddings, history, scoring — happens locally. The only
outbound traffic is the periodic news-feed fetch (no user data sent)
and the initial model download.

## Architecture

- **`extension/`** — the Firefox extension. MV2, no build step. Content
  script captures dwelled-on pages; background script embeds them and
  runs MMR-diversified nearest-neighbor search against the live feed.
- **`worker/`** — a Cloudflare Worker that proxies NewsAPI. Pulls US
  top-headlines across general, technology, business, and science
  hourly, dedupes by URL, caches in KV, serves `/feed.json` with CORS.
  The NewsAPI key stays server-side; clients never see it.

## How it works

- A **content script** detects when you've dwelled on a page (5+ seconds
  with at least one scroll) and extracts a lightweight signal: title,
  H1s, description, og:title, og:description.
- A **background page** loads `Xenova/all-MiniLM-L6-v2` once on startup
  (cached in IndexedDB after first download) and embeds captured text
  locally.
- The **live feed** is fetched from the Worker on demand and on a 30-min
  background timer. Each new article gets embedded client-side on first
  encounter; vectors are cached in IndexedDB per article id and pruned
  when articles age out of the feed.
- An **in-page popup** slides in bottom-right and walks through three
  visible states — *Reading this page locally → Embedding → Read next* —
  annotated *"Because you read X"*.
- A **Discovery page** (toolbar icon) shows 10 stories matched to your
  recent browsing, diversified with greedy MMR (λ=0.7).

CSP locks `connect-src` to `huggingface.co` + `*.hf.co` (model download)
and the Worker URL (live feed) — those are the only outbound destinations
the extension can reach.

## Layout

```
extension/                          # Firefox extension (MV2)
├── manifest.json
├── config.js                       # FEED_URL — edit after deploying the worker
├── background/
│   ├── background.html             # ESM entry
│   ├── background.js               # message router, capture handler, periodic refresh
│   ├── embedder.js                 # transformers.js wrapper (q8 model)
│   ├── storage.js                  # IndexedDB: pages, blocklist, feed embeddings
│   └── recommender.js              # live feed loading, top-1 match, MMR
├── content/
│   ├── content-script.js           # dwell + scroll detection, extraction
│   ├── popup.js                    # in-page popup (closed shadow DOM)
│   └── popup.css
├── homepage/
│   ├── homepage.html               # Discovery page
│   ├── homepage.js
│   └── homepage.css
├── debug/
│   ├── debug.html                  # dev-only: inspect captured pages
│   └── debug.js
├── lib/                            # vendored transformers.js + ONNX wasm
└── icons/

worker/                             # Cloudflare Worker
├── src/index.js                    # scheduled + fetch handlers
├── wrangler.toml
└── README.md                       # deployment instructions

tools/
└── build-xpi.sh                    # produces dist/lume.xpi + dist/lume-source.zip
```

## Try it locally

0. Deploy the Worker first — see [`worker/README.md`](worker/README.md) —
   then paste its URL into `extension/config.js` as `FEED_URL`.
1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Pick `extension/manifest.json`
3. Open the Browser Console (Cmd+Shift+J) or Inspect the background page.
   Watch for `[disco] model ready (...)` — first load is ~25 MB from
   `huggingface.co`, cached after.
4. Browse a normal article (BBC, NYT, Wikipedia), dwell 5+ seconds,
   scroll once. Popup slides in.
5. Click the toolbar icon → Discovery page. After ~5 captures, the grid
   populates with recommendations.

## Build for AMO submission

```sh
./tools/build-xpi.sh
```

Produces:

- `dist/lume.xpi` — extension package (upload as the addon file).
- `dist/lume-source.zip` — source archive AMO reviewers need to verify
  the vendored `transformers.min.js` matches public npm source. Includes
  a `SOURCES.md` with byte-diff commands for each vendored file.

## Tech notes

- **Embedding model**: `Xenova/all-MiniLM-L6-v2`, int8 quantization
  (`dtype: 'q8'`), ~25 MB, 384-dim, mean-pooled and unit-normalized.
- **Cosine similarity** = dot product (vectors are normalized), no
  vector-DB library — just a tight loop over a single `Float32Array`.
- **transformers.js v3.0.2** vendored alongside the ONNX runtime WASM
  blob. No CDN dependency at runtime except the model itself.
- **Feed budget**: 4 NewsAPI requests × 24-hour cron = 96/day, under the
  free dev-tier 100/day cap.
- **No build step**, no React, no TypeScript, no bundler. Vanilla files
  end-to-end.

## License

MIT — see [LICENSE](LICENSE).
