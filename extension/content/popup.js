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
  let cssText = null;

  async function loadCSS() {
    if (cssText != null) return cssText;
    try {
      const res = await fetch(browser.runtime.getURL("content/popup.css"));
      cssText = await res.text();
    } catch {
      cssText = "";
    }
    return cssText;
  }

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
    if (host && document.body.contains(host)) return;
    await loadCSS();
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${cssText}</style>
      <div class="wrap extracting" role="status" aria-live="polite">
        <div class="head">
          <div class="dot"></div>
          <div class="label">Local Discovery</div>
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
    root.querySelector(".close").addEventListener("click", dismiss);
    root.querySelector(".mute").addEventListener("click", muteCurrentSite);
    requestAnimationFrame(() => {
      root.querySelector(".wrap").classList.add("show");
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
    if (!root) return;
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
    resetDismissTimer();
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
    async open(opts = {}) {
      openedAt = performance.now();
      await ensureMounted();
      setState("extracting");
      setStatus("Reading this page locally…");
      // Brief extracting state so it's actually perceptible.
      await new Promise((r) => setTimeout(r, 250));
      setState("embedding");
      setStatus(opts.modelLoading ? "Setting up model (one-time)…" : "Embedding…");
    },

    setEmbedding() {
      if (!root) return;
      setState("embedding");
      setStatus("Embedding…");
      embeddingShownAt = performance.now();
    },

    async showResult(related) {
      // Pad embedding state if real time was too fast to see.
      const elapsed = performance.now() - embeddingShownAt;
      if (elapsed < MIN_EMBEDDING_VISIBLE_MS) {
        await new Promise((r) => setTimeout(r, MIN_EMBEDDING_VISIBLE_MS - elapsed));
      }
      if (!root) return; // dismissed mid-flight
      if (!related) { dismiss(); return; }
      setResult(related);
    },

    error() {
      // Per spec: silent on error. Just dismiss.
      dismiss();
    },

    dismiss,
  };
})();
