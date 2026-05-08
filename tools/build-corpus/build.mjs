// Embed articles.json with Xenova/all-MiniLM-L6-v2 and emit the corpus
// file the extension expects at extension/data/reuters-corpus.json.
//
//   cd tools/build-corpus && npm install && node build.mjs

import { pipeline } from "@huggingface/transformers";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const SRC = resolve(REPO, "articles.json");
const DST = resolve(REPO, "extension", "data", "reuters-corpus.json");

const MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH = 32;
const MAX_BODY_CHARS = 280;

function bodyExcerpt(body) {
  const s = (body || "").replace(/\s+/g, " ").trim();
  if (s.length <= MAX_BODY_CHARS) return s;
  return s.slice(0, MAX_BODY_CHARS).replace(/\s+\S*$/, "") + "…";
}

function docText(a) {
  return [a.headline, a.description, a.body].filter(Boolean).join("\n\n");
}

async function main() {
  console.log(`reading ${SRC}`);
  const articles = JSON.parse(readFileSync(SRC, "utf8"));
  console.log(`loaded ${articles.length} articles`);

  console.log(`loading ${MODEL}`);
  const ex = await pipeline("feature-extraction", MODEL);

  const out = [];
  const t0 = Date.now();
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    const texts = batch.map(docText);
    const r = await ex(texts, { pooling: "mean", normalize: true });
    const dim = r.dims[1];
    for (let j = 0; j < batch.length; j++) {
      const a = batch[j];
      const v = r.data.slice(j * dim, (j + 1) * dim);
      out.push({
        id: a.id,
        title: a.headline,
        body_excerpt: bodyExcerpt(a.body),
        source: "Reuters",
        published_at: a.date,
        url: a.url ? `https://www.reuters.com${a.url}` : "",
        image_url: a.image_url || "",
        embedding: Array.from(v, (x) => Math.round(x * 1e6) / 1e6),
      });
    }
    const done = Math.min(i + BATCH, articles.length);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    process.stdout.write(`\rembedded ${done}/${articles.length} (${rate.toFixed(1)}/s)`);
  }
  process.stdout.write("\n");

  mkdirSync(dirname(DST), { recursive: true });
  writeFileSync(DST, JSON.stringify(out));
  const sizeMb = (JSON.parse(readFileSync(DST, "utf8")).length, // touch to confirm parseable
                  (Buffer.byteLength(readFileSync(DST)) / 1024 / 1024)).toFixed(2);
  console.log(`wrote ${out.length} records to ${DST} (${sizeMb} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
