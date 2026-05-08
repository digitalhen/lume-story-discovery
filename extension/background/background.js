import { warmUp, embed, isReady, modelName } from "./embedder.js";
import {
  initDB, putPage, getAllPages, countPages, clearAllPages,
  approxStorageBytes, addBlockedDomain, removeBlockedDomain,
  getBlockedDomains, isDomainBlocked,
} from "./storage.js";
import { loadCorpus, topMatch, recommend, isLoaded as corpusLoaded } from "./recommender.js";

const DEFAULT_BLOCKLIST = new Set([
  "gmail.com", "mail.google.com", "accounts.google.com",
  "localhost", "127.0.0.1",
]);

console.log("[disco] background starting");

(async () => {
  try {
    await initDB();
    console.log("[disco] db ready");
  } catch (e) {
    console.error("[disco] db init failed:", e);
  }
  // Warm in parallel; don't block message routing.
  warmUp().catch(() => {});
  loadCorpus().catch((e) => console.warn("[disco] corpus not loaded yet:", e?.message));
})();

browser.browserAction.onClicked.addListener(async () => {
  const url = browser.runtime.getURL("homepage/homepage.html");
  await browser.tabs.create({ url });
});

function shouldBlock(domain) {
  if (!domain) return true;
  for (const d of DEFAULT_BLOCKLIST) {
    if (domain === d || domain.endsWith("." + d)) return true;
  }
  if (/(^|\.)bank(\.|$)/i.test(domain)) return true;
  if (/banking/i.test(domain)) return true;
  return false;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg?.type) {
    case "ping":
      return Promise.resolve({ ok: true, ready: isReady(), corpus: corpusLoaded(), model: modelName() });

    case "preflight": {
      // Content script asks before extracting whether this site is allowed.
      const host = (() => { try { return new URL(msg.url).hostname; } catch { return null; } })();
      if (!host) return Promise.resolve({ allowed: false, reason: "bad-url" });
      if (shouldBlock(host)) return Promise.resolve({ allowed: false, reason: "default-blocklist" });
      return isDomainBlocked(host).then((muted) =>
        muted ? { allowed: false, reason: "user-muted" } : { allowed: true });
    }

    case "capture":
      return handleCapture(msg, sender).catch((e) => {
        console.error("[disco] capture failed:", e);
        return { ok: false, error: String(e) };
      });

    case "muteSite":
      return addBlockedDomain(msg.domain).then(() => ({ ok: true }));

    case "unmuteSite":
      return removeBlockedDomain(msg.domain).then(() => ({ ok: true }));

    case "getStats":
      return Promise.all([countPages(), approxStorageBytes(), getBlockedDomains()])
        .then(([count, bytes, blocked]) => ({
          count, bytes, blocked, model: modelName(),
          modelReady: isReady(), corpusReady: corpusLoaded(),
        }));

    case "getAllPages":
      return getAllPages().then((pages) =>
        pages.map((p) => ({ ...p, embedding: undefined })));

    case "getRecommendations":
      return handleRecommendations();

    case "clearAll":
      return clearAllPages().then(() => ({ ok: true }));
  }
  // Unknown message — return undefined so other listeners can handle it.
});

async function handleCapture(msg, sender) {
  const { url, title, text } = msg;
  if (!url || !text || text.length < 30) return { ok: false, reason: "no-text" };

  // Make sure model is up.
  await warmUp();

  const t0 = performance.now();
  const vec = await embed(text);
  const tEmbed = performance.now() - t0;

  let host = null;
  try { host = new URL(url).hostname; } catch {}

  await putPage({
    url,
    title: title || "",
    text,
    hostname: host,
    embedding: vec,
    timestamp: Date.now(),
  });

  // Find related corpus article (excluding the page itself, in case the
  // page is a Reuters article that's also in the corpus).
  let related = null;
  if (corpusLoaded()) {
    const m = topMatch(vec, { excludeUrls: [url] });
    if (m) {
      related = {
        title: m.article.title,
        url: m.article.url,
        source: m.article.source,
        score: m.score,
      };
    }
  }

  console.log(`[disco] captured ${url} (embed ${tEmbed.toFixed(0)} ms` +
    (related ? `, top match ${related.score.toFixed(3)}: ${related.title}` : "") + ")");

  return { ok: true, related, embedMs: tEmbed };
}

async function handleRecommendations() {
  await loadCorpus().catch(() => null);
  if (!corpusLoaded()) return { ok: false, reason: "corpus-not-loaded" };
  const sinceTs = Date.now() - 30 * 24 * 3600 * 1000;
  const pages = await getAllPages();
  const recent = pages
    .filter((p) => (p.timestamp ?? 0) >= sinceTs)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 200);
  const recs = recommend(recent, { count: 10 });
  return { ok: true, recommendations: recs, historyCount: recent.length };
}
