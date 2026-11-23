/**
 * SerpyDerpy v2 — Bing Search Engine Adapter
 * Implements Section 6.3 #2 including mandatory Base64URL ck/a u=a1... unwrapping.
 */

export const ENGINE_ID = "bing";

export function buildInitialUrl(query) {
  return `https://www.bing.com/search?q=${encodeURIComponent(String(query || "").trim())}&setlang=en-US&cc=US`;
}

export function isEngineSearchUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isBing = host === "bing.com" || host.endsWith(".bing.com");
    return isBing && (u.pathname.startsWith("/search") || u.searchParams.has("q"));
  } catch (_) {
    return false;
  }
}

export function parseActiveTabQuery(url) {
  try {
    const u = new URL(url);
    const query = (u.searchParams.get("q") || "").trim();
    const first = parseInt(u.searchParams.get("first") || "1", 10);
    const pageNumber = Number.isFinite(first) && first >= 1 ? Math.floor((first - 1) / 10) + 1 : 1;
    return { query, pageNumber };
  } catch (_) {
    return { query: "", pageNumber: 1 };
  }
}

/**
 * Decode Bing `u=a1<base64url>` redirect payload safely with padding and UTF-8 TextDecoder.
 */
export function decodeBingBase64UrlParam(uParam) {
  if (!uParam || typeof uParam !== "string") return "";
  if (!uParam.startsWith("a1")) return "";
  let b64 = uParam.slice(2).replace(/-/g, "+").replace(/_/g, "/");
  const mod = b64.length % 4;
  if (mod === 2) b64 += "==";
  else if (mod === 3) b64 += "=";
  else if (mod === 1) return "";

  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    const parsed = new URL(decoded);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return "";
  } catch (_) {
    return "";
  }
}

/**
 * Unwrap Bing click-tracking redirect URL (`bing.com/ck/a?...&u=a1...`) with optional <cite> fallback.
 */
export function unwrapResultUrl(rawHref, citeFallback = "", baseOrigin = "https://www.bing.com") {
  if (!rawHref) return { url: "", urlDecodeFallback: false };
  try {
    const parsed = new URL(rawHref, baseOrigin);
    const host = parsed.hostname.toLowerCase();

    // Bing click wrapper: /ck/a?...&u=a1<base64url>
    if ((host === "bing.com" || host.endsWith(".bing.com")) && parsed.pathname.startsWith("/ck/a")) {
      const uParam = parsed.searchParams.get("u");
      const decoded = decodeBingBase64UrlParam(uParam);
      if (decoded) {
        return { url: decoded, urlDecodeFallback: false };
      }
      // Fallback to visible <cite> when decoding fails
      const cleanCite = String(citeFallback || "")
        .replace(/\s*›\s*/g, "/")
        .replace(/\s+/g, "")
        .trim();
      if (cleanCite) {
        try {
          const candidate = /^https?:\/\//i.test(cleanCite) ? cleanCite : `https://${cleanCite}`;
          const citeUrl = new URL(candidate);
          if (citeUrl.protocol === "http:" || citeUrl.protocol === "https:") {
            return { url: citeUrl.href, urlDecodeFallback: true };
          }
        } catch (_) {}
      }
      return { url: "", urlDecodeFallback: false };
    }

    // Filter Bing internal & ad links
    if (host === "bing.com" || host.endsWith(".bing.com")) {
      if (
        parsed.pathname.startsWith("/search") ||
        parsed.pathname.startsWith("/aclick") ||
        parsed.pathname.startsWith("/ck/") ||
        parsed.pathname.startsWith("/images") ||
        parsed.pathname.startsWith("/videos") ||
        parsed.pathname.startsWith("/maps")
      ) {
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
 * Self-contained DOM extractor executed inside a Bing SERP tab.
 */
export function bingDomExtractorFunc() {
  const cleanText = (str) =>
    String(str || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();

  function decodeBingParam(uParam) {
    if (!uParam || !uParam.startsWith("a1")) return "";
    let b64 = uParam.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const mod = b64.length % 4;
    if (mod === 2) b64 += "==";
    else if (mod === 3) b64 += "=";
    else if (mod === 1) return "";
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
      const parsed = new URL(decoded);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
      return "";
    } catch (_) {
      return "";
    }
  }

  function unwrapHref(rawHref, citeFallback) {
    if (!rawHref) return { url: "", fallback: false };
    try {
      const parsed = new URL(rawHref, window.location.origin);
      const host = parsed.hostname.toLowerCase();
      if ((host === "bing.com" || host.endsWith(".bing.com")) && parsed.pathname.startsWith("/ck/a")) {
        const dec = decodeBingParam(parsed.searchParams.get("u") || "");
        if (dec) return { url: dec, fallback: false };
        const cleanCite = String(citeFallback || "").replace(/\s*›\s*/g, "/").replace(/\s+/g, "").trim();
        if (cleanCite) {
          try {
            const c = new URL(/^https?:\/\//i.test(cleanCite) ? cleanCite : `https://${cleanCite}`);
            if (c.protocol === "http:" || c.protocol === "https:") return { url: c.href, fallback: true };
          } catch (_) {}
        }
        return { url: "", fallback: false };
      }
      if (host === "bing.com" || host.endsWith(".bing.com")) {
        if (
          parsed.pathname.startsWith("/search") ||
          parsed.pathname.startsWith("/aclick") ||
          parsed.pathname.startsWith("/ck/")
        ) {
          return { url: "", fallback: false };
        }
      }
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return { url: parsed.href, fallback: false };
      return { url: "", fallback: false };
    } catch (_) {
      return { url: "", fallback: false };
    }
  }

  function detectChallenge() {
    const url = (window.location.href || "").toLowerCase();
    const title = (document.title || "").toLowerCase();
    const text = document.body ? document.body.innerText || "" : "";
    if (
      document.querySelector('#b_captcha, #captcha, iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')
    ) {
      return { isChallenge: true, provider: "bing-captcha" };
    }
    if (
      url.includes("/challenge") ||
      url.includes("login.live.com") ||
      title.includes("one last step") ||
      text.includes("One last step") ||
      text.includes("Please solve the challenge") ||
      text.includes("Verify you are human")
    ) {
      return { isChallenge: true, provider: "bing-challenge" };
    }
    return { isChallenge: false, provider: null };
  }

  const challenge = detectChallenge();
  if (challenge.isChallenge) {
    return {
      ok: false,
      isChallenge: true,
      challengeProvider: challenge.provider,
      error: `Bing challenge detected (${challenge.provider})`
    };
  }

  let query = "";
  try {
    query = (new URL(window.location.href).searchParams.get("q") || "").trim();
  } catch (_) {}
  if (!query) {
    const inp = document.querySelector('#sb_form_q, input[name="q"]');
    if (inp && inp.value) query = inp.value.trim();
  }

  const bodyText = document.body ? document.body.innerText || "" : "";
  const zeroResults =
    Boolean(document.querySelector("li.b_no")) ||
    /There are no results for/i.test(bodyText);

  let queryRewrittenTo = null;
  let exactMatchLost = false;
  const rewriteEl = document.querySelector("#sp_requery a, .b_ans a.sp_requery");
  if (rewriteEl) {
    queryRewrittenTo = cleanText(rewriteEl.textContent) || null;
    exactMatchLost = /including results for|showing results for/i.test(
      cleanText(rewriteEl.parentElement ? rewriteEl.parentElement.textContent : "")
    );
  }

  // Organic results (excluding ad blocks)
  const results = [];
  const seenUrls = new Set();
  const algoItems = Array.from(document.querySelectorAll("#b_results li.b_algo"));

  for (const li of algoItems) {
    if (li.closest('.b_ad, .b_adTop, .b_adBottom, [data-isad="true"]')) continue;
    if (li.querySelector('.b_adSlug, [data-isad="true"], a[href*="/aclick?"]')) continue;

    const anchor = li.querySelector("h2 a[href]");
    if (!anchor) continue;
    const title = cleanText(anchor.innerText || anchor.textContent);
    if (!title) continue;

    const citeEl = li.querySelector("cite, .b_attribution cite");
    const citeTxt = cleanText(citeEl ? citeEl.textContent : "");
    const rawHref = anchor.getAttribute("href") || anchor.href || "";
    const unwrapped = unwrapHref(rawHref, citeTxt);
    if (!unwrapped.url || seenUrls.has(unwrapped.url)) continue;
    seenUrls.add(unwrapped.url);

    let domain = "";
    try {
      domain = new URL(unwrapped.url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch (_) {}

    const snippetEl = li.querySelector(".b_caption p, p.b_lineclamp2, p.b_lineclamp3, p.b_lineclamp4, .b_algoSlug");
    const snippet = cleanText(snippetEl ? snippetEl.innerText || snippetEl.textContent : "");
    const siteNameEl = li.querySelector(".tptt, .b_tpcn a");
    const siteName = cleanText(siteNameEl ? siteNameEl.textContent : "") || domain;

    results.push({
      title,
      rawHref,
      resolvedUrl: unwrapped.url,
      domain,
      siteName,
      snippet,
      urlDecodeFallback: unwrapped.fallback
    });
  }

  // People Also Ask & Related searches
  const peopleAlsoAsk = [];
  for (const qEl of document.querySelectorAll(".df_qna_q, .b_wpt_q, [data-tag='QnA'] .b_primtxt")) {
    const q = cleanText(qEl.textContent);
    if (q && q.endsWith("?") && !peopleAlsoAsk.includes(q)) peopleAlsoAsk.push(q);
  }

  const relatedSearches = [];
  for (const rel of document.querySelectorAll(".b_rs a, .b_rrsr a")) {
    const txt = cleanText(rel.textContent);
    if (txt && txt.length >= 2 && txt.length <= 120 && !relatedSearches.includes(txt)) {
      relatedSearches.push(txt);
    }
  }

  // Decoy candidates
  const decoyCandidates = [];
  const seenDecoys = new Set();
  for (const adItem of document.querySelectorAll('.b_ad li, .b_adTop li, .b_adBottom li, li[data-isad="true"]')) {
    const a = adItem.querySelector("h2 a[href], a[href]");
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
          displayUrl: cleanText(adItem.querySelector("cite")?.textContent || ""),
          adText: cleanText(adItem.textContent || "").slice(0, 300)
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

  const nextAnchor = document.querySelector('a.sb_pagN, a[title="Next page"], a[aria-label="Next page"]');
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
    engine: "bing",
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

export function bingClickNextFunc() {
  const nextEl = document.querySelector('a.sb_pagN, a[title="Next page"], a[aria-label="Next page"]');
  if (!nextEl) return { ok: false, reason: "no_next_button" };
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

export function bingCheckChallengeFunc() {
  const url = (window.location.href || "").toLowerCase();
  const title = (document.title || "").toLowerCase();
  const text = document.body ? document.body.innerText || "" : "";
  if (
    document.querySelector('#b_captcha, #captcha, iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')
  ) {
    return { isChallenge: true, provider: "bing-captcha" };
  }
  if (
    url.includes("/challenge") ||
    url.includes("login.live.com") ||
    title.includes("one last step") ||
    text.includes("One last step") ||
    text.includes("Please solve the challenge") ||
    text.includes("Verify you are human")
  ) {
    return { isChallenge: true, provider: "bing-challenge" };
  }
  return { isChallenge: false, provider: null };
}
