const $loading = document.getElementById("loading");
const $empty = document.getElementById("empty");
const $emptyCount = document.getElementById("empty-count");
const $grid = document.getElementById("grid");
const $stats = document.getElementById("stats");
const $clear = document.getElementById("clear");
const $mutedSection = document.getElementById("muted-section");
const $mutedList = document.getElementById("muted-list");

const MIN_PAGES_FOR_RECS = 5;
const REUTERS_LOGO = browser.runtime.getURL("icons/reuters.png");

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
  return Math.max(0, Math.min(1, (s || 0) / 0.8));
}

// Deterministic gradient from a string for the missing-image placeholder.
function colorFromString(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 50) % 360} 80% 35%))`;
}

function thumbHtml(article, score) {
  const initial = ((article.title || "·").trim()[0] || "·").toUpperCase();
  const grad = colorFromString(article.title || article.id);
  const scoreHtml = `<span class="score">${(scoreToPct(score) * 100).toFixed(0)}% match</span>`;
  if (article.image_url) {
    return `<div class="thumb" style="background: ${grad}" data-fallback="${escapeAttr(initial)}">
      <img src="${escapeAttr(article.image_url)}" alt="" loading="lazy" />
      ${scoreHtml}
    </div>`;
  }
  return `<div class="thumb" style="background: ${grad}">
    <div class="placeholder">${escapeHtml(initial)}</div>
    ${scoreHtml}
  </div>`;
}

function renderCard({ article, score, becauseYouRead }) {
  return `
    <a class="card" href="${escapeAttr(article.url)}" target="_blank" rel="noopener">
      ${thumbHtml(article, score)}
      <div class="body">
        <h2 class="title">${escapeHtml(article.title)}</h2>
        <p class="because">Because you read <a href="${escapeAttr(becauseYouRead.url)}" target="_blank" rel="noopener" data-stop>${escapeHtml(becauseYouRead.title || becauseYouRead.url)}</a></p>
        <div class="footer">
          <span class="src-pill">
            <img src="${escapeAttr(REUTERS_LOGO)}" alt="" width="16" height="16">
            ${escapeHtml(article.source || "Reuters")}
          </span>
          <span class="date">${escapeHtml(fmtDate(article.published_at))}</span>
        </div>
      </div>
    </a>
  `;
}

function attachCardListeners() {
  $grid.querySelectorAll(".thumb img").forEach((img) => {
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
  $grid.querySelectorAll("a[data-stop]").forEach((a) => {
    a.addEventListener("click", (e) => e.stopPropagation());
  });
}

function renderMuted(domains) {
  if (!domains?.length) { $mutedSection.hidden = true; return; }
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
  $grid.innerHTML = res.recommendations.map(renderCard).join("");
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
