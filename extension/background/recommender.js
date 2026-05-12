// Live feed loading + nearest-neighbor matching + MMR diversification.
//
// The feed is fetched from our Worker proxy (see worker/), which caches NewsAPI
// top-headlines. Articles arrive without embeddings; we embed them client-side
// on first encounter and cache the vectors in IndexedDB keyed by article id.

import { FEED_URL } from "../config.js";
import { embedBatch } from "./embedder.js";
import {
  getFeedEmbeddings, putFeedEmbeddings, pruneFeedEmbeddings,
} from "./storage.js";

const DIM = 384;
// Min freshness: don't refetch the feed more often than this from the same
// background context. The Worker also caches with its own cadence.
const FEED_TTL_MS = 5 * 60 * 1000;

let corpus = null;          // [{ id, title, body_excerpt, source, published_at, url, image_url, embedding (Float32Array) }]
let corpusVectors = null;    // Float32Array of length corpus.length * DIM
let loadPromise = null;
let lastLoadedAt = 0;

export function isLoaded() { return corpus !== null; }
export function corpusSize() { return corpus ? corpus.length : 0; }
export function feedAge() {
  return lastLoadedAt ? Date.now() - lastLoadedAt : null;
}

function docText(a) {
  return [a.title, a.description, a.body_excerpt].filter(Boolean).join("\n\n");
}

export async function loadCorpus({ force = false } = {}) {
  if (corpus && !force && Date.now() - lastLoadedAt < FEED_TTL_MS) return corpus;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const t0 = performance.now();
    const res = await fetch(FEED_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
    const feed = await res.json();
    const articles = Array.isArray(feed.articles) ? feed.articles : [];
    if (!articles.length) throw new Error("feed has no articles");

    const ids = articles.map((a) => a.id);
    const cached = await getFeedEmbeddings(ids);

    // Embed any article we don't already have a vector for.
    const missing = [];
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const v = cached.get(a.id);
      if (v && v.length === DIM) {
        a.embedding = v;
      } else {
        missing.push(i);
      }
    }
    if (missing.length) {
      const tEmbed = performance.now();
      const vectors = await embedBatch(missing.map((i) => docText(articles[i])));
      for (let k = 0; k < missing.length; k++) {
        articles[missing[k]].embedding = vectors[k];
      }
      await putFeedEmbeddings(
        missing.map((i, k) => ({ id: articles[i].id, embedding: vectors[k] }))
      );
      console.log(
        `[disco] embedded ${missing.length} new feed articles in ` +
        `${(performance.now() - tEmbed).toFixed(0)} ms`
      );
    }

    // Pack into a contiguous Float32Array for fast dot products.
    corpus = articles;
    corpusVectors = new Float32Array(articles.length * DIM);
    for (let i = 0; i < articles.length; i++) {
      const v = articles[i].embedding;
      if (!v || v.length !== DIM) throw new Error(`bad embedding for ${articles[i].id}`);
      corpusVectors.set(v, i * DIM);
      articles[i].embedding = corpusVectors.subarray(i * DIM, (i + 1) * DIM);
    }
    lastLoadedAt = Date.now();

    // GC stale cached embeddings for articles that have aged out of the feed.
    pruneFeedEmbeddings(ids).catch(() => {});

    console.log(
      `[disco] feed loaded: ${articles.length} articles ` +
      `(${missing.length} new, ${articles.length - missing.length} cached) ` +
      `in ${(performance.now() - t0).toFixed(0)} ms`
    );
    return corpus;
  })().finally(() => { loadPromise = null; });
  return loadPromise;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

function normalizeUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/$/, "").toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

// Nearest article in the corpus to a single query vector.
// opts.excludeUrls: Iterable of URLs to skip (e.g., the current page).
export function topMatch(queryVec, opts = {}) {
  if (!corpus) return null;
  const excluded = new Set(
    Array.from(opts.excludeUrls || []).map(normalizeUrl).filter(Boolean)
  );
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < corpus.length; i++) {
    if (excluded.has(normalizeUrl(corpus[i].url))) continue;
    const s = dot(queryVec, corpus[i].embedding);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  return { article: corpus[bestIdx], score: bestScore };
}

// Top-K candidates against the corpus.
function topK(queryVec, k) {
  const heap = [];
  for (let i = 0; i < corpus.length; i++) {
    const s = dot(queryVec, corpus[i].embedding);
    if (heap.length < k) {
      heap.push({ idx: i, score: s });
      if (heap.length === k) heap.sort((a, b) => a.score - b.score);
    } else if (s > heap[0].score) {
      heap[0] = { idx: i, score: s };
      // re-sort small array — fine for k≈30
      heap.sort((a, b) => a.score - b.score);
    }
  }
  heap.sort((a, b) => b.score - a.score);
  return heap;
}

/**
 * Discovery recommendations.
 *
 * @param {Array} historyPages — page records with .embedding (Float32Array), .title, .url
 * @param {{ count?: number, lambda?: number, candidatePool?: number }} opts
 * @returns {Array<{ article, score, becauseYouRead: { title, url } }>}
 */
export function recommend(historyPages, opts = {}) {
  const count = opts.count ?? 10;
  const lambda = opts.lambda ?? 0.7;
  const pool = opts.candidatePool ?? 30;

  if (!corpus || !historyPages || historyPages.length === 0) return [];

  // Skip any corpus article whose URL the user has already captured.
  const seen = new Set(historyPages.map((p) => normalizeUrl(p.url)).filter(Boolean));

  // For each corpus article, find max similarity to any history page,
  // and remember which history page produced that max.
  const N = corpus.length;
  const bestScore = new Float32Array(N);
  const bestHistoryIdx = new Int32Array(N);
  for (let i = 0; i < N; i++) bestScore[i] = -Infinity;

  for (let h = 0; h < historyPages.length; h++) {
    const hv = historyPages[h].embedding;
    if (!hv || hv.length !== DIM) continue;
    for (let i = 0; i < N; i++) {
      const s = dot(hv, corpus[i].embedding);
      if (s > bestScore[i]) {
        bestScore[i] = s;
        bestHistoryIdx[i] = h;
      }
    }
  }

  // Top P candidates by bestScore, dropping any the user has already read.
  const candidates = [];
  for (let i = 0; i < N; i++) {
    if (seen.has(normalizeUrl(corpus[i].url))) continue;
    candidates.push({ idx: i, score: bestScore[i] });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, pool);

  // Greedy MMR
  const selected = [];
  const remaining = top.slice();
  while (selected.length < count && remaining.length) {
    let bestI = 0;
    let bestVal = -Infinity;
    for (let r = 0; r < remaining.length; r++) {
      const cand = remaining[r];
      let maxSimToSelected = 0;
      for (const s of selected) {
        const sim = dot(corpus[cand.idx].embedding, corpus[s.idx].embedding);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSimToSelected;
      if (mmr > bestVal) { bestVal = mmr; bestI = r; }
    }
    selected.push(remaining[bestI]);
    remaining.splice(bestI, 1);
  }

  return selected.map(({ idx, score }) => ({
    article: corpus[idx],
    score,
    becauseYouRead: {
      title: historyPages[bestHistoryIdx[idx]].title,
      url: historyPages[bestHistoryIdx[idx]].url,
    },
  }));
}
