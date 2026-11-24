/**
 * SerpyDerpy v2 — Multi-Engine Campaign Scheduler & Orchestrator
 * Implements Section 6 (3 simultaneous lanes, rolling target window K, fetch backpressure 50/20,
 * bounded skew delays, decoy ad cap, challenge circuit breaker), Section 7 (per-host fetch pool),
 * Section 9 (strict commits, delta/full JSONL checkpoints, alarms), and Section 10 (Pause/Stop/Managed Window).
 */

import {
  canonicalizeUrl,
  checkUrlSafety,
  isOffDomain,
  sha256Hex,
  buildSerpRelativePaths,
  buildResultRelativePaths,
  DEFAULT_DENYLIST_PATTERNS,
  DEFAULT_BLOCKED_EXTENSIONS
} from "./naming.js";
import {
  DEFAULT_PACING,
  sampleBoundedDelay,
  selectSafeDecoy
} from "./pacing.js";
import {
  buildSerpJson,
  buildSerpMarkdown,
  buildResultJson,
  buildErrorJson,
  buildDirectoryReadmeMarkdown,
  buildCampaignReportMarkdown,
  buildSkippedFilesReportMarkdown,
  buildCampaignSummaryJson,
  buildCheckpointJsonl,
  formatSearchTaskExportRow,
  formatUrlLedgerExportRow,
  getLocalDateTimePrefix,
  getLocalIsoTimestamp
} from "./schemas.js";
import {
  STORES,
  getRecord,
  putRecord,
  putMany,
  getAllRecords,
  getAllByIndex,
  countByIndex,
  commitSerpPageAndEnqueue,
  commitFetchOutcome,
  appendEvent,
  lookupUrlDeduplication,
  exportFullCheckpointJsonl
} from "./db.js";
import {
  downloadTextVerified,
  downloadChunkedTextVerified,
  executeScriptWithTimeout,
  waitForTabComplete,
  simulateHumanActivityFunc,
  safeCloseTab,
  fetchAndArchiveUrl,
  captureTargetSiteMetadata,
  getEnvironmentInfo,
  setDiskErrorCallback,
  resetDiskErrorCounter
} from "./fetcher.js";
import * as googleAdapter from "./engines/google.js";
import * as bingAdapter from "./engines/bing.js";
import * as ddgAdapter from "./engines/duckduckgo.js";

export const ADAPTERS = {
  google: {
    ...googleAdapter,
    extractFunc: googleAdapter.googleDomExtractorFunc,
    clickNextFunc: googleAdapter.googleClickNextFunc,
    checkChallengeFunc: googleAdapter.googleCheckChallengeFunc
  },
  bing: {
    ...bingAdapter,
    extractFunc: bingAdapter.bingDomExtractorFunc,
    clickNextFunc: bingAdapter.bingClickNextFunc,
    checkChallengeFunc: bingAdapter.bingCheckChallengeFunc
  },
  duckduckgo: {
    ...ddgAdapter,
    extractFunc: ddgAdapter.duckduckgoDomExtractorFunc,
    clickNextFunc: ddgAdapter.duckduckgoClickNextFunc,
    checkChallengeFunc: ddgAdapter.duckduckgoCheckChallengeFunc
  }
};

export const ALARM_WATCHDOG = "serpyderpy-watchdog";
export const ALARM_DELTA_CHECKPOINT = "serpyderpy-delta-checkpoint";
export const ALARM_LOG_FLUSH = "serpyderpy-log-flush";
export const ALARM_AUTO_RESUME = "serpyderpy-auto-resume";

const ESCALATION_COOLDOWN_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
const HOST_BACKOFF_MS = [30 * 1000, 120 * 1000, 300 * 1000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decide whether a SERP result link should be enqueued for fetching.
 * On target-site queries, off-domain links that appear directly on the SERP
 * (e.g. cloaked ads or search-engine drift) are logged in SERP JSON but not fetched.
 */
export function shouldEnqueueSerpResult({ scope = "target-site", offDomain = false, fetchLinks = true }) {
  if (fetchLinks === false) return false;
  const normScope = String(scope || "target-site").toLowerCase();
  if (normScope === "target-site" && Boolean(offDomain)) return false;
  return true;
}

/**
 * Claim the next eligible fetchQueue item, reserving its host and fetchKey synchronously
 * before awaiting hostState so concurrent workers cannot pick the same item or host.
 */
export async function claimNextFetchCandidate({
  candidates,
  activeHostsInMem,
  activeFetchKeysInMem,
  getHostState,
  now = Date.now()
}) {
  for (const cand of candidates) {
    const host = cand.host || "unknown";
    if (activeHostsInMem.has(host) || activeFetchKeysInMem.has(cand.fetchKey)) continue;

    activeHostsInMem.add(host);
    activeFetchKeysInMem.add(cand.fetchKey);

    try {
      const hs = (await getHostState(host)) || {
        host,
        cooldownUntilUtc: null,
        consecutiveBackoffs: 0,
        pausedByChallenge: false,
        activeFetchKey: null,
        lastRequestUtc: null
      };
      if (hs.pausedByChallenge || hs.activeFetchKey || (hs.cooldownUntilUtc && Date.parse(hs.cooldownUntilUtc) > now)) {
        activeHostsInMem.delete(host);
        activeFetchKeysInMem.delete(cand.fetchKey);
        continue;
      }
      return { chosen: cand, hostState: hs, host };
    } catch (err) {
      activeHostsInMem.delete(host);
      activeFetchKeysInMem.delete(cand.fetchKey);
      throw err;
    }
  }
  return null;
}

export class CampaignScheduler {
  constructor() {
    this.activeCampaignId = null;
    this.isRunning = false;
    this.stopMode = null; // null | "pause" | "stop" | "error"
    this.managedWindowId = null;
    this.backpressureActive = false;

    // Track live lane loops and fetch worker pool
    this.lanePromises = new Map();
    this.fetchPoolPromise = null;
    this.lanePausedByUser = new Set();

    // Open challenges awaiting human click: key -> { id, kind ("engine"|"fetch"), engine?, host?, url, provider, tabId, resolveDecision }
    this.activeChallenges = new Map();

    // Buffered delta checkpoint records & rotated log buffer
    this.deltaBuffer = [];
    this.logBuffer = [];
    this.lastDeltaFlushMs = 0;
    this.lastLogFlushMs = 0;

    // Per-engine hourly page timestamps for optional softHourlyPageCap
    this.engineHourlyPages = { google: [], bing: [], duckduckgo: [] };

    // Live UI snapshot state
    this.liveLanes = {
      google: { status: "idle" },
      bing: { status: "idle" },
      duckduckgo: { status: "idle" }
    };
    this.liveFetchers = { activeHosts: [], pendingCount: 0, backpressure: false };

    setDiskErrorCallback((errInfo) => {
      this.handleDiskCircuitBreaker(errInfo).catch(() => {});
    });
  }

  async log(level, component, message, details = null) {
    const campaignId = this.activeCampaignId;
    const entry = await appendEvent({ campaignId, level, component, message, details }).catch(() => ({
      timestampUtc: new Date().toISOString(),
      level,
      component,
      message
    }));
    this.logBuffer.push(
      `[${entry.timestampUtc}] [${String(level).toUpperCase()}] [${component}] ${message}${details ? " " + JSON.stringify(details) : ""}`
    );
    if (this.logBuffer.length >= 2000) {
      this.flushLogSegment().catch(() => {});
    }
    this.broadcastLiveUpdate();
  }

  async updateBadge(text, color) {
    try {
      await chrome.action.setBadgeText({ text: text || "" });
      if (color) await chrome.action.setBadgeBackgroundColor({ color });
    } catch (_) {}
  }

  async notify(id, title, message) {
    try {
      await chrome.notifications.create(id, {
        type: "basic",
        iconUrl: "icon128.png",
        title,
        message,
        priority: 2
      });
    } catch (_) {}
  }

  broadcastLiveUpdate() {
    chrome.runtime
      .sendMessage({
        type: "CAMPAIGN_LIVE_UPDATE",
        snapshot: this.getLiveSnapshot()
      })
      .catch(() => {});
  }

  getLiveSnapshot() {
    return {
      activeCampaignId: this.activeCampaignId,
      isRunning: this.isRunning,
      stopMode: this.stopMode,
      managedWindowId: this.managedWindowId,
      backpressureActive: this.backpressureActive,
      lanes: { ...this.liveLanes },
      fetchers: { ...this.liveFetchers },
      challenges: Array.from(this.activeChallenges.values()).map((c) => ({
        id: c.id,
        kind: c.kind,
        engine: c.engine || null,
        host: c.host || null,
        url: c.url,
        provider: c.provider,
        tabId: c.tabId,
        detectedAtUtc: c.detectedAtUtc
      }))
    };
  }

  async ensureManagedWindow(campaign) {
    if (campaign.config?.useManagedWindow === false) return undefined;
    if (this.managedWindowId !== null) {
      try {
        const w = await chrome.windows.get(this.managedWindowId);
        if (w) return this.managedWindowId;
      } catch (_) {
        this.managedWindowId = null;
      }
    }
    // Non-minimized window so browser timers stay unthrottled (REQ-OPS-01)
    const win = await chrome.windows.create({
      url: "about:blank",
      focused: false,
      state: "normal",
      width: 1200,
      height: 850
    });
    this.managedWindowId = win.id;
    return this.managedWindowId;
  }

  async handleWindowRemoved(windowId) {
    if (this.managedWindowId !== null && windowId === this.managedWindowId) {
      this.managedWindowId = null;
      if (this.isRunning) {
        await this.log("warn", "window", "Managed browser window was closed by user; pausing campaign cleanly.");
        await this.pauseCampaign();
      }
    }
  }

  async acquireKeepAwake(campaign) {
    if (campaign.config?.keepAwake !== false && chrome.power) {
      try {
        chrome.power.requestKeepAwake("system");
      } catch (_) {}
    }
  }

  releaseKeepAwake() {
    if (chrome.power) {
      try {
        chrome.power.releaseKeepAwake();
      } catch (_) {}
    }
  }

  async setDownloadShelfEnabled(enabled) {
    if (chrome.downloads && typeof chrome.downloads.setUiOptions === "function") {
      try {
        await chrome.downloads.setUiOptions({ enabled: Boolean(enabled) });
      } catch (_) {}
    }
  }

  /**
   * Start or resume a campaign by campaignId.
   */
  async startCampaign(campaignId) {
    if (this.isRunning && this.activeCampaignId === campaignId) {
      return { ok: true, alreadyRunning: true };
    }
    const campaign = await getRecord(STORES.campaigns, campaignId);
    if (!campaign) {
      return { ok: false, error: `Campaign "${campaignId}" not found.` };
    }

    resetDiskErrorCounter();
    this.activeCampaignId = campaignId;
    this.isRunning = true;
    this.stopMode = null;
    this.lanePausedByUser.clear();
    this.lastDeltaFlushMs = Date.now();
    this.lastLogFlushMs = Date.now();

    campaign.status = "running";
    campaign.updatedAtUtc = new Date().toISOString();
    await putRecord(STORES.campaigns, campaign);

    await this.acquireKeepAwake(campaign);
    await this.setDownloadShelfEnabled(false);
    await this.updateBadge("RUN", "#0284c7");

    // Ensure directory README.md once per campaign (REQ-OUT-02)
    if (!campaign.readmeWritten) {
      try {
        const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : { version: "2.0.0" };
        await downloadTextVerified({
          content: buildDirectoryReadmeMarkdown(campaign.outputRoot, manifest.version || "2.0.0"),
          filename: `${campaign.outputRoot}/README.md`,
          mimeType: "text/markdown;charset=utf-8",
          isCampaign: true,
          eraseFromHistory: campaign.config?.eraseDownloadHistory !== false
        });
        campaign.readmeWritten = true;
        await putRecord(STORES.campaigns, campaign);
      } catch (err) {
        await this.log("warn", "readme", `Could not write directory README.md: ${err.message}`);
      }
    }

    // Register MV3 alarms (watchdog 1 min, delta checkpoint 10 min, log flush 10 min)
    chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: 1 });
    chrome.alarms.create(ALARM_DELTA_CHECKPOINT, { periodInMinutes: 10 });
    chrome.alarms.create(ALARM_LOG_FLUSH, { periodInMinutes: 10 });

    await this.ensureManagedWindow(campaign);
    await this.log("info", "campaign", `Started campaign "${campaign.name}" (${campaignId}) -> Downloads/${campaign.outputRoot}/`);

    // Launch 3 simultaneous Search Engine Lanes with staggered starts (REQ-ENG-01, REQ-ENG-03)
    const engines = ["google", "bing", "duckduckgo"];
    const staggerMs = [
      0,
      Math.round((4 + Math.random() * 7) * 1000),
      Math.round((9 + Math.random() * 12) * 1000)
    ];

    engines.forEach((engine, idx) => {
      const p = this.runEngineLane(campaignId, engine, staggerMs[idx]).catch(async (err) => {
        await this.log("error", `lane:${engine}`, `Lane crashed: ${err.message || String(err)}`);
      });
      this.lanePromises.set(engine, p);
    });

    // Launch decoupled Result Fetch Pool (REQ-FETCH-01)
    this.fetchPoolPromise = this.runFetchPool(campaignId).catch(async (err) => {
      await this.log("error", "fetcher", `Fetch pool crashed: ${err.message || String(err)}`);
    });

    // Monitor overall campaign completion
    this.watchCompletion(campaignId);
    this.broadcastLiveUpdate();
    return { ok: true };
  }

  async watchCompletion(campaignId) {
    await Promise.all([...this.lanePromises.values(), this.fetchPoolPromise].filter(Boolean));
    if (this.activeCampaignId !== campaignId) return;

    const campaign = await getRecord(STORES.campaigns, campaignId);
    if (!campaign) return;

    if (this.stopMode === "pause") {
      campaign.status = "paused";
      campaign.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.campaigns, campaign);
      await this.writeFullCheckpoint(campaign);
      this.isRunning = false;
      this.releaseKeepAwake();
      await this.updateBadge("PAUS", "#f59e0b");
      chrome.alarms.clear(ALARM_WATCHDOG);
      chrome.alarms.clear(ALARM_DELTA_CHECKPOINT);
      chrome.alarms.clear(ALARM_LOG_FLUSH);
      await this.log("info", "campaign", "Campaign paused cleanly.");
      this.broadcastLiveUpdate();
      return;
    }

    if (this.stopMode === "stop") {
      campaign.status = "stopped";
      campaign.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.campaigns, campaign);
      await this.closeAutomatedTabs(campaignId);
      await this.setDownloadShelfEnabled(true);
      await this.writeCampaignReport(campaign);
      await this.flushLogSegment();
      await this.writeFullCheckpoint(campaign);
      this.isRunning = false;
      this.releaseKeepAwake();
      await this.updateBadge("", "#334155");
      chrome.alarms.clear(ALARM_WATCHDOG);
      chrome.alarms.clear(ALARM_DELTA_CHECKPOINT);
      chrome.alarms.clear(ALARM_LOG_FLUSH);
      await this.log("info", "campaign", "Campaign stopped cleanly (resumable).");
      this.broadcastLiveUpdate();
      return;
    }

    if (this.stopMode === "error") {
      this.isRunning = false;
      this.releaseKeepAwake();
      await this.setDownloadShelfEnabled(true);
      chrome.alarms.clear(ALARM_WATCHDOG);
      chrome.alarms.clear(ALARM_DELTA_CHECKPOINT);
      chrome.alarms.clear(ALARM_LOG_FLUSH);
      this.broadcastLiveUpdate();
      return;
    }

    // Natural completion
    campaign.status = "completed";
    campaign.updatedAtUtc = new Date().toISOString();
    await putRecord(STORES.campaigns, campaign);
    await this.closeAutomatedTabs(campaignId);
    await this.setDownloadShelfEnabled(true);
    await this.writeCampaignReport(campaign);
    await this.flushLogSegment();
    await this.writeFullCheckpoint(campaign);
    await this.exportCampaignBundle(campaign);
    this.isRunning = false;
    this.releaseKeepAwake();
    await this.updateBadge("DONE", "#22c55e");
    chrome.alarms.clear(ALARM_WATCHDOG);
    chrome.alarms.clear(ALARM_DELTA_CHECKPOINT);
    chrome.alarms.clear(ALARM_LOG_FLUSH);
    await this.notify("serpyderpy-done", "SerpyDerpy Campaign Complete", `Finished "${campaign.name}".`);
    await this.log("info", "campaign", `Campaign "${campaign.name}" completed.`);
    this.broadcastLiveUpdate();
  }

  /**
   * Pause campaign per REQ-UI-03 (finish in-flight work, release keep-awake, keep tabs ready, write full checkpoint, no report).
   */
  async pauseCampaign() {
    if (!this.isRunning) return { ok: true };
    this.stopMode = "pause";
    for (const c of this.activeChallenges.values()) {
      if (typeof c.resolveDecision === "function") c.resolveDecision("aborted");
    }
    this.activeChallenges.clear();
    this.broadcastLiveUpdate();
    return { ok: true };
  }

  /**
   * Stop campaign per REQ-UI-03 (finish in-flight work, close automated tabs, restore download shelf, write report + log + full checkpoint, remain resumable).
   */
  async stopCampaign() {
    if (!this.isRunning) {
      if (this.activeCampaignId) {
        const c = await getRecord(STORES.campaigns, this.activeCampaignId);
        if (c && c.status !== "completed") {
          c.status = "stopped";
          c.updatedAtUtc = new Date().toISOString();
          await putRecord(STORES.campaigns, c);
          await this.setDownloadShelfEnabled(true);
          await this.writeCampaignReport(c);
          await this.flushLogSegment();
          await this.writeFullCheckpoint(c);
        }
      }
      return { ok: true };
    }
    this.stopMode = "stop";
    for (const c of this.activeChallenges.values()) {
      if (typeof c.resolveDecision === "function") c.resolveDecision("aborted");
    }
    this.activeChallenges.clear();
    this.broadcastLiveUpdate();
    return { ok: true };
  }

  /**
   * Disk-full / local write circuit breaker per REQ-OPS-10.
   */
  async handleDiskCircuitBreaker(errInfo) {
    if (!this.activeCampaignId) return;
    this.stopMode = "error";
    const campaign = await getRecord(STORES.campaigns, this.activeCampaignId);
    if (campaign) {
      campaign.status = "paused_error";
      campaign.lastError = `${errInfo.code}: ${errInfo.message}`;
      campaign.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.campaigns, campaign);
    }
    this.releaseKeepAwake();
    await this.setDownloadShelfEnabled(true);
    await this.updateBadge("ERR", "#ef4444");
    await this.notify(
      "serpyderpy-disk-err",
      "SerpyDerpy Paused — Local Disk Error",
      `${errInfo.code}: ${errInfo.message}`
    );
    await this.log("error", "disk", `Disk circuit breaker tripped: ${errInfo.code} — ${errInfo.message}`);
    this.broadcastLiveUpdate();
  }

  async closeAutomatedTabs(campaignId) {
    const engineStates = (await getAllRecords(STORES.engineState)).filter((e) => e.campaignId === campaignId);
    for (const es of engineStates) {
      if (es.activeTabId != null) {
        await safeCloseTab(es.activeTabId);
        es.activeTabId = null;
        es.activeTaskKey = null;
        await putRecord(STORES.engineState, es);
      }
    }
    if (this.managedWindowId !== null) {
      try {
        await chrome.windows.remove(this.managedWindowId);
      } catch (_) {}
      this.managedWindowId = null;
    }
  }

  /**
   * Rolling active Target window computation (REQ-ENG-09).
   * Returns Set of up to K targetSlugs that still have non-terminal Search Tasks or Fetch Tasks.
   */
  async getActiveTargetWindow(campaign) {
    const K = Math.max(1, Number(campaign.config?.rollingTargetWindow ?? 4));
    const orderedTargets = [...(campaign.targets || [])]
      .filter((t) => t.enabled !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const allSearchTasks = (await getAllRecords(STORES.searchTasks)).filter((t) => t.campaignId === campaign.campaignId);
    const allFetchTasks = (await getAllRecords(STORES.fetchQueue)).filter((f) => f.campaignId === campaign.campaignId);

    const terminalSearch = new Set(["completed", "failed_permanent"]);
    const terminalFetch = new Set(["completed", "completed_dedup", "failed_permanent", "skipped_too_large", "skipped_policy"]);

    const activeSlugs = [];
    const newlyCompletedTargets = [];

    for (const target of orderedTargets) {
      const tSearches = allSearchTasks.filter((t) => t.targetSlug === target.slug);
      const tFetches = allFetchTasks.filter((f) => f.targetSlug === target.slug);
      const hasOpenSearch = tSearches.some((t) => !terminalSearch.has(t.status));
      const hasOpenFetch = tFetches.some((f) => !terminalFetch.has(f.status));

      if (hasOpenSearch || hasOpenFetch) {
        if (activeSlugs.length < K) {
          activeSlugs.push(target.slug);
        }
      } else if (tSearches.length > 0 && !(campaign.siteCapturedTargets || []).includes(target.slug)) {
        newlyCompletedTargets.push(target);
      }
    }

    // Trigger end-of-target _site/ capture (REQ-OPS-09) & delta checkpoint (REQ-STATE-07)
    for (const doneTarget of newlyCompletedTargets) {
      await this.completeTargetSiteCapture(campaign, doneTarget);
    }

    return new Set(activeSlugs);
  }

  async completeTargetSiteCapture(campaign, target) {
    if ((campaign.siteCapturedTargets || []).includes(target.slug)) return;
    await this.log("info", "site-capture", `All tasks finished for "${target.slug}"; capturing robots.txt & sitemaps.`);
    try {
      await captureTargetSiteMetadata({
        campaignId: campaign.campaignId,
        outputRoot: campaign.outputRoot,
        target,
        eraseFromHistory: campaign.config?.eraseDownloadHistory !== false
      });
    } catch (err) {
      await this.log("warn", "site-capture", `Site capture warning for ${target.slug}: ${err.message}`);
    }
    const fresh = await getRecord(STORES.campaigns, campaign.campaignId);
    if (fresh) {
      fresh.siteCapturedTargets = Array.from(new Set([...(fresh.siteCapturedTargets || []), target.slug]));
      fresh.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.campaigns, fresh);
      await this.flushDeltaCheckpoint(fresh);
    }
  }

  /**
   * Check & update fetch-queue backpressure hysteresis (REQ-ENG-10: pause at 50, resume at <= 20; 0 disables).
   */
  async checkBackpressure(campaign) {
    const high = Number(campaign.config?.backpressureHigh ?? 50);
    const low = Number(campaign.config?.backpressureLow ?? 20);
    if (high <= 0) {
      this.backpressureActive = false;
      this.liveFetchers.backpressure = false;
      return false;
    }
    const pendingCount = await countByIndex(STORES.fetchQueue, "byCampaignStatus", [campaign.campaignId, "pending"]);
    this.liveFetchers.pendingCount = pendingCount;
    if (!this.backpressureActive && pendingCount >= high) {
      this.backpressureActive = true;
      await this.log("info", "backpressure", `Paused new search launches (${pendingCount} pending fetch tasks >= ${high}).`);
    } else if (this.backpressureActive && pendingCount <= low) {
      this.backpressureActive = false;
      await this.log("info", "backpressure", `Resumed search launches (${pendingCount} pending fetch tasks <= ${low}).`);
    }
    this.liveFetchers.backpressure = this.backpressureActive;
    return this.backpressureActive;
  }

  isGloballyPausedByChallenge(campaign) {
    return campaign.config?.challengePauseScope === "pause-all" && this.activeChallenges.size > 0;
  }

  /**
   * One independent Search Engine Lane (`google`, `bing`, or `duckduckgo`).
   */
  async runEngineLane(campaignId, engine, initialStaggerMs = 0) {
    const adapter = ADAPTERS[engine];
    const engineKey = `${campaignId}::${engine}`;
    let engState = (await getRecord(STORES.engineState, engineKey)) || {
      engineKey,
      campaignId,
      engine,
      status: "idle",
      activeTabId: null,
      activeTaskKey: null,
      cooldownUntilUtc: null,
      challengeWindowTimestamps: [],
      escalationLevel: 0,
      queriesSinceBreak: 0,
      lastRequestUtc: null,
      decoyVisits: 0,
      adVisits: 0
    };

    if (initialStaggerMs > 0 && !this.stopMode) {
      this.liveLanes[engine] = { status: "stagger", waitSec: Math.round(initialStaggerMs / 1000) };
      this.broadcastLiveUpdate();
      await this.interruptibleSleep(initialStaggerMs);
    }

    let nextCoffeeBreakAt =
      (DEFAULT_PACING.coffeeBreakEveryMin) +
      Math.floor(Math.random() * (DEFAULT_PACING.coffeeBreakEveryMax - DEFAULT_PACING.coffeeBreakEveryMin + 1));

    while (this.isRunning && !this.stopMode) {
      const campaign = await getRecord(STORES.campaigns, campaignId);
      if (!campaign || campaign.status !== "running") break;

      if (this.lanePausedByUser.has(engine) || this.isGloballyPausedByChallenge(campaign)) {
        this.liveLanes[engine] = { status: "paused" };
        this.broadcastLiveUpdate();
        await this.interruptibleSleep(1500);
        continue;
      }

      // Check persisted engine cooldown (REQ-ENG-04 / REQ-STATE-06)
      if (engState.status === "paused_cooldown") {
        if (!engState.cooldownUntilUtc) {
          this.liveLanes[engine] = { status: "paused_cooldown", message: "Manual resume required after repeated challenges" };
          this.broadcastLiveUpdate();
          await this.interruptibleSleep(2000);
          engState = (await getRecord(STORES.engineState, engineKey)) || engState;
          continue;
        }
        const remMs = Date.parse(engState.cooldownUntilUtc) - Date.now();
        if (remMs > 0) {
          this.liveLanes[engine] = { status: "paused_cooldown", waitSec: Math.ceil(remMs / 1000) };
          this.broadcastLiveUpdate();
          await this.interruptibleSleep(Math.min(remMs, 5000));
          continue;
        }
        engState.status = "idle";
        engState.cooldownUntilUtc = null;
        await putRecord(STORES.engineState, engState);
      }

      // Check optional soft hourly page cap
      const hourlyCap = Number(campaign.config?.pacing?.softHourlyPageCap ?? 0);
      if (hourlyCap > 0) {
        const oneHourAgo = Date.now() - 3600 * 1000;
        this.engineHourlyPages[engine] = this.engineHourlyPages[engine].filter((ts) => ts > oneHourAgo);
        if (this.engineHourlyPages[engine].length >= hourlyCap) {
          this.liveLanes[engine] = { status: "hourly_cap", message: `Hourly cap (${hourlyCap} pages) reached` };
          this.broadcastLiveUpdate();
          await this.interruptibleSleep(15000);
          continue;
        }
      }

      // Check fetch-queue backpressure (REQ-ENG-10)
      if (await this.checkBackpressure(campaign)) {
        this.liveLanes[engine] = { status: "backpressure", message: "Waiting for fetch queue to drain" };
        this.broadcastLiveUpdate();
        await this.interruptibleSleep(3000);
        continue;
      }

      // Select next pending Search Task within the rolling active Target window (REQ-ENG-09)
      const activeWindow = await this.getActiveTargetWindow(campaign);
      const pendingTasks = await getAllByIndex(STORES.searchTasks, "byCampaignEngineStatus", [campaignId, engine, "pending"]);
      const retryTasks = await getAllByIndex(STORES.searchTasks, "byCampaignEngineStatus", [campaignId, engine, "failed_retryable"]);
      const candidateTasks = [...pendingTasks, ...retryTasks].filter((t) => activeWindow.has(t.targetSlug));

      if (candidateTasks.length === 0) {
        // Check if any pending tasks exist outside the current active window (waiting on fetch pool to finish a target)
        if (pendingTasks.length > 0 || retryTasks.length > 0) {
          this.liveLanes[engine] = { status: "waiting_window", message: "Waiting for active target window" };
          this.broadcastLiveUpdate();
          await this.interruptibleSleep(3000);
          continue;
        }
        // No more search tasks for this engine!
        this.liveLanes[engine] = { status: "done" };
        this.broadcastLiveUpdate();
        break;
      }

      // Rotate across targets in the rolling window (pick least recently searched target first)
      candidateTasks.sort((a, b) => (a.roundRobinOrder || 0) - (b.roundRobinOrder || 0));
      const task = candidateTasks[0];

      await this.executeSearchTask(campaign, engine, adapter, engState, task);

      if (this.stopMode) break;

      // Coffee break check
      engState.queriesSinceBreak = (engState.queriesSinceBreak || 0) + 1;
      await putRecord(STORES.engineState, engState);

      const pacing = { ...DEFAULT_PACING, ...(campaign.config?.pacing || {}) };
      if (engState.queriesSinceBreak >= nextCoffeeBreakAt) {
        const breakSec =
          pacing.coffeeBreakDurationMin +
          Math.random() * Math.max(0, pacing.coffeeBreakDurationMax - pacing.coffeeBreakDurationMin);
        const untilIso = new Date(Date.now() + breakSec * 1000).toISOString();
        engState.queriesSinceBreak = 0;
        engState.status = "paused_cooldown";
        engState.cooldownUntilUtc = untilIso;
        await putRecord(STORES.engineState, engState);
        chrome.alarms.create(`serpyderpy-cooldown-${engine}`, { when: Date.parse(untilIso) });
        await this.log("info", `lane:${engine}`, `Taking coffee break for ${Math.round(breakSec)}s.`);
        nextCoffeeBreakAt =
          pacing.coffeeBreakEveryMin +
          Math.floor(Math.random() * (pacing.coffeeBreakEveryMax - pacing.coffeeBreakEveryMin + 1));
      } else {
        // Inter-query bounded skew delay (REQ-ENG-08)
        const iq = pacing.interQueryDelay || DEFAULT_PACING.interQueryDelay;
        const delaySec = sampleBoundedDelay(iq.min, iq.max, iq.mean);
        await this.laneDelayWithCountdown(engine, delaySec * 1000, "inter_query", engState);
      }
    }
  }

  async executeSearchTask(campaign, engine, adapter, engState, task) {
    const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : { name: "SerpyDerpy", version: "2.0.0" };
    const extInfo = { name: manifest.name || "SerpyDerpy", version: manifest.version || "2.0.0" };
    const pacing = { ...DEFAULT_PACING, ...(campaign.config?.pacing || {}) };
    const eraseFromHistory = campaign.config?.eraseDownloadHistory !== false;
    const saveSerpHtml = campaign.config?.saveSerpHtml !== false;
    const envInfo = await getEnvironmentInfo({ recordPublicIp: Boolean(campaign.config?.recordPublicIp) });

    task.status = "in_progress";
    task.attemptCount = (task.attemptCount || 0) + 1;
    task.updatedAtUtc = new Date().toISOString();
    await putRecord(STORES.searchTasks, task);

    const startPage = Math.max(1, (task.pagesCompleted || 0) + 1);
    const targetObj = (campaign.targets || []).find((t) => t.slug === task.targetSlug) || {
      domain: task.targetDomain,
      slug: task.targetSlug,
      name: null,
      externalId: task.externalId ?? null,
      metadata: {}
    };

    // Track already-seen canonical URLs in this Search Task (for REQ-ENG-06 intra-search dedup & DDG crash recovery)
    const existingFetchRows = await getAllByIndex(STORES.fetchQueue, "byTaskKey", task.taskKey);
    const seenCanonicalInSearch = new Set(existingFetchRows.map((r) => r.canonicalUrl));
    let nextOverallRank = Math.max(task.nextRank || 1, existingFetchRows.length + 1);

    // Open or reuse the lane's single SERP tab (REQ-ENG-02)
    const initialUrl =
      task.lastSerpUrl && startPage > 1 && engine !== "duckduckgo"
        ? task.lastSerpUrl
        : adapter.buildInitialUrl(task.resolvedQuery, {
            noPersonalization: campaign.config?.noPersonalization !== false,
            htmlMode: Boolean(campaign.config?.ddgHtmlMode)
          });

    let tabId = engState.activeTabId;
    try {
      if (tabId != null) {
        const existingTab = await chrome.tabs.get(tabId).catch(() => null);
        if (existingTab) {
          await chrome.tabs.update(tabId, { url: initialUrl, active: false });
        } else {
          tabId = null;
        }
      }
      if (tabId == null) {
        const winId = await this.ensureManagedWindow(campaign);
        const createOpts = { url: initialUrl, active: false };
        if (typeof winId === "number") createOpts.windowId = winId;
        const created = await chrome.tabs.create(createOpts);
        tabId = created.id;
        try {
          await chrome.tabs.update(tabId, { autoDiscardable: false });
        } catch (_) {}
      }

      engState.activeTabId = tabId;
      engState.activeTaskKey = task.taskKey;
      engState.status = "working";
      await putRecord(STORES.engineState, engState);

      await waitForTabComplete(tabId, 30000);
      if (engine === "duckduckgo" && !campaign.config?.ddgHtmlMode) {
        // Wait for DuckDuckGo React SPA hydration to settle before extracting page 1
        const ddgStart = Date.now();
        let prevCount = -1;
        let stableTicks = 0;
        await sleep(1200);
        while (Date.now() - ddgStart < 8000 && !this.stopMode) {
          const probe = await executeScriptWithTimeout({ target: { tabId }, func: adapter.extractFunc }, 10000).catch(() => null);
          const pr = probe?.[0]?.result;
          if (!pr || pr.isChallenge || pr.zeroResults) break;
          const cnt = Array.isArray(pr.results) ? pr.results.length : 0;
          if (cnt === prevCount) {
            stableTicks++;
            if ((cnt >= 2 && stableTicks >= 2) || (cnt > 0 && stableTicks >= 3)) break;
          } else {
            prevCount = cnt;
            stableTicks = 0;
          }
          await sleep(600);
        }
      } else {
        await sleep(1800);
      }

      // If resuming DuckDuckGo past page 1, click "More Results" up to startPage - 1 first
      if (engine === "duckduckgo" && startPage > 1 && !campaign.config?.ddgHtmlMode) {
        for (let skipP = 1; skipP < startPage; skipP++) {
          const clk = await executeScriptWithTimeout({ target: { tabId }, func: adapter.clickNextFunc }, 15000);
          if (!clk?.[0]?.result?.ok) break;
          await sleep(2500);
        }
      }

      let paginationEndReason = "reached_requested_pages";
      const ddgSeenRawUrls = new Set();

      for (let pageNum = startPage; pageNum <= task.pagesRequested; pageNum++) {
        if (this.stopMode) break;
        const pageStart = new Date();

        this.liveLanes[engine] = {
          status: "extracting",
          target: task.targetSlug,
          search: task.searchSlug,
          page: pageNum,
          pagesRequested: task.pagesRequested
        };
        this.broadcastLiveUpdate();

        // Check challenge before extraction
        let challengeMeta = { encountered: false, provider: null, resolvedByHuman: false, waitDurationMs: 0 };
        const preChal = await this.checkAndHandleEngineChallenge(campaign, engine, adapter, engState, tabId, task);
        if (preChal.decision === "skipped") {
          task.status = "failed_permanent";
          task.lastError = `User skipped ${engine} challenge`;
          task.updatedAtUtc = new Date().toISOString();
          await putRecord(STORES.searchTasks, task);
          return;
        }
        if (preChal.decision === "aborted") {
          task.status = "pending";
          task.updatedAtUtc = new Date().toISOString();
          await putRecord(STORES.searchTasks, task);
          return;
        }
        if (preChal.encountered) challengeMeta = preChal;

        // Extract SERP page
        const extRes = await executeScriptWithTimeout({ target: { tabId }, func: adapter.extractFunc }, 20000);
        let payload = extRes?.[0]?.result || null;

        if (payload && payload.isChallenge) {
          const postChal = await this.checkAndHandleEngineChallenge(campaign, engine, adapter, engState, tabId, task);
          if (postChal.decision === "skipped") {
            task.status = "failed_permanent";
            task.lastError = `User skipped ${engine} challenge`;
            task.updatedAtUtc = new Date().toISOString();
            await putRecord(STORES.searchTasks, task);
            return;
          }
          if (postChal.decision === "aborted") {
            task.status = "pending";
            task.updatedAtUtc = new Date().toISOString();
            await putRecord(STORES.searchTasks, task);
            return;
          }
          challengeMeta = postChal;
          const retryRes = await executeScriptWithTimeout({ target: { tabId }, func: adapter.extractFunc }, 20000);
          payload = retryRes?.[0]?.result || null;
        }

        if (!payload || !payload.ok) {
          throw new Error(payload?.error || `Failed to extract ${engine} page ${pageNum}`);
        }

        this.engineHourlyPages[engine].push(Date.now());

        // For DuckDuckGo virtual pagination, slice only newly appended results on this virtual page
        let rawPageResults = payload.results || [];
        if (engine === "duckduckgo" && payload.virtualPagination) {
          const slice = [];
          for (const r of rawPageResults) {
            if (!ddgSeenRawUrls.has(r.resolvedUrl)) {
              ddgSeenRawUrls.add(r.resolvedUrl);
              slice.push(r);
            }
          }
          rawPageResults = slice;
        }

        // Build deterministic 000-...-results.pageNN.[json|md|html] paths up front so
        // fetchQueue items record their exact parent serpJsonFile basename (REQ-OUT-03, REQ-OUT-08)
        const serpPaths = await buildSerpRelativePaths({
          outputRoot: campaign.outputRoot,
          targetSlug: task.targetSlug,
          fullTargetSlug: targetObj.fullSlug || task.targetSlug,
          engine,
          searchSlug: task.searchSlug,
          fullSearchSlug: task.fullSearchSlug || task.searchSlug,
          pageNumber: pageNum
        });

        // Canonicalize, flag off-domain & intra-search duplicates, assign consecutive overallRank
        const pageResults = [];
        const newFetchItems = [];
        let newUniqueCount = 0;

        for (let idx = 0; idx < rawPageResults.length; idx++) {
          const r = rawPageResults[idx];
          const canon = canonicalizeUrl(r.resolvedUrl);
          if (!canon) continue;
          const isDupInSearch = seenCanonicalInSearch.has(canon);
          const offDom = isOffDomain(r.resolvedUrl, task.targetDomain);
          const enqueueThisResult = shouldEnqueueSerpResult({
            scope: task.scope || "target-site",
            offDomain: offDom,
            fetchLinks: task.fetchLinks !== false
          });

          let assignedRank = null;
          if (!isDupInSearch) {
            seenCanonicalInSearch.add(canon);
            assignedRank = nextOverallRank++;
            newUniqueCount++;

            if (enqueueThisResult) {
              const canonHash = await sha256Hex(canon);
              let host = "";
              try {
                host = new URL(r.resolvedUrl).hostname.toLowerCase();
              } catch (_) {}
              newFetchItems.push({
                fetchKey: `${task.taskKey}::${assignedRank}`,
                taskKey: task.taskKey,
                campaignId: campaign.campaignId,
                targetSlug: task.targetSlug,
                targetDomain: task.targetDomain,
                externalId: targetObj.externalId ?? null,
                engine,
                searchSlug: task.searchSlug,
                pageNumber: pageNum,
                pageRank: idx + 1,
                overallRank: assignedRank,
                serpTitle: r.title || "",
                serpSnippet: r.snippet || "",
                serpJsonFile: serpPaths.basenames.json,
                rawUrl: r.resolvedUrl,
                canonicalUrl: canon,
                canonicalUrlHash: canonHash,
                host,
                offDomain: offDom,
                status: "pending",
                attemptCount: 0,
                lastError: null,
                updatedAtUtc: new Date().toISOString()
              });
            }
          }

          pageResults.push({
            overallRank: assignedRank ?? nextOverallRank,
            pageNumber: pageNum,
            pageRank: idx + 1,
            title: r.title,
            rawHref: r.rawHref,
            resolvedUrl: r.resolvedUrl,
            canonicalUrl: canon,
            domain: r.domain,
            offDomain: offDom,
            skippedOffDomainOnSerp: Boolean(offDom && (task.scope || "target-site").toLowerCase() === "target-site"),
            duplicateInSameSearch: isDupInSearch,
            urlDecodeFallback: Boolean(r.urlDecodeFallback),
            siteName: r.siteName,
            snippet: r.snippet,
            extractedTimestampUtc: payload.timestampUtc
          });
        }

        // Optional parallel decoy browsing with REQ-ENG-07 ad relevance & 1.5% cap
        const decoyVisits = [];
        const decoyEnabledForEngine = Boolean(pacing.decoyEnabled?.[engine]);
        if (decoyEnabledForEngine && Math.random() < (pacing.decoyProbability ?? 0.45)) {
          const allHosts = await getAllRecords(STORES.hostState);
          const busyHosts = new Set(
            allHosts.filter((h) => h.activeFetchKey || h.pausedByChallenge).map((h) => h.host)
          );
          const pick = selectSafeDecoy({
            candidates: payload.decoyCandidates || [],
            preference: campaign.config?.decoyPreference || "any",
            resolvedQuery: task.resolvedQuery,
            targetDomain: task.targetDomain,
            adVisits: engState.adVisits || 0,
            decoyVisits: engState.decoyVisits || 0,
            isCandidateAllowed: (c) => {
              const safety = checkUrlSafety(
                c.url,
                campaign.config?.denylistPatterns || DEFAULT_DENYLIST_PATTERNS,
                campaign.config?.blockedExtensions || DEFAULT_BLOCKED_EXTENSIONS
              );
              if (!safety.allowed) return false;
              return !busyHosts.has(safety.host);
            }
          });
          if (pick) {
            const dwellMs = Math.round(
              ((pacing.decoyMinSec ?? 3) + Math.random() * ((pacing.decoyMaxSec ?? 33) - (pacing.decoyMinSec ?? 3))) * 1000
            );
            engState.decoyVisits = (engState.decoyVisits || 0) + 1;
            if (pick.type === "sponsored") {
              engState.adVisits = (engState.adVisits || 0) + 1;
            }
            decoyVisits.push({
              type: pick.type,
              url: pick.url,
              title: pick.title || "",
              dwellMs,
              relevanceReason: pick.relevanceReason || null,
              timestampUtc: new Date().toISOString()
            });
            this.spawnDecoyTab(campaign, pick.url, dwellMs).catch(() => {});
          }
        }

        // Determine pagination end reason for this page (REQ-ENG-05, REQ-ENG-06)
        let shouldStopAfterPage = false;
        if (payload.zeroResults) {
          paginationEndReason = "zero_results";
          shouldStopAfterPage = true;
        } else if (pageNum > 1 && newUniqueCount === 0) {
          paginationEndReason = "no_new_results";
          shouldStopAfterPage = true;
        } else if (pageNum >= task.pagesRequested) {
          paginationEndReason = "reached_requested_pages";
          shouldStopAfterPage = true;
        } else if (!payload.hasNextPage) {
          paginationEndReason = "no_next_button";
          shouldStopAfterPage = true;
        }

        const pageEnd = new Date();
        const campaignMeta = {
          campaignId: campaign.campaignId,
          runId: campaign.runId || campaign.campaignId,
          rosterVersion: campaign.rosterVersion ?? null,
          queryListVersion: campaign.queryListVersion ?? null,
          target: {
            externalId: targetObj.externalId ?? null,
            name: targetObj.name ?? null,
            slug: task.targetSlug,
            domain: task.targetDomain,
            metadata: targetObj.metadata || {}
          },
          searchEngine: engine,
          search: {
            id: task.searchId,
            group: task.group ?? null,
            slug: task.searchSlug,
            scope: task.scope || "target-site",
            template: task.template,
            resolvedQuery: task.resolvedQuery
          }
        };

        // Save .md, .html (if enabled), and .json via offscreen Blob URLs with strict verification
        const serpMd = buildSerpMarkdown({
          targetSlug: task.targetSlug,
          domain: task.targetDomain,
          searchEngine: engine,
          searchSlug: task.searchSlug,
          query: task.resolvedQuery,
          serpUrl: payload.currentUrl,
          pageNumber: pageNum,
          pagesRequested: task.pagesRequested,
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
          isCampaign: true,
          eraseFromHistory
        });

        if (saveSerpHtml && payload.rawHtml) {
          await downloadTextVerified({
            content: payload.rawHtml,
            filename: serpPaths.html,
            mimeType: "text/html;charset=utf-8",
            isCampaign: true,
            eraseFromHistory
          });
        }

        const serpJson = buildSerpJson({
          mode: "campaign",
          extension: extInfo,
          campaign: campaignMeta,
          environment: {
            ...envInfo,
            userAgent: payload.clientMetadata?.userAgent || envInfo.userAgent,
            platform: payload.clientMetadata?.platform || envInfo.platform,
            language: payload.clientMetadata?.language || envInfo.language,
            timezone: payload.clientMetadata?.timezone || envInfo.timezone
          },
          searchMetadata: {
            query: task.resolvedQuery,
            initialSearchUrl: initialUrl,
            pageUrl: payload.currentUrl,
            pageNumber: pageNum,
            pagesRequested: task.pagesRequested,
            noPersonalizationApplied: engine === "google" && campaign.config?.noPersonalization !== false,
            zeroResults: payload.zeroResults,
            queryRewrittenTo: payload.queryRewrittenTo,
            exactMatchLost: payload.exactMatchLost,
            challenge: challengeMeta,
            pagination: {
              hasNextPage: Boolean(payload.hasNextPage),
              endReason: shouldStopAfterPage ? paginationEndReason : null
            },
            timestamps: {
              startedUtc: pageStart.toISOString(),
              startedLocal: getLocalIsoTimestamp(pageStart),
              completedUtc: pageEnd.toISOString(),
              completedLocal: getLocalIsoTimestamp(pageEnd),
              durationMs: pageEnd.getTime() - pageStart.getTime()
            }
          },
          decoyBrowsing: {
            enabled: decoyEnabledForEngine,
            preference: campaign.config?.decoyPreference || "any",
            visits: decoyVisits
          },
          files: {
            relativeDir: serpPaths.relDir,
            markdown: serpPaths.basenames.md,
            html: saveSerpHtml ? serpPaths.basenames.html : null,
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
          isCampaign: true,
          eraseFromHistory
        });

        // Atomic commit point 1 (REQ-STATE-05 #1)
        task.pagesCompleted = pageNum;
        task.lastSerpUrl = payload.currentUrl;
        task.serpRelDir = serpPaths.relDir;
        task.nextRank = nextOverallRank;
        task.resultCount = (task.resultCount || 0) + newUniqueCount;
        task.paginationEndReason = shouldStopAfterPage ? paginationEndReason : null;
        if (shouldStopAfterPage) {
          task.status = "completed";
        }
        task.updatedAtUtc = new Date().toISOString();
        engState.lastRequestUtc = task.updatedAtUtc;

        await commitSerpPageAndEnqueue({
          searchTask: task,
          fetchItems: newFetchItems,
          engineState: engState
        });

        this.deltaBuffer.push({ type: "searchTask", data: { ...task } });
        for (const fi of newFetchItems) this.deltaBuffer.push({ type: "fetchQueue", data: { ...fi } });
        this.deltaBuffer.push({ type: "engineState", data: { ...engState } });

        await this.log(
          "info",
          `lane:${engine}`,
          `${task.targetSlug} / ${task.searchSlug} page ${pageNum}/${task.pagesRequested}: ${newUniqueCount} new results.`
        );

        if (shouldStopAfterPage || this.stopMode) break;

        // Bounded inter-page SERP delay (REQ-ENG-08) with human simulation in tab
        const ip = pacing.serpPageDelay || DEFAULT_PACING.serpPageDelay;
        const waitSec = sampleBoundedDelay(ip.min, ip.max, ip.mean);
        executeScriptWithTimeout(
          { target: { tabId }, func: simulateHumanActivityFunc, args: [Math.round(waitSec * 1000)] },
          Math.round(waitSec * 1000) + 10000
        ).catch(() => {});
        await this.laneDelayWithCountdown(engine, waitSec * 1000, "inter_page", engState);
        if (this.stopMode) break;

        // Native click pagination
        const clickRes = await executeScriptWithTimeout({ target: { tabId }, func: adapter.clickNextFunc }, 15000);
        const cr = clickRes?.[0]?.result;
        if (!cr || !cr.ok) {
          task.status = "completed";
          task.paginationEndReason = "no_next_button";
          task.updatedAtUtc = new Date().toISOString();
          await putRecord(STORES.searchTasks, task);
          break;
        }

        if (engine === "duckduckgo" && cr.virtualPagination) {
          // Wait for new results to append in DOM (up to 15s)
          const beforeCount = (payload.results || []).length;
          const waitStart = Date.now();
          while (Date.now() - waitStart < 15000 && !this.stopMode) {
            await sleep(1000);
            const probe = await executeScriptWithTimeout({ target: { tabId }, func: adapter.extractFunc }, 10000).catch(() => null);
            if (probe?.[0]?.result?.ok && (probe[0].result.results || []).length > beforeCount) {
              break;
            }
          }
        } else {
          await waitForTabComplete(tabId, 30000);
          await sleep(1800);
        }
      }

      if (task.status === "in_progress") {
        task.status = this.stopMode ? "pending" : "completed";
        task.updatedAtUtc = new Date().toISOString();
        await putRecord(STORES.searchTasks, task);
      }
    } catch (err) {
      task.status = (task.attemptCount || 1) >= (campaign.config?.maxRetries ?? 3) ? "failed_permanent" : "failed_retryable";
      task.lastError = err?.message || String(err);
      task.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.searchTasks, task);
      await this.log("error", `lane:${engine}`, `Task ${task.taskKey} failed: ${task.lastError}`);
    }
  }

  async spawnDecoyTab(campaign, url, dwellMs) {
    let tabId = null;
    try {
      const winId = await this.ensureManagedWindow(campaign);
      const opts = { url, active: false };
      if (typeof winId === "number") opts.windowId = winId;
      const tab = await chrome.tabs.create(opts);
      tabId = tab.id;
      await waitForTabComplete(tabId, 15000);
      await executeScriptWithTimeout(
        { target: { tabId }, func: simulateHumanActivityFunc, args: [dwellMs] },
        dwellMs + 10000
      ).catch(() => sleep(dwellMs));
    } catch (_) {
    } finally {
      await safeCloseTab(tabId);
    }
  }

  /**
   * Handle search-engine challenge with 30-min sliding-window escalation cooldowns (REQ-ENG-04).
   */
  async checkAndHandleEngineChallenge(campaign, engine, adapter, engState, tabId, task) {
    const chkRes = await executeScriptWithTimeout({ target: { tabId }, func: adapter.checkChallengeFunc }, 10000).catch(() => null);
    const ch = chkRes?.[0]?.result;
    if (!ch || !ch.isChallenge) {
      return { encountered: false, decision: "none" };
    }

    const startMs = Date.now();
    const challengeId = `engine::${engine}::${tabId}`;
    const tabObj = await chrome.tabs.get(tabId).catch(() => null);
    const url = tabObj?.url || "";

    // Record in 30-minute sliding window
    const thirtyMinAgo = startMs - 30 * 60 * 1000;
    engState.challengeWindowTimestamps = (engState.challengeWindowTimestamps || [])
      .filter((ts) => ts > thirtyMinAgo);
    engState.challengeWindowTimestamps.push(startMs);
    engState.status = "paused_challenge";
    await putRecord(STORES.engineState, engState);

    this.liveLanes[engine] = {
      status: "paused_challenge",
      provider: ch.provider,
      target: task.targetSlug,
      search: task.searchSlug
    };
    await this.updateBadge("CAP!", "#f59e0b");
    await this.notify(
      challengeId,
      `SerpyDerpy: ${engine} CAPTCHA`,
      `Click to solve ${ch.provider} on ${task.targetSlug} / ${task.searchSlug}.`
    );
    await this.log("warn", `lane:${engine}`, `Challenge detected (${ch.provider}); waiting for human click.`);

    if (campaign.config?.autoFocusCaptcha) {
      await this.focusTab(tabId);
    }

    const decision = await this.waitForChallengeResolution({
      id: challengeId,
      kind: "engine",
      engine,
      url,
      provider: ch.provider,
      tabId,
      pollResolved: async () => {
        const r = await executeScriptWithTimeout({ target: { tabId }, func: adapter.checkChallengeFunc }, 10000).catch(() => null);
        return Boolean(r?.[0]?.result && !r[0].result.isChallenge);
      }
    });

    const waitDurationMs = Date.now() - startMs;

    // Apply escalation cooldown if >= N challenges (default 3) in 30 minutes (REQ-ENG-04 #6)
    const threshold = Number(campaign.config?.challengeEscalationThreshold ?? 3);
    if (engState.challengeWindowTimestamps.length >= threshold) {
      const level = engState.escalationLevel || 0;
      engState.escalationLevel = level + 1;
      engState.status = "paused_cooldown";
      if (level < ESCALATION_COOLDOWN_MS.length) {
        const ms = ESCALATION_COOLDOWN_MS[level];
        engState.cooldownUntilUtc = new Date(Date.now() + ms).toISOString();
        chrome.alarms.create(`serpyderpy-cooldown-${engine}`, { when: Date.now() + ms });
        await this.log("warn", `lane:${engine}`, `Escalation cooldown level ${level + 1}: pausing ${engine} for ${ms / 60000} min.`);
      } else {
        engState.cooldownUntilUtc = null; // Manual resume required
        await this.log("warn", `lane:${engine}`, `Escalation cooldown ceiling reached: ${engine} paused until manual Resume.`);
      }
      await putRecord(STORES.engineState, engState);
    } else {
      engState.status = "working";
      await putRecord(STORES.engineState, engState);
    }

    if (this.activeChallenges.size === 0 && this.isRunning && !this.stopMode) {
      await this.updateBadge("RUN", "#0284c7");
    }

    if (decision === "resolved") {
      await sleep(3000 + Math.floor(Math.random() * 2000));
    }

    return {
      encountered: true,
      provider: ch.provider,
      resolvedByHuman: decision === "resolved",
      waitDurationMs,
      decision
    };
  }

  /**
   * Register a challenge in Needs Human Click and poll every 2s until cleared, skipped, or aborted.
   */
  waitForChallengeResolution({ id, kind, engine = null, host = null, url, provider, tabId, pollResolved }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        this.activeChallenges.delete(id);
        this.broadcastLiveUpdate();
        resolve(decision);
      };

      this.activeChallenges.set(id, {
        id,
        kind,
        engine,
        host,
        url,
        provider,
        tabId,
        detectedAtUtc: new Date().toISOString(),
        resolveDecision: finish
      });
      this.broadcastLiveUpdate();

      const interval = setInterval(async () => {
        if (this.stopMode) {
          finish("aborted");
          return;
        }
        try {
          const cleared = await pollResolved();
          if (cleared) finish("resolved");
        } catch (_) {}
      }, 2000);
    });
  }

  async focusTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (_) {}
  }

  async skipChallenge(challengeId) {
    const c = this.activeChallenges.get(challengeId);
    if (c && typeof c.resolveDecision === "function") {
      c.resolveDecision("skipped");
      return { ok: true };
    }
    return { ok: false, error: "Challenge not found." };
  }

  /**
   * Decoupled Result Fetch Pool (REQ-FETCH-01..05, REQ-STATE-03).
   */
  async runFetchPool(campaignId) {
    const campaign = await getRecord(STORES.campaigns, campaignId);
    const maxWorkers = Math.max(1, Math.min(7, Number(campaign?.config?.fetchConcurrency ?? 3)));
    const activeHostsInMem = new Set();
    const activeFetchKeysInMem = new Set();

    const worker = async (workerId) => {
      while (this.isRunning && !this.stopMode) {
        const freshCampaign = await getRecord(STORES.campaigns, campaignId);
        if (!freshCampaign || freshCampaign.status !== "running") break;

        if (this.isGloballyPausedByChallenge(freshCampaign)) {
          await this.interruptibleSleep(1500);
          continue;
        }

        // Re-evaluate waiting_dedup items whose owner may have finished
        const waitingRows = await getAllByIndex(STORES.fetchQueue, "byCampaignStatus", [campaignId, "waiting_dedup"]);
        for (const w of waitingRows) {
          const d = await lookupUrlDeduplication({
            canonicalUrlHash: w.canonicalUrlHash,
            campaignId,
            globalDedup: freshCampaign.config?.globalDedup !== false,
            freshnessDays: freshCampaign.config?.freshnessDays ?? 30,
            dedupPolicy: freshCampaign.config?.dedupPolicy || "skip-and-stub"
          });
          if (d.action !== "waiting_dedup") {
            w.status = "pending";
            w.updatedAtUtc = new Date().toISOString();
            await putRecord(STORES.fetchQueue, w);
          }
        }

        const pendingFetches = await getAllByIndex(STORES.fetchQueue, "byCampaignStatus", [campaignId, "pending"]);
        const retryFetches = await getAllByIndex(STORES.fetchQueue, "byCampaignStatus", [campaignId, "failed_retryable"]);
        const allCandidates = [...pendingFetches, ...retryFetches];

        if (allCandidates.length === 0) {
          // Check if all search lanes are finished
          const openSearches = [
            ...(await getAllByIndex(STORES.searchTasks, "byCampaignStatus", [campaignId, "pending"])),
            ...(await getAllByIndex(STORES.searchTasks, "byCampaignStatus", [campaignId, "in_progress"])),
            ...(await getAllByIndex(STORES.searchTasks, "byCampaignStatus", [campaignId, "paused_challenge"])),
            ...(await getAllByIndex(STORES.searchTasks, "byCampaignStatus", [campaignId, "failed_retryable"]))
          ];
          if (openSearches.length === 0 && waitingRows.length === 0) {
            break;
          }
          await this.interruptibleSleep(1500);
          continue;
        }

        // Claim a candidate whose host is NOT currently locked, NOT paused by challenge, and past host cooldown
        const claim = await claimNextFetchCandidate({
          candidates: allCandidates,
          activeHostsInMem,
          activeFetchKeysInMem,
          getHostState: (h) => getRecord(STORES.hostState, h)
        });

        if (!claim) {
          await this.interruptibleSleep(1200);
          continue;
        }

        const { chosen, hostState: chosenHostState, host } = claim;
        this.liveFetchers.activeHosts = Array.from(activeHostsInMem);
        this.broadcastLiveUpdate();

        try {
          await this.processFetchTask(freshCampaign, chosen, chosenHostState);
        } finally {
          activeHostsInMem.delete(host);
          activeFetchKeysInMem.delete(chosen.fetchKey);
          this.liveFetchers.activeHosts = Array.from(activeHostsInMem);
          this.broadcastLiveUpdate();
        }
      }
    };

    const workers = [];
    for (let w = 1; w <= maxWorkers; w++) workers.push(worker(w));
    await Promise.all(workers);

    // Final target window sweep to ensure _site/ capture runs for the last targets
    const endCampaign = await getRecord(STORES.campaigns, campaignId);
    if (endCampaign && !this.stopMode) {
      await this.getActiveTargetWindow(endCampaign);
    }
  }

  async processFetchTask(campaign, fetchItem, hostState) {
    const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : { name: "SerpyDerpy", version: "2.0.0" };
    const extInfo = { name: manifest.name || "SerpyDerpy", version: manifest.version || "2.0.0" };
    const eraseFromHistory = campaign.config?.eraseDownloadHistory !== false;
    const globalDedup = campaign.config?.globalDedup !== false;
    const freshnessDays = campaign.config?.freshnessDays ?? 30;
    const dedupPolicy = campaign.config?.dedupPolicy || "skip-and-stub";
    const pacing = { ...DEFAULT_PACING, ...(campaign.config?.pacing || {}) };

    // 1. Check URL Ledger deduplication & freshness (REQ-STATE-03)
    const dedup = await lookupUrlDeduplication({
      canonicalUrlHash: fetchItem.canonicalUrlHash,
      campaignId: campaign.campaignId,
      globalDedup,
      freshnessDays,
      dedupPolicy
    });

    if (dedup.action === "waiting_dedup") {
      // Yield worker immediately without blocking (REQ-STATE-03)
      fetchItem.status = "waiting_dedup";
      fetchItem.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.fetchQueue, fetchItem);
      return;
    }

    const targetObj = (campaign.targets || []).find((t) => t.slug === fetchItem.targetSlug) || {
      domain: fetchItem.targetDomain,
      slug: fetchItem.targetSlug,
      name: null,
      externalId: fetchItem.externalId ?? null,
      metadata: {}
    };
    const searchTask = await getRecord(STORES.searchTasks, fetchItem.taskKey);
    const campaignContext = {
      campaignId: campaign.campaignId,
      runId: campaign.runId || campaign.campaignId,
      target: {
        externalId: targetObj.externalId ?? null,
        name: targetObj.name ?? null,
        slug: fetchItem.targetSlug,
        domain: fetchItem.targetDomain,
        metadata: targetObj.metadata || {}
      },
      searchEngine: fetchItem.engine,
      search: {
        id: searchTask?.searchId || fetchItem.searchSlug,
        group: searchTask?.group ?? null,
        slug: fetchItem.searchSlug,
        scope: searchTask?.scope || "target-site",
        template: searchTask?.template || "",
        resolvedQuery: searchTask?.resolvedQuery || ""
      }
    };
    const serpContext = {
      pageNumber: fetchItem.pageNumber,
      pageRank: fetchItem.pageRank,
      overallRank: fetchItem.overallRank,
      serpTitle: fetchItem.serpTitle,
      serpSnippet: fetchItem.serpSnippet,
      serpJsonFile: fetchItem.serpJsonFile || null
    };

    if (dedup.action === "skip-and-stub" || dedup.action === "skip-silent") {
      if (dedup.action === "skip-and-stub") {
        await this.writeDedupStub({
          campaign,
          extInfo,
          campaignContext,
          serpContext,
          fetchItem,
          match: dedup.match,
          eraseFromHistory
        });
      }
      fetchItem.status = "completed_dedup";
      fetchItem.artifactRelPath = dedup.match.canonicalArtifactRelPath;
      fetchItem.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.fetchQueue, fetchItem);
      this.deltaBuffer.push({ type: "fetchQueue", data: { ...fetchItem } });
      return;
    }

    if (dedup.action === "propagate_terminal") {
      const m = dedup.match;
      const paths = buildResultRelativePaths({
        outputRoot: campaign.outputRoot,
        targetSlug: fetchItem.targetSlug,
        engine: fetchItem.engine,
        searchSlug: fetchItem.searchSlug,
        overallRank: fetchItem.overallRank,
        title: fetchItem.serpTitle || fetchItem.rawUrl,
        ext: "json",
        kind: "binary"
      });
      const errObj = buildErrorJson({
        mode: "campaign",
        extension: extInfo,
        campaign: campaignContext,
        serpContext,
        url: {
          requested: fetchItem.rawUrl,
          canonical: fetchItem.canonicalUrl,
          final: m.finalUrl || fetchItem.rawUrl,
          offDomain: Boolean(fetchItem.offDomain)
        },
        status: m.status,
        errorClass: m.errorClass || "http_4xx",
        httpStatus: m.httpStatus ?? null,
        reason: `Propagated unexpired ledger disposition from ${m.firstSeenTaskKey || m.campaignId}: ${m.lastError || m.status}`,
        retryable: false,
        attemptCount: 0
      });
      await downloadTextVerified({
        content: JSON.stringify(errObj, null, 2),
        filename: paths.errorJson,
        mimeType: "application/json;charset=utf-8",
        isCampaign: true,
        eraseFromHistory
      });
      fetchItem.status = m.status;
      fetchItem.errorClass = m.errorClass;
      fetchItem.artifactRelPath = paths.errorJson;
      fetchItem.updatedAtUtc = new Date().toISOString();
      await putRecord(STORES.fetchQueue, fetchItem);
      return;
    }

    // 2. Claim ownership in urlLedger & hostState before hitting the network
    const ledgerKey = `${campaign.campaignId}::${fetchItem.canonicalUrlHash}`;
    const nowIso = new Date().toISOString();
    fetchItem.status = "in_progress";
    fetchItem.attemptCount = (fetchItem.attemptCount || 0) + 1;
    fetchItem.updatedAtUtc = nowIso;
    hostState.activeFetchKey = fetchItem.fetchKey;

    const inFlightLedger = {
      ledgerKey,
      campaignId: campaign.campaignId,
      outputRoot: campaign.outputRoot,
      canonicalUrlHash: fetchItem.canonicalUrlHash,
      canonicalUrl: fetchItem.canonicalUrl,
      finalCanonicalUrl: fetchItem.canonicalUrl,
      sampleRawUrl: fetchItem.rawUrl,
      title: fetchItem.serpTitle || null,
      host: fetchItem.host,
      offDomain: Boolean(fetchItem.offDomain),
      status: "in_progress",
      errorClass: null,
      httpStatus: null,
      kind: null,
      mimeType: null,
      fileSizeBytes: null,
      contentSha256: null,
      canonicalArtifactRelPath: null,
      firstSeenTaskKey: fetchItem.taskKey,
      fetchedAtUtc: null,
      attemptCount: fetchItem.attemptCount,
      lastError: null,
      updatedAtUtc: nowIso
    };

    await commitFetchOutcome({ ledgerRows: [inFlightLedger], fetchItem, hostState });

    const winId = await this.ensureManagedWindow(campaign);

    const outcome = await fetchAndArchiveUrl({
      requestedUrl: fetchItem.rawUrl,
      canonicalUrl: fetchItem.canonicalUrl,
      mode: "campaign",
      campaignContext,
      serpContext,
      outputRoot: campaign.outputRoot,
      targetSlug: fetchItem.targetSlug,
      targetDomain: fetchItem.targetDomain,
      engine: fetchItem.engine,
      searchSlug: fetchItem.searchSlug,
      overallRank: fetchItem.overallRank,
      serpTitle: fetchItem.serpTitle,
      attemptNumber: fetchItem.attemptCount,
      windowId: winId,
      config: campaign.config || {},
      onFinalCanonicalCheck: async (finalCanon) => {
        const fHash = await sha256Hex(finalCanon);
        const aliasDedup = await lookupUrlDeduplication({
          canonicalUrlHash: fHash,
          campaignId: campaign.campaignId,
          globalDedup,
          freshnessDays,
          dedupPolicy
        });
        if (aliasDedup.action === "skip-and-stub" || aliasDedup.action === "skip-silent") {
          if (aliasDedup.action === "skip-and-stub") {
            await this.writeDedupStub({
              campaign,
              extInfo,
              campaignContext,
              serpContext,
              fetchItem,
              match: aliasDedup.match,
              eraseFromHistory
            });
          }
          return {
            ok: true,
            dedupHandled: true,
            status: "completed_dedup",
            finalCanonicalUrl: finalCanon,
            artifactRelPath: aliasDedup.match.canonicalArtifactRelPath
          };
        }
        return null;
      },
      onChallengeDetected: async ({ tabId, url, provider, pollResolved }) => {
        hostState.pausedByChallenge = true;
        fetchItem.status = "paused_challenge";
        inFlightLedger.status = "paused_challenge";
        await commitFetchOutcome({ ledgerRows: [inFlightLedger], fetchItem, hostState });

        const cid = `fetch::${fetchItem.host}::${tabId}`;
        await this.updateBadge("CAP!", "#f59e0b");
        await this.notify(cid, `SerpyDerpy: ${provider} Challenge`, `Click to clear challenge on ${fetchItem.host}.`);
        await this.log("warn", "fetcher", `Target challenge (${provider}) on ${url}; holding host ${fetchItem.host}.`);

        if (campaign.config?.autoFocusCaptcha) await this.focusTab(tabId);

        const decision = await this.waitForChallengeResolution({
          id: cid,
          kind: "fetch",
          host: fetchItem.host,
          url,
          provider,
          tabId,
          pollResolved
        });

        hostState.pausedByChallenge = false;
        await putRecord(STORES.hostState, hostState);
        if (this.activeChallenges.size === 0 && this.isRunning && !this.stopMode) {
          await this.updateBadge("RUN", "#0284c7");
        }
        return decision;
      }
    });

    if (outcome.aborted) {
      hostState.activeFetchKey = null;
      hostState.pausedByChallenge = false;
      fetchItem.status = "pending";
      inFlightLedger.status = "failed_retryable";
      await commitFetchOutcome({ ledgerRows: [inFlightLedger], fetchItem, hostState });
      return;
    }

    // 3. Apply per-host politeness cooldown (REQ-FETCH-02, REQ-ENG-08)
    const sh = pacing.sameHostFetchDelay || DEFAULT_PACING.sameHostFetchDelay;
    let hostCooldownMs = Math.round(sampleBoundedDelay(sh.min, sh.max, sh.mean) * 1000);
    if (outcome.httpStatus === 429 || outcome.httpStatus === 503) {
      const idx = Math.min(hostState.consecutiveBackoffs || 0, HOST_BACKOFF_MS.length - 1);
      hostCooldownMs = HOST_BACKOFF_MS[idx];
      hostState.consecutiveBackoffs = (hostState.consecutiveBackoffs || 0) + 1;
    } else if (outcome.ok) {
      hostState.consecutiveBackoffs = 0;
    }

    const doneIso = new Date().toISOString();
    hostState.activeFetchKey = null;
    hostState.pausedByChallenge = false;
    hostState.lastRequestUtc = doneIso;
    hostState.cooldownUntilUtc = new Date(Date.now() + hostCooldownMs).toISOString();

    const maxRetries = Number(campaign.config?.maxRetries ?? 3);
    let finalStatus = outcome.status;
    if (finalStatus === "failed_retryable" && fetchItem.attemptCount >= maxRetries) {
      finalStatus = "failed_permanent";
    }

    fetchItem.status = outcome.dedupHandled ? "completed_dedup" : outcome.ok ? "completed" : finalStatus;
    fetchItem.errorClass = outcome.errorClass || null;
    fetchItem.lastError = outcome.reason || null;
    fetchItem.observedContentLengthBytes = outcome.observedContentLengthBytes ?? null;
    fetchItem.artifactRelPath = outcome.artifactRelPath || null;
    fetchItem.updatedAtUtc = doneIso;

    const finalLedgerRow = {
      ...inFlightLedger,
      finalUrl: outcome.finalUrl || fetchItem.rawUrl,
      finalCanonicalUrl: outcome.finalCanonicalUrl || fetchItem.canonicalUrl,
      title: outcome.title || fetchItem.serpTitle || null,
      offDomain: Boolean(outcome.offDomain),
      status: outcome.dedupHandled ? "fetched" : outcome.ok ? "fetched" : finalStatus,
      errorClass: outcome.errorClass || null,
      httpStatus: outcome.httpStatus ?? null,
      kind: outcome.kind || null,
      mimeType: outcome.mimeType || null,
      fileSizeBytes: outcome.fileSizeBytes ?? null,
      contentSha256: outcome.contentSha256 ?? null,
      canonicalArtifactRelPath: outcome.artifactRelPath || null,
      fetchedAtUtc: doneIso,
      lastError: outcome.reason || null,
      updatedAtUtc: doneIso
    };

    const ledgerRowsToCommit = [finalLedgerRow];

    // Redirect aliasing: also store alias row under finalCanonicalUrl hash (REQ-STATE-02)
    if (outcome.ok && outcome.finalCanonicalUrl && outcome.finalCanonicalUrl !== fetchItem.canonicalUrl) {
      const fHash = await sha256Hex(outcome.finalCanonicalUrl);
      ledgerRowsToCommit.push({
        ...finalLedgerRow,
        ledgerKey: `${campaign.campaignId}::${fHash}`,
        canonicalUrlHash: fHash,
        canonicalUrl: outcome.finalCanonicalUrl
      });
    }

    // Atomic commit point 2 (REQ-STATE-05 #2)
    await commitFetchOutcome({ ledgerRows: ledgerRowsToCommit, fetchItem, hostState });

    this.deltaBuffer.push({ type: "fetchQueue", data: { ...fetchItem } });
    for (const lr of ledgerRowsToCommit) this.deltaBuffer.push({ type: "urlLedger", data: { ...lr } });
    this.deltaBuffer.push({ type: "hostState", data: { ...hostState } });
  }

  async writeDedupStub({ campaign, extInfo, campaignContext, serpContext, fetchItem, match, eraseFromHistory }) {
    const envInfo = await getEnvironmentInfo({ recordPublicIp: Boolean(campaign.config?.recordPublicIp) });
    const paths = buildResultRelativePaths({
      outputRoot: campaign.outputRoot,
      targetSlug: fetchItem.targetSlug,
      engine: fetchItem.engine,
      searchSlug: fetchItem.searchSlug,
      overallRank: fetchItem.overallRank,
      title: match.title || fetchItem.serpTitle || fetchItem.rawUrl,
      ext: "json",
      kind: "binary"
    });
    const stubObj = buildResultJson({
      mode: "campaign",
      extension: extInfo,
      campaign: campaignContext,
      serpContext,
      fetchedAt: new Date(),
      processingDurationMs: 0,
      attemptNumber: 0,
      url: {
        requested: fetchItem.rawUrl,
        canonical: fetchItem.canonicalUrl,
        final: match.finalUrl || fetchItem.rawUrl,
        finalCanonical: match.finalCanonicalUrl || fetchItem.canonicalUrl,
        offDomain: Boolean(fetchItem.offDomain)
      },
      resource: {
        kind: match.kind || "html",
        title: match.title || fetchItem.serpTitle || null,
        mimeType: match.mimeType || null,
        fileSizeBytes: match.fileSizeBytes ?? null,
        sha256: match.contentSha256 ?? null
      },
      deduplication: {
        isDuplicateReference: true,
        canonicalCampaignId: match.campaignId,
        canonicalOutputRoot: match.outputRoot,
        canonicalArtifactRelPath: match.canonicalArtifactRelPath,
        firstFetchedUtc: match.fetchedAtUtc,
        firstSeenTaskKey: match.firstSeenTaskKey
      },
      files: { source: null, markdown: null, metadata: paths.basenames.json },
      environment: envInfo
    });
    await downloadTextVerified({
      content: JSON.stringify(stubObj, null, 2),
      filename: paths.json,
      mimeType: "application/json;charset=utf-8",
      isCampaign: true,
      eraseFromHistory
    });
  }

  async laneDelayWithCountdown(engine, delayMs, phase, engState) {
    const endMs = Date.now() + delayMs;
    if (delayMs > 15000) {
      engState.cooldownUntilUtc = new Date(endMs).toISOString();
      await putRecord(STORES.engineState, engState);
      chrome.alarms.create(`serpyderpy-wait-${engine}`, { when: endMs });
    }
    while (Date.now() < endMs && this.isRunning && !this.stopMode) {
      const remSec = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
      this.liveLanes[engine] = { ...this.liveLanes[engine], status: phase, waitSec: remSec };
      this.broadcastLiveUpdate();
      await sleep(Math.min(1000, Math.max(50, endMs - Date.now())));
    }
    if (delayMs > 15000) {
      engState.cooldownUntilUtc = null;
      await putRecord(STORES.engineState, engState);
    }
  }

  async interruptibleSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && this.isRunning && !this.stopMode) {
      await sleep(Math.min(500, Math.max(50, end - Date.now())));
    }
  }

  /**
   * Flush incremental delta checkpoint (REQ-STATE-07).
   */
  async flushDeltaCheckpoint(campaignOverride = null) {
    if (this.deltaBuffer.length === 0) return;
    const campaign = campaignOverride || (this.activeCampaignId ? await getRecord(STORES.campaigns, this.activeCampaignId) : null);
    if (!campaign) return;

    const records = this.deltaBuffer.splice(0, this.deltaBuffer.length);
    const seq = (campaign.nextDeltaSeq || 1);
    campaign.nextDeltaSeq = seq + 1;
    await putRecord(STORES.campaigns, campaign);

    const content = await buildCheckpointJsonl({
      checkpointKind: "delta",
      seq,
      campaignId: campaign.campaignId,
      records
    });
    const filename = `${campaign.outputRoot}/_state/checkpoint-delta-${String(seq).padStart(6, "0")}.jsonl`;
    await downloadTextVerified({
      content,
      filename,
      mimeType: "application/x-ndjson;charset=utf-8",
      isCampaign: true,
      eraseFromHistory: campaign.config?.eraseDownloadHistory !== false
    });
    this.lastDeltaFlushMs = Date.now();
  }

  /**
   * Write full streamed JSONL checkpoint snapshot (REQ-STATE-07).
   */
  async writeFullCheckpoint(campaign) {
    const jsonl = await exportFullCheckpointJsonl(campaign.campaignId, campaign.nextDeltaSeq || 0);
    const prefix = getLocalDateTimePrefix(new Date());
    const filename = `${campaign.outputRoot}/_state/checkpoint-full-${prefix}.jsonl`;
    await downloadTextVerified({
      content: jsonl,
      filename,
      mimeType: "application/x-ndjson;charset=utf-8",
      isCampaign: true,
      eraseFromHistory: campaign.config?.eraseDownloadHistory !== false
    });
    return filename;
  }

  /**
   * Flush rotated execution log segment (REQ-OUT-02).
   */
  async flushLogSegment() {
    if (this.logBuffer.length === 0 || !this.activeCampaignId) return;
    const campaign = await getRecord(STORES.campaigns, this.activeCampaignId);
    if (!campaign) return;

    const lines = this.logBuffer.splice(0, this.logBuffer.length);
    const part = campaign.nextLogPart || 1;
    campaign.nextLogPart = part + 1;
    await putRecord(STORES.campaigns, campaign);

    const prefix = getLocalDateTimePrefix(new Date());
    const filename = `${campaign.outputRoot}/_reports/${prefix}-serpyderpy-part${String(part).padStart(4, "0")}.log`;
    await downloadTextVerified({
      content: lines.join("\n") + "\n",
      filename,
      mimeType: "text/plain;charset=utf-8",
      isCampaign: true,
      eraseFromHistory: campaign.config?.eraseDownloadHistory !== false
    });
    this.lastLogFlushMs = Date.now();
  }

  /**
   * Write concise Campaign Report Markdown (<= 200 sample failed URLs, REQ-OUT-02).
   */
  async writeCampaignReport(campaign) {
    const searchTasks = (await getAllRecords(STORES.searchTasks)).filter((t) => t.campaignId === campaign.campaignId);
    const fetchRows = (await getAllRecords(STORES.fetchQueue)).filter((f) => f.campaignId === campaign.campaignId);

    const countsByEngine = {
      google: { completed: 0, pending: 0, failed: 0, results: 0 },
      bing: { completed: 0, pending: 0, failed: 0, results: 0 },
      duckduckgo: { completed: 0, pending: 0, failed: 0, results: 0 }
    };
    const targetMap = new Map();
    const errorCountsByClass = {};
    const failedSamples = [];
    const skippedItems = [];
    let offDomainTotal = 0;

    for (const t of searchTasks) {
      const e = countsByEngine[t.engine] || (countsByEngine[t.engine] = { completed: 0, pending: 0, failed: 0, results: 0 });
      if (t.status === "completed") e.completed++;
      else if (t.status.startsWith("failed")) e.failed++;
      else e.pending++;
      e.results += t.resultCount || 0;

      const tm = targetMap.get(t.targetSlug) || { targetSlug: t.targetSlug, searchesDone: 0, fetched: 0, deduped: 0, failed: 0, offDomain: 0 };
      if (t.status === "completed") tm.searchesDone++;
      targetMap.set(t.targetSlug, tm);
    }

    for (const f of fetchRows) {
      const tm = targetMap.get(f.targetSlug) || { targetSlug: f.targetSlug, searchesDone: 0, fetched: 0, deduped: 0, failed: 0, offDomain: 0 };
      if (f.offDomain) {
        offDomainTotal++;
        tm.offDomain++;
      }
      if (f.status === "completed") tm.fetched++;
      else if (f.status === "completed_dedup") tm.deduped++;
      else if (f.status.startsWith("failed") || f.status.startsWith("skipped")) {
        tm.failed++;
        const cls = f.errorClass || f.status;
        errorCountsByClass[cls] = (errorCountsByClass[cls] || 0) + 1;
        failedSamples.push({ url: f.rawUrl, status: f.status, errorClass: cls, reason: f.lastError || "" });
        if (f.status.startsWith("skipped")) {
          skippedItems.push({
            targetSlug: f.targetSlug,
            engine: f.engine,
            searchSlug: f.searchSlug,
            status: f.status,
            errorClass: cls,
            title: f.serpTitle || "",
            url: f.rawUrl,
            observedContentLengthBytes: f.observedContentLengthBytes ?? null,
            reason: f.lastError || ""
          });
        }
      }
      targetMap.set(f.targetSlug, tm);
    }

    const completedAtUtc = new Date().toISOString();
    const reportMd = buildCampaignReportMarkdown({
      campaign,
      startedAtUtc: campaign.createdAtUtc,
      completedAtUtc,
      countsByEngine,
      countsByTarget: Array.from(targetMap.values()),
      errorCountsByClass,
      challengesEncountered: 0,
      offDomainTotal,
      sampleFailedUrls: failedSamples,
      totalFailedUrls: failedSamples.length
    });

    const prefix = getLocalDateTimePrefix(new Date());
    const filename = `${campaign.outputRoot}/_reports/${prefix}-serpyderpy-report.md`;
    await downloadTextVerified({
      content: reportMd,
      filename,
      mimeType: "text/markdown;charset=utf-8",
      isCampaign: true,
      eraseFromHistory: campaign.config?.eraseDownloadHistory !== false
    });

    const skippedMd = buildSkippedFilesReportMarkdown({
      campaign,
      generatedAtUtc: completedAtUtc,
      skippedItems
    });
    const skippedFilename = `${campaign.outputRoot}/_reports/${prefix}-serpyderpy-skipped-files.md`;
    await downloadTextVerified({
      content: skippedMd,
      filename: skippedFilename,
      mimeType: "text/markdown;charset=utf-8",
      isCampaign: true,
      eraseFromHistory: campaign.config?.eraseDownloadHistory !== false
    });
    return filename;
  }

  /**
   * Stream _exports/campaign-summary.json, _exports/search-tasks.jsonl, _exports/url-ledger.jsonl (REQ-OPS-08).
   */
  async exportCampaignBundle(campaign) {
    const eraseFromHistory = campaign.config?.eraseDownloadHistory !== false;
    const searchTasks = (await getAllRecords(STORES.searchTasks)).filter((t) => t.campaignId === campaign.campaignId);
    const fetchRows = (await getAllRecords(STORES.fetchQueue)).filter((f) => f.campaignId === campaign.campaignId);
    const ledgerRows = await getAllByIndex(STORES.urlLedger, "byCampaign", campaign.campaignId);
    const ledgerByHash = new Map(ledgerRows.map((l) => [l.canonicalUrlHash, l]));

    const searchChunks = [];
    const searchTasksByStatus = {};
    for (const st of searchTasks) {
      searchTasksByStatus[st.status] = (searchTasksByStatus[st.status] || 0) + 1;
      searchChunks.push(JSON.stringify(formatSearchTaskExportRow(st)) + "\n");
    }

    const urlChunks = [];
    const fetchTasksByStatus = {};
    let offDomainResults = 0;
    for (const fq of fetchRows) {
      fetchTasksByStatus[fq.status] = (fetchTasksByStatus[fq.status] || 0) + 1;
      if (fq.offDomain) offDomainResults++;
      urlChunks.push(JSON.stringify(formatUrlLedgerExportRow(fq, ledgerByHash.get(fq.canonicalUrlHash))) + "\n");
    }

    await downloadChunkedTextVerified({
      chunks: searchChunks,
      filename: `${campaign.outputRoot}/_exports/search-tasks.jsonl`,
      isCampaign: true,
      eraseFromHistory
    });

    await downloadChunkedTextVerified({
      chunks: urlChunks,
      filename: `${campaign.outputRoot}/_exports/url-ledger.jsonl`,
      isCampaign: true,
      eraseFromHistory
    });

    const summary = buildCampaignSummaryJson({
      campaign,
      counts: {
        targets: (campaign.targets || []).length,
        searchTasksByStatus,
        fetchTasksByStatus,
        offDomainResults,
        challengesEncountered: 0
      }
    });

    await downloadTextVerified({
      content: JSON.stringify(summary, null, 2),
      filename: `${campaign.outputRoot}/_exports/campaign-summary.json`,
      mimeType: "application/json;charset=utf-8",
      isCampaign: true,
      eraseFromHistory
    });

    return {
      summary: `${campaign.outputRoot}/_exports/campaign-summary.json`,
      searchTasks: `${campaign.outputRoot}/_exports/search-tasks.jsonl`,
      urlLedger: `${campaign.outputRoot}/_exports/url-ledger.jsonl`
    };
  }

  async handleAlarm(alarm) {
    if (!alarm || !alarm.name) return;
    if (alarm.name === ALARM_DELTA_CHECKPOINT) {
      await this.flushDeltaCheckpoint().catch(() => {});
    } else if (alarm.name === ALARM_LOG_FLUSH) {
      await this.flushLogSegment().catch(() => {});
    } else if (alarm.name === ALARM_AUTO_RESUME && this.activeCampaignId && !this.isRunning) {
      await this.startCampaign(this.activeCampaignId);
    }
  }
}
