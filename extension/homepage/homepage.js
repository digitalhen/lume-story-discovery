const $loading = document.getElementById("loading");
const $empty = document.getElementById("empty");
const $emptyCount = document.getElementById("empty-count");
const $grid = document.getElementById("grid");
const $stats = document.getElementById("stats");
const $clear = document.getElementById("clear");

const MIN_PAGES_FOR_RECS = 5;

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch { return ""; }
}

function scoreToPct(s) {
  // Cosine on normalized vectors lives in [-1,1] but in practice news embeddings
  // for related content cluster in [0.2, 0.8]. Map [0, 0.8] → [0, 100%] for
  // a more readable bar; clamp.
  const v = Math.max(0, Math.min(1, (s || 0) / 0.8));
  return v;
}

function renderCard({ article, score, becauseYouRead }) {
  const pct = scoreToPct(score);
  const pctText = `${(pct * 100).toFixed(0)}%`;
  return `
    <article class="card">
      <div class="src">
        <span>${escapeHtml(article.source || "Reuters")}</span>
        <span class="date">${escapeHtml(fmtDate(article.published_at))}</span>
      </div>
      <h2 class="title"><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener">${escapeHtml(article.title)}</a></h2>
      <p class="excerpt">${escapeHtml(article.body_excerpt || "")}</p>
      <div class="relevance" title="cosine similarity ${score.toFixed(3)}">
        <div class="bar"><span style="width: ${pct * 100}%"></span></div>
        <span class="pct">${pctText}</span>
      </div>
      <div class="because">
        Because you read: <a href="${escapeHtml(becauseYouRead.url)}" target="_blank" rel="noopener">${escapeHtml(becauseYouRead.title || becauseYouRead.url)}</a>
      </div>
    </article>
  `;
}

async function refresh() {
  $loading.hidden = false;
  $grid.hidden = true;
  $empty.hidden = true;

  const stats = await browser.runtime.sendMessage({ type: "getStats" });
  $stats.textContent =
    `${stats.count} pages embedded · ${fmtBytes(stats.bytes)} · ${stats.modelReady ? "model ready" : "model loading"}` +
    (stats.blocked.length ? ` · ${stats.blocked.length} muted site(s)` : "");

  if (stats.count < MIN_PAGES_FOR_RECS) {
    $emptyCount.textContent = String(stats.count);
    $loading.hidden = true;
    $empty.hidden = false;
    return;
  }

  const res = await browser.runtime.sendMessage({ type: "getRecommendations" });
  if (!res?.ok) {
    $loading.textContent = `Couldn't load recommendations (${res?.reason || "unknown"}).`;
    return;
  }
  $grid.innerHTML = res.recommendations.map(renderCard).join("");
  $loading.hidden = true;
  $grid.hidden = false;
}

$clear.addEventListener("click", async () => {
  if (!confirm("Delete all captured page records? Your browsing history is not affected.")) return;
  await browser.runtime.sendMessage({ type: "clearAll" });
  await refresh();
});

refresh();
