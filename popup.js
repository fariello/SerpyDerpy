/**
 * SerpyDerpy v2 Popup Script (Interactive Mode + Campaign Status Launcher)
 * Strictly uses textContent for all untrusted text (REQ-UI-04).
 */

import * as googleAdapter from "./engines/google.js";
import * as bingAdapter from "./engines/bing.js";
import * as ddgAdapter from "./engines/duckduckgo.js";

const versionBadge = document.getElementById("versionBadge");
const openDashboardBtn = document.getElementById("openDashboardBtn");
const campaignCard = document.getElementById("campaignCard");
const campaignStatusPill = document.getElementById("campaignStatusPill");
const campaignSummaryText = document.getElementById("campaignSummaryText");
const campaignToggleBtn = document.getElementById("campaignToggleBtn");
const campaignOpenBtn = document.getElementById("campaignOpenBtn");

const subfolderInput = document.getElementById("subfolderInput");
const folderPreview = document.getElementById("folderPreview");
const pageCountSelect = document.getElementById("pageCountSelect");
const customPagesInput = document.getElementById("customPagesInput");
const noPersonalizationCheckbox = document.getElementById("noPersonalizationCheckbox");
const decoyBrowsingCheckbox = document.getElementById("decoyBrowsingCheckbox");
const saveHtmlCheckbox = document.getElementById("saveHtmlCheckbox");
const fetchLinksCheckbox = document.getElementById("fetchLinksCheckbox");
const reuseTabCheckbox = document.getElementById("reuseTabCheckbox");
const recordIpCheckbox = document.getElementById("recordIpCheckbox");

const tabHint = document.getElementById("tabHint");
const extractSingleBtn = document.getElementById("extractSingleBtn");
const crawlFromTabBtn = document.getElementById("crawlFromTabBtn");
const engineSelect = document.getElementById("engineSelect");
const queryInput = document.getElementById("queryInput");
const searchBtn = document.getElementById("searchBtn");

const statusArea = document.getElementById("statusArea");
const statusMsg = document.getElementById("statusMsg");
const fileInfo = document.getElementById("fileInfo");
const stopCrawlBtn = document.getElementById("stopCrawlBtn");
const copyUrlsBtn = document.getElementById("copyUrlsBtn");
const urlsPreview = document.getElementById("urlsPreview");

let activeTabId = null;
let activeEngine = null;
let currentCleanUrls = [];
let latestCampaignSnapshot = null;

try {
  const manifest = chrome.runtime.getManifest();
  if (versionBadge && manifest.version) {
    versionBadge.textContent = `v${manifest.version}`;
  }
} catch (_) {}

function getSelectedPageCount() {
  if (pageCountSelect.value === "custom") {
    const n = parseInt(customPagesInput.value, 10);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 3;
  }
  return parseInt(pageCountSelect.value, 10) || 3;
}

function updateLabels() {
  const pgs = getSelectedPageCount();
  crawlFromTabBtn.textContent = `Save & Crawl (${pgs} pgs)`;
  searchBtn.textContent = `Search & Crawl (${pgs} pgs)`;
  folderPreview.textContent = `Downloads/${subfolderInput.value.trim() || "SerpyDerpy/Interactive"}/`;
}

function savePrefs() {
  chrome.storage.local.set({
    sdSubfolder: subfolderInput.value.trim() || "SerpyDerpy/Interactive",
    sdPagePreset: pageCountSelect.value,
    sdCustomPages: customPagesInput.value,
    sdNoPersonalization: noPersonalizationCheckbox.checked,
    sdDecoyBrowsing: decoyBrowsingCheckbox.checked,
    sdSaveHtml: saveHtmlCheckbox.checked,
    sdFetchLinks: fetchLinksCheckbox.checked,
    sdReuseTab: reuseTabCheckbox.checked,
    sdRecordIp: recordIpCheckbox.checked,
    sdEngine: engineSelect.value
  });
}

chrome.storage.local.get(
  [
    "sdSubfolder",
    "sdPagePreset",
    "sdCustomPages",
    "sdNoPersonalization",
    "sdDecoyBrowsing",
    "sdSaveHtml",
    "sdFetchLinks",
    "sdReuseTab",
    "sdRecordIp",
    "sdEngine"
  ],
  (res) => {
    if (res.sdSubfolder) subfolderInput.value = res.sdSubfolder;
    if (res.sdPagePreset) pageCountSelect.value = res.sdPagePreset;
    if (res.sdCustomPages) customPagesInput.value = res.sdCustomPages;
    customPagesInput.disabled = pageCountSelect.value !== "custom";
    if (res.sdNoPersonalization !== undefined) noPersonalizationCheckbox.checked = Boolean(res.sdNoPersonalization);
    if (res.sdDecoyBrowsing !== undefined) decoyBrowsingCheckbox.checked = Boolean(res.sdDecoyBrowsing);
    if (res.sdSaveHtml !== undefined) saveHtmlCheckbox.checked = Boolean(res.sdSaveHtml);
    if (res.sdFetchLinks !== undefined) fetchLinksCheckbox.checked = Boolean(res.sdFetchLinks);
    if (res.sdReuseTab !== undefined) reuseTabCheckbox.checked = Boolean(res.sdReuseTab);
    if (res.sdRecordIp !== undefined) recordIpCheckbox.checked = Boolean(res.sdRecordIp);
    if (res.sdEngine) engineSelect.value = res.sdEngine;
    updateLabels();
  }
);

subfolderInput.addEventListener("input", () => { updateLabels(); savePrefs(); });
pageCountSelect.addEventListener("change", () => {
  customPagesInput.disabled = pageCountSelect.value !== "custom";
  updateLabels();
  savePrefs();
});
customPagesInput.addEventListener("input", () => { updateLabels(); savePrefs(); });
[
  noPersonalizationCheckbox,
  decoyBrowsingCheckbox,
  saveHtmlCheckbox,
  fetchLinksCheckbox,
  reuseTabCheckbox,
  recordIpCheckbox,
  engineSelect
].forEach((el) => el.addEventListener("change", savePrefs));

function openDashboard() {
  chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
}
openDashboardBtn.addEventListener("click", openDashboard);
campaignOpenBtn.addEventListener("click", openDashboard);

// Inspect Active Tab across Google, Bing, and DuckDuckGo (REQ-INT-01 #1)
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs || tabs.length === 0) return;
  const tab = tabs[0];
  activeTabId = tab.id;

  const adapters = [
    ["google", googleAdapter],
    ["bing", bingAdapter],
    ["duckduckgo", ddgAdapter]
  ];
  for (const [eng, adapter] of adapters) {
    if (adapter.isEngineSearchUrl(tab.url)) {
      activeEngine = eng;
      const parsed = adapter.parseActiveTabQuery(tab.url);
      extractSingleBtn.disabled = false;
      crawlFromTabBtn.disabled = false;
      tabHint.textContent = parsed.query
        ? `Active ${eng} tab: "${parsed.query}" (Page ${parsed.pageNumber})`
        : `Active ${eng} search tab (Page ${parsed.pageNumber})`;
      return;
    }
  }
  extractSingleBtn.disabled = true;
  crawlFromTabBtn.disabled = true;
  tabHint.textContent = "Active tab is not a Google, Bing, or DuckDuckGo search page.";
});

function setBusy(isBusy) {
  extractSingleBtn.disabled = isBusy || !activeEngine;
  crawlFromTabBtn.disabled = isBusy || !activeEngine;
  searchBtn.disabled = isBusy;
  stopCrawlBtn.style.display = isBusy ? "block" : "none";
}

function renderInteractiveState(state) {
  if (!state) return;
  if (state.isRunning) {
    setBusy(true);
    statusArea.classList.add("visible");
    statusMsg.className = state.isChallenge ? "status-msg warning" : "status-msg";
    statusMsg.textContent = state.statusText || "Crawling...";
    fileInfo.textContent = state.query ? `${state.engine}: "${state.query}"` : "";
  } else if (state.savedSummary) {
    setBusy(false);
    statusArea.classList.add("visible");
    statusMsg.className = "status-msg success";
    statusMsg.textContent = state.statusText || "Saved.";
    fileInfo.textContent = state.savedSummary;
    currentCleanUrls = Array.isArray(state.cleanUrls) ? state.cleanUrls : [];
    if (currentCleanUrls.length > 0) {
      copyUrlsBtn.style.display = "block";
      copyUrlsBtn.textContent = `Copy ${currentCleanUrls.length} Clean URLs`;
      urlsPreview.style.display = "block";
      urlsPreview.value = currentCleanUrls.join("\n");
    }
  } else if (state.error) {
    setBusy(false);
    statusArea.classList.add("visible");
    statusMsg.className = "status-msg error";
    statusMsg.textContent = `Error: ${state.error}`;
    fileInfo.textContent = "";
  }
}

function renderCampaignCard(snapshot) {
  latestCampaignSnapshot = snapshot;
  if (!snapshot || !snapshot.activeCampaignId) {
    campaignCard.style.display = "none";
    return;
  }
  campaignCard.style.display = "block";
  const chalCount = (snapshot.challenges || []).length;
  campaignStatusPill.textContent = chalCount > 0 ? `CAP! (${chalCount})` : snapshot.isRunning ? "RUNNING" : "PAUSED";
  campaignStatusPill.className = chalCount > 0 ? "pill warning" : snapshot.isRunning ? "pill running" : "pill";
  campaignSummaryText.textContent =
    `Campaign ${snapshot.activeCampaignId} · Pending fetches: ${snapshot.fetchers?.pendingCount ?? 0}` +
    (chalCount > 0 ? ` · ${chalCount} tab(s) need human click` : "");
  campaignToggleBtn.textContent = snapshot.isRunning ? "Pause Campaign" : "Resume Campaign";
}

campaignToggleBtn.addEventListener("click", () => {
  if (!latestCampaignSnapshot?.activeCampaignId) return;
  if (latestCampaignSnapshot.isRunning) {
    chrome.runtime.sendMessage({ type: "CAMPAIGN_PAUSE" });
  } else {
    chrome.runtime.sendMessage({ type: "CAMPAIGN_START", campaignId: latestCampaignSnapshot.activeCampaignId });
  }
});

chrome.runtime.sendMessage({ type: "GET_INTERACTIVE_STATE" }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.interactive?.isRunning) renderInteractiveState(res.interactive);
  if (res.campaign) renderCampaignCard(res.campaign);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "INTERACTIVE_STATE_UPDATE") renderInteractiveState(msg.state);
  if (msg?.type === "CAMPAIGN_LIVE_UPDATE") renderCampaignCard(msg.snapshot);
});

function buildCommonOptions() {
  return {
    subfolder: subfolderInput.value.trim() || "SerpyDerpy/Interactive",
    saveHtml: saveHtmlCheckbox.checked,
    noPersonalization: noPersonalizationCheckbox.checked,
    decoyBrowsing: decoyBrowsingCheckbox.checked,
    fetchLinks: fetchLinksCheckbox.checked,
    recordPublicIp: recordIpCheckbox.checked
  };
}

extractSingleBtn.addEventListener("click", () => {
  if (!activeTabId) return;
  setBusy(true);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg";
  statusMsg.textContent = "Extracting current page...";
  chrome.runtime.sendMessage(
    { type: "INTERACTIVE_SAVE_TAB", tabId: activeTabId, pagesToExtract: 1, ...buildCommonOptions() },
    (res) => {
      if (!res?.ok) renderInteractiveState({ isRunning: false, error: res?.error || "Failed" });
    }
  );
});

crawlFromTabBtn.addEventListener("click", () => {
  if (!activeTabId) return;
  setBusy(true);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg";
  statusMsg.textContent = "Starting crawl from active tab...";
  chrome.runtime.sendMessage(
    {
      type: "INTERACTIVE_SAVE_TAB",
      tabId: activeTabId,
      pagesToExtract: getSelectedPageCount(),
      ...buildCommonOptions()
    },
    (res) => {
      if (!res?.ok) renderInteractiveState({ isRunning: false, error: res?.error || "Failed" });
    }
  );
});

searchBtn.addEventListener("click", () => {
  const query = queryInput.value.trim();
  if (!query) {
    renderInteractiveState({ isRunning: false, error: "Please enter a search query." });
    return;
  }
  setBusy(true);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg";
  statusMsg.textContent = `Launching ${engineSelect.value} search...`;
  chrome.runtime.sendMessage(
    {
      type: "INTERACTIVE_DIRECT_SEARCH",
      engine: engineSelect.value,
      query,
      pagesToExtract: getSelectedPageCount(),
      reuseTab: reuseTabCheckbox.checked,
      ...buildCommonOptions()
    },
    (res) => {
      if (!res?.ok) renderInteractiveState({ isRunning: false, error: res?.error || "Failed" });
    }
  );
});

queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchBtn.click();
});

stopCrawlBtn.addEventListener("click", () => {
  stopCrawlBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "STOP_INTERACTIVE" });
});

copyUrlsBtn.addEventListener("click", () => {
  if (currentCleanUrls.length === 0) return;
  navigator.clipboard.writeText(currentCleanUrls.join("\n")).then(() => {
    const orig = copyUrlsBtn.textContent;
    copyUrlsBtn.textContent = `Copied ${currentCleanUrls.length} URLs`;
    setTimeout(() => { copyUrlsBtn.textContent = orig; }, 2000);
  });
});
