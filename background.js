/**
 * SerpyDerpy v2 — Manifest V3 Background Service Worker (ES Module)
 * Coordinates Interactive Mode (REQ-INT-01..04) and Campaign Mode (scheduler.js, db.js).
 */

import {
  canonicalizeUrl,
  checkUrlSafety,
  sha256Hex,
  sanitizeSegment,
  buildInteractiveBaseDir,
  buildSerpRelativePaths,
  validateOutputRoot,
  DEFAULT_DENYLIST_PATTERNS,
  DEFAULT_BLOCKED_EXTENSIONS
} from "./naming.js";
import {
  DEFAULT_PACING,
  sampleBoundedDelay,
  selectSafeDecoy
} from "./pacing.js";
import { expandSearchTemplate } from "./inputs.js";
import {
  buildSerpJson,
  buildSerpMarkdown,
  getLocalIsoTimestamp
} from "./schemas.js";
import {
  STORES,
  getRecord,
  putRecord,
  putMany,
  getAllRecords,
  getAllByIndex,
  reconcileAllCampaignsInDb,
  mergeUpdatedSearchTasks,
  importCheckpointsIntoDb
} from "./db.js";
import {
  initNavigationErrorTracker,
  downloadTextVerified,
  executeScriptWithTimeout,
  waitForTabComplete,
  simulateHumanActivityFunc,
  safeCloseTab,
  fetchAndArchiveUrl,
  getEnvironmentInfo
} from "./fetcher.js";
import {
  CampaignScheduler,
  ADAPTERS,
  ALARM_AUTO_RESUME
} from "./scheduler.js";

initNavigationErrorTracker();

const scheduler = new CampaignScheduler();

// Interactive Mode isolated state (never touches Campaign Mode IndexedDB or managed window — REQ-INT-04)
let interactiveState = {
  isRunning: false,
  engine: "google",
  query: "",
  currentPage: 0,
  totalPages: 0,
  totalResults: 0,
  statusText: "Ready",
  isChallenge: false,
  cleanUrls: [],
  savedSummary: "",
  error: null,
  abortRequested: false,
  adVisitsByEngine: { google: 0, bing: 0, duckduckgo: 0 },
  decoyVisitsByEngine: { google: 0, bing: 0, duckduckgo: 0 }
};

let interactiveDesignatedTabId = null;

function updateInteractiveState(updates) {
  interactiveState = { ...interactiveState, ...updates };
  chrome.storage.local.set({ serpyderpyInteractiveState: interactiveState }).catch(() => {});
  chrome.runtime.sendMessage({ type: "INTERACTIVE_STATE_UPDATE", state: interactiveState }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === interactiveDesignatedTabId) interactiveDesignatedTabId = null;
});

chrome.windows.onRemoved.addListener((windowId) => {
  scheduler.handleWindowRemoved(windowId).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  scheduler.handleAlarm(alarm).catch(() => {});
});

// Startup recovery after browser exit or OS reboot (REQ-STATE-06)
chrome.runtime.onStartup.addListener(async () => {
  try {
    const results = await reconcileAllCampaignsInDb({ isBrowserStartup: true, existingTabIds: new Set() });
    for (const r of results) {
      if (r.action === "prompt") {
        await scheduler.setDownloadShelfEnabled(true);
        await scheduler.updateBadge("!", "#f59e0b");
        await scheduler.notify(
          "serpyderpy-interrupted",
          "SerpyDerpy Campaign Interrupted",
          `"${r.campaign.name}" was interrupted on browser restart. Open the Dashboard to resume from checkpoint.`
        );
      } else if (r.action === "auto-resume") {
        scheduler.activeCampaignId = r.campaign.campaignId;
        const delaySec = Math.max(5, Number(r.campaign.config?.autoResumeDelaySec ?? 15));
        chrome.alarms.create(ALARM_AUTO_RESUME, { when: Date.now() + delaySec * 1000 });
      }
    }
  } catch (_) {}
});

function detectEngineFromUrl(url) {
  for (const [eng, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.isEngineSearchUrl(url)) return eng;
  }
  return null;
}

/**
 * Wait for user to clear an Interactive Mode CAPTCHA on the active tab.
 */
async function waitInteractiveChallenge(tabId, engine, adapter) {
  await chrome.tabs.update(tabId, { active: true });
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
  } catch (_) {}

  updateInteractiveState({
    isChallenge: true,
    statusText: `Challenge detected on ${engine}. Please solve it in the tab to continue...`
  });

  const start = Date.now();
  while (Date.now() - start < 300000) {
    if (interactiveState.abortRequested) throw new Error("Interactive crawl stopped by user.");
    await new Promise((r) => setTimeout(r, 2000));
    const res = await executeScriptWithTimeout({ target: { tabId }, func: adapter.checkChallengeFunc }, 10000).catch(() => null);
    if (res?.[0]?.result && !res[0].result.isChallenge) {
      updateInteractiveState({ isChallenge: false, statusText: "Challenge resolved. Resuming..." });
      await new Promise((r) => setTimeout(r, 2500));
      return { encountered: true, provider: `${engine}-challenge`, resolvedByHuman: true, waitDurationMs: Date.now() - start };
    }
  }
  throw new Error("Timed out waiting for CAPTCHA resolution.");
}

/**
 * Unified Interactive Mode crawler (REQ-INT-01..04):
 * Uses shared engines/*.js, fetcher.js, v2 JSON/MD schemas, opt-in IP (default OFF), and REQ-ENG-07 ad cap.
 */
async function runInteractiveCrawl({
  tabId,
  shouldCloseTab = false,
  engine = "google",
  targetPages = 1,
  subfolder = "SerpyDerpy/Interactive",
  saveHtml = true,
  noPersonalization = true,
  decoyBrowsing = true,
  decoyPreference = "any",
  fetchLinks = false,
  recordPublicIp = false,
  initialQuery = ""
}) {
  const adapter = ADAPTERS[engine] || ADAPTERS.google;
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : { name: "SerpyDerpy", version: "2.0.0" };
  const extInfo = { name: manifest.name || "SerpyDerpy", version: manifest.version || "2.0.0" };
  const baseDir = buildInteractiveBaseDir(subfolder);
  const envInfo = await getEnvironmentInfo({ recordPublicIp });

  let query = initialQuery;
  const seenCanon = new Set();
  const allCleanUrls = [];
  let overallRank = 1;
  let pagesCrawled = 0;
  let lastRelDir = baseDir;
  const ddgSeenRaw = new Set();

  updateInteractiveState({
    isRunning: true,
    engine,
    query: initialQuery,
    currentPage: 1,
    totalPages: targetPages,
    totalResults: 0,
    statusText: `Extracting ${engine} page 1 of ${targetPages}...`,
    isChallenge: false,
    cleanUrls: [],
    savedSummary: "",
    error: null,
    abortRequested: false
  });

  try {
    for (let pageNum = 1; pageNum <= targetPages; pageNum++) {
      if (interactiveState.abortRequested) break;
      const pageStart = new Date();
      let challengeMeta = { encountered: false, provider: null, resolvedByHuman: false, waitDurationMs: 0 };

      const preChk = await executeScriptWithTimeout({ target: { tabId }, func: adapter.checkChallengeFunc }, 10000).catch(() => null);
      if (preChk?.[0]?.result?.isChallenge) {
        challengeMeta = await waitInteractiveChallenge(tabId, engine, adapter);
      }

      const extRes = await executeScriptWithTimeout({ target: { tabId }, func: adapter.extractFunc }, 20000);
      let payload = extRes?.[0]?.result || null;
      if (payload && payload.isChallenge) {
        challengeMeta = await waitInteractiveChallenge(tabId, engine, adapter);
        const retryRes = await executeScriptWithTimeout({ target: { tabId }, func: adapter.extractFunc }, 20000);
        payload = retryRes?.[0]?.result || null;
      }

      if (!payload || !payload.ok) {
        throw new Error(payload?.error || `Could not extract ${engine} page ${pageNum}`);
      }

      if (!query && payload.query) query = payload.query;

      let rawPageResults = payload.results || [];
      if (engine === "duckduckgo" && payload.virtualPagination) {
        const slice = [];
        for (const r of rawPageResults) {
          if (!ddgSeenRaw.has(r.resolvedUrl)) {
            ddgSeenRaw.add(r.resolvedUrl);
            slice.push(r);
          }
        }
        rawPageResults = slice;
      }

      const pageResults = [];
      let newCount = 0;
      for (let i = 0; i < rawPageResults.length; i++) {
        const r = rawPageResults[i];
        const canon = canonicalizeUrl(r.resolvedUrl);
        if (!canon) continue;
        const dup = seenCanon.has(canon);
        let assignedRank = null;
        if (!dup) {
          seenCanon.add(canon);
          assignedRank = overallRank++;
          allCleanUrls.push(r.resolvedUrl);
          newCount++;
        }
        pageResults.push({
          overallRank: assignedRank ?? overallRank,
          pageNumber: pageNum,
          pageRank: i + 1,
          title: r.title,
          rawHref: r.rawHref,
          resolvedUrl: r.resolvedUrl,
          canonicalUrl: canon,
          domain: r.domain,
          offDomain: false,
          duplicateInSameSearch: dup,
          urlDecodeFallback: Boolean(r.urlDecodeFallback),
          siteName: r.siteName,
          snippet: r.snippet,
          extractedTimestampUtc: payload.timestampUtc
        });
      }

      // Decoy browsing with REQ-ENG-07 ad relevance and 1.5% cap
      const decoyVisits = [];
      if (decoyBrowsing && Math.random() < 0.45) {
        const pick = selectSafeDecoy({
          candidates: payload.decoyCandidates || [],
          preference: decoyPreference,
          resolvedQuery: query,
          adVisits: interactiveState.adVisitsByEngine[engine] || 0,
          decoyVisits: interactiveState.decoyVisitsByEngine[engine] || 0,
          isCandidateAllowed: (c) => checkUrlSafety(c.url, DEFAULT_DENYLIST_PATTERNS, DEFAULT_BLOCKED_EXTENSIONS).allowed
        });
        if (pick) {
          const dwellMs = Math.round((3 + Math.random() * 30) * 1000);
          interactiveState.decoyVisitsByEngine[engine] = (interactiveState.decoyVisitsByEngine[engine] || 0) + 1;
          if (pick.type === "sponsored") {
            interactiveState.adVisitsByEngine[engine] = (interactiveState.adVisitsByEngine[engine] || 0) + 1;
          }
          decoyVisits.push({
            type: pick.type,
            url: pick.url,
            title: pick.title || "",
            dwellMs,
            relevanceReason: pick.relevanceReason || null,
            timestampUtc: new Date().toISOString()
          });
          (async () => {
            let dTab = null;
            try {
              const t = await chrome.tabs.create({ url: pick.url, active: false });
              dTab = t.id;
              await waitForTabComplete(dTab, 15000);
              await executeScriptWithTimeout({ target: { tabId: dTab }, func: simulateHumanActivityFunc, args: [dwellMs] }, dwellMs + 10000).catch(() => {});
            } catch (_) {
            } finally {
              await safeCloseTab(dTab);
            }
          })();
        }
      }

      const searchSlug = sanitizeSegment(query || "search", "search", 36);
      const serpPaths = await buildSerpRelativePaths({
        outputRoot: baseDir,
        targetSlug: "interactive",
        fullTargetSlug: "interactive",
        engine,
        searchSlug,
        fullSearchSlug: searchSlug,
        pageNumber: pageNum
      });
      lastRelDir = serpPaths.relDir;

      const shouldStop =
        payload.zeroResults ||
        (pageNum > 1 && newCount === 0) ||
        pageNum >= targetPages ||
        !payload.hasNextPage;

      const endReason = payload.zeroResults
        ? "zero_results"
        : pageNum > 1 && newCount === 0
        ? "no_new_results"
        : pageNum >= targetPages
        ? "reached_requested_pages"
        : !payload.hasNextPage
        ? "no_next_button"
        : null;

      const pageEnd = new Date();
      const serpMd = buildSerpMarkdown({
        targetSlug: null,
        domain: null,
        searchEngine: engine,
        searchSlug,
        query: query || `${engine} search`,
        serpUrl: payload.currentUrl,
        pageNumber: pageNum,
        pagesRequested: targetPages,
        timestampUtc: pageStart.toISOString(),
        results: pageResults,
        peopleAlsoAsk: payload.peopleAlsoAsk || [],
        relatedSearches: payload.relatedSearches || [],
        zeroResults: payload.zeroResults
      });

      await downloadTextVerified({
        content: serpMd,
        filename: serpPaths.md,
        mimeType: "text/markdown;charset=utf-8",
        isCampaign: false,
        eraseFromHistory: false
      });

      if (saveHtml && payload.rawHtml) {
        await downloadTextVerified({
          content: payload.rawHtml,
          filename: serpPaths.html,
          mimeType: "text/html;charset=utf-8",
          isCampaign: false,
          eraseFromHistory: false
        });
      }

      const serpJson = buildSerpJson({
        mode: "interactive",
        extension: extInfo,
        campaign: null,
        environment: {
          ...envInfo,
          userAgent: payload.clientMetadata?.userAgent || envInfo.userAgent,
          platform: payload.clientMetadata?.platform || envInfo.platform,
          language: payload.clientMetadata?.language || envInfo.language,
          timezone: payload.clientMetadata?.timezone || envInfo.timezone
        },
        searchMetadata: {
          query: query || `${engine} search`,
          initialSearchUrl: payload.currentUrl,
          pageUrl: payload.currentUrl,
          pageNumber: pageNum,
          pagesRequested: targetPages,
          noPersonalizationApplied: engine === "google" && noPersonalization,
          zeroResults: payload.zeroResults,
          queryRewrittenTo: payload.queryRewrittenTo,
          exactMatchLost: payload.exactMatchLost,
          challenge: challengeMeta,
          pagination: { hasNextPage: Boolean(payload.hasNextPage), endReason },
          timestamps: {
            startedUtc: pageStart.toISOString(),
            startedLocal: getLocalIsoTimestamp(pageStart),
            completedUtc: pageEnd.toISOString(),
            completedLocal: getLocalIsoTimestamp(pageEnd),
            durationMs: pageEnd.getTime() - pageStart.getTime()
          }
        },
        decoyBrowsing: { enabled: decoyBrowsing, preference: decoyPreference, visits: decoyVisits },
        files: {
          relativeDir: serpPaths.relDir,
          markdown: serpPaths.basenames.md,
          html: saveHtml ? serpPaths.basenames.html : null,
          json: serpPaths.basenames.json
        },
        results: pageResults,
        peopleAlsoAsk: payload.peopleAlsoAsk || [],
        relatedSearches: payload.relatedSearches || []
      });

      await downloadTextVerified({
        content: JSON.stringify(serpJson, null, 2),
        filename: serpPaths.json,
        mimeType: "application/json;charset=utf-8",
        isCampaign: false,
        eraseFromHistory: false
      });

      pagesCrawled++;

      // Optional link fetching in Interactive Mode (REQ-INT-01 #2)
      if (fetchLinks) {
        for (const r of pageResults) {
          if (interactiveState.abortRequested || r.duplicateInSameSearch) continue;
          updateInteractiveState({
            statusText: `Archiving result #${r.overallRank}: ${r.title.slice(0, 45)}...`
          });
          await fetchAndArchiveUrl({
            requestedUrl: r.resolvedUrl,
            canonicalUrl: r.canonicalUrl,
            mode: "interactive",
            campaignContext: null,
            serpContext: {
              pageNumber: pageNum,
              pageRank: r.pageRank,
              overallRank: r.overallRank,
              serpTitle: r.title,
              serpSnippet: r.snippet,
              serpJsonFile: serpPaths.basenames.json
            },
            outputRoot: baseDir,
            relDirOverride: serpPaths.relDir,
            targetSlug: "interactive",
            engine,
            searchSlug,
            overallRank: r.overallRank,
            serpTitle: r.title,
            config: { recordPublicIp, settleWaitMin: 5, settleWaitMax: 12 }
          });
        }
      }

      updateInteractiveState({
        query,
        currentPage: pageNum,
        totalResults: allCleanUrls.length,
        cleanUrls: allCleanUrls,
        statusText: `Saved ${engine} page ${pageNum}/${targetPages} (${allCleanUrls.length} organic results)`
      });

      if (shouldStop || interactiveState.abortRequested) break;

      // Gentle bounded-skew delay between SERP pages
      const ip = DEFAULT_PACING.serpPageDelay;
      const waitSec = sampleBoundedDelay(ip.min, ip.max, ip.mean);
      const endMs = Date.now() + waitSec * 1000;
      executeScriptWithTimeout(
        { target: { tabId }, func: simulateHumanActivityFunc, args: [Math.round(waitSec * 1000)] },
        Math.round(waitSec * 1000) + 10000
      ).catch(() => {});
      while (Date.now() < endMs && !interactiveState.abortRequested) {
        const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
        updateInteractiveState({ statusText: `Waiting ${rem}s before ${engine} page ${pageNum + 1}...` });
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (interactiveState.abortRequested) break;

      const clickRes = await executeScriptWithTimeout({ target: { tabId }, func: adapter.clickNextFunc }, 15000);
      const cr = clickRes?.[0]?.result;
      if (!cr || !cr.ok) break;

      if (engine === "duckduckgo" && cr.virtualPagination) {
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        await waitForTabComplete(tabId, 30000);
        await new Promise((r) => setTimeout(r, 1800));
      }
    }

    updateInteractiveState({
      isRunning: false,
      totalPages: pagesCrawled,
      totalResults: allCleanUrls.length,
      cleanUrls: allCleanUrls,
      savedSummary: `Downloads/${lastRelDir}/ (${pagesCrawled} page(s))`,
      statusText: `Saved ${allCleanUrls.length} result(s) across ${pagesCrawled} page(s).`,
      error: null
    });

    return {
      ok: true,
      query,
      engine,
      pagesCrawled,
      resultsCount: allCleanUrls.length,
      cleanUrls: allCleanUrls,
      filename: `${lastRelDir}/`
    };
  } catch (err) {
    updateInteractiveState({
      isRunning: false,
      error: err?.message || String(err),
      statusText: `Error: ${err?.message || String(err)}`,
      isChallenge: false
    });
    throw err;
  } finally {
    if (shouldCloseTab && tabId != null) {
      await safeCloseTab(tabId);
    }
  }
}

/**
 * Create or update a Campaign in IndexedDB, expanding Targets x Searches x Engines into searchTasks
 * with incremental merge support (REQ-STATE-04).
 */
async function saveCampaignToDb(payload) {
  const {
    campaignId,
    name,
    outputRoot,
    rosterVersion = null,
    queryListVersion = null,
    targets = [],
    searches = [],
    config = {},
    missingPlaceholderMode = "skip"
  } = payload;

  const rootCheck = validateOutputRoot(outputRoot);
  if (!rootCheck.ok) {
    return { ok: false, error: rootCheck.error };
  }

  const nowIso = new Date().toISOString();
  const id = campaignId || `cmp-${Date.now().toString(36)}`;
  const existingCampaign = await getRecord(STORES.campaigns, id);

  const campaign = {
    campaignId: id,
    runId: existingCampaign?.runId || `run-${Date.now().toString(36)}`,
    name: name || "Untitled Campaign",
    outputRoot: rootCheck.normalized,
    rosterVersion,
    queryListVersion,
    targets,
    searches,
    config: {
      rollingTargetWindow: 4,
      backpressureHigh: 50,
      backpressureLow: 20,
      fetchConcurrency: 3,
      globalDedup: true,
      freshnessDays: 30,
      dedupPolicy: "skip-and-stub",
      challengePauseScope: "pause-affected-only",
      onBrowserRestart: "prompt",
      autoResumeDelaySec: 15,
      useManagedWindow: true,
      keepAwake: true,
      eraseDownloadHistory: true,
      recordPublicIp: false,
      noPersonalization: true,
      saveSerpHtml: true,
      maxFileSizeMb: 250,
      maxHtmlSizeMb: 50,
      maxRetries: 3,
      pacing: DEFAULT_PACING,
      ...config
    },
    readmeWritten: existingCampaign?.readmeWritten || false,
    nextDeltaSeq: existingCampaign?.nextDeltaSeq || 1,
    nextLogPart: existingCampaign?.nextLogPart || 1,
    siteCapturedTargets: existingCampaign?.siteCapturedTargets || [],
    status: existingCampaign?.status || "idle",
    createdAtUtc: existingCampaign?.createdAtUtc || nowIso,
    updatedAtUtc: nowIso
  };

  // Build Search Tasks with round-robin ordering across targets
  const enabledTargets = targets.filter((t) => t.enabled !== false);
  const enabledSearches = searches.filter((s) => s.enabled !== false);
  const newTasks = [];
  let rrCounter = 0;

  for (let sIdx = 0; sIdx < enabledSearches.length; sIdx++) {
    const s = enabledSearches[sIdx];
    for (let tIdx = 0; tIdx < enabledTargets.length; tIdx++) {
      const t = enabledTargets[tIdx];
      const exp = expandSearchTemplate(s, t, missingPlaceholderMode);
      if (!exp.ok || exp.skipped) continue;
      const qHash = await sha256Hex(exp.resolvedQuery);
      for (const engine of s.engines || ["google", "bing", "duckduckgo"]) {
        const taskKey = `${id}::${t.slug}::${engine}::${s.slug}`;
        newTasks.push({
          taskKey,
          campaignId: id,
          targetSlug: t.slug,
          targetDomain: t.domain,
          externalId: t.externalId ?? null,
          searchId: s.id,
          group: s.group ?? null,
          searchSlug: s.slug,
          fullSearchSlug: s.fullSlug || s.slug,
          engine,
          scope: s.scope || "target-site",
          template: s.template,
          resolvedQuery: exp.resolvedQuery,
          resolvedQueryHash: qHash,
          pagesRequested: s.pages || 3,
          pagesCompleted: 0,
          fetchLinks: s.fetchLinks !== false,
          lastSerpUrl: null,
          serpRelDir: "",
          nextRank: 1,
          status: "pending",
          paginationEndReason: null,
          resultCount: 0,
          attemptCount: 0,
          lastError: null,
          roundRobinOrder: ++rrCounter,
          updatedAtUtc: nowIso
        });
      }
    }
  }

  const existingTasks = (await getAllRecords(STORES.searchTasks)).filter((t) => t.campaignId === id);
  const merged = mergeUpdatedSearchTasks({ existingTasks, newTasks });

  await putRecord(STORES.campaigns, campaign);
  await putMany(STORES.searchTasks, merged.toSave);

  return {
    ok: true,
    campaign,
    summary: {
      totalTasks: newTasks.length,
      newlyAdded: merged.newlyAdded,
      unchangedCompleted: merged.unchangedCompleted,
      reopenedForMorePages: merged.reopenedForMorePages,
      slugConflicts: merged.slugConflicts
    }
  };
}

// Unified Message Router for Popup & Dashboard
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type || message.target === "offscreen") return;

  // --- Interactive Mode ---
  if (message.type === "GET_INTERACTIVE_STATE") {
    sendResponse({
      interactive: interactiveState,
      campaign: scheduler.getLiveSnapshot()
    });
    return true;
  }

  if (message.type === "STOP_INTERACTIVE") {
    interactiveState.abortRequested = true;
    updateInteractiveState({ abortRequested: true, statusText: "Stopping after current step..." });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "INTERACTIVE_SAVE_TAB") {
    (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      const engine = detectEngineFromUrl(tab.url) || "google";
      const parsed = ADAPTERS[engine].parseActiveTabQuery(tab.url);
      return runInteractiveCrawl({
        tabId: message.tabId,
        shouldCloseTab: false,
        engine,
        targetPages: parseInt(message.pagesToExtract || "1", 10),
        subfolder: message.subfolder || "SerpyDerpy/Interactive",
        saveHtml: message.saveHtml !== false,
        noPersonalization: message.noPersonalization !== false,
        decoyBrowsing: Boolean(message.decoyBrowsing),
        decoyPreference: message.decoyPreference || "any",
        fetchLinks: Boolean(message.fetchLinks),
        recordPublicIp: Boolean(message.recordPublicIp),
        initialQuery: parsed.query
      });
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "INTERACTIVE_DIRECT_SEARCH") {
    (async () => {
      const query = String(message.query || "").trim();
      if (!query) throw new Error("Please enter a search query.");
      const engine = ADAPTERS[message.engine] ? message.engine : "google";
      const searchUrl = ADAPTERS[engine].buildInitialUrl(query, {
        noPersonalization: message.noPersonalization !== false
      });

      let tabId = null;
      let shouldClose = !message.reuseTab;
      if (message.reuseTab && interactiveDesignatedTabId !== null) {
        const existing = await chrome.tabs.get(interactiveDesignatedTabId).catch(() => null);
        if (existing) {
          await chrome.tabs.update(interactiveDesignatedTabId, { url: searchUrl, active: true });
          tabId = interactiveDesignatedTabId;
          shouldClose = false;
        }
      }
      if (tabId === null) {
        const created = await chrome.tabs.create({ url: searchUrl, active: true });
        tabId = created.id;
        if (message.reuseTab) interactiveDesignatedTabId = tabId;
      }

      await waitForTabComplete(tabId, 30000);
      await new Promise((r) => setTimeout(r, 1800));

      return runInteractiveCrawl({
        tabId,
        shouldCloseTab: shouldClose,
        engine,
        targetPages: parseInt(message.pagesToExtract || "1", 10),
        subfolder: message.subfolder || "SerpyDerpy/Interactive",
        saveHtml: message.saveHtml !== false,
        noPersonalization: message.noPersonalization !== false,
        decoyBrowsing: Boolean(message.decoyBrowsing),
        decoyPreference: message.decoyPreference || "any",
        fetchLinks: Boolean(message.fetchLinks),
        recordPublicIp: Boolean(message.recordPublicIp),
        initialQuery: query
      });
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  // --- Campaign Mode ---
  if (message.type === "CAMPAIGN_GET_OVERVIEW") {
    (async () => {
      const campaigns = await getAllRecords(STORES.campaigns);
      campaigns.sort((a, b) => Date.parse(b.updatedAtUtc || 0) - Date.parse(a.updatedAtUtc || 0));
      const activeId = message.campaignId || scheduler.activeCampaignId || campaigns[0]?.campaignId || null;
      let stats = null;
      let recentEvents = [];
      if (activeId) {
        const searchTasks = (await getAllRecords(STORES.searchTasks)).filter((t) => t.campaignId === activeId);
        const fetchRows = (await getAllRecords(STORES.fetchQueue)).filter((f) => f.campaignId === activeId);
        const events = await getAllByIndex(STORES.events, "byCampaign", activeId);
        recentEvents = events.slice(-80).reverse();

        const stCounts = {};
        for (const s of searchTasks) stCounts[s.status] = (stCounts[s.status] || 0) + 1;
        const fqCounts = {};
        for (const f of fetchRows) fqCounts[f.status] = (fqCounts[f.status] || 0) + 1;

        stats = {
          totalSearchTasks: searchTasks.length,
          searchTasksByStatus: stCounts,
          totalFetchTasks: fetchRows.length,
          fetchTasksByStatus: fqCounts
        };
      }
      return {
        ok: true,
        campaigns,
        activeCampaignId: activeId,
        live: scheduler.getLiveSnapshot(),
        stats,
        recentEvents
      };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_SAVE") {
    saveCampaignToDb(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_START") {
    scheduler
      .startCampaign(message.campaignId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_PAUSE") {
    scheduler
      .pauseCampaign()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_STOP") {
    scheduler
      .stopCampaign()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_TOGGLE_LANE_PAUSE") {
    const eng = message.engine;
    if (scheduler.lanePausedByUser.has(eng)) {
      scheduler.lanePausedByUser.delete(eng);
    } else {
      scheduler.lanePausedByUser.add(eng);
    }
    scheduler.broadcastLiveUpdate();
    sendResponse({ ok: true, paused: scheduler.lanePausedByUser.has(eng) });
    return true;
  }

  if (message.type === "CAMPAIGN_FOCUS_TAB") {
    scheduler
      .focusTab(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_SKIP_CHALLENGE") {
    scheduler
      .skipChallenge(message.challengeId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_LIST_HISTORY") {
    (async () => {
      const cid = message.campaignId;
      const kind = message.kind || "searchTasks";
      const statusFilter = message.status || "all";
      const searchFilter = String(message.filterText || "").trim().toLowerCase();
      const limit = Math.min(500, Math.max(20, Number(message.limit || 200)));

      let rows =
        kind === "urlLedger"
          ? await getAllByIndex(STORES.urlLedger, "byCampaign", cid)
          : kind === "fetchQueue"
          ? (await getAllRecords(STORES.fetchQueue)).filter((r) => r.campaignId === cid)
          : (await getAllRecords(STORES.searchTasks)).filter((r) => r.campaignId === cid);

      if (statusFilter !== "all") {
        rows = rows.filter((r) => r.status === statusFilter);
      }
      if (searchFilter) {
        rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(searchFilter));
      }
      return { ok: true, total: rows.length, rows: rows.slice(0, limit) };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  // Selective retry (REQ-OPS-07): bulk retries failed_retryable only; manual keys retry explicitly selected rows
  if (message.type === "CAMPAIGN_RETRY_ITEMS") {
    (async () => {
      const { campaignId, kind = "fetchQueue", manualKeys = null } = message;
      const nowIso = new Date().toISOString();
      let count = 0;

      if (kind === "searchTasks") {
        const rows = (await getAllRecords(STORES.searchTasks)).filter((r) => r.campaignId === campaignId);
        const toUpdate = [];
        for (const r of rows) {
          const match = Array.isArray(manualKeys)
            ? manualKeys.includes(r.taskKey)
            : r.status === "failed_retryable";
          if (match) {
            toUpdate.push({ ...r, status: "pending", attemptCount: 0, lastError: null, updatedAtUtc: nowIso });
            count++;
          }
        }
        await putMany(STORES.searchTasks, toUpdate);
      } else {
        const rows = (await getAllRecords(STORES.fetchQueue)).filter((r) => r.campaignId === campaignId);
        const toUpdate = [];
        const ledgerUpdates = [];
        for (const r of rows) {
          const match = Array.isArray(manualKeys)
            ? manualKeys.includes(r.fetchKey)
            : r.status === "failed_retryable";
          if (match) {
            toUpdate.push({ ...r, status: "pending", attemptCount: 0, lastError: null, updatedAtUtc: nowIso });
            const lKey = `${campaignId}::${r.canonicalUrlHash}`;
            const lRow = await getRecord(STORES.urlLedger, lKey);
            if (lRow) {
              ledgerUpdates.push({ ...lRow, status: "failed_retryable", attemptCount: 0, updatedAtUtc: nowIso });
            }
            count++;
          }
        }
        await putMany(STORES.fetchQueue, toUpdate);
        await putMany(STORES.urlLedger, ledgerUpdates);
      }
      return { ok: true, requeued: count };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_EXPORT_CHECKPOINT") {
    (async () => {
      const c = await getRecord(STORES.campaigns, message.campaignId);
      if (!c) throw new Error("Campaign not found.");
      const filename = await scheduler.writeFullCheckpoint(c);
      return { ok: true, filename };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_IMPORT_CHECKPOINTS") {
    importCheckpointsIntoDb(message.jsonlTexts || [])
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_EXPORT_BUNDLE") {
    (async () => {
      const c = await getRecord(STORES.campaigns, message.campaignId);
      if (!c) throw new Error("Campaign not found.");
      const files = await scheduler.exportCampaignBundle(c);
      return { ok: true, files };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "CAMPAIGN_EXPORT_REPORT") {
    (async () => {
      const c = await getRecord(STORES.campaigns, message.campaignId);
      if (!c) throw new Error("Campaign not found.");
      const filename = await scheduler.writeCampaignReport(c);
      await scheduler.flushLogSegment();
      return { ok: true, filename };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "OPEN_DASHBOARD") {
    const url = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.query({ url }, (tabs) => {
      if (tabs && tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url });
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});
