# story-discovery-feed (Cloudflare Worker)

A tiny proxy + cache in front of [NewsAPI](https://newsapi.org). Clients
(the extension) hit this Worker for `/feed.json`; the Worker pulls from
NewsAPI on a 30-minute cron and serves the cached result. The NewsAPI
key stays server-side.

## Endpoints

- `GET /feed.json` — cached feed (JSON). Permissive CORS.
- `GET /refresh?token=…` — force a refresh now (requires `REFRESH_TOKEN`).

## Feed shape

```json
{
  "fetched_at": "2026-05-12T17:30:00.000Z",
  "source": "newsapi:top-headlines:us",
  "article_count": 38,
  "articles": [
    {
      "id": "abc123",              // stable FNV-1a hash of url
      "title": "...",
      "description": "...",
      "body_excerpt": "description · truncated content (no [+N chars] tail)",
      "source": "Reuters",
      "author": "...",
      "published_at": "2026-05-12T17:12:00Z",
      "url": "https://...",
      "image_url": "https://..."
    }
  ]
}
```

## One-time setup

```bash
cd worker
npm install
npx wrangler login

# Create the KV namespace and paste the returned id into wrangler.toml.
npx wrangler kv:namespace create FEED_KV

# Set secrets (you'll be prompted for each value):
npx wrangler secret put NEWSAPI_KEY
npx wrangler secret put REFRESH_TOKEN   # any random string

# Deploy
npx wrangler deploy
```

The deploy output prints the public URL, e.g.
`https://story-discovery-feed.<your-subdomain>.workers.dev`. Paste that
into `extension/config.js` as `FEED_URL`.

## Local dev

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars to add your NEWSAPI_KEY
npx wrangler dev
```

Then `curl http://localhost:8787/feed.json`.

## Refresh cadence

`crons = ["0 * * * *"]` in `wrangler.toml` — hourly. Each refresh makes
4 parallel NewsAPI calls (general, technology, business, science US
top-headlines), so 4 × 24 = 96 requests/day, under the dev-tier 100/day
limit. Articles are deduplicated by URL across slices and sorted by
`publishedAt` desc.
