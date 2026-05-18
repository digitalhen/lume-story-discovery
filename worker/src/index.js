// Cached proxy in front of Pocket's public GraphQL API (getSections).
//
// - Scheduled handler refreshes the feed periodically and writes it to KV.
// - Fetch handler serves the cached blob with permissive CORS so the extension
//   (and any other browser client) can hit it directly.
//
// No API key required — uses Firefox's well-known public consumer_key.

const POCKET_API = "https://client-api.getpocket.com";
const POCKET_SURFACE = "NEW_TAB_EN_US";

const SECTIONS_QUERY = `query GetSections($filters: SectionFilters!) {
  getSections(filters: $filters) {
    title
    sectionItems {
      corpusItem {
        id url title excerpt publisher topic
        imageUrl datePublished isTimeSensitive
        timeToRead
        authors { name }
      }
    }
  }
}`;

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
  const res = await fetch(POCKET_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apollographql-client-name": "lume-story-discovery",
      "apollographql-client-version": "0.1.0",
    },
    body: JSON.stringify({
      query: SECTIONS_QUERY,
      variables: { filters: { scheduledSurfaceGuid: POCKET_SURFACE } },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pocket API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Pocket GraphQL: ${json.errors[0].message}`);

  const sections = json.data?.getSections;
  if (!Array.isArray(sections)) throw new Error("unexpected Pocket response shape");

  // Flatten sections → articles, deduping by URL, skipping A/B test sections.
  const byUrl = new Map();
  for (const section of sections) {
    if (/__exp/.test(section.title)) continue;
    for (const si of section.sectionItems || []) {
      const a = normalize(si.corpusItem, section.title);
      if (a && !byUrl.has(a.url)) byUrl.set(a.url, a);
    }
  }

  const articles = Array.from(byUrl.values());

  const out = {
    fetched_at: new Date().toISOString(),
    source: "pocket:getSections:" + POCKET_SURFACE,
    article_count: articles.length,
    articles,
  };

  await env.FEED_KV.put(KV_KEY, JSON.stringify(out));
  return out;
}

function normalize(item, sectionTitle) {
  if (!item || !item.url || !item.title) return null;
  return {
    id: item.id,
    title: item.title,
    description: item.excerpt || "",
    body_excerpt: item.excerpt || "",
    source: item.publisher || "",
    author: (item.authors || []).map((a) => a.name).join(", "),
    published_at: item.datePublished || "",
    url: item.url,
    image_url: item.imageUrl || "",
    topic: item.topic || null,
    section: sectionTitle,
  };
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
