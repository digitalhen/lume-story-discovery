// Cached proxy in front of NewsAPI top-headlines.
//
// - Scheduled handler refreshes the feed every 30 minutes and writes it to KV.
// - Fetch handler serves the cached blob with permissive CORS so the extension
//   (and any other browser client) can hit it directly.
//
// The NewsAPI key never leaves the Worker.

// Four NewsAPI top-headlines slices, merged + deduped. 4 reqs/hour × 24 = 96/day,
// safely under the dev-tier 100/day limit.
const FEED_QUERIES = [
  { label: "general", url: "https://newsapi.org/v2/top-headlines?country=us&pageSize=100" },
  { label: "technology", url: "https://newsapi.org/v2/top-headlines?country=us&category=technology&pageSize=100" },
  { label: "business", url: "https://newsapi.org/v2/top-headlines?country=us&category=business&pageSize=100" },
  { label: "science", url: "https://newsapi.org/v2/top-headlines?country=us&category=science&pageSize=100" },
];
const KV_KEY = "feed:current";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshFeed(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/" || url.pathname === "/feed.json") {
      let cached = await env.FEED_KV.get(KV_KEY);
      if (!cached) {
        // Cold start — populate KV inline.
        const fresh = await refreshFeed(env);
        cached = JSON.stringify(fresh);
      }
      return new Response(cached, { headers: corsHeaders("application/json") });
    }

    // Manual refresh trigger (handy for testing). Requires REFRESH_TOKEN secret.
    if (url.pathname === "/refresh") {
      const token = url.searchParams.get("token") || "";
      if (!env.REFRESH_TOKEN || token !== env.REFRESH_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const fresh = await refreshFeed(env);
      return new Response(JSON.stringify(fresh), {
        headers: corsHeaders("application/json"),
      });
    }

    return new Response("not found", { status: 404 });
  },
};

async function refreshFeed(env) {
  const settled = await Promise.allSettled(
    FEED_QUERIES.map((q) => fetchSlice(q, env))
  );

  const byUrl = new Map();
  const counts = {};
  const errors = [];
  for (let i = 0; i < settled.length; i++) {
    const q = FEED_QUERIES[i];
    const s = settled[i];
    if (s.status !== "fulfilled") {
      errors.push({ slice: q.label, error: String(s.reason).slice(0, 200) });
      counts[q.label] = 0;
      continue;
    }
    counts[q.label] = s.value.length;
    // First slice to mention an article wins (preserves NewsAPI's per-slice ranking).
    for (const a of s.value) {
      if (a.url && !byUrl.has(a.url)) {
        byUrl.set(a.url, { ...a, _slice: q.label });
      }
    }
  }

  const articles = Array.from(byUrl.values()).sort(
    (a, b) => (b.published_at || "").localeCompare(a.published_at || "")
  );

  const out = {
    fetched_at: new Date().toISOString(),
    source: "newsapi:top-headlines:us:multi",
    slices: counts,
    errors: errors.length ? errors : undefined,
    article_count: articles.length,
    articles,
  };

  await env.FEED_KV.put(KV_KEY, JSON.stringify(out));
  return out;
}

async function fetchSlice({ url }, env) {
  const res = await fetch(url, {
    headers: {
      "X-Api-Key": env.NEWSAPI_KEY,
      "User-Agent": "story-discovery-localai/0.1 (+https://github.com/digitalhen/story-discovery-localai)",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsAPI ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.articles || []).map(normalize).filter(Boolean);
}

function normalize(a) {
  if (!a || !a.url || !a.title) return null;
  const snippet = stripContentTail(a.content);
  return {
    id: fnv1a(a.url),
    title: a.title,
    description: a.description || "",
    body_excerpt: [a.description, snippet].filter(Boolean).join(" · "),
    source: (a.source && a.source.name) || "",
    author: a.author || "",
    published_at: a.publishedAt || "",
    url: a.url,
    image_url: a.urlToImage || "",
  };
}

// NewsAPI free tier truncates `content` and adds e.g. " [+1234 chars]".
function stripContentTail(c) {
  if (!c) return "";
  return c.replace(/\s*\[\+\d+\s*chars\]\s*$/i, "").trim();
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function corsHeaders(contentType) {
  const h = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "public, max-age=60",
  };
  if (contentType) h["content-type"] = `${contentType}; charset=utf-8`;
  return h;
}
