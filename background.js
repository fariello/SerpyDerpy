/**
 * SerpyDerpy Background Service Worker (v1.0.5)
 * Coordinates multi-page Google SERP crawling, gentle randomized delays,
 * reCAPTCHA handling, human presence simulation, click-based Next navigation,
 * and comprehensive metadata compilation (.json + .md + .html).
 */

function sanitizeSubfolder(folder) {
  const cleaned = (folder || "SerpyDerpy")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((part) => part.replace(/[<>:"|?*\x00-\x1F]/g, "").trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || "SerpyDerpy";
}

function getLocalDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function getLocalTimestampString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const tzOffset = -date.getTimezoneOffset();
  const diffSign = tzOffset >= 0 ? "+" : "-";
  const diffHours = pad(Math.floor(Math.abs(tzOffset) / 60));
  const diffMinutes = pad(Math.abs(tzOffset) % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${diffSign}${diffHours}:${diffMinutes}`;
}

function buildBaseFilename(subfolder, query) {
  const dateStr = getLocalDateString();
  const slug =
    (query || "google-search")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "results";

  const folder = sanitizeSubfolder(subfolder);
  return `${folder}/${dateStr}-${slug}`;
}

function downloadFile(content, filename, mimeType = "text/plain") {
  return new Promise((resolve, reject) => {
    const dataUrl =
      `data:${mimeType};charset=utf-8,` + encodeURIComponent(content);

    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(
            new Error(
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                "Download failed"
            )
          );
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

async function getPublicIpAddress() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.ip) return data.ip;
    }
  } catch (_) {}

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("https://icanhazip.com", {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const text = await res.text();
      if (text && text.trim()) return text.trim();
    }
  } catch (_) {}

  return "unavailable";
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) finish();
      else if (tab.status === "complete") finish();
    });
  });
}

function waitForTabNavigation(tabId, oldUrl, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId) {
        if (changeInfo.status === "complete") {
          cleanup();
          resolve(true);
        }
      }
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) {
        cleanup();
        resolve(false);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

let designatedSearchTabId = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === designatedSearchTabId) {
    designatedSearchTabId = null;
  }
});

async function getOrCreateSearchTab(searchUrl, reuseTab) {
  if (reuseTab && designatedSearchTabId !== null) {
    try {
      const existing = await chrome.tabs.get(designatedSearchTabId);
      if (existing) {
        await chrome.tabs.update(designatedSearchTabId, {
          url: searchUrl,
          active: true
        });
        return { tabId: designatedSearchTabId, shouldClose: false };
      }
    } catch (_) {
      designatedSearchTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: searchUrl,
    active: true
  });

  if (reuseTab) {
    designatedSearchTabId = tab.id;
  }

  return { tabId: tab.id, shouldClose: !reuseTab };
}

// Active crawl state management
let activeCrawlState = {
  isRunning: false,
  query: "",
  currentPage: 0,
  totalPages: 0,
  totalResults: 0,
  statusText: "Ready",
  isWaiting: false,
  waitingSeconds: 0,
  isCaptcha: false,
  cleanUrls: [],
  savedFilename: "",
  error: null,
  abortRequested: false
};

function updateCrawlState(updates) {
  activeCrawlState = { ...activeCrawlState, ...updates };
  chrome.storage.local.set({ serpyderpyActiveCrawl: activeCrawlState });
  chrome.runtime
    .sendMessage({ type: "CRAWL_STATE_UPDATE", state: activeCrawlState })
    .catch(() => {});
}

// Check if tab is currently on a CAPTCHA or unusual traffic page
async function checkTabForCaptcha(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return false;
    const url = (tab.url || "").toLowerCase();
    if (url.includes("/sorry/index") || url.includes("google.com/sorry")) {
      return true;
    }

    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const u = window.location.href.toLowerCase();
        if (u.includes("/sorry/index") || u.includes("google.com/sorry")) return true;
        if (
          document.querySelector(
            '#captcha-form, form[action*="sorry"], #recaptcha, .g-recaptcha, iframe[src*="recaptcha"]'
          )
        ) {
          return true;
        }
        const title = (document.title || "").toLowerCase();
        if (title.includes("unusual traffic") || title.startsWith("sorry")) return true;
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
    });

    return Boolean(res && res[0] && res[0].result);
  } catch (_) {
    return false;
  }
}

// Wait for the user to solve a detected reCAPTCHA
async function handleCaptchaWait(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  try {
    const tabObj = await chrome.tabs.get(tabId);
    if (tabObj.windowId) {
      await chrome.windows.update(tabObj.windowId, { focused: true });
    }
  } catch (_) {}

  updateCrawlState({
    isCaptcha: true,
    statusText: "⚠️ reCAPTCHA detected! Please solve the CAPTCHA in the Google tab to continue..."
  });

  const maxWait = 300000; // 5 minutes
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    if (activeCrawlState.abortRequested) {
      throw new Error("Crawl cancelled by user.");
    }
    await new Promise((r) => setTimeout(r, 1500));

    const stillCaptcha = await checkTabForCaptcha(tabId);
    if (!stillCaptcha) {
      updateCrawlState({
        isCaptcha: false,
        statusText: "✓ CAPTCHA resolved! Resuming crawl..."
      });
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    }
  }
  throw new Error("Timed out waiting for CAPTCHA to be solved.");
}

// Simulate human mouse movement and scrolling in the tab
async function simulateHumanInTab(tabId, durationMs) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (duration) => {
        return new Promise((resolve) => {
          const startTime = Date.now();
          const timer = setInterval(() => {
            if (Date.now() - startTime >= duration) {
              clearInterval(timer);
              resolve();
              return;
            }
            const deltaY = (Math.random() - 0.35) * 280;
            window.scrollBy({ top: deltaY, behavior: "smooth" });

            const x = Math.floor(Math.random() * (window.innerWidth - 100) + 50);
            const y = Math.floor(Math.random() * (window.innerHeight - 100) + 50);
            const evt = new MouseEvent("mousemove", {
              clientX: x,
              clientY: y,
              bubbles: true,
              cancelable: true,
              view: window
            });
            document.dispatchEvent(evt);
          }, 1400);
        });
      },
      args: [durationMs]
    });
  } catch (_) {
    await new Promise((r) => setTimeout(r, durationMs));
  }
}

// Track background decoy tabs so they close cleanly
const activeDecoyTabIds = new Set();

async function spawnParallelDecoyTab(targetUrl, durationMs) {
  let tabId = null;
  try {
    // Open in background tab so the search tab / window is never interrupted
    const tab = await chrome.tabs.create({
      url: targetUrl,
      active: false
    });
    tabId = tab.id;
    activeDecoyTabIds.add(tabId);

    // Wait for the decoy page to complete loading (safety timeout 15s)
    await waitForTabComplete(tabId, 15000);

    // Human-like scrolling simulation in parallel tab for 3 to 33 seconds
    await simulateHumanInTab(tabId, durationMs);
  } catch (_) {
    // Silent fail for decoy tabs so they never affect the main task
  } finally {
    if (tabId !== null) {
      activeDecoyTabIds.delete(tabId);
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {}
    }
  }
}

function selectDecoyLink(candidates, preference = "any") {
  if (!candidates || candidates.length === 0) return null;

  const pref = (preference || "any").toLowerCase();
  let pool = candidates;

  if (pref === "sponsored") {
    const sponsored = candidates.filter((c) => c.type === "sponsored");
    if (sponsored.length > 0) {
      pool = sponsored;
    }
  } else if (pref === "organic") {
    const organic = candidates.filter((c) => c.type === "organic");
    if (organic.length > 0) {
      pool = organic;
    }
  }

  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// Gentle delay with 1-second countdown ticks and human simulation
async function gentleWaitWithSimulation(tabId, delayMs, onTick) {
  const endTime = Date.now() + delayMs;
  simulateHumanInTab(tabId, delayMs).catch(() => {});

  while (Date.now() < endTime) {
    if (activeCrawlState.abortRequested) break;
    const remainingSec = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    if (onTick) onTick(remainingSec);
    await new Promise((res) => setTimeout(res, 1000));
  }
}

// Click Google's 'Next' link in the tab
async function clickNextPageInTab(tabId) {
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
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
          nextEl = document.querySelector(
            `a[aria-label="Page ${targetNum}"], a[aria-label*="page ${targetNum}" i]`
          );
        }

        if (!nextEl) {
          return { ok: false, reason: "No Next page link found in DOM" };
        }

        nextEl.scrollIntoView({ behavior: "smooth", block: "center" });

        const rect = nextEl.getBoundingClientRect();
        const clientX = Math.round(rect.left + rect.width / 2);
        const clientY = Math.round(rect.top + rect.height / 2);
        const evtInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY
        };

        nextEl.dispatchEvent(new MouseEvent("mousemove", evtInit));
        nextEl.dispatchEvent(new MouseEvent("mousedown", evtInit));
        nextEl.dispatchEvent(new MouseEvent("mouseup", evtInit));
        nextEl.click();

        return {
          ok: true,
          href: nextEl.getAttribute("href") || nextEl.href || null,
          tagName: nextEl.tagName
        };
      }
    });

    return injection && injection[0] ? injection[0].result : { ok: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Merge page results and associate each result with its source page and file
function mergePageResults(pages, htmlFilenames = []) {
  const allResults = [];
  const seenUrls = new Set();
  const allPaa = [];
  const seenPaa = new Set();

  pages.forEach((page, pageIdx) => {
    const pageNumber = pageIdx + 1;
    const htmlFile = htmlFilenames[pageIdx] || null;

    (page.results || []).forEach((r, itemIdx) => {
      if (r && r.url && !seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        allResults.push({
          rank: allResults.length + 1,
          pageNumber,
          pageRank: itemIdx + 1,
          title: r.title,
          url: r.url,
          domain: r.domain || "",
          siteName: r.siteName || "",
          snippet: r.snippet || "",
          extractedTimestampUtc: page.timestampUtc,
          htmlFile
        });
      }
    });

    (page.peopleAlsoAsk || []).forEach((q) => {
      if (q && !seenPaa.has(q)) {
        seenPaa.add(q);
        allPaa.push({
          question: q,
          pageNumber,
          htmlFile
        });
      }
    });
  });

  return { allResults, allPaa };
}

function buildMasterMarkdown({
  query,
  initialUrl,
  timestampUtc,
  pagesCrawled,
  allResults,
  allPaa
}) {
  const mdLines = [
    "---",
    `Query: "${(query || "").replace(/"/g, '\\"')}"`,
    `URL: ${initialUrl}`,
    `Retrieved-Timestamp: ${timestampUtc}`,
    `Pages-Crawled: ${pagesCrawled}`,
    `Total-Results: ${allResults.length}`,
    "---",
    "",
    `# Search Results: ${query}`,
    ""
  ];

  if (allResults.length === 0) {
    mdLines.push("*No organic search results could be extracted.*");
  } else {
    allResults.forEach((r, idx) => {
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

  if (allPaa.length > 0) {
    mdLines.push("---");
    mdLines.push("");
    mdLines.push("### People Also Ask");
    mdLines.push("");
    for (const item of allPaa) {
      mdLines.push(`- ${item.question}`);
    }
    mdLines.push("");
  }

  return mdLines.join("\n");
}

function buildComprehensiveJson({
  query,
  initialUrl,
  noPersonalization,
  pagesRequested,
  startTimestamp,
  endTimestamp,
  ipAddress,
  clientMetadata,
  savedFiles,
  collectedPages,
  allResults,
  allPaa,
  decoyBrowsingEnabled = false,
  decoyTypePreference = "any",
  recordedDecoyVisits = []
}) {
  const durationMs = endTimestamp.getTime() - startTimestamp.getTime();
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  const extVersion = manifest.version || "1.0.5";

  return {
    version: extVersion,
    generator: {
      name: manifest.name || "SerpyDerpy",
      description: manifest.description || "SERP to Markdown & Comprehensive Metadata Extractor",
      version: extVersion,
      manifestVersion: manifest.manifest_version || 3
    },
    environment: {
      ipAddress: ipAddress || "unavailable",
      browser: {
        userAgent: clientMetadata.userAgent || "",
        appVersion: clientMetadata.appVersion || "",
        platform: clientMetadata.platform || "",
        vendor: clientMetadata.vendor || "",
        language: clientMetadata.language || "",
        languages: clientMetadata.languages || [],
        cookieEnabled: clientMetadata.cookieEnabled,
        doNotTrack: clientMetadata.doNotTrack,
        hardwareConcurrency: clientMetadata.hardwareConcurrency,
        deviceMemory: clientMetadata.deviceMemory,
        screen: clientMetadata.screen || {},
        viewport: clientMetadata.viewport || {},
        timezone: clientMetadata.timezone || "",
        timezoneOffsetMinutes: clientMetadata.timezoneOffsetMinutes,
        documentCharacterSet: clientMetadata.documentCharacterSet || "UTF-8"
      }
    },
    searchMetadata: {
      query: query || "",
      initialSearchUrl: initialUrl || "",
      noPersonalizationApplied: Boolean(noPersonalization),
      pagesRequested,
      pagesCrawled: collectedPages.length,
      totalOrganicResults: allResults.length,
      totalPeopleAlsoAsk: allPaa.length,
      timestamps: {
        startedUtc: startTimestamp.toISOString(),
        startedLocal: getLocalTimestampString(startTimestamp),
        completedUtc: endTimestamp.toISOString(),
        completedLocal: getLocalTimestampString(endTimestamp),
        durationMs,
        durationFormatted: `${(durationMs / 1000).toFixed(1)}s`
      },
      pages: collectedPages.map((page, idx) => {
        const pNum = idx + 1;
        const htmlFile = savedFiles.htmlFiles[idx] || null;
        return {
          pageNumber: pNum,
          url: page.currentUrl,
          resultsOnPage: (page.results || []).length,
          extractedTimestampUtc: page.timestampUtc,
          associatedFiles: {
            markdown: savedFiles.markdownFile,
            html: htmlFile
          }
        };
      })
    },
    savedFiles: {
      subfolder: savedFiles.subfolder,
      markdown: savedFiles.markdownFile,
      json: savedFiles.jsonFile || null,
      html: savedFiles.htmlFiles
    },
    decoyBrowsing: {
      enabled: Boolean(decoyBrowsingEnabled),
      preference: decoyTypePreference,
      totalDecoyVisits: recordedDecoyVisits.length,
      visits: recordedDecoyVisits
    },
    results: allResults.map((r) => ({
      rank: r.rank,
      pageNumber: r.pageNumber,
      pageRank: r.pageRank,
      title: r.title,
      url: r.url,
      domain: r.domain,
      siteName: r.siteName,
      snippet: r.snippet,
      extractedTimestampUtc: r.extractedTimestampUtc,
      sourceFiles: {
        markdown: savedFiles.markdownFile,
        html: r.htmlFile || null
      }
    })),
    peopleAlsoAsk: allPaa.map((paa) => ({
      question: paa.question,
      pageNumber: paa.pageNumber,
      sourceFiles: {
        markdown: savedFiles.markdownFile,
        html: paa.htmlFile || null
      }
    }))
  };
}

// Master Crawl & Extract function
async function runCrawl({
  tabId,
  shouldCloseTab = false,
  targetPages = 1,
  subfolder = "SerpyDerpy",
  saveHtml = true,
  saveJson = true,
  noPersonalization = true,
  decoyBrowsing = true,
  decoyType = "any",
  initialQuery = ""
}) {
  const collectedPages = [];
  const recordedDecoyVisits = [];
  let query = initialQuery;
  let initialUrl = "";
  const startTimestamp = new Date();

  // Fetch public IP address concurrently
  const ipPromise = getPublicIpAddress();

  updateCrawlState({
    isRunning: true,
    query: initialQuery,
    currentPage: 1,
    totalPages: targetPages,
    totalResults: 0,
    statusText: `Extracting page 1 of ${targetPages}...`,
    isWaiting: false,
    waitingSeconds: 0,
    isCaptcha: false,
    cleanUrls: [],
    savedFilename: "",
    error: null,
    abortRequested: false
  });

  try {
    for (let pageNum = 1; pageNum <= targetPages; pageNum++) {
      if (activeCrawlState.abortRequested) {
        break;
      }

      // Check for CAPTCHA before extraction
      const isCaptcha = await checkTabForCaptcha(tabId);
      if (isCaptcha) {
        await handleCaptchaWait(tabId);
      }

      // Extract current tab page
      const injection = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["extractor.js"]
      });

      let pagePayload = injection && injection[0] ? injection[0].result : null;

      if (pagePayload && pagePayload.isCaptcha) {
        await handleCaptchaWait(tabId);
        const retry = await chrome.scripting.executeScript({
          target: { tabId },
          files: ["extractor.js"]
        });
        pagePayload = retry && retry[0] ? retry[0].result : null;
      }

      if (!pagePayload || !pagePayload.ok) {
        throw new Error(
          (pagePayload && pagePayload.error) ||
            `Failed to extract results from page ${pageNum}`
        );
      }

      if (!query && pagePayload.query) {
        query = pagePayload.query;
      }
      if (!initialUrl && pagePayload.currentUrl) {
        initialUrl = pagePayload.currentUrl;
      }

      collectedPages.push(pagePayload);

      // Parallel decoy browsing: occasionally open a sponsored or regular link
      // in a background tab, scroll for 3-33s, and close it (non-blocking)
      if (
        decoyBrowsing &&
        pagePayload.decoyCandidates &&
        pagePayload.decoyCandidates.length > 0
      ) {
        // ~65% chance per page to visit a decoy link
        if (Math.random() < 0.65) {
          const pick = selectDecoyLink(pagePayload.decoyCandidates, decoyType);
          if (pick) {
            const durationMs =
              Math.floor(Math.random() * (33000 - 3000 + 1)) + 3000;
            const durationSec = Math.round(durationMs / 1000);

            recordedDecoyVisits.push({
              url: pick.url,
              type: pick.type,
              title: pick.title,
              pageNumber: pageNum,
              durationMs,
              durationFormatted: `${durationSec}s`,
              timestampUtc: new Date().toISOString()
            });

            // Fire and forget in parallel without awaiting!
            spawnParallelDecoyTab(pick.url, durationMs).catch(() => {});
          }
        }
      }

      const { allResults: runningResults } = mergePageResults(collectedPages);
      updateCrawlState({
        query,
        currentPage: pageNum,
        totalResults: runningResults.length,
        statusText: `Page ${pageNum} extracted (${runningResults.length} organic results so far)`
      });

      // Stop if targetPages reached
      if (pageNum >= targetPages) {
        break;
      }

      // Random gentle delay between 7 and 27 seconds
      const delayMs =
        Math.floor(Math.random() * (27000 - 7000 + 1)) + 7000;
      const delaySec = Math.round(delayMs / 1000);

      updateCrawlState({
        isWaiting: true,
        waitingSeconds: delaySec,
        statusText: `Page ${pageNum} of ${targetPages} extracted (${runningResults.length} results). Waiting ${delaySec}s before page ${pageNum + 1}...`
      });

      await gentleWaitWithSimulation(tabId, delayMs, (remSec) => {
        updateCrawlState({
          isWaiting: true,
          waitingSeconds: remSec,
          statusText: `Waiting ${remSec}s before fetching page ${pageNum + 1}...`
        });
      });

      updateCrawlState({ isWaiting: false, waitingSeconds: 0 });

      if (activeCrawlState.abortRequested) {
        break;
      }

      // Advance to next page by clicking Google's 'Next' link
      updateCrawlState({
        currentPage: pageNum + 1,
        statusText: `Clicking 'Next' page link for page ${pageNum + 1} of ${targetPages}...`
      });

      let currentTab = null;
      try {
        currentTab = await chrome.tabs.get(tabId);
      } catch (_) {}
      const oldUrl = currentTab ? currentTab.url : "";

      const navPromise = waitForTabNavigation(tabId, oldUrl, 30000);
      const clickRes = await clickNextPageInTab(tabId);

      if (!clickRes || !clickRes.ok) {
        updateCrawlState({
          statusText: `Reached end of search results (no 'Next' link).`
        });
        break;
      }

      const completed = await navPromise;
      if (!completed) {
        if (clickRes.href) {
          const fallbackUrl = new URL(
            clickRes.href,
            oldUrl || "https://www.google.com"
          ).href;
          await chrome.tabs.update(tabId, { url: fallbackUrl });
          await waitForTabComplete(tabId, 30000);
        } else {
          break;
        }
      }

      // Settle delay for DOM rendering
      await new Promise((res) => setTimeout(res, 1800));
    }

    const endTimestamp = new Date();
    const basePath = buildBaseFilename(subfolder, query);
    const mdFilename = `${basePath}.md`;
    const jsonFilename = `${basePath}.json`;

    // Compute HTML filenames according to whether 1 or multi-page
    const htmlFiles = [];
    if (saveHtml) {
      if (collectedPages.length === 1) {
        htmlFiles.push(`${basePath}.html`);
      } else {
        for (let i = 0; i < collectedPages.length; i++) {
          htmlFiles.push(`${basePath}-p${i + 1}.html`);
        }
      }
    }

    // Merge results with exact associations to the saved HTML files
    const { allResults, allPaa } = mergePageResults(collectedPages, htmlFiles);
    const cleanUrls = allResults.map((r) => r.url);

    // 1. Build and download Markdown
    const masterMarkdown = buildMasterMarkdown({
      query: query || "Google Search",
      initialUrl: initialUrl || `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      timestampUtc: startTimestamp.toISOString(),
      pagesCrawled: collectedPages.length,
      allResults,
      allPaa
    });
    await downloadFile(masterMarkdown, mdFilename, "text/markdown");

    // 2. Download HTML files if toggled
    if (saveHtml) {
      for (let i = 0; i < collectedPages.length; i++) {
        const fileTarget = htmlFiles[i];
        if (fileTarget && collectedPages[i].rawHtml) {
          try {
            await downloadFile(
              collectedPages[i].rawHtml,
              fileTarget,
              "text/html"
            );
            await new Promise((r) => setTimeout(r, 120));
          } catch (_) {}
        }
      }
    }

    // 3. Build and download Comprehensive JSON if toggled
    const ipAddress = await ipPromise;
    const clientMetadata =
      (collectedPages[0] && collectedPages[0].clientMetadata) || {};

    let savedSummaryFiles = `${mdFilename}`;
    if (saveJson) {
      const comprehensiveJson = buildComprehensiveJson({
        query: query || "Google Search",
        initialUrl: initialUrl || `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        noPersonalization,
        pagesRequested: targetPages,
        startTimestamp,
        endTimestamp,
        ipAddress,
        clientMetadata,
        savedFiles: {
          subfolder,
          markdownFile: mdFilename,
          jsonFile: jsonFilename,
          htmlFiles
        },
        collectedPages,
        allResults,
        allPaa,
        decoyBrowsingEnabled: decoyBrowsing,
        decoyTypePreference: decoyType,
        recordedDecoyVisits
      });

      const jsonContent = JSON.stringify(comprehensiveJson, null, 2);
      await downloadFile(jsonContent, jsonFilename, "application/json");
      savedSummaryFiles += ", .json";
    }

    if (saveHtml) {
      savedSummaryFiles +=
        collectedPages.length === 1
          ? " & .html"
          : ` & ${collectedPages.length} HTML pages`;
    }

    updateCrawlState({
      isRunning: false,
      query,
      totalPages: collectedPages.length,
      totalResults: allResults.length,
      statusText: activeCrawlState.abortRequested
        ? `Crawl stopped. Extracted ${allResults.length} result(s) across ${collectedPages.length} page(s).`
        : `Extracted ${allResults.length} organic result(s) across ${collectedPages.length} page(s).`,
      cleanUrls,
      savedFilename: savedSummaryFiles,
      isWaiting: false,
      isCaptcha: false,
      error: null
    });

    return {
      ok: true,
      query,
      pagesCrawled: collectedPages.length,
      resultsCount: allResults.length,
      cleanUrls,
      filename: savedSummaryFiles,
      markdown: masterMarkdown
    };
  } catch (err) {
    updateCrawlState({
      isRunning: false,
      error: err.message || String(err),
      statusText: `Error: ${err.message || String(err)}`,
      isWaiting: false,
      isCaptcha: false
    });
    throw err;
  } finally {
    if (shouldCloseTab && tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {}
    }
  }
}

// Single-page extraction helper (Save Current Page Only)
async function executeSinglePageSave({
  tabId,
  subfolder = "SerpyDerpy",
  saveHtml = true,
  saveJson = true,
  decoyBrowsing = true,
  decoyType = "any"
}) {
  const startTimestamp = new Date();
  const recordedDecoyVisits = [];
  const ipPromise = getPublicIpAddress();

  const isCaptcha = await checkTabForCaptcha(tabId);
  if (isCaptcha) {
    await handleCaptchaWait(tabId);
  }

  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["extractor.js"]
  });

  const payload = injection && injection[0] ? injection[0].result : null;
  if (!payload || !payload.ok) {
    throw new Error((payload && payload.error) || "Could not read search results");
  }

  // Parallel decoy browsing: fire and forget in background
  if (
    decoyBrowsing &&
    payload.decoyCandidates &&
    payload.decoyCandidates.length > 0
  ) {
    if (Math.random() < 0.65) {
      const pick = selectDecoyLink(payload.decoyCandidates, decoyType);
      if (pick) {
        const durationMs =
          Math.floor(Math.random() * (33000 - 3000 + 1)) + 3000;
        const durationSec = Math.round(durationMs / 1000);

        recordedDecoyVisits.push({
          url: pick.url,
          type: pick.type,
          title: pick.title,
          pageNumber: 1,
          durationMs,
          durationFormatted: `${durationSec}s`,
          timestampUtc: new Date().toISOString()
        });

        spawnParallelDecoyTab(pick.url, durationMs).catch(() => {});
      }
    }
  }

  const endTimestamp = new Date();
  const basePath = buildBaseFilename(subfolder, payload.query);
  const mdFilename = `${basePath}.md`;
  const htmlFilename = `${basePath}.html`;
  const jsonFilename = `${basePath}.json`;

  const htmlFiles = saveHtml ? [htmlFilename] : [];
  const { allResults, allPaa } = mergePageResults([payload], htmlFiles);

  await downloadFile(payload.markdown, mdFilename, "text/markdown");

  let savedSummary = `${mdFilename}`;

  if (saveHtml && payload.rawHtml) {
    try {
      await downloadFile(payload.rawHtml, htmlFilename, "text/html");
    } catch (_) {}
  }

  if (saveJson) {
    const ipAddress = await ipPromise;
    const clientMetadata = payload.clientMetadata || {};

    const comprehensiveJson = buildComprehensiveJson({
      query: payload.query,
      initialUrl: payload.currentUrl,
      noPersonalization: false,
      pagesRequested: 1,
      startTimestamp,
      endTimestamp,
      ipAddress,
      clientMetadata,
      savedFiles: {
        subfolder,
        markdownFile: mdFilename,
        jsonFile: jsonFilename,
        htmlFiles
      },
      collectedPages: [payload],
      allResults,
      allPaa,
      decoyBrowsingEnabled: decoyBrowsing,
      decoyTypePreference: decoyType,
      recordedDecoyVisits
    });

    await downloadFile(
      JSON.stringify(comprehensiveJson, null, 2),
      jsonFilename,
      "application/json"
    );
    savedSummary += ", .json";
  }

  if (saveHtml) {
    savedSummary += " & .html";
  }

  return {
    ok: true,
    query: payload.query,
    resultsCount: payload.resultsCount,
    cleanUrls: payload.cleanUrls,
    filename: savedSummary,
    markdown: payload.markdown
  };
}

// Message Dispatcher
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "GET_CRAWL_STATE") {
    sendResponse(activeCrawlState);
    return true;
  }

  if (message.type === "STOP_CRAWL") {
    activeCrawlState.abortRequested = true;
    updateCrawlState({
      abortRequested: true,
      statusText: "Stopping crawl after current step..."
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "SAVE_CURRENT_PAGE") {
    executeSinglePageSave({
      tabId: message.tabId,
      subfolder: message.subfolder || "SerpyDerpy",
      saveHtml: Boolean(message.saveHtml),
      saveJson: Boolean(message.saveJson),
      decoyBrowsing: message.decoyBrowsing !== undefined ? Boolean(message.decoyBrowsing) : true,
      decoyType: message.decoyType || "any"
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "START_CRAWL_FROM_TAB") {
    runCrawl({
      tabId: message.tabId,
      shouldCloseTab: false,
      targetPages: parseInt(message.pagesToExtract || "1", 10),
      subfolder: message.subfolder || "SerpyDerpy",
      saveHtml: Boolean(message.saveHtml),
      saveJson: Boolean(message.saveJson),
      noPersonalization: Boolean(message.noPersonalization),
      decoyBrowsing: message.decoyBrowsing !== undefined ? Boolean(message.decoyBrowsing) : true,
      decoyType: message.decoyType || "any",
      initialQuery: message.query || ""
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "SEARCH_AND_CRAWL") {
    const query = (message.query || "").trim();
    const subfolder = message.subfolder || "SerpyDerpy";
    const reuseTab = Boolean(message.reuseTab);
    const saveHtml = Boolean(message.saveHtml);
    const saveJson = Boolean(message.saveJson);
    const noPersonalization = Boolean(message.noPersonalization);
    const decoyBrowsing = message.decoyBrowsing !== undefined ? Boolean(message.decoyBrowsing) : true;
    const decoyType = message.decoyType || "any";
    const pagesToExtract = parseInt(message.pagesToExtract || "1", 10);

    if (!query) {
      sendResponse({ ok: false, error: "Empty query provided" });
      return true;
    }

    let searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    if (noPersonalization) {
      searchUrl += "&pws=0";
    }

    (async () => {
      const tabInfo = await getOrCreateSearchTab(searchUrl, reuseTab);
      await waitForTabComplete(tabInfo.tabId, 30000);
      await new Promise((res) => setTimeout(res, 1800));

      return runCrawl({
        tabId: tabInfo.tabId,
        shouldCloseTab: tabInfo.shouldClose,
        targetPages: pagesToExtract,
        subfolder,
        saveHtml,
        saveJson,
        noPersonalization,
        decoyBrowsing,
        decoyType,
        initialQuery: query
      });
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
