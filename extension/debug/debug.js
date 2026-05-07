const $stats = document.getElementById("stats");
const $tbody = document.getElementById("tbody");
const $recs = document.getElementById("recs");

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function refresh() {
  const stats = await browser.runtime.sendMessage({ type: "getStats" });
  $stats.textContent =
    `${stats.count} pages · ${fmtBytes(stats.bytes)} · model ${stats.modelReady ? "ready" : "loading"} · corpus ${stats.corpusReady ? "ready" : "loading"} · ${stats.blocked.length} muted domain(s)`;

  const pages = await browser.runtime.sendMessage({ type: "getAllPages" });
  pages.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  if (!pages.length) {
    $tbody.innerHTML = `<tr><td colspan="7" class="empty">No pages captured yet. Browse a few sites and dwell 20+ seconds.</td></tr>`;
    return;
  }
  $tbody.innerHTML = pages.map((p) => {
    const ts = p.timestamp ? new Date(p.timestamp).toLocaleString() : "?";
    return `
      <tr>
        <td>${ts}</td>
        <td class="title">${escapeHtml(p.title || "(no title)")}</td>
        <td>${escapeHtml(p.hostname || "")}</td>
        <td class="url"><a href="${escapeAttr(p.url)}" target="_blank">${escapeHtml(p.url)}</a></td>
        <td class="num">${(p.text || "").length}</td>
        <td class="num">—</td>
        <td><button data-url="${escapeAttr(p.url)}" class="del">×</button></td>
      </tr>
    `;
  }).join("");
}

document.getElementById("refresh").addEventListener("click", refresh);

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Delete all captured page records?")) return;
  await browser.runtime.sendMessage({ type: "clearAll" });
  $recs.textContent = "";
  refresh();
});

document.getElementById("recommend").addEventListener("click", async () => {
  $recs.textContent = "Computing…";
  const res = await browser.runtime.sendMessage({ type: "getRecommendations" });
  if (!res.ok) {
    $recs.textContent = `Error: ${res.reason}`;
    return;
  }
  const lines = [
    `History pages used: ${res.historyCount}`,
    `Recommendations:`,
    ...res.recommendations.map((r, i) =>
      `${(i+1).toString().padStart(2)}. [${r.score.toFixed(3)}] ${r.article.title}\n` +
      `      → because you read: ${r.becauseYouRead.title}`),
  ];
  $recs.textContent = lines.join("\n");
});

$tbody.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("del")) return;
  // We don't expose deletePage as a message in v1; clear is the only delete.
});

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

refresh();
