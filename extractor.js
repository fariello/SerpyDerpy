/**
 * SerpyDerpy Content Extractor (v1.0.5)
 * Injected into a Google Search Results Page (SERP).
 * Resiliently parses organic results, titles, destination URLs, domains, snippets,
 * extracts pagination links, detects bot/CAPTCHA challenges, and gathers browser/system metadata.
 */
(() => {
  function cleanText(str) {
    return (str || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();
  }

  function checkForCaptcha() {
    const url = window.location.href.toLowerCase();
    if (url.includes("/sorry/index") || url.includes("google.com/sorry")) {
      return true;
    }
    if (
      document.querySelector(
        '#captcha-form, form[action*="sorry"], #recaptcha, .g-recaptcha, iframe[src*="recaptcha"]'
      )
    ) {
      return true;
    }
    const title = (document.title || "").toLowerCase();
    if (title.includes("unusual traffic") || title.startsWith("sorry")) {
      return true;
    }
    const text = document.body ? document.body.innerText : "";
    if (
      text.includes("Our systems have detected unusual traffic") ||
      text.includes("Please solve the challenge below") ||
      text.includes("automated queries")
    ) {
      return true;
    }
    return false;
  }

  function getClientMetadata() {
    const nav = window.navigator || {};
    const scr = window.screen || {};

    let timezone = "";
    let timezoneOffsetMinutes = 0;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      timezoneOffsetMinutes = new Date().getTimezoneOffset();
    } catch (_) {}

    return {
      userAgent: nav.userAgent || "",
      appVersion: nav.appVersion || "",
      platform: nav.platform || "",
      vendor: nav.vendor || "",
      language: nav.language || "",
      languages: Array.isArray(nav.languages) ? [...nav.languages] : [nav.language || ""],
      cookieEnabled: Boolean(nav.cookieEnabled),
      doNotTrack: nav.doNotTrack || null,
      hardwareConcurrency: nav.hardwareConcurrency || null,
      deviceMemory: nav.deviceMemory || null,
      screen: {
        width: scr.width || null,
        height: scr.height || null,
        availWidth: scr.availWidth || null,
        availHeight: scr.availHeight || null,
        colorDepth: scr.colorDepth || null,
        pixelDepth: scr.pixelDepth || null,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      viewport: {
        innerWidth: window.innerWidth || null,
        innerHeight: window.innerHeight || null
      },
      timezone,
      timezoneOffsetMinutes,
      documentCharacterSet: document.characterSet || "UTF-8",
      documentReferrer: document.referrer || ""
    };
  }

  function resolveDestinationUrl(rawHref) {
    if (!rawHref) return "";
    try {
      const parsed = new URL(rawHref, window.location.origin);

      // Handle Google redirect wrappers (/url?q=https://...)
      if (parsed.pathname === "/url" && parsed.searchParams.has("q")) {
        const dest = parsed.searchParams.get("q");
        return dest ? new URL(dest).href : "";
      }

      // Ignore internal google domains, services, and search pages
      const host = parsed.hostname.toLowerCase();
      if (
        host === "google.com" ||
        host.endsWith(".google.com") ||
        host.includes("google.")
      ) {
        if (
          parsed.pathname.startsWith("/search") ||
          parsed.pathname.startsWith("/url") ||
          parsed.pathname.startsWith("/preferences") ||
          parsed.pathname.startsWith("/advanced_search") ||
          parsed.pathname.startsWith("/imgres")
        ) {
          return "";
        }
      }

      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
      return "";
    } catch (_) {
      return "";
    }
  }

  function getSearchQuery() {
    try {
      const urlQuery = new URL(window.location.href).searchParams.get("q");
      if (urlQuery && urlQuery.trim()) return urlQuery.trim();
    } catch (_) {}

    const searchInput = document.querySelector('textarea[name="q"], input[name="q"]');
    if (searchInput && searchInput.value) {
      return searchInput.value.trim();
    }

    const docTitle = document.title || "";
    const titleMatch = docTitle.replace(/ - Google Search$/i, "").trim();
    return titleMatch || "Google Search";
  }

  function extractSnippet(container, h3) {
    if (!container) return "";

    const snippetSelectors = [
      'div[style*="-webkit-line-clamp"]',
      ".VwiC3b",
      ".yXK7lf",
      ".MUxGbd",
      ".BNeawe.s3v9rd.AP7Wnd",
      "span.aCOpRe",
      "div.IsZvec"
    ];

    for (const sel of snippetSelectors) {
      try {
        const els = container.querySelectorAll(sel);
        for (const el of els) {
          const txt = cleanText(el.innerText || el.textContent);
          if (txt && txt.length > 25 && !txt.includes(cleanText(h3.textContent))) {
            return txt;
          }
        }
      } catch (_) {}
    }

    const blockElements = container.querySelectorAll("div, p, span");
    for (const el of blockElements) {
      if (el.contains(h3) || h3.contains(el)) continue;
      const txt = cleanText(el.innerText || el.textContent);
      if (txt.length >= 35 && !txt.includes(cleanText(h3.textContent))) {
        if (!Array.from(el.children).some((c) => cleanText(c.innerText).length > 30)) {
          return txt;
        }
      }
    }

    return "";
  }

  function extractSiteNameOrDomain(container, url) {
    let domain = "";
    try {
      domain = new URL(url).hostname.replace(/^www\./i, "");
    } catch (_) {}

    if (container) {
      const cite = container.querySelector("cite, span[role='text'], div.notranslate");
      if (cite) {
        const txt = cleanText(cite.textContent);
        if (txt && txt.length < 80) {
          return { siteName: txt, domain };
        }
      }
    }
    return { siteName: domain, domain };
  }

  function extractOrganicResults() {
    const results = [];
    const seenUrls = new Set();

    const h3Elements = Array.from(document.querySelectorAll("h3"));

    for (const h3 of h3Elements) {
      const title = cleanText(h3.innerText || h3.textContent);
      if (!title) continue;

      const lower = title.toLowerCase();
      if (
        lower === "people also ask" ||
        lower === "people also search for" ||
        lower === "related searches" ||
        lower === "videos" ||
        lower === "images" ||
        lower === "news" ||
        lower === "maps" ||
        lower.includes("search filters")
      ) {
        continue;
      }

      const anchor =
        h3.closest("a[href]") ||
        h3.querySelector("a[href]") ||
        h3.parentElement?.querySelector("a[href]");
      if (!anchor) continue;

      const destUrl = resolveDestinationUrl(anchor.getAttribute("href") || anchor.href);
      if (!destUrl) continue;

      if (seenUrls.has(destUrl)) continue;
      seenUrls.add(destUrl);

      let container = h3.closest(
        "div.g, div[data-sokoban-container], div[jscontroller], div[data-hveid]"
      );
      if (!container || container === document.body) {
        container = h3.parentElement?.parentElement || h3.parentElement;
      }

      if (
        container &&
        (container.querySelector('[data-text-ad="1"]') ||
          container.getAttribute("data-text-ad") === "1" ||
          container.closest('[data-text-ad="1"]'))
      ) {
        continue;
      }

      const snippet = extractSnippet(container, h3);
      const { siteName, domain } = extractSiteNameOrDomain(container, destUrl);

      results.push({
        title,
        url: destUrl,
        domain,
        siteName,
        snippet
      });
    }

    return results;
  }

  function extractPeopleAlsoAsk() {
    const questions = [];
    const paaContainers = document.querySelectorAll(
      'div[jsname="yEVEwb"], div[related-question-pair], div[data-q]'
    );

    for (const item of paaContainers) {
      const heading = item.querySelector('div[role="button"], span.CSkcDe, [data-q]');
      const qText = cleanText(
        heading ? heading.getAttribute("data-q") || heading.textContent : item.textContent
      );
      if (qText && qText.endsWith("?")) {
        if (!questions.includes(qText)) {
          questions.push(qText);
        }
      }
    }
    return questions.slice(0, 10);
  }

  function extractNextPageUrl() {
    const nextAnchor = document.querySelector(
      'a#pnnext, a[aria-label="Next page"], a[aria-label="Next"]'
    );
    if (nextAnchor) {
      const href = nextAnchor.getAttribute("href") || nextAnchor.href;
      if (href) {
        try {
          return new URL(href, window.location.origin).href;
        } catch (_) {}
      }
    }

    try {
      const currentUrl = new URL(window.location.href);
      const currentStart = parseInt(currentUrl.searchParams.get("start") || "0", 10);
      const currentPageNum = Math.floor(currentStart / 10) + 1;
      const targetPageNum = currentPageNum + 1;

      const pageAnchor = document.querySelector(
        `a[aria-label="Page ${targetPageNum}"], a[aria-label*="page ${targetPageNum}"]`
      );
      if (pageAnchor) {
        const href = pageAnchor.getAttribute("href") || pageAnchor.href;
        if (href) {
          return new URL(href, window.location.origin).href;
        }
      }
    } catch (_) {}

    return null;
  }

  function extractDecoyCandidates() {
    const candidates = [];
    const seenHrefs = new Set();

    // 1. Sponsored Links (Google Ads)
    const adSelectors = [
      'div[data-text-ad="1"] a[href]',
      'div.uEierd a[href]',
      'a[href*="/aclk?"]',
      '[data-rw] a[href]',
      '.v5yQqb a[href]',
      'div.vdQmEd a[href]'
    ];

    for (const sel of adSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const raw = el.getAttribute("href") || el.href;
          if (!raw) continue;
          let fullUrl = "";
          try {
            fullUrl = new URL(raw, window.location.origin).href;
          } catch (_) {
            continue;
          }
          if (
            fullUrl &&
            (fullUrl.startsWith("http://") || fullUrl.startsWith("https://")) &&
            !seenHrefs.has(fullUrl)
          ) {
            seenHrefs.add(fullUrl);
            candidates.push({
              url: fullUrl,
              type: "sponsored",
              title: cleanText(el.innerText || el.textContent || "Sponsored Ad")
            });
          }
        }
      } catch (_) {}
    }

    // 2. Regular Organic Links
    try {
      const organicAnchors = document.querySelectorAll(
        "div.g h3 a[href], h3 a[href], div.g a[href]"
      );
      for (const a of organicAnchors) {
        const raw = a.getAttribute("href") || a.href;
        if (!raw) continue;
        const dest = resolveDestinationUrl(raw);
        if (dest && !seenHrefs.has(dest)) {
          seenHrefs.add(dest);
          candidates.push({
            url: dest,
            type: "organic",
            title: cleanText(a.innerText || a.textContent || "Organic Result")
          });
        }
      }
    } catch (_) {}

    return candidates;
  }

  try {
    const isCaptcha = checkForCaptcha();
    if (isCaptcha) {
      return {
        ok: false,
        isCaptcha: true,
        error: "Google reCAPTCHA or unusual traffic page detected."
      };
    }

    const query = getSearchQuery();
    const currentUrl = window.location.href;
    const timestampUtc = new Date().toISOString();
    const results = extractOrganicResults();
    const peopleAlsoAsk = extractPeopleAlsoAsk();
    const nextPageUrl = extractNextPageUrl();
    const clientMetadata = getClientMetadata();
    const decoyCandidates = extractDecoyCandidates();

    // Construct Markdown output for this page
    const mdLines = [
      "---",
      `Query: "${query.replace(/"/g, '\\"')}"`,
      `URL: ${currentUrl}`,
      `Retrieved-Timestamp: ${timestampUtc}`,
      `Total-Results: ${results.length}`,
      "---",
      "",
      `# Search Results: ${query}`,
      ""
    ];

    if (results.length === 0) {
      mdLines.push("*No organic search results could be extracted from this page.*");
    } else {
      results.forEach((r, idx) => {
        mdLines.push(`## ${idx + 1}. [${r.title}](${r.url})`);
        if (r.siteName) {
          mdLines.push(`*${r.siteName}*`);
        }
        if (r.snippet) {
          mdLines.push("");
          mdLines.push(r.snippet);
        }
        mdLines.push("");
      });
    }

    if (peopleAlsoAsk.length > 0) {
      mdLines.push("---");
      mdLines.push("");
      mdLines.push("### People Also Ask");
      mdLines.push("");
      for (const q of peopleAlsoAsk) {
        mdLines.push(`- ${q}`);
      }
      mdLines.push("");
    }

    const markdown = mdLines.join("\n");
    const cleanUrls = results.map((r) => r.url);
    const rawHtml =
      "<!DOCTYPE html>\n" +
      (document.documentElement ? document.documentElement.outerHTML : "");

    return {
      ok: true,
      isCaptcha: false,
      query,
      currentUrl,
      timestampUtc,
      resultsCount: results.length,
      results,
      peopleAlsoAsk,
      nextPageUrl,
      cleanUrls,
      markdown,
      rawHtml,
      clientMetadata,
      decoyCandidates
    };
  } catch (err) {
    return {
      ok: false,
      isCaptcha: false,
      error: String(err && err.message ? err.message : err),
      rawHtml:
        "<!DOCTYPE html>\n" +
        (document.documentElement ? document.documentElement.outerHTML : "")
    };
  }
})();
