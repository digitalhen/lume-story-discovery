// Capture pipeline: detect when the user has dwelled long enough, extract a
// lightweight signal, and send it to the background for embedding + storage.
//
// Trigger: 20s foreground dwell AND scroll depth >= 25%, OR pagehide after 10s.

(() => {
  const DWELL_TRIGGER_MS = 5_000;
  const DWELL_UNLOAD_MIN_MS = 3_000;
  const SCROLL_TRIGGER_PCT = 0.001; // any user scroll
  const MAX_TEXT = 1000;

  if (window.__discoCaptureBooted) return;
  window.__discoCaptureBooted = true;

  // Quick local bail-outs before talking to background.
  if (window.top !== window) return;
  if (document.querySelector('meta[name="robots" i][content*="noindex" i]')) return;

  let dwellMs = 0;
  let lastVisibleAt = document.visibilityState === "visible" ? performance.now() : null;
  let maxScrollPct = 0;
  let captured = false;
  let allowed = null; // null = unknown, true/false from preflight
  let preflightPromise = null;

  function nowVisible() { return document.visibilityState === "visible"; }

  function tickDwell() {
    if (lastVisibleAt != null) {
      const t = performance.now();
      dwellMs += t - lastVisibleAt;
      lastVisibleAt = t;
    }
    return dwellMs;
  }

  function updateScroll() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const pct = Math.min(1, Math.max(0, window.scrollY / max));
    if (pct > maxScrollPct) maxScrollPct = pct;
  }

  function onVisibility() {
    if (nowVisible()) {
      lastVisibleAt = performance.now();
    } else {
      tickDwell();
      lastVisibleAt = null;
    }
  }

  // Throttled scroll listener
  let scrollPending = false;
  function onScroll() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      updateScroll();
      maybeFire();
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  // Tick every second while visible to evaluate the dwell threshold.
  const interval = setInterval(() => {
    if (!nowVisible()) return;
    tickDwell();
    maybeFire();
  }, 1000);

  function preflight() {
    if (preflightPromise) return preflightPromise;
    preflightPromise = browser.runtime.sendMessage({ type: "preflight", url: location.href })
      .then((res) => { allowed = !!res?.allowed; return allowed; })
      .catch(() => { allowed = false; return false; });
    return preflightPromise;
  }

  async function maybeFire() {
    if (captured) return;
    const ms = tickDwell();
    if (ms < DWELL_TRIGGER_MS) return;
    if (maxScrollPct < SCROLL_TRIGGER_PCT) return;
    if (allowed === null) await preflight();
    if (!allowed) { captured = true; return; }
    fire("dwell+scroll");
  }

  function onPageHide() {
    if (captured) return;
    const ms = tickDwell();
    if (ms < DWELL_UNLOAD_MIN_MS) return;
    if (allowed === null) {
      // Best-effort: skip, we don't have time to await preflight on unload.
      return;
    }
    if (!allowed) return;
    fire("unload");
  }

  function extract() {
    const parts = [];
    if (document.title) parts.push(document.title);

    const h1s = Array.from(document.querySelectorAll("h1")).slice(0, 3);
    for (const h of h1s) {
      const t = (h.textContent || "").trim();
      if (t) parts.push(t);
    }

    const metaSel = [
      'meta[name="description" i]',
      'meta[property="og:title"]',
      'meta[property="og:description"]',
    ];
    for (const sel of metaSel) {
      const m = document.querySelector(sel);
      const v = m?.getAttribute("content")?.trim();
      if (v) parts.push(v);
    }

    let text = parts.join("\n").replace(/\s+/g, " ").trim();
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    return text;
  }

  function fire(reason) {
    captured = true;
    const text = extract();
    if (!text || text.length < 30) return;
    const payload = {
      type: "capture",
      url: location.href,
      title: document.title || "",
      text,
      reason,
    };
    console.log("[disco/cs] firing capture:", reason, text.length, "chars");

    // Open the popup immediately so the user sees the local-processing state
    // BEFORE the embed completes — that visible state is the product.
    if (reason !== "unload") {
      // Probe model readiness so we can label the wait honestly on cold start.
      browser.runtime.sendMessage({ type: "ping" })
        .then((p) => window.__discoPopup?.open({ modelLoading: p && !p.ready }))
        .catch(() => window.__discoPopup?.open());
    }

    browser.runtime.sendMessage(payload).then((res) => {
      if (res?.ok) {
        console.log("[disco/cs] captured ok", res.related ? `→ ${res.related.title}` : "");
        if (reason !== "unload") window.__discoPopup?.showResult(res.related);
      } else {
        console.log("[disco/cs] capture skipped:", res?.reason || res?.error);
        if (reason !== "unload") window.__discoPopup?.error();
      }
    }).catch((e) => {
      console.warn("[disco/cs] capture error:", e);
      if (reason !== "unload") window.__discoPopup?.error();
    });
  }

  // First-pass scroll measurement so a pre-scrolled page starts above 0.
  updateScroll();
})();
