/**
 * SerpyDerpy v2 — Google Search Engine Adapter
 * Implements REQ-ENG-03, REQ-ENG-04, REQ-ENG-05, REQ-ENG-06, and Section 6.3 #1.
 */

export const ENGINE_ID = "google";

export function buildInitialUrl(query, { noPersonalization = true } = {}) {
  let url = `https://www.google.com/search?q=${encodeURIComponent(String(query || "").trim())}&hl=en&gl=us`;
  if (noPersonalization) {
    url += "&pws=0";
  }
  return url;
}

export function isEngineSearchUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isGoogle = host === "google.com" || host.endsWith(".google.com") || /(^|\.)google\.[a-z.]+$/.test(host);
    return isGoogle && (u.pathname.startsWith("/search") || u.searchParams.has("q"));
  } catch (_) {
    return false;
  }
}

export function parseActiveTabQuery(url) {
  try {
    const u = new URL(url);
    const query = (u.searchParams.get("q") || "").trim();
    const start = parseInt(u.searchParams.get("start") || "0", 10);
    const pageNumber = Number.isFinite(start) && start >= 0 ? Math.floor(start / 10) + 1 : 1;
    return { query, pageNumber };
  } catch (_) {
    return { query: "", pageNumber: 1 };
  }
}

/**
 * Unwrap Google /url?q=... and /url?url=... redirects and filter internal Google links.
 */
export function unwrapResultUrl(rawHref, baseOrigin = "https://www.google.com") {
  if (!rawHref) return { url: "", urlDecodeFallback: false };
  try {
    const parsed = new URL(rawHref, baseOrigin);

    if (parsed.pathname === "/url") {
      const dest = parsed.searchParams.get("q") || parsed.searchParams.get("url");
      if (dest) {
        const inner = new URL(dest);
        if (inner.protocol === "http:" || inner.protocol === "https:") {
          return { url: inner.href, urlDecodeFallback: false };
        }
      }
      return { url: "", urlDecodeFallback: false };
    }

    const host = parsed.hostname.toLowerCase();
    if (host === "google.com" || host.endsWith(".google.com") || /(^|\.)google\.[a-z.]+$/.test(host)) {
      if (
        parsed.pathname.startsWith("/search") ||
        parsed.pathname.startsWith("/url") ||
        parsed.pathname.startsWith("/preferences") ||
        parsed.pathname.startsWith("/advanced_search") ||
        parsed.pathname.startsWith("/imgres") ||
        parsed.pathname.startsWith("/aclk") ||
        host.startsWith("accounts.google.") ||
        host.startsWith("policies.google.") ||
        host.startsWith("support.google.")
      ) {
        return { url: "", urlDecodeFallback: false };
      }
    }

    if (host === "www.googleadservices.com" || host === "googleadservices.com") {
      return { url: "", urlDecodeFallback: false };
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
 * Self-contained DOM extractor executed inside a Google SERP tab (via executeScript)
 * or directly in Node.js tests against a DOM document.
 */
export function googleDomExtractorFunc() {
  const cleanText = (str) =>
    String(str || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();

  function detectChallenge() {
    const url = (window.location.href || "").toLowerCase();
    if (url.includes("/sorry/index") || url.includes("google.com/sorry")) {
      return { isChallenge: true, provider: "google-sorry" };
    }
    if (document.querySelector('#captcha-form, form[action*="sorry"], #recaptcha, .g-recaptcha, iframe[src*="recaptcha"]')) {
      return { isChallenge: true, provider: "google-recaptcha" };
    }
    if (url.includes("consent.google.com") || document.querySelector('form[action*="consent.google.com"]')) {
      return { isChallenge: true, provider: "google-consent" };
    }
    const title = (document.title || "").toLowerCase();
    if (title.includes("unusual traffic") || title.startsWith("sorry")) {
      return { isChallenge: true, provider: "google-sorry" };
    }
    const text = document.body ? document.body.innerText || "" : "";
    if (
      text.includes("Our systems have detected unusual traffic") ||
      text.includes("Please solve the challenge below") ||
      text.includes("automated queries")
    ) {
      return { isChallenge: true, provider: "google-unusual-traffic" };
    }
    return { isChallenge: false, provider: null };
  }

  function unwrapGoogleHref(rawHref) {
    if (!rawHref) return "";
    try {
      const parsed = new URL(rawHref, window.location.origin);
      if (parsed.pathname === "/url") {
        const dest = parsed.searchParams.get("q") || parsed.searchParams.get("url");
        if (dest) {
          const inner = new URL(dest);
          if (inner.protocol === "http:" || inner.protocol === "https:") return inner.href;
        }
        return "";
      }
      const host = parsed.hostname.toLowerCase();
      if (host === "www.googleadservices.com" || host === "googleadservices.com") return "";
      if (host === "google.com" || host.endsWith(".google.com") || /(^|\.)google\.[a-z.]+$/.test(host)) {
        if (
          parsed.pathname.startsWith("/search") ||
          parsed.pathname.startsWith("/url") ||
          parsed.pathname.startsWith("/preferences") ||
          parsed.pathname.startsWith("/advanced_search") ||
          parsed.pathname.startsWith("/imgres") ||
          parsed.pathname.startsWith("/aclk") ||
          host.startsWith("accounts.google.") ||
          host.startsWith("policies.google.") ||
          host.startsWith("support.google.")
        ) {
          return "";
        }
      }
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
      return "";
    } catch (_) {
      return "";
    }
  }

  function isInsideExcludedRegion(el) {
    if (!el || typeof el.closest !== "function") return false;
    // Exclude sponsored ads, AI Overview, and People Also Ask accordions
    if (
      el.closest(
        '[data-text-ad="1"], #tads, #tadsb, div.uEierd, div.vdQmEd, [data-attrid="SGE"], [data-mcpr], .M8OgIe, .LT6XE, div[jsname="yEVEwb"], div[related-question-pair], div[data-q], #rhs'
      )
    ) {
      return true;
    }
    // Check if nested inside an explicit AI Overview section heading
    const region = el.closest("section, [data-hveid], [jscontroller]");
    if (region) {
      const heading = region.querySelector("h1, h2, [role='heading']");
      const hTxt = cleanText(heading ? heading.textContent : "").toLowerCase();
      if (hTxt === "ai overview" || hTxt === "people also ask" || hTxt === "sponsored") {
        return true;
      }
    }
    return false;
  }

  function extractSnippet(container, h3) {
    if (!container) return "";
    const selectors = [
      'div[style*="-webkit-line-clamp"]',
      ".VwiC3b",
      ".yXK7lf",
      ".MUxGbd",
      ".BNeawe.s3v9rd.AP7Wnd",
      "span.aCOpRe",
      "div.IsZvec"
    ];
    const titleTxt = cleanText(h3.textContent);
    for (const sel of selectors) {
      try {
        for (const el of container.querySelectorAll(sel)) {
          const txt = cleanText(el.innerText || el.textContent);
          if (txt && txt.length > 20 && !txt.includes(titleTxt)) {
            return txt;
          }
        }
      } catch (_) {}
    }
    return "";
  }

  function extractSiteNameOrDomain(container, url) {
    let domain = "";
    try {
      domain = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch (_) {}
    if (container) {
      const cite = container.querySelector("cite, span.VuuXrf, span[role='text'], div.notranslate");
      if (cite) {
        const txt = cleanText(cite.textContent);
        if (txt && txt.length < 80) return { siteName: txt, domain };
      }
    }
    return { siteName: domain, domain };
  }

  const challenge = detectChallenge();
  if (challenge.isChallenge) {
    return {
      ok: false,
      isChallenge: true,
      challengeProvider: challenge.provider,
      error: `Google challenge detected (${challenge.provider})`
    };
  }

  let query = "";
  try {
    query = (new URL(window.location.href).searchParams.get("q") || "").trim();
  } catch (_) {}
  if (!query) {
    const inp = document.querySelector('textarea[name="q"], input[name="q"]');
    if (inp && inp.value) query = inp.value.trim();
  }

  // Zero-result and rewrite detection (REQ-ENG-05)
  const bodyText = document.body ? document.body.innerText || "" : "";
  const zeroResults =
    /did not match any documents/i.test(bodyText) ||
    /No results found for/i.test(bodyText) ||
    Boolean(document.querySelector(".card-section p, #topstuff .med")?.textContent?.match(/did not match any documents/i));

  let queryRewrittenTo = null;
  let exactMatchLost = false;
  const rewriteEl = document.querySelector("#fprsl, a.gL9Hy, #topstuff a.spell_orig, #taw a.gL9Hy");
  if (rewriteEl) {
    const rw = cleanText(rewriteEl.textContent);
    if (rw) {
      queryRewrittenTo = rw;
      exactMatchLost = /showing results for|including results for/i.test(
        cleanText(rewriteEl.parentElement ? rewriteEl.parentElement.textContent : "")
      );
    }
  }

  // Organic results
  const results = [];
  const seenUrls = new Set();
  const h3Elements = Array.from(document.querySelectorAll("#search h3, #rso h3, h3"));
  const skipTitles = new Set([
    "people also ask", "people also search for", "related searches",
    "videos", "images", "news", "maps", "ai overview", "sponsored", "discussions and forums"
  ]);

  for (const h3 of h3Elements) {
    if (isInsideExcludedRegion(h3)) continue;
    const title = cleanText(h3.innerText || h3.textContent);
    if (!title) continue;
    const lower = title.toLowerCase();
    if (skipTitles.has(lower) || lower.includes("search filters")) continue;

    const anchor = h3.closest("a[href]") || h3.querySelector("a[href]") || h3.parentElement?.querySelector("a[href]");
    if (!anchor) continue;
    const rawHref = anchor.getAttribute("href") || anchor.href || "";
    const resolvedUrl = unwrapGoogleHref(rawHref);
    if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;
    seenUrls.add(resolvedUrl);

    let container = h3.closest("div.g, div.MjjYud, div[data-sokoban-container], div[data-hveid]");
    if (!container || container === document.body) {
      container = h3.parentElement?.parentElement || h3.parentElement;
    }

    const snippet = extractSnippet(container, h3);
    const { siteName, domain } = extractSiteNameOrDomain(container, resolvedUrl);
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

  // People Also Ask
  const peopleAlsoAsk = [];
  for (const item of document.querySelectorAll('div[jsname="yEVEwb"], div[related-question-pair], div[data-q]')) {
    const heading = item.querySelector('div[role="button"], span.CSkcDe, [data-q]');
    const qText = cleanText(heading ? heading.getAttribute("data-q") || heading.textContent : item.textContent);
    if (qText && qText.endsWith("?") && !peopleAlsoAsk.includes(qText)) {
      peopleAlsoAsk.push(qText);
    }
  }

  // Related searches
  const relatedSearches = [];
  for (const el of document.querySelectorAll('#botstuff a[href*="/search?"], div.s75CSd')) {
    const txt = cleanText(el.textContent);
    if (txt && txt.length >= 2 && txt.length <= 120 && !relatedSearches.includes(txt)) {
      relatedSearches.push(txt);
    }
  }

  // Decoy candidates (REQ-ENG-07)
  const decoyCandidates = [];
  const seenDecoys = new Set();
  for (const adCard of document.querySelectorAll('[data-text-ad="1"], div.uEierd, div.vdQmEd')) {
    const a = adCard.querySelector("a[href]");
    if (!a) continue;
    const raw = a.getAttribute("href") || a.href || "";
    try {
      const fullUrl = new URL(raw, window.location.origin).href;
      if ((fullUrl.startsWith("http://") || fullUrl.startsWith("https://")) && !seenDecoys.has(fullUrl)) {
        seenDecoys.add(fullUrl);
        decoyCandidates.push({
          url: fullUrl,
          type: "sponsored",
          title: cleanText(adCard.querySelector('[role="heading"], h3, span')?.textContent || a.textContent || ""),
          displayUrl: cleanText(adCard.querySelector("cite, span.x2VHCd")?.textContent || ""),
          adText: cleanText(adCard.textContent || "").slice(0, 300)
        });
      }
    } catch (_) {}
  }
  for (const r of results) {
    if (!seenDecoys.has(r.resolvedUrl)) {
      seenDecoys.add(r.resolvedUrl);
      decoyCandidates.push({
        url: r.resolvedUrl,
        type: "organic",
        title: r.title
      });
    }
  }

  // Next page
  const nextAnchor = document.querySelector('a#pnnext, a[aria-label="Next page"], a[aria-label="Next"]');
  let nextPageUrl = null;
  if (nextAnchor) {
    const href = nextAnchor.getAttribute("href") || nextAnchor.href;
    if (href) {
      try {
        nextPageUrl = new URL(href, window.location.origin).href;
      } catch (_) {}
    }
  }

  const nav = window.navigator || {};
  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (_) {}

  return {
    ok: true,
    isChallenge: false,
    challengeProvider: null,
    engine: "google",
    query,
    currentUrl: window.location.href,
    timestampUtc: new Date().toISOString(),
    zeroResults,
    queryRewrittenTo,
    exactMatchLost,
    results,
    peopleAlsoAsk: peopleAlsoAsk.slice(0, 15),
    relatedSearches: relatedSearches.slice(0, 15),
    decoyCandidates,
    hasNextPage: Boolean(nextPageUrl),
    nextPageUrl,
    rawHtml: "<!DOCTYPE html>\n" + (document.documentElement ? document.documentElement.outerHTML : ""),
    clientMetadata: {
      userAgent: nav.userAgent || "",
      platform: nav.platform || "",
      language: nav.language || "",
      timezone
    }
  };
}

/**
 * Click Google's Next page link using native mouse events.
 */
export function googleClickNextFunc() {
  const selectors = [
    "a#pnnext",
    "#pnnext",
    'a[aria-label="Next page"]',
    'a[aria-label="Next"]',
    'a[aria-label*="next page" i]'
  ];
  let nextEl = null;
  for (const sel of selectors) {
    nextEl = document.querySelector(sel);
    if (nextEl) break;
  }
  if (!nextEl) {
    const curEl = document.querySelector("td.cur, [aria-current='page']");
    const curNum = curEl ? parseInt(curEl.textContent.trim(), 10) : 1;
    const targetNum = curNum + 1;
    nextEl = document.querySelector(`a[aria-label="Page ${targetNum}"], a[aria-label*="page ${targetNum}" i]`);
  }
  if (!nextEl) {
    return { ok: false, reason: "no_next_button" };
  }
  nextEl.scrollIntoView({ behavior: "smooth", block: "center" });
  const rect = nextEl.getBoundingClientRect();
  const evtInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };
  nextEl.dispatchEvent(new MouseEvent("mousemove", evtInit));
  nextEl.dispatchEvent(new MouseEvent("mousedown", evtInit));
  nextEl.dispatchEvent(new MouseEvent("mouseup", evtInit));
  nextEl.click();
  return { ok: true, href: nextEl.getAttribute("href") || nextEl.href || null };
}

export function googleCheckChallengeFunc() {
  const url = (window.location.href || "").toLowerCase();
  if (url.includes("/sorry/index") || url.includes("google.com/sorry")) return { isChallenge: true, provider: "google-sorry" };
  if (document.querySelector('#captcha-form, form[action*="sorry"], #recaptcha, .g-recaptcha, iframe[src*="recaptcha"]')) {
    return { isChallenge: true, provider: "google-recaptcha" };
  }
  if (url.includes("consent.google.com")) return { isChallenge: true, provider: "google-consent" };
  const title = (document.title || "").toLowerCase();
  if (title.includes("unusual traffic") || title.startsWith("sorry")) return { isChallenge: true, provider: "google-sorry" };
  const text = document.body ? document.body.innerText || "" : "";
  if (
    text.includes("Our systems have detected unusual traffic") ||
    text.includes("Please solve the challenge below") ||
    text.includes("automated queries")
  ) {
    return { isChallenge: true, provider: "google-unusual-traffic" };
  }
  return { isChallenge: false, provider: null };
}
