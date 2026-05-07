import {
  pipeline,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js";

env.allowLocalModels = false;

const MODEL = "Xenova/all-MiniLM-L6-v2";
const DIM = 384;
const BATCH = 16;
const TOP_K = 20;
const RRF_POOL = 100; // candidates per system fed into RRF
const RRF_K = 60;     // standard RRF constant
const DB_NAME = "semantic-search-poc";
const DB_VERSION = 1;
const STORE = "kv";

const $status = document.getElementById("status");
const $bar = $status.querySelector(".bar");
const $barFill = $bar.querySelector("div");
const $q = document.getElementById("q");
const $resultsSem = document.getElementById("results-sem");
const $resultsHybrid = document.getElementById("results-hybrid");
const $resultsBm25 = document.getElementById("results-bm25");
const $count = document.getElementById("count");
const $reindex = document.getElementById("reindex");

function setStatus(msg, progress) {
  $status.firstChild.textContent = msg;
  if (progress == null) {
    $bar.style.display = "none";
  } else {
    $bar.style.display = "block";
    $barFill.style.width = `${(progress * 100).toFixed(1)}%`;
  }
}

// ---------- IndexedDB ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Articles + embedding ----------
function docText(a) {
  // Headline + description + body, the tokenizer will truncate to 256.
  return [a.headline, a.description, a.body].filter(Boolean).join("\n\n");
}

async function loadArticles() {
  setStatus("Loading articles…");
  const res = await fetch("./articles.json");
  if (!res.ok) throw new Error(`Failed to load articles.json (${res.status})`);
  return await res.json();
}

let extractor = null;
async function getExtractor() {
  if (extractor) return extractor;
  setStatus("Loading model (≈25 MB, cached after first load)…", 0);
  extractor = await pipeline("feature-extraction", MODEL, {
    progress_callback: (p) => {
      if (p.status === "progress" && p.total) {
        setStatus(`Loading model: ${p.file}`, p.loaded / p.total);
      }
    },
  });
  return extractor;
}

async function embed(texts) {
  const ex = await getExtractor();
  const out = await ex(texts, { pooling: "mean", normalize: true });
  // out.data is a Float32Array of shape [texts.length, DIM]
  return out.data;
}

async function buildIndex(articles) {
  const ex = await getExtractor();
  const t0 = performance.now();
  const buf = new Float32Array(articles.length * DIM);
  for (let i = 0; i < articles.length; i += BATCH) {
    const slice = articles.slice(i, i + BATCH).map(docText);
    const out = await ex(slice, { pooling: "mean", normalize: true });
    buf.set(out.data, i * DIM);
    const done = Math.min(i + BATCH, articles.length);
    const elapsed = (performance.now() - t0) / 1000;
    const rate = done / elapsed;
    const eta = (articles.length - done) / rate;
    setStatus(
      `Encoding articles: ${done}/${articles.length} (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s)`,
      done / articles.length,
    );
    await new Promise((r) => setTimeout(r)); // yield to UI
  }
  return buf;
}

async function getOrBuildVectors(articles) {
  const meta = await idbGet("meta");
  const stored = await idbGet("vectors");
  const ids = articles.map((a) => a.id).join(",");
  const fingerprint = `${MODEL}|${articles.length}|${ids.length}`;
  if (
    meta &&
    stored &&
    meta.fingerprint === fingerprint &&
    stored.byteLength === articles.length * DIM * 4
  ) {
    return new Float32Array(stored);
  }
  const buf = await buildIndex(articles);
  await idbPut("meta", { fingerprint, model: MODEL, dim: DIM, count: articles.length });
  await idbPut("vectors", buf.buffer);
  return buf;
}

// ---------- BM25 ----------
const STOP = new Set([
  "a","an","and","are","as","at","be","but","by","for","from","has","have","he",
  "her","his","i","in","is","it","its","of","on","or","she","that","the","their",
  "them","they","this","to","was","were","will","with","you","your","we","our",
  "us","not","no","do","does","did","been","than","then","so","if","into","over",
  "about","after","before","up","down","out","also","more","most","such","can",
]);

function tokenize(text) {
  const m = text.toLowerCase().match(/[a-z0-9]+/g);
  if (!m) return [];
  const out = [];
  for (const t of m) if (t.length > 1 && !STOP.has(t)) out.push(t);
  return out;
}

function buildBM25(articles) {
  const N = articles.length;
  const docs = new Array(N);
  const df = new Map();
  let totalLen = 0;
  for (let i = 0; i < N; i++) {
    const tokens = tokenize(docText(articles[i]));
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docs[i] = { tf, len: tokens.length };
    totalLen += tokens.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgdl = totalLen / N;
  const postings = new Map();
  for (let i = 0; i < N; i++) {
    for (const [t, c] of docs[i].tf) {
      let p = postings.get(t);
      if (!p) { p = []; postings.set(t, p); }
      p.push(i, c);
    }
  }
  return { N, df, avgdl, docs, postings };
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function bm25Search(query, idx, k) {
  const qtokens = [...new Set(tokenize(query))];
  const scores = new Float32Array(idx.N);
  for (const t of qtokens) {
    const post = idx.postings.get(t);
    if (!post) continue;
    const docFreq = post.length / 2;
    const idfVal = Math.log((idx.N - docFreq + 0.5) / (docFreq + 0.5) + 1);
    for (let p = 0; p < post.length; p += 2) {
      const i = post[p];
      const tf = post[p + 1];
      const dl = idx.docs[i].len;
      const num = tf * (BM25_K1 + 1);
      const den = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / idx.avgdl);
      scores[i] += idfVal * (num / den);
    }
  }
  const hits = [];
  for (let i = 0; i < idx.N; i++) if (scores[i] > 0) hits.push(i);
  hits.sort((a, b) => scores[b] - scores[a]);
  return hits.slice(0, k).map((i) => ({ i, score: scores[i] }));
}

// ---------- Hybrid (Reciprocal Rank Fusion) ----------
function rrfFuse(rankings, k, kConst = RRF_K) {
  // rankings: array of arrays of { i, score } already sorted desc.
  const fused = new Map();
  for (const list of rankings) {
    for (let rank = 0; rank < list.length; rank++) {
      const i = list[rank].i;
      const contrib = 1 / (kConst + rank + 1);
      fused.set(i, (fused.get(i) || 0) + contrib);
    }
  }
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([i, score]) => ({ i, score }));
}

// ---------- Semantic search ----------
function topK(query, vectors, k, count) {
  // vectors is a flat Float32Array of length count*DIM (all unit-normalized).
  // query is a Float32Array of length DIM (unit-normalized).
  // cosine similarity = dot product.
  const scores = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let s = 0;
    const off = i * DIM;
    for (let j = 0; j < DIM; j++) s += vectors[off + j] * query[j];
    scores[i] = s;
  }
  // partial top-k via simple sort of indices (n=995 is fine)
  const idx = Array.from({ length: count }, (_, i) => i);
  idx.sort((a, b) => scores[b] - scores[a]);
  return idx.slice(0, k).map((i) => ({ i, score: scores[i] }));
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderHits(hits, articles, target, sharedIds) {
  if (!hits.length) {
    target.innerHTML = "<p style='color:var(--muted); margin:0;'>No results.</p>";
    return;
  }
  target.innerHTML = hits.map(({ i, score }) => {
    const a = articles[i];
    const date = a.date ? new Date(a.date).toISOString().slice(0, 10) : "";
    const url = a.url ? `https://www.reuters.com${a.url}` : "#";
    const meta = [a.section, date, a.byline].filter(Boolean).join(" · ");
    const cls = sharedIds && sharedIds.has(i) ? "hit shared" : "hit";
    return `
      <div class="${cls}">
        <span class="score">${score.toFixed(3)}</span>
        <h3><a href="${url}" target="_blank" rel="noopener">${escapeHtml(a.headline)}</a></h3>
        <div class="meta">${escapeHtml(meta)}</div>
        <div class="desc">${escapeHtml(a.description || a.body.slice(0, 240) + "…")}</div>
      </div>
    `;
  }).join("");
}

// ---------- Boot ----------
let ARTICLES = [];
let VECTORS = null;
let BM25 = null;
let searchSeq = 0;

async function boot() {
  ARTICLES = await loadArticles();
  $count.textContent = `${ARTICLES.length} articles`;
  setStatus("Building BM25 index…");
  const tBM = performance.now();
  BM25 = buildBM25(ARTICLES);
  console.log(`BM25 indexed in ${(performance.now() - tBM).toFixed(0)} ms`);
  VECTORS = await getOrBuildVectors(ARTICLES);
  setStatus(`Ready · ${ARTICLES.length} articles indexed (${MODEL} + BM25)`);
  $q.disabled = false;
  $q.focus();
}

function clearResults() {
  $resultsSem.innerHTML = "";
  $resultsHybrid.innerHTML = "";
  $resultsBm25.innerHTML = "";
}

$q.addEventListener("input", async () => {
  const q = $q.value.trim();
  if (!q) { clearResults(); return; }
  const seq = ++searchSeq;
  const t0 = performance.now();
  const qvec = await embed([q]);
  if (seq !== searchSeq) return; // stale
  const tEmbed = performance.now() - t0;

  // Pull a deeper pool from each so RRF has room to rerank, then trim to TOP_K for display.
  const semPool = topK(qvec, VECTORS, RRF_POOL, ARTICLES.length);
  const bmPool = bm25Search(q, BM25, RRF_POOL);
  const hybridHits = rrfFuse([semPool, bmPool], TOP_K);
  const semHits = semPool.slice(0, TOP_K);
  const bmHits = bmPool.slice(0, TOP_K);

  const semIds = new Set(semHits.map((h) => h.i));
  const bmIds = new Set(bmHits.map((h) => h.i));
  const shared = new Set([...semIds].filter((x) => bmIds.has(x)));

  renderHits(semHits, ARTICLES, $resultsSem, shared);
  renderHits(hybridHits, ARTICLES, $resultsHybrid, shared);
  renderHits(bmHits, ARTICLES, $resultsBm25, shared);

  const ms = (performance.now() - t0).toFixed(0);
  setStatus(
    `Ready · ${ARTICLES.length} articles · search ${ms} ms ` +
    `(embed ${tEmbed.toFixed(0)} ms) · ${shared.size}/${TOP_K} sem∩bm25`,
  );
});

$reindex.addEventListener("click", async () => {
  if (!confirm("Delete cached embeddings and re-encode all articles?")) return;
  await idbDel("vectors");
  await idbDel("meta");
  $q.disabled = true;
  VECTORS = await getOrBuildVectors(ARTICLES);
  $q.disabled = false;
  setStatus(`Ready · ${ARTICLES.length} articles re-indexed`);
});

boot().catch((e) => {
  console.error(e);
  setStatus(`Error: ${e.message}`);
});
