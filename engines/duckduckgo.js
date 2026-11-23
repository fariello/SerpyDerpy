/**
 * SerpyDerpy v2 — DuckDuckGo Search Engine Adapter
 * Implements Section 6.3 #3, OQ-06 (standard JS default + optional HTML fallback),
 * and OQ-18 (omit &kp=-2 to use normal default SafeSearch).
 */

export const ENGINE_ID = "duckduckgo";

export function buildInitialUrl(query, { htmlMode = false } = {}) {
  const q = encodeURIComponent(String(query || "").trim());
  if (htmlMode) {
    return `https://html.duckduckgo.com/html/?q=${q}&kl=us-en`;
  }
  // Explicitly omit kp so DuckDuckGo uses normal default SafeSearch (OQ-18)
  return `https://duckduckgo.com/?q=${q}&kl=us-en&ia=web`;
}

export function isEngineSearchUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isDdg = host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
    return isDdg && (u.searchParams.has("q") || u.pathname.startsWith("/html"));
  } catch (_) {
    return false;
  }
}

export function parseActiveTabQuery(url) {
  try {
    const u = new URL(url);
    return { query: (u.searchParams.get("q") || "").trim(), pageNumber: 1 };
  } catch (_) {
    return { query: "", pageNumber: 1 };
  }
}

/**
 * Unwrap DuckDuckGo /l/?uddg=... redirect links.
 */
export function unwrapResultUrl(rawHref, baseOrigin = "https://duckduckgo.com") {
  if (!rawHref) return { url: "", urlDecodeFallback: false };
  try {
    const parsed = new URL(rawHref, baseOrigin);
    const host = parsed.hostname.toLowerCase();

    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) {
        const inner = new URL(uddg);
        if (inner.protocol === "http:" || inner.protocol === "https:") {
          return { url: inner.href, urlDecodeFallback: false };
        }
      }
      if (parsed.pathname.startsWith("/y.js") || parsed.pathname.startsWith("/l/") || parsed.pathname === "/") {
        return { url: "", urlDecodeFallback: false };
      }
    }

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return { url: parsed.href, urlDecodeFallback: false };
    }
    return { url: "", urlDecodeFallback: false };
  } catch (_) {
    return { url: "", urlDecodeFallback: false };
  }
}

/**
 * Self-contained DOM extractor executed inside a DuckDuckGo SERP tab (supports both
 * standard JS DuckDuckGo with "More Results" virtual paging and html.duckduckgo.com).
 */
export function duckduckgoDomExtractorFunc() {
  const cleanText = (str) =>
    String(str || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();

  function unwrapDdgHref(rawHref) {
    if (!rawHref) return "";
    try {
      const parsed = new URL(rawHref, window.location.origin);
      const host = parsed.hostname.toLowerCase();
      if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
        const uddg = parsed.searchParams.get("uddg");
        if (uddg) {
          const inner = new URL(uddg);
          if (inner.protocol === "http:" || inner.protocol === "https:") return inner.href;
        }
        return "";
      }
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
      return "";
    } catch (_) {
      return "";
    }
  }

  function detectChallenge() {
    const url = (window.location.href || "").toLowerCase();
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const text = document.body ? document.body.innerText || "" : "";
    if (
      url.includes("anomaly") ||
      document.querySelector('form[action*="anomaly"], #challenge-form, .anomaly-modal, iframe[src*="captcha"]') ||
      html.includes("anomaly.js") ||
      text.includes("Unfortunately, bots use DuckDuckGo too") ||
      text.includes("Please complete the following challenge") ||
      text.includes("Select all squares containing a duck")
    ) {
      return { isChallenge: true, provider: "duckduckgo-anomaly" };
    }
    return { isChallenge: false, provider: null };
  }

  const challenge = detectChallenge();
  if (challenge.isChallenge) {
    return {
      ok: false,
      isChallenge: true,
      challengeProvider: challenge.provider,
      error: `DuckDuckGo challenge detected (${challenge.provider})`
    };
  }

  const isHtmlEndpoint = window.location.hostname.toLowerCase() === "html.duckduckgo.com";
  let query = "";
  try {
    query = (new URL(window.location.href).searchParams.get("q") || "").trim();
  } catch (_) {}
  if (!query) {
    const inp = document.querySelector('#search_form_input, input[name="q"]');
    if (inp && inp.value) query = inp.value.trim();
  }

  const bodyText = document.body ? document.body.innerText || "" : "";
  const zeroResults =
    /No results found for/i.test(bodyText) ||
    /No results\./i.test(bodyText) ||
    Boolean(document.querySelector(".no-results"));

  let queryRewrittenTo = null;
  let exactMatchLost = false;
  const rewriteEl = document.querySelector('#did_mean a, .msg--spelling a, [data-testid="spelling-message"] a');
  if (rewriteEl) {
    queryRewrittenTo = cleanText(rewriteEl.textContent) || null;
    exactMatchLost = /including results for|showing results for/i.test(
      cleanText(rewriteEl.parentElement ? rewriteEl.parentElement.textContent : "")
    );
  }

  const results = [];
  const seenUrls = new Set();

  // Selectors for standard JS DDG and HTML DDG
  const cardSelectors = isHtmlEndpoint
    ? ".results .result:not(.result--ad)"
    : 'article[data-testid="result"], ol.react-results--main li[data-layout="organic"] article, div.result:not(.result--ad)';

  const cards = Array.from(document.querySelectorAll(cardSelectors));

  for (const card of cards) {
    if (
      card.closest('[data-testid="ad"], .result--ad, li[data-layout="ad"]') ||
      card.querySelector('.badge--ad, a[href*="/y.js?"]')
    ) {
      continue;
    }

    const anchor = card.querySelector(
      'a[data-testid="result-title-a"], h2 a[href], a.result__a'
    );
    if (!anchor) continue;

    const title = cleanText(anchor.innerText || anchor.textContent);
    if (!title) continue;

    const rawHref = anchor.getAttribute("href") || anchor.href || "";
    const resolvedUrl = unwrapDdgHref(rawHref);
    if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;
    seenUrls.add(resolvedUrl);

    let domain = "";
    try {
      domain = new URL(resolvedUrl).hostname.replace(/^www\./i, "").toLowerCase();
    } catch (_) {}

    const snippetEl = card.querySelector(
      '[data-result="snippet"], [data-testid="result-snippet"], .result__snippet, .OgdwYG6KE2qthn9XQWFC'
    );
    const snippet = cleanText(snippetEl ? snippetEl.innerText || snippetEl.textContent : "");
    const siteEl = card.querySelector('[data-testid="result-extras-url-link"], .result__url');
    const siteName = cleanText(siteEl ? siteEl.textContent : "") || domain;

    results.push({
      title,
      rawHref,
      resolvedUrl,
      domain,
      siteName,
      snippet,
      urlDecodeFallback: false
    });
  }

  // Related searches
  const relatedSearches = [];
  for (const el of document.querySelectorAll('[data-testid="related-searches"] a, .related-searches__link')) {
    const txt = cleanText(el.textContent);
    if (txt && txt.length >= 2 && txt.length <= 120 && !relatedSearches.includes(txt)) {
      relatedSearches.push(txt);
    }
  }

  // Decoy candidates
  const decoyCandidates = [];
  const seenDecoys = new Set();
  for (const adCard of document.querySelectorAll('[data-testid="ad"], .result--ad, li[data-layout="ad"]')) {
    const a = adCard.querySelector("h2 a[href], a[href]");
    if (!a) continue;
    const raw = a.getAttribute("href") || a.href || "";
    try {
      const fullUrl = new URL(raw, window.location.origin).href;
      if ((fullUrl.startsWith("http://") || fullUrl.startsWith("https://")) && !seenDecoys.has(fullUrl)) {
        seenDecoys.add(fullUrl);
        decoyCandidates.push({
          url: fullUrl,
          type: "sponsored",
          title: cleanText(a.textContent || ""),
          displayUrl: cleanText(adCard.querySelector('.result__url, [data-testid="result-extras-url-link"]')?.textContent || ""),
          adText: cleanText(adCard.textContent || "").slice(0, 300)
        });
      }
    } catch (_) {}
  }
  for (const r of results) {
    if (!seenDecoys.has(r.resolvedUrl)) {
      seenDecoys.add(r.resolvedUrl);
      decoyCandidates.push({ url: r.resolvedUrl, type: "organic", title: r.title });
    }
  }

  const moreBtn = isHtmlEndpoint
    ? document.querySelector('form input[type="submit"][value="Next"], .nav-link input[value="Next"]')
    : document.querySelector('button#more-results, button[data-testid="more-results"], a.result--more__btn');

  const nav = window.navigator || {};
  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (_) {}

  return {
    ok: true,
    isChallenge: false,
    challengeProvider: null,
    engine: "duckduckgo",
    isHtmlEndpoint,
    virtualPagination: !isHtmlEndpoint,
    query,
    currentUrl: window.location.href,
    timestampUtc: new Date().toISOString(),
    zeroResults,
    queryRewrittenTo,
    exactMatchLost,
    results,
    peopleAlsoAsk: [],
    relatedSearches: relatedSearches.slice(0, 15),
    decoyCandidates,
    hasNextPage: Boolean(moreBtn && !moreBtn.disabled),
    nextPageUrl: null,
    rawHtml: "<!DOCTYPE html>\n" + (document.documentElement ? document.documentElement.outerHTML : ""),
    clientMetadata: {
      userAgent: nav.userAgent || "",
      platform: nav.platform || "",
      language: nav.language || "",
      timezone
    }
  };
}

export function duckduckgoClickNextFunc() {
  const isHtmlEndpoint = window.location.hostname.toLowerCase() === "html.duckduckgo.com";
  const btn = isHtmlEndpoint
    ? document.querySelector('form input[type="submit"][value="Next"], .nav-link input[value="Next"]')
    : document.querySelector('button#more-results, button[data-testid="more-results"], a.result--more__btn');

  if (!btn || btn.disabled) {
    return { ok: false, reason: "no_next_button", isHtmlEndpoint };
  }
  btn.scrollIntoView({ behavior: "smooth", block: "center" });
  const rect = btn.getBoundingClientRect();
  const evtInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };
  btn.dispatchEvent(new MouseEvent("mousemove", evtInit));
  btn.dispatchEvent(new MouseEvent("mousedown", evtInit));
  btn.dispatchEvent(new MouseEvent("mouseup", evtInit));
  btn.click();
  return { ok: true, isHtmlEndpoint, virtualPagination: !isHtmlEndpoint };
}

export function duckduckgoCheckChallengeFunc() {
  const url = (window.location.href || "").toLowerCase();
  const html = document.documentElement ? document.documentElement.innerHTML : "";
  const text = document.body ? document.body.innerText || "" : "";
  if (
    url.includes("anomaly") ||
    document.querySelector('form[action*="anomaly"], #challenge-form, .anomaly-modal, iframe[src*="captcha"]') ||
    html.includes("anomaly.js") ||
    text.includes("Unfortunately, bots use DuckDuckGo too") ||
    text.includes("Please complete the following challenge") ||
    text.includes("Select all squares containing a duck")
  ) {
    return { isChallenge: true, provider: "duckduckgo-anomaly" };
  }
  return { isChallenge: false, provider: null };
}
