const $loading = document.getElementById("loading");
const $empty = document.getElementById("empty");
const $emptyCount = document.getElementById("empty-count");
const $grid = document.getElementById("grid");
const $stats = document.getElementById("stats");
const $clear = document.getElementById("clear");
const $mutedSection = document.getElementById("muted-section");
const $mutedList = document.getElementById("muted-list");

const MIN_PAGES_FOR_RECS = 5;

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

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
  // for related content cluster in [0.2, 0.8]. Map [0, 0.8] → [0, 100%].
  return Math.max(0, Math.min(1, (s || 0) / 0.8));
}

// Deterministic gradient from a string, used as a placeholder when an article
// has no image.
function colorFromString(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 50) % 360} 80% 35%))`;
}

function thumbHtml(article) {
  const initial = ((article.title || "·").trim()[0] || "·").toUpperCase();
  if (article.image_url) {
    // Inline-styled gradient as fallback colour visible behind the loading image.
    return `<div class="thumb" style="background: ${colorFromString(article.title || article.id)}" data-fallback="${escapeAttr(initial)}">
      <img src="${escapeAttr(article.image_url)}" alt="" loading="lazy" />
    </div>`;
  }
  return `<div class="thumb" style="background: ${colorFromString(article.title || article.id)}">
    <div class="placeholder">${escapeHtml(initial)}</div>
  </div>`;
}

function attachCardListeners() {
  // Image error → swap in initial-letter placeholder.
  $grid.querySelectorAll(".card .thumb img").forEach((img) => {
    img.addEventListener("error", () => {
      const thumb = img.closest(".thumb");
      if (!thumb) return;
      const init = thumb.dataset.fallback || "·";
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = init;
      img.replaceWith(ph);
    });
  });
  // Inner "because" link should not bubble to the card's outer <a>.
  $grid.querySelectorAll(".because a").forEach((a) => {
    a.addEventListener("click", (e) => e.stopPropagation());
  });
}

function renderCard({ article, score, becauseYouRead }, opts = {}) {
  const featured = !!opts.featured;
  const pct = scoreToPct(score);
  const pctText = `${(pct * 100).toFixed(0)}%`;

  return `
    <a class="card${featured ? " featured" : ""}" href="${escapeAttr(article.url)}" target="_blank" rel="noopener">
      ${thumbHtml(article)}
      <div class="body">
        <h2 class="title">${escapeHtml(article.title)}</h2>
        ${featured ? `<p class="excerpt">${escapeHtml(article.body_excerpt || "")}</p>` : ""}
        <div class="relevance" title="cosine similarity ${score.toFixed(3)}">
          <div class="bar"><span style="width: ${pct * 100}%"></span></div>
          <span class="pct">${pctText}</span>
        </div>
        <div class="footer">
          <span class="src-pill"><span class="src-mark">R</span>${escapeHtml(article.source || "Reuters")}</span>
          <span class="date">${escapeHtml(fmtDate(article.published_at))}</span>
          <p class="because">Because you read <a href="${escapeAttr(becauseYouRead.url)}" target="_blank" rel="noopener">${escapeHtml(becauseYouRead.title || becauseYouRead.url)}</a></p>
        </div>
      </div>
    </a>
  `;
}

function renderMuted(domains) {
  if (!domains?.length) {
    $mutedSection.hidden = true;
    return;
  }
  $mutedSection.hidden = false;
  $mutedList.innerHTML = domains.map((d) =>
    `<li>${escapeHtml(d)} <button data-domain="${escapeAttr(d)}" aria-label="Unmute ${escapeHtml(d)}">×</button></li>`
  ).join("");
}

$mutedList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-domain]");
  if (!btn) return;
  await browser.runtime.sendMessage({ type: "unmuteSite", domain: btn.dataset.domain });
  refresh();
});

async function refresh() {
  $loading.hidden = false;
  $grid.hidden = true;
  $empty.hidden = true;

  const stats = await browser.runtime.sendMessage({ type: "getStats" });
  $stats.textContent =
    `${stats.count} pages embedded · ${fmtBytes(stats.bytes)} · ${stats.modelReady ? "model ready" : "model loading"}`;
  renderMuted(stats.blocked);

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
  const recs = res.recommendations;
  const html = recs.map((r, i) => renderCard(r, { featured: i === 0 })).join("");
  $grid.innerHTML = html;
  attachCardListeners();
  $loading.hidden = true;
  $grid.hidden = false;
}

$clear.addEventListener("click", async () => {
  if (!confirm("Delete all captured page records? Your browsing history is not affected.")) return;
  await browser.runtime.sendMessage({ type: "clearAll" });
  await refresh();
});

refresh();
