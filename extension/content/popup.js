// In-page popup. Mounted in a closed Shadow DOM so the host page's CSS
// can't leak in. Drives three visible states: extracting → embedding → result.
//
// Exposed on window.__discoPopup so content-script.js can drive it.

(() => {
  if (window.__discoPopup) return;

  const HOST_ID = "__disco_popup_host__";
  const AUTO_DISMISS_MS = 30_000;
  // Visual minimum so the "embedding…" state actually registers.
  const MIN_EMBEDDING_VISIBLE_MS = 700;

  let host = null;
  let root = null;
  let dismissTimer = null;
  let openedAt = 0;
  let embeddingShownAt = 0;
  let openPromise = null;

  // Inlined to avoid relying on web_accessible_resources fetch from the page
  // origin, which has been flaky in MV2.
  const POPUP_CSS = `
:host { all: initial; }
.wrap {
  position: fixed; right: 20px; bottom: 20px; width: 360px;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1a1a1a; background: #ffffff;
  border: 1px solid #e3e3e3; border-radius: 14px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 36px rgba(0,0,0,0.16);
  padding: 16px 18px 14px; z-index: 2147483000;
  opacity: 0; transform: translateY(8px);
  transition: opacity 300ms ease, transform 300ms ease;
  box-sizing: border-box;
  display: block;
}
.wrap.show { opacity: 1; transform: none; }
@media (prefers-color-scheme: dark) {
  .wrap { color:#e8e8e8; background:#1c1c1e; border-color:#2c2c2e;
    box-shadow: 0 1px 2px rgba(0,0,0,0.5), 0 14px 40px rgba(0,0,0,0.6); }
}
.head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.dot { width:8px; height:8px; border-radius:50%; background:#f59e0b; }
.wrap.embedding .dot { animation: pulse 1.1s ease-in-out infinite; }
.wrap.result .dot { background:#f59e0b; }
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.5); opacity: 0.55; }
}
.label { font-size:11px; letter-spacing:0.04em; text-transform:uppercase;
  font-weight:600; color:#666; }
@media (prefers-color-scheme: dark) { .label { color:#999; } }
.close { margin-left:auto; appearance:none; background:none; border:none;
  width:22px; height:22px; font:inherit; font-size:16px; line-height:1;
  color:#999; cursor:pointer; padding:0; border-radius:4px; }
.close:hover { color:#1a1a1a; background: rgba(0,0,0,0.05); }
@media (prefers-color-scheme: dark) {
  .close:hover { color:#fff; background: rgba(255,255,255,0.1); }
}
.status { font-size:14px; font-weight:500; margin-bottom:4px; min-height:19px; }
.caption { font-size:11.5px; color:#888; display:flex; align-items:center; gap:6px;
  margin-bottom:10px; }
.bar { height:3px; background: rgba(0,0,0,0.06); border-radius:999px;
  overflow:hidden; margin:8px 0 10px; display:none; }
@media (prefers-color-scheme: dark) {
  .bar { background: rgba(255,255,255,0.08); }
}
.wrap.extracting .bar, .wrap.embedding .bar { display:block; }
.bar > span { display:block; height:100%; width:30%; background:#f59e0b;
  border-radius:999px; animation: slide 1.4s ease-in-out infinite; }
@keyframes slide { 0% { margin-left:-30%; } 100% { margin-left:100%; } }
.result { display:none; padding:10px 12px;
  background: rgba(245,158,11,0.06);
  border:1px solid rgba(245,158,11,0.2); border-radius:10px; margin-bottom:10px; }
@media (prefers-color-scheme: dark) {
  .result { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.3); }
}
.wrap.result .result { display:block; }
.result .src { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.04em;
  margin-bottom:4px; display:flex; align-items:center; gap:8px; }
.result .score { margin-left:auto; font-variant-numeric:tabular-nums;
  background:#f59e0b; color:white; padding:1px 7px; border-radius:999px;
  font-size:10.5px; letter-spacing:0; text-transform:none; }
.result .title { font-size:14px; font-weight:500; line-height:1.35; margin-bottom:6px; }
.result .title a { color:inherit; text-decoration:none; }
.result .title a:hover { text-decoration:underline; }
.foot { display:flex; align-items:center; gap:12px; font-size:11px; }
.foot a, .foot button { appearance:none; background:none; border:none;
  font:inherit; color:#666; cursor:pointer; padding:0; text-decoration:none; }
.foot a:hover, .foot button:hover { color:#f59e0b; }
@media (prefers-color-scheme: dark) {
  .foot a, .foot button { color:#999; }
  .foot a:hover, .foot button:hover { color:#fde68a; }
}
.foot .open { margin-left:auto; background:#f59e0b; color:white;
  padding:4px 12px; border-radius:999px; font-weight:500; }
.foot .open:hover { background:#d97706; color:white; text-decoration:none; }
.lock { display:inline-block; width:10px; height:10px; vertical-align:-1px; }
`;

  function privacyCaption() {
    return `
      <svg class="lock" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
      </svg>
      Nothing leaves your device
    `;
  }

  async function ensureMounted() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    // Force the host out of any inherited flow.
    host.style.cssText = "all: initial; position: fixed; right: 0; bottom: 0; z-index: 2147483647; width: 0; height: 0;";
    (document.body || document.documentElement).appendChild(host);
    // "open" so the user can inspect the contents via devtools.
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${POPUP_CSS}</style>
      <div class="wrap extracting" role="status" aria-live="polite">
        <div class="head">
          <div class="dot"></div>
          <div class="label">Lume</div>
          <button class="close" aria-label="Dismiss">×</button>
        </div>
        <div class="status">Reading this page locally…</div>
        <div class="caption">${privacyCaption()}</div>
        <div class="bar"><span></span></div>
        <div class="result">
          <div class="src">
            <span class="result-source">Reuters</span>
            <span class="score">0%</span>
          </div>
          <div class="title"><a class="result-link" href="#" target="_blank" rel="noopener"></a></div>
        </div>
        <div class="foot">
          <button class="mute">Mute this site</button>
          <a class="open" target="_blank" rel="noopener" style="display:none">Open</a>
        </div>
      </div>
    `;
    // Belt-and-suspenders inline styles in case the shadow stylesheet
    // didn't apply (e.g., Firefox quirk on certain pages).
    const wrap = root.querySelector(".wrap");
    wrap.style.cssText = [
      "position: fixed",
      "right: 20px",
      "bottom: 20px",
      "width: 360px",
      "min-height: 80px",
      "padding: 16px 18px 14px",
      "box-sizing: border-box",
      "background: #ffffff",
      "color: #1a1a1a",
      "border: 1px solid #e3e3e3",
      "border-radius: 14px",
      "box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 36px rgba(0,0,0,0.16)",
      "font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      "opacity: 1",
      "transform: none",
      "z-index: 2147483000",
      "display: block",
    ].join("; ") + ";";
    root.querySelector(".close").addEventListener("click", dismiss);
    root.querySelector(".mute").addEventListener("click", muteCurrentSite);
    requestAnimationFrame(() => {
      wrap.classList.add("show");
    });
    resetDismissTimer();
  }

  function setState(state) {
    if (!root) return;
    const wrap = root.querySelector(".wrap");
    wrap.classList.remove("extracting", "embedding", "result", "error");
    wrap.classList.add(state);
    if (state === "embedding") embeddingShownAt = performance.now();
  }

  function setStatus(text) {
    if (!root) return;
    root.querySelector(".status").textContent = text;
  }

  function setResult({ title, url, source, score }) {
    const attached = host && document.documentElement.contains(host);
    console.log("[disco/popup] setResult enter, host attached:", attached, "root:", !!root);
    if (!root) return;
    if (!attached) {
      // Page yanked our host (SPA route change, framework re-render, etc.) —
      // re-attach so the popup actually gets seen.
      console.log("[disco/popup] re-attaching host");
      document.documentElement.appendChild(host);
    }
    root.querySelector(".result-source").textContent = source || "Reuters";
    const pct = Math.max(0, Math.min(1, score || 0));
    root.querySelector(".score").textContent = `${(pct * 100).toFixed(0)}%`;
    const a = root.querySelector(".result-link");
    a.textContent = title || "";
    a.href = url || "#";
    const open = root.querySelector(".open");
    open.href = url || "#";
    open.style.display = url ? "" : "none";
    open.textContent = "Open";
    setStatus("Read next");
    setState("result");
    const wrap = root.querySelector(".wrap");
    if (!wrap.classList.contains("show")) wrap.classList.add("show");
    resetDismissTimer();
    const r = wrap.getBoundingClientRect();
    const cs = getComputedStyle(wrap);
    console.log("[disco/popup] setResult done, classes:", wrap.className,
      "rect:", r.width + "x" + r.height, "@", r.left + "," + r.top,
      "computed:", cs.position, cs.width, cs.height, cs.display, "opacity:", cs.opacity);
    console.log("[disco/popup] host in DOM:", document.documentElement.contains(host),
      "host parent:", host.parentNode?.nodeName);
  }

  function dismiss() {
    if (!root) return;
    const wrap = root.querySelector(".wrap");
    wrap.classList.remove("show");
    setTimeout(() => {
      try { host?.remove(); } catch {}
      host = null; root = null;
      clearTimeout(dismissTimer);
    }, 320);
  }

  function resetDismissTimer() {
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  async function muteCurrentSite() {
    let domain = null;
    try { domain = location.hostname; } catch {}
    if (!domain) return;
    try { await browser.runtime.sendMessage({ type: "muteSite", domain }); } catch {}
    dismiss();
  }

  window.__discoPopup = {
    open(opts = {}) {
      openPromise = (async () => {
        openedAt = performance.now();
        await ensureMounted();
        setState("extracting");
        setStatus("Reading this page locally…");
        // Brief extracting state so it's actually perceptible.
        await new Promise((r) => setTimeout(r, 250));
        setState("embedding");
        setStatus(opts.modelLoading ? "Setting up model (one-time)…" : "Embedding…");
      })();
      return openPromise;
    },

    async showResult(related) {
      console.log("[disco/popup] showResult:", related?.title || "(no related)");
      // Wait for open() to finish so we don't race the embedding state.
      if (openPromise) {
        try { await openPromise; } catch {}
      }
      // Pad embedding state if the real embed was too fast to see.
      const elapsed = performance.now() - embeddingShownAt;
      if (elapsed < MIN_EMBEDDING_VISIBLE_MS) {
        await new Promise((r) => setTimeout(r, MIN_EMBEDDING_VISIBLE_MS - elapsed));
      }
      if (!root) { console.log("[disco/popup] no root, skipping"); return; }
      if (!related) { console.log("[disco/popup] no related, dismissing"); dismiss(); return; }
      setResult(related);
    },

    error() {
      // Per spec: silent on error. Just dismiss.
      dismiss();
    },

    dismiss,
  };
})();
