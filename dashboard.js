/**
 * SerpyDerpy v2 — Campaign Dashboard Controller
 * Implements REQ-UI-02, REQ-UI-03, and REQ-UI-04 (strict textContent / safe DOM rendering only;
 * clickable links strictly limited to http: and https:).
 */

import {
  parseRosterText,
  parseRosterCsv,
  parseRosterJson,
  parseSearchesText,
  parseSearchesCsv,
  parseSearchesJson,
  parseCampaignJson,
  validateCampaignInputs,
  estimateCampaignScope
} from "./inputs.js";
import { computeSegmentCaps } from "./naming.js";
import { DEFAULT_PACING } from "./pacing.js";

const versionBadge = document.getElementById("versionBadge");
const campaignSelect = document.getElementById("campaignSelect");
const refreshBtn = document.getElementById("refreshBtn");
const challengeBanner = document.getElementById("challengeBanner");
const challengeList = document.getElementById("challengeList");

let loadedTargets = [];
let loadedSearches = [];
let loadedRosterVersion = null;
let loadedQueryListVersion = null;
let loadedImportedConfig = {};
let currentCampaignId = null;
let currentCampaigns = [];

try {
  const m = chrome.runtime.getManifest();
  if (m?.version) versionBadge.textContent = `v${m.version}`;
} catch (_) {}

// --- Safe DOM helpers (REQ-UI-04) ---
function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function createSafeLink(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const a = document.createElement("a");
      a.href = parsed.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.color = "#38bdf8";
      a.textContent = label || parsed.href;
      return a;
    }
  } catch (_) {}
  const span = document.createElement("span");
  span.textContent = label || String(url || "");
  return span;
}

// --- Tab Switching ---
for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab-btn")) b.classList.remove("active");
    for (const p of document.querySelectorAll(".panel")) p.classList.remove("active");
    btn.classList.add("active");
    const target = document.getElementById(`tab-${btn.dataset.tab}`);
    if (target) target.classList.add("active");
    if (btn.dataset.tab === "history") loadHistoryTable();
    if (btn.dataset.tab === "live") refreshOverview();
  });
}

function getSelectedEngines() {
  const out = [];
  if (document.getElementById("engGoogle").checked) out.push("google");
  if (document.getElementById("engBing").checked) out.push("bing");
  if (document.getElementById("engDdg").checked) out.push("duckduckgo");
  return out.length > 0 ? out : ["google", "bing", "duckduckgo"];
}

function buildConfigFromForm() {
  const engines = getSelectedEngines();
  const base = loadedImportedConfig && typeof loadedImportedConfig === "object" ? loadedImportedConfig : {};
  const basePacing = base.pacing && typeof base.pacing === "object" ? base.pacing : {};
  return {
    ...base,
    rollingTargetWindow: parseInt(document.getElementById("rollingWindowInput").value, 10) || 4,
    fetchConcurrency: parseInt(document.getElementById("fetchConcurrencyInput").value, 10) || 3,
    maxFileSizeMb: parseInt(document.getElementById("maxFileSizeMbInput").value, 10) || 250,
    backpressureHigh: parseInt(document.getElementById("bpHighInput").value, 10) ?? 50,
    backpressureLow: parseInt(document.getElementById("bpLowInput").value, 10) ?? 20,
    dedupPolicy: document.getElementById("dedupPolicySelect").value || "skip-and-stub",
    freshnessDays: parseInt(document.getElementById("freshnessDaysInput").value, 10) ?? 30,
    globalDedup: document.getElementById("globalDedupCheckbox").checked,
    challengePauseScope: document.getElementById("challengeScopeSelect").value || "pause-affected-only",
    onBrowserRestart: document.getElementById("restartBehaviorSelect").value || "prompt",
    useManagedWindow: document.getElementById("managedWindowCheckbox").checked,
    keepAwake: document.getElementById("keepAwakeCheckbox").checked,
    eraseDownloadHistory: document.getElementById("eraseHistoryCheckbox").checked,
    saveSerpHtml: document.getElementById("saveSerpHtmlCheckbox").checked,
    noPersonalization: document.getElementById("noPersonalizationCheckbox").checked,
    ddgHtmlMode: document.getElementById("ddgHtmlModeCheckbox").checked,
    plainLinks: document.getElementById("plainLinksCheckbox").checked,
    recordPublicIp: document.getElementById("recordPublicIpCheckbox").checked,
    engines,
    pacing: {
      ...DEFAULT_PACING,
      ...basePacing,
      serpPageDelay: {
        min: parseFloat(document.getElementById("serpMin").value),
        max: parseFloat(document.getElementById("serpMax").value),
        mean: parseFloat(document.getElementById("serpMean").value)
      },
      interQueryDelay: {
        min: parseFloat(document.getElementById("iqMin").value),
        max: parseFloat(document.getElementById("iqMax").value),
        mean: parseFloat(document.getElementById("iqMean").value)
      },
      sameHostFetchDelay: {
        min: parseFloat(document.getElementById("shMin").value),
        max: parseFloat(document.getElementById("shMax").value),
        mean: parseFloat(document.getElementById("shMean").value)
      }
    }
  };
}

async function parseInputsFromUiIfNeeded() {
  const outputRoot = document.getElementById("outputRootInput").value.trim();
  const caps = computeSegmentCaps(outputRoot);
  const defaultPages = parseInt(document.getElementById("defaultPagesInput").value, 10) || 3;
  const engines = getSelectedEngines();

  const rosterText = document.getElementById("rosterTextarea").value.trim();
  const searchesText = document.getElementById("searchesTextarea").value.trim();

  const parseErrors = [];
  if (rosterText) {
    const r = await parseRosterText(rosterText, caps.targetCap);
    loadedTargets = r.targets;
    parseErrors.push(...r.errors);
    document.getElementById("rosterStatusHint").textContent = `${loadedTargets.length} target(s) parsed from text.`;
  }
  if (searchesText) {
    const s = await parseSearchesText(searchesText, {
      campaignDefaultPages: defaultPages,
      searchCap: caps.searchCap,
      defaultEngines: engines
    });
    loadedSearches = s.searches;
    parseErrors.push(...s.errors);
    document.getElementById("searchesStatusHint").textContent = `${loadedSearches.length} search(es) parsed from text.`;
  }
  return parseErrors;
}

function renderValidation(errors = [], warnings = []) {
  const box = document.getElementById("validationFeedback");
  clearEl(box);
  if (errors.length > 0) {
    const div = document.createElement("div");
    div.className = "alert danger";
    const strong = document.createElement("strong");
    strong.textContent = `Validation Errors (${errors.length}):`;
    div.appendChild(strong);
    const ul = document.createElement("ul");
    for (const e of errors.slice(0, 25)) {
      const li = document.createElement("li");
      li.textContent = e;
      ul.appendChild(li);
    }
    div.appendChild(ul);
    box.appendChild(div);
  }
  if (warnings.length > 0) {
    const div = document.createElement("div");
    div.className = "alert warning";
    const strong = document.createElement("strong");
    strong.textContent = `Warnings (${warnings.length}):`;
    div.appendChild(strong);
    const ul = document.createElement("ul");
    for (const w of warnings.slice(0, 25)) {
      const li = document.createElement("li");
      li.textContent = w;
      ul.appendChild(li);
    }
    div.appendChild(ul);
    box.appendChild(div);
  }
}

async function runValidateAndEstimate() {
  const parseErrors = await parseInputsFromUiIfNeeded();
  const outputRoot = document.getElementById("outputRootInput").value.trim();
  const cfg = buildConfigFromForm();
  const missingPlaceholderMode = document.getElementById("missingPlaceholderSelect").value;

  const val = validateCampaignInputs({
    targets: loadedTargets,
    searches: loadedSearches,
    outputRoot,
    pacing: cfg.pacing,
    missingPlaceholderMode
  });

  const allErrors = [...parseErrors, ...val.errors];
  renderValidation(allErrors, val.warnings);

  const est = estimateCampaignScope({
    targets: loadedTargets,
    searches: loadedSearches,
    campaignId: currentCampaignId || "new",
    pacing: cfg.pacing,
    missingPlaceholderMode: missingPlaceholderMode === "error" ? "skip" : missingPlaceholderMode
  });

  document.getElementById("estTargets").textContent = String(est.targets);
  document.getElementById("estSearches").textContent = String(est.searches);
  document.getElementById("estTasks").textContent = String(est.remainingTasks);
  const lowMin = Math.round(est.estimatedWallClockSecRange[0] / 60);
  const highMin = Math.round(est.estimatedWallClockSecRange[1] / 60);
  document.getElementById("estTime").textContent =
    highMin >= 120 ? `${(lowMin / 60).toFixed(1)}-${(highMin / 60).toFixed(1)}h` : `${lowMin}-${highMin}m`;

  return { ok: allErrors.length === 0 && val.ok, cfg, outputRoot, missingPlaceholderMode };
}

// File Loaders
document.getElementById("rosterFileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const caps = computeSegmentCaps(document.getElementById("outputRootInput").value.trim());
  document.getElementById("rosterTextarea").value = "";
  let res;
  if (file.name.toLowerCase().endsWith(".json")) {
    res = await parseRosterJson(text, caps.targetCap);
  } else if (file.name.toLowerCase().endsWith(".csv")) {
    res = await parseRosterCsv(text, caps.targetCap);
  } else {
    res = await parseRosterText(text, caps.targetCap);
  }
  loadedTargets = res.targets;
  loadedRosterVersion = res.rosterVersion;
  document.getElementById("rosterStatusHint").textContent =
    `Loaded ${loadedTargets.length} target(s) from ${file.name}` + (res.errors.length ? ` (${res.errors.length} error(s))` : "");
  renderValidation(res.errors, []);
  await runValidateAndEstimate();
});

document.getElementById("searchesFileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const caps = computeSegmentCaps(document.getElementById("outputRootInput").value.trim());
  const defaultPages = parseInt(document.getElementById("defaultPagesInput").value, 10) || 3;
  const engines = getSelectedEngines();
  document.getElementById("searchesTextarea").value = "";
  let res;
  if (file.name.toLowerCase().endsWith(".json")) {
    res = await parseSearchesJson(text, { campaignDefaultPages: defaultPages, searchCap: caps.searchCap, defaultEngines: engines });
  } else if (file.name.toLowerCase().endsWith(".csv")) {
    res = await parseSearchesCsv(text, { campaignDefaultPages: defaultPages, searchCap: caps.searchCap, defaultEngines: engines });
  } else {
    res = await parseSearchesText(text, { campaignDefaultPages: defaultPages, searchCap: caps.searchCap, defaultEngines: engines });
  }
  loadedSearches = res.searches;
  loadedQueryListVersion = res.queryListVersion;
  document.getElementById("searchesStatusHint").textContent =
    `Loaded ${loadedSearches.length} search(es) from ${file.name}` + (res.errors.length ? ` (${res.errors.length} error(s))` : "");
  renderValidation(res.errors, []);
  await runValidateAndEstimate();
});

function applyConfigToForm(cfg = {}) {
  if (!cfg || typeof cfg !== "object") return;
  const setVal = (id, v) => {
    if (v !== undefined && v !== null) document.getElementById(id).value = String(v);
  };
  const setChk = (id, v) => {
    if (v !== undefined && v !== null) document.getElementById(id).checked = Boolean(v);
  };

  setVal("rollingWindowInput", cfg.rollingTargetWindow);
  setVal("fetchConcurrencyInput", cfg.fetchConcurrency);
  setVal("maxFileSizeMbInput", cfg.maxFileSizeMb);
  setVal("bpHighInput", cfg.backpressureHigh);
  setVal("bpLowInput", cfg.backpressureLow);
  setVal("dedupPolicySelect", cfg.dedupPolicy);
  setVal("freshnessDaysInput", cfg.freshnessDays);
  setVal("challengeScopeSelect", cfg.challengePauseScope);
  setVal("restartBehaviorSelect", cfg.onBrowserRestart);

  setChk("globalDedupCheckbox", cfg.globalDedup);
  setChk("managedWindowCheckbox", cfg.useManagedWindow);
  setChk("keepAwakeCheckbox", cfg.keepAwake);
  setChk("eraseHistoryCheckbox", cfg.eraseDownloadHistory);
  setChk("saveSerpHtmlCheckbox", cfg.saveSerpHtml);
  setChk("noPersonalizationCheckbox", cfg.noPersonalization);
  setChk("ddgHtmlModeCheckbox", cfg.ddgHtmlMode);
  setChk("plainLinksCheckbox", cfg.plainLinks);
  setChk("recordPublicIpCheckbox", cfg.recordPublicIp);

  if (Array.isArray(cfg.engines) && cfg.engines.length > 0) {
    const set = new Set(cfg.engines.map((e) => String(e).toLowerCase()));
    setChk("engGoogle", set.has("google"));
    setChk("engBing", set.has("bing"));
    setChk("engDdg", set.has("duckduckgo"));
  }

  if (cfg.pacing) {
    setVal("serpMin", cfg.pacing.serpPageDelay?.min);
    setVal("serpMax", cfg.pacing.serpPageDelay?.max);
    setVal("serpMean", cfg.pacing.serpPageDelay?.mean);
    setVal("iqMin", cfg.pacing.interQueryDelay?.min);
    setVal("iqMax", cfg.pacing.interQueryDelay?.max);
    setVal("iqMean", cfg.pacing.interQueryDelay?.mean);
    setVal("shMin", cfg.pacing.sameHostFetchDelay?.min);
    setVal("shMax", cfg.pacing.sameHostFetchDelay?.max);
    setVal("shMean", cfg.pacing.sameHostFetchDelay?.mean);
  }
}

document.getElementById("campaignBundleFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const res = await parseCampaignJson(text);
  if (!res.ok) {
    renderValidation(res.errors, []);
    return;
  }
  document.getElementById("campaignNameInput").value = res.campaign.name;
  document.getElementById("outputRootInput").value = res.campaign.outputRoot;
  document.getElementById("defaultPagesInput").value = res.campaign.defaultPages;
  loadedImportedConfig = res.campaign.config && typeof res.campaign.config === "object" ? { ...res.campaign.config } : {};
  applyConfigToForm(loadedImportedConfig);
  document.getElementById("rosterTextarea").value = "";
  document.getElementById("searchesTextarea").value = "";
  loadedTargets = res.campaign.targets;
  loadedSearches = res.campaign.searches;
  loadedRosterVersion = res.campaign.rosterVersion;
  loadedQueryListVersion = res.campaign.queryListVersion;
  document.getElementById("rosterStatusHint").textContent = `Loaded ${loadedTargets.length} target(s) from ${file.name}`;
  document.getElementById("searchesStatusHint").textContent = `Loaded ${loadedSearches.length} search(es) from ${file.name}`;
  await runValidateAndEstimate();
});

document.getElementById("validateBtn").addEventListener("click", runValidateAndEstimate);

async function saveCampaign(autoStart = false) {
  const check = await runValidateAndEstimate();
  if (!check.ok) return;

  const saveBtn = document.getElementById("saveCampaignBtn");
  const startBtn = document.getElementById("saveAndStartBtn");
  const origSave = saveBtn.textContent;
  const origStart = startBtn.textContent;
  saveBtn.disabled = true;
  startBtn.disabled = true;
  saveBtn.textContent = "Saving campaign to IndexedDB...";
  startBtn.textContent = "Saving...";

  const payload = {
    campaignId: currentCampaignId || undefined,
    name: document.getElementById("campaignNameInput").value.trim() || "Domain Research Campaign",
    outputRoot: check.outputRoot,
    rosterVersion: loadedRosterVersion,
    queryListVersion: loadedQueryListVersion,
    targets: loadedTargets,
    searches: loadedSearches,
    config: check.cfg,
    missingPlaceholderMode: check.missingPlaceholderMode
  };

  chrome.runtime.sendMessage({ type: "CAMPAIGN_SAVE", payload }, (res) => {
    saveBtn.disabled = false;
    startBtn.disabled = false;
    saveBtn.textContent = origSave;
    startBtn.textContent = origStart;
    if (!res?.ok) {
      renderValidation([res?.error || "Failed to save campaign."], []);
      return;
    }
    currentCampaignId = res.campaign.campaignId;
    if (res.summary?.slugConflicts?.length) {
      renderValidation([], [`${res.summary.slugConflicts.length} search slug conflict(s) skipped.`]);
    }
    if (autoStart) {
      chrome.runtime.sendMessage({ type: "CAMPAIGN_START", campaignId: currentCampaignId }, () => {
        document.querySelector('.tab-btn[data-tab="live"]').click();
        refreshOverview();
      });
    } else {
      refreshOverview();
    }
  });
}

document.getElementById("saveCampaignBtn").addEventListener("click", () => saveCampaign(false));
document.getElementById("saveAndStartBtn").addEventListener("click", () => saveCampaign(true));

// --- Live Operations ---
function renderChallenges(challenges = []) {
  clearEl(challengeList);
  if (!challenges || challenges.length === 0) {
    challengeBanner.style.display = "none";
    return;
  }
  challengeBanner.style.display = "block";
  for (const ch of challenges) {
    const row = document.createElement("div");
    row.className = "btn-row";
    row.style.marginBottom = "6px";

    const desc = document.createElement("span");
    desc.textContent = `[${ch.kind === "engine" ? ch.engine : ch.host}] ${ch.provider} — ${ch.url}`;
    desc.style.flex = "1";
    desc.className = "mono";
    row.appendChild(desc);

    const focusBtn = document.createElement("button");
    focusBtn.className = "btn btn-primary";
    focusBtn.textContent = "Focus Tab";
    focusBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CAMPAIGN_FOCUS_TAB", tabId: ch.tabId });
    });
    row.appendChild(focusBtn);

    const skipBtn = document.createElement("button");
    skipBtn.className = "btn btn-danger";
    skipBtn.textContent = "Skip / Mark Blocked";
    skipBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CAMPAIGN_SKIP_CHALLENGE", challengeId: ch.id });
    });
    row.appendChild(skipBtn);

    challengeList.appendChild(row);
  }
}

function renderLiveSnapshot(live, stats = null, recentEvents = null, campaignObj = null) {
  if (!live) return;
  renderChallenges(live.challenges || []);

  const stText = campaignObj?.status || (live.isRunning ? "running" : "idle");
  const pill = document.getElementById("liveCampaignStatus");
  pill.textContent = stText.toUpperCase();
  pill.className =
    stText === "running"
      ? "pill running"
      : stText === "completed"
      ? "pill success"
      : stText === "paused_error"
      ? "pill danger"
      : stText.startsWith("paused")
      ? "pill warning"
      : "pill";

  for (const eng of ["google", "bing", "duckduckgo"]) {
    const l = live.lanes?.[eng] || { status: "idle" };
    const statusEl = document.getElementById(`lane-status-${eng}`);
    const detailEl = document.getElementById(`lane-detail-${eng}`);
    statusEl.textContent = String(l.status || "idle").toUpperCase();
    statusEl.className =
      l.status === "paused_challenge" || l.status === "paused_cooldown"
        ? "pill warning"
        : l.status === "done"
        ? "pill success"
        : l.status === "extracting"
        ? "pill running"
        : "pill";

    const parts = [];
    if (l.target) parts.push(`${l.target} / ${l.search}`);
    if (l.page) parts.push(`page ${l.page}/${l.pagesRequested}`);
    if (l.waitSec) parts.push(`wait ${l.waitSec}s`);
    if (l.message) parts.push(l.message);
    detailEl.textContent = parts.join(" · ") || "Idle";
  }

  document.getElementById("livePendingFetch").textContent = String(live.fetchers?.pendingCount ?? 0);
  document.getElementById("liveBackpressure").textContent = live.backpressureActive ? "PAUSED" : "OFF";
  const hosts = live.fetchers?.activeHosts || [];
  document.getElementById("activeHostsText").textContent =
    hosts.length > 0 ? `Active fetch hosts (${hosts.length}): ${hosts.join(", ")}` : "Active fetch hosts: none";

  if (stats) {
    const sDone = stats.searchTasksByStatus?.completed || 0;
    document.getElementById("liveSearchProgress").textContent = `${sDone} / ${stats.totalSearchTasks || 0}`;
    const fDone = stats.fetchTasksByStatus?.completed || 0;
    const fDedup = stats.fetchTasksByStatus?.completed_dedup || 0;
    document.getElementById("liveFetchProgress").textContent = `${fDone} / ${fDedup}`;
  }

  if (Array.isArray(recentEvents)) {
    const box = document.getElementById("eventsLogBox");
    clearEl(box);
    for (const ev of recentEvents) {
      const div = document.createElement("div");
      div.className = `log-line ${ev.level || "info"}`;
      div.textContent = `[${(ev.timestampUtc || "").slice(11, 19)}] [${ev.component || "sys"}] ${ev.message || ""}`;
      box.appendChild(div);
    }
  }
}

function refreshOverview() {
  chrome.runtime.sendMessage({ type: "CAMPAIGN_GET_OVERVIEW", campaignId: currentCampaignId }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    currentCampaigns = res.campaigns || [];
    currentCampaignId = res.activeCampaignId;

    clearEl(campaignSelect);
    const newOpt = document.createElement("option");
    newOpt.value = "";
    newOpt.textContent = "+ New Campaign";
    campaignSelect.appendChild(newOpt);
    for (const c of currentCampaigns) {
      const opt = document.createElement("option");
      opt.value = c.campaignId;
      opt.textContent = `${c.name} (${c.status})`;
      if (c.campaignId === currentCampaignId) opt.selected = true;
      campaignSelect.appendChild(opt);
    }

    const activeObj = currentCampaigns.find((c) => c.campaignId === currentCampaignId) || null;
    renderLiveSnapshot(res.live, res.stats, res.recentEvents, activeObj);
  });
}

campaignSelect.addEventListener("change", () => {
  currentCampaignId = campaignSelect.value || null;
  refreshOverview();
});
refreshBtn.addEventListener("click", refreshOverview);

document.getElementById("startResumeBtn").addEventListener("click", () => {
  if (!currentCampaignId) return;
  chrome.runtime.sendMessage({ type: "CAMPAIGN_START", campaignId: currentCampaignId }, () => refreshOverview());
});
document.getElementById("pauseBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CAMPAIGN_PAUSE" }, () => refreshOverview());
});
document.getElementById("stopBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CAMPAIGN_STOP" }, () => refreshOverview());
});

for (const btn of document.querySelectorAll(".lane-toggle-btn")) {
  btn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CAMPAIGN_TOGGLE_LANE_PAUSE", engine: btn.dataset.engine }, () => refreshOverview());
  });
}

// --- History & Ledger Inspector (strict safe DOM rendering, REQ-UI-04) ---
function loadHistoryTable() {
  if (!currentCampaignId) return;
  const kind = document.getElementById("historyKindSelect").value;
  const status = document.getElementById("historyStatusSelect").value;
  const filterText = document.getElementById("historyFilterInput").value;

  chrome.runtime.sendMessage(
    { type: "CAMPAIGN_LIST_HISTORY", campaignId: currentCampaignId, kind, status, filterText, limit: 250 },
    (res) => {
      if (!res?.ok) return;
      document.getElementById("historyCountHint").textContent =
        `Showing ${res.rows.length} of ${res.total} matching row(s).`;

      const head = document.getElementById("historyTableHead");
      const body = document.getElementById("historyTableBody");
      clearEl(head);
      clearEl(body);

      const cols =
        kind === "searchTasks"
          ? ["Sel", "Target", "Engine", "Search", "Pages", "Status", "Results", "Error"]
          : kind === "fetchQueue"
          ? ["Sel", "Target", "Engine", "Rank", "URL", "Status", "Error"]
          : ["Target/Host", "URL", "Status", "Kind", "HTTP", "SHA-256", "Artifact"];

      const trHead = document.createElement("tr");
      for (const c of cols) {
        const th = document.createElement("th");
        th.textContent = c;
        trHead.appendChild(th);
      }
      head.appendChild(trHead);

      for (const r of res.rows) {
        const tr = document.createElement("tr");
        if (kind === "searchTasks") {
          const tdChk = document.createElement("td");
          const chk = document.createElement("input");
          chk.type = "checkbox";
          chk.className = "row-select-chk";
          chk.dataset.key = r.taskKey;
          tdChk.appendChild(chk);
          tr.appendChild(tdChk);

          for (const val of [
            r.targetSlug,
            r.engine,
            r.searchSlug,
            `${r.pagesCompleted || 0}/${r.pagesRequested || 0}`,
            r.status,
            String(r.resultCount || 0),
            r.lastError || ""
          ]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
        } else if (kind === "fetchQueue") {
          const tdChk = document.createElement("td");
          const chk = document.createElement("input");
          chk.type = "checkbox";
          chk.className = "row-select-chk";
          chk.dataset.key = r.fetchKey;
          tdChk.appendChild(chk);
          tr.appendChild(tdChk);

          for (const val of [r.targetSlug, r.engine, String(r.overallRank)]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          const tdUrl = document.createElement("td");
          tdUrl.className = "mono";
          tdUrl.appendChild(createSafeLink(r.rawUrl, r.rawUrl));
          tr.appendChild(tdUrl);

          for (const val of [r.status, r.lastError || ""]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
        } else {
          const tdHost = document.createElement("td");
          tdHost.textContent = r.host || "";
          tr.appendChild(tdHost);

          const tdUrl = document.createElement("td");
          tdUrl.className = "mono";
          tdUrl.appendChild(createSafeLink(r.canonicalUrl, r.canonicalUrl));
          tr.appendChild(tdUrl);

          for (const val of [
            r.status,
            r.kind || "",
            r.httpStatus != null ? String(r.httpStatus) : "",
            r.contentSha256 ? r.contentSha256.slice(0, 12) : "",
            r.canonicalArtifactRelPath || ""
          ]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
        }
        body.appendChild(tr);
      }
    }
  );
}

document.getElementById("loadHistoryBtn").addEventListener("click", loadHistoryTable);
document.getElementById("retryFailedSearchesBtn").addEventListener("click", () => {
  if (!currentCampaignId) return;
  chrome.runtime.sendMessage({ type: "CAMPAIGN_RETRY_ITEMS", campaignId: currentCampaignId, kind: "searchTasks" }, (res) => {
    document.getElementById("historyCountHint").textContent = `Re-queued ${res?.requeued || 0} retryable search task(s).`;
    loadHistoryTable();
  });
});
document.getElementById("retryFailedUrlsBtn").addEventListener("click", () => {
  if (!currentCampaignId) return;
  chrome.runtime.sendMessage({ type: "CAMPAIGN_RETRY_ITEMS", campaignId: currentCampaignId, kind: "fetchQueue" }, (res) => {
    document.getElementById("historyCountHint").textContent = `Re-queued ${res?.requeued || 0} retryable fetch task(s).`;
    loadHistoryTable();
  });
});
document.getElementById("retrySelectedBtn").addEventListener("click", () => {
  if (!currentCampaignId) return;
  const kind = document.getElementById("historyKindSelect").value;
  if (kind === "urlLedger") return;
  const keys = Array.from(document.querySelectorAll(".row-select-chk:checked")).map((c) => c.dataset.key);
  if (keys.length === 0) return;
  chrome.runtime.sendMessage(
    { type: "CAMPAIGN_RETRY_ITEMS", campaignId: currentCampaignId, kind, manualKeys: keys },
    (res) => {
      document.getElementById("historyCountHint").textContent = `Manually re-queued ${res?.requeued || 0} selected item(s).`;
      loadHistoryTable();
    }
  );
});

// --- Checkpoints & Exports ---
document.getElementById("exportCheckpointBtn").addEventListener("click", () => {
  if (!currentCampaignId) return;
  chrome.runtime.sendMessage({ type: "CAMPAIGN_EXPORT_CHECKPOINT", campaignId: currentCampaignId }, (res) => {
    document.getElementById("checkpointResultText").textContent = res?.ok
      ? `Saved checkpoint: Downloads/${res.filename}`
      : `Error: ${res?.error || "Export failed"}`;
  });
});

document.getElementById("importCheckpointBtn").addEventListener("click", async () => {
  const files = Array.from(document.getElementById("importCheckpointFiles").files || []);
  if (files.length === 0) return;
  const jsonlTexts = [];
  for (const f of files) jsonlTexts.push(await f.text());
  chrome.runtime.sendMessage({ type: "CAMPAIGN_IMPORT_CHECKPOINTS", jsonlTexts }, (res) => {
    document.getElementById("checkpointResultText").textContent = res?.ok
      ? `Imported ${res.importedRecords} record(s) from ${res.filesImported} file(s) for campaign ${res.campaignId}.`
      : `Import rejected: ${res?.error || "Unknown error"}`;
    if (res?.ok) {
      currentCampaignId = res.campaignId;
      refreshOverview();
    }
  });
});

document.getElementById("exportBundleBtn").addEventListener("click", () => {
  if (!currentCampaignId) return;
  chrome.runtime.sendMessage({ type: "CAMPAIGN_EXPORT_BUNDLE", campaignId: currentCampaignId }, (res) => {
    document.getElementById("exportResultText").textContent = res?.ok
      ? `Exported: ${res.files.summary}, ${res.files.searchTasks}, ${res.files.urlLedger}`
      : `Error: ${res?.error || "Export failed"}`;
  });
});

document.getElementById("exportReportBtn").addEventListener("click", () => {
  if (!currentCampaignId) return;
  chrome.runtime.sendMessage({ type: "CAMPAIGN_EXPORT_REPORT", campaignId: currentCampaignId }, (res) => {
    document.getElementById("exportResultText").textContent = res?.ok
      ? `Report saved: Downloads/${res.filename}`
      : `Error: ${res?.error || "Report failed"}`;
  });
});

document.getElementById("exportCampaignJsonBtn").addEventListener("click", () => {
  const active = currentCampaigns.find((c) => c.campaignId === currentCampaignId);
  if (!active) return;
  const bundle = {
    schemaVersion: 2,
    name: active.name,
    outputRoot: active.outputRoot,
    rosterVersion: active.rosterVersion,
    queryListVersion: active.queryListVersion,
    targets: active.targets,
    searches: active.searches,
    config: active.config
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${active.campaignId}-campaign.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "CAMPAIGN_LIVE_UPDATE") {
    renderLiveSnapshot(msg.snapshot);
  }
});

refreshOverview();
setInterval(() => {
  if (document.getElementById("tab-live").classList.contains("active")) {
    refreshOverview();
  }
}, 4000);
