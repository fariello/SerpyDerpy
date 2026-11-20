// SerpyDerpy Popup Script (v1.0.5)

const versionBadge = document.getElementById("versionBadge");
const subfolderInput = document.getElementById("subfolderInput");
const folderPreview = document.getElementById("folderPreview");
const pageCountSelect = document.getElementById("pageCountSelect");
const noPersonalizationCheckbox = document.getElementById("noPersonalizationCheckbox");
const decoyBrowsingCheckbox = document.getElementById("decoyBrowsingCheckbox");
const decoyTypeSelect = document.getElementById("decoyTypeSelect");
const saveJsonCheckbox = document.getElementById("saveJsonCheckbox");
const saveHtmlCheckbox = document.getElementById("saveHtmlCheckbox");
const reuseTabCheckbox = document.getElementById("reuseTabCheckbox");

const tabHint = document.getElementById("tabHint");
const extractSingleBtn = document.getElementById("extractSingleBtn");
const crawlFromTabBtn = document.getElementById("crawlFromTabBtn");

const queryInput = document.getElementById("queryInput");
const searchBtn = document.getElementById("searchBtn");

const statusArea = document.getElementById("statusArea");
const statusMsg = document.getElementById("statusMsg");
const fileInfo = document.getElementById("fileInfo");
const stopCrawlBtn = document.getElementById("stopCrawlBtn");
const copyUrlsBtn = document.getElementById("copyUrlsBtn");
const urlsPreview = document.getElementById("urlsPreview");

let activeTabId = null;
let activeQuery = "";
let activePageNum = 1;
let currentCleanUrls = [];

// 1. Dynamic Version Pill
try {
  const manifest = chrome.runtime.getManifest();
  if (versionBadge && manifest.version) {
    versionBadge.textContent = `v${manifest.version}`;
  }
} catch (_) {}

function isGoogleSearchUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isGoogle =
      host === "google.com" || host.endsWith(".google.com") || host.includes("google.");
    return isGoogle && (u.pathname.startsWith("/search") || u.searchParams.has("q"));
  } catch (_) {
    return false;
  }
}

function updateButtonLabels() {
  const pages = pageCountSelect.value || "1";
  crawlFromTabBtn.textContent = `🚀 Save & Crawl (${pages} pgs)`;
  searchBtn.textContent = `🔍 Search & Crawl (${pages} pgs)`;
  if (activePageNum > 1) {
    extractSingleBtn.textContent = `📄 Save Page ${activePageNum} Only`;
  } else {
    extractSingleBtn.textContent = "📄 Save Current Page Only";
  }
}

// 2. Load saved preferences
chrome.storage.local.get(
  [
    "serpyderpySubfolder",
    "serpyderpyPageCount",
    "serpyderpyNoPersonalization",
    "serpyderpyDecoyBrowsing",
    "serpyderpyDecoyType",
    "serpyderpySaveJson",
    "serpyderpySaveHtml",
    "serpyderpyReuseTab"
  ],
  (res) => {
    if (res.serpyderpySubfolder) {
      subfolderInput.value = res.serpyderpySubfolder;
      folderPreview.textContent = res.serpyderpySubfolder;
    }
    if (res.serpyderpyPageCount) {
      pageCountSelect.value = res.serpyderpyPageCount;
    }
    if (res.serpyderpyNoPersonalization !== undefined) {
      noPersonalizationCheckbox.checked = Boolean(res.serpyderpyNoPersonalization);
    }
    if (res.serpyderpyDecoyBrowsing !== undefined) {
      decoyBrowsingCheckbox.checked = Boolean(res.serpyderpyDecoyBrowsing);
    }
    if (res.serpyderpyDecoyType) {
      decoyTypeSelect.value = res.serpyderpyDecoyType;
    }
    if (res.serpyderpySaveJson !== undefined) {
      saveJsonCheckbox.checked = Boolean(res.serpyderpySaveJson);
    }
    if (res.serpyderpySaveHtml !== undefined) {
      saveHtmlCheckbox.checked = Boolean(res.serpyderpySaveHtml);
    }
    if (res.serpyderpyReuseTab !== undefined) {
      reuseTabCheckbox.checked = Boolean(res.serpyderpyReuseTab);
    }
    decoyTypeSelect.disabled = !decoyBrowsingCheckbox.checked;
    updateButtonLabels();
  }
);

subfolderInput.addEventListener("input", () => {
  const val = subfolderInput.value.trim() || "SerpyDerpy";
  folderPreview.textContent = val;
  chrome.storage.local.set({ serpyderpySubfolder: val });
});

pageCountSelect.addEventListener("change", () => {
  chrome.storage.local.set({ serpyderpyPageCount: pageCountSelect.value });
  updateButtonLabels();
});

noPersonalizationCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({
    serpyderpyNoPersonalization: noPersonalizationCheckbox.checked
  });
});

decoyBrowsingCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({
    serpyderpyDecoyBrowsing: decoyBrowsingCheckbox.checked
  });
  decoyTypeSelect.disabled = !decoyBrowsingCheckbox.checked;
});

decoyTypeSelect.addEventListener("change", () => {
  chrome.storage.local.set({
    serpyderpyDecoyType: decoyTypeSelect.value
  });
});

saveJsonCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ serpyderpySaveJson: saveJsonCheckbox.checked });
});

saveHtmlCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ serpyderpySaveHtml: saveHtmlCheckbox.checked });
});

reuseTabCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ serpyderpyReuseTab: reuseTabCheckbox.checked });
});

// 3. Inspect Active Tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs || tabs.length === 0) return;
  const tab = tabs[0];
  activeTabId = tab.id;

  if (isGoogleSearchUrl(tab.url)) {
    try {
      const u = new URL(tab.url);
      activeQuery = u.searchParams.get("q") || "";
      const startParam = parseInt(u.searchParams.get("start") || "0", 10);
      activePageNum = Math.floor(startParam / 10) + 1;
    } catch (_) {
      activePageNum = 1;
    }

    extractSingleBtn.disabled = false;
    crawlFromTabBtn.disabled = false;
    decoyTypeSelect.disabled = !decoyBrowsingCheckbox.checked;
    updateButtonLabels();

    tabHint.textContent = activeQuery
      ? `Active Query: "${activeQuery}" (Page ${activePageNum})`
      : `Active tab is a Google search page (Page ${activePageNum})`;
  } else {
    extractSingleBtn.disabled = true;
    crawlFromTabBtn.disabled = true;
    tabHint.textContent =
      "Active tab is not Google Search. Open a search page or use Mode 2.";
  }
});

function setBusy(isBusy) {
  extractSingleBtn.disabled = isBusy;
  crawlFromTabBtn.disabled = isBusy;
  searchBtn.disabled = isBusy;
  pageCountSelect.disabled = isBusy;
  stopCrawlBtn.style.display = isBusy ? "block" : "none";
}

function displaySuccess(query, resultsCount, filename, cleanUrls, pagesCrawled) {
  setBusy(false);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg success";
  const pgsText = pagesCrawled && pagesCrawled > 1 ? ` across ${pagesCrawled} pages` : "";
  statusMsg.textContent = `✓ Extracted ${resultsCount} organic result(s)${pgsText} for "${query}"`;
  fileInfo.textContent = `Saved to Downloads/${filename}`;

  currentCleanUrls = Array.isArray(cleanUrls) ? cleanUrls : [];
  if (currentCleanUrls.length > 0) {
    copyUrlsBtn.style.display = "block";
    copyUrlsBtn.textContent = `📋 Copy ${currentCleanUrls.length} Clean URLs for TidyTexty`;
    urlsPreview.style.display = "block";
    urlsPreview.value = currentCleanUrls.join("\n");
  } else {
    copyUrlsBtn.style.display = "none";
    urlsPreview.style.display = "none";
  }
}

function displayError(msg) {
  setBusy(false);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg error";
  statusMsg.textContent = `Error: ${msg}`;
  fileInfo.textContent = "";
  stopCrawlBtn.style.display = "none";
  copyUrlsBtn.style.display = "none";
  urlsPreview.style.display = "none";
}

function applyCrawlState(state) {
  if (!state) return;

  if (state.isRunning) {
    setBusy(true);
    statusArea.classList.add("visible");
    if (state.isCaptcha) {
      statusMsg.className = "status-msg warning";
    } else {
      statusMsg.className = "status-msg";
    }
    statusMsg.textContent = state.statusText || "Crawling Google search results...";
    fileInfo.textContent = state.query ? `Query: "${state.query}"` : "";
  } else if (state.savedFilename) {
    displaySuccess(
      state.query,
      state.totalResults,
      state.savedFilename,
      state.cleanUrls,
      state.totalPages
    );
  } else if (state.error) {
    displayError(state.error);
  }
}

// 4. Initial Sync with Background Crawl State
chrome.runtime.sendMessage({ type: "GET_CRAWL_STATE" }, (state) => {
  if (chrome.runtime.lastError) return;
  if (state && state.isRunning) {
    applyCrawlState(state);
  }
});

// 5. Live State Updates from Background
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "CRAWL_STATE_UPDATE" && message.state) {
    applyCrawlState(message.state);
  }
});

// Mode 1: 1-Click Save Current Page Only
extractSingleBtn.addEventListener("click", () => {
  if (!activeTabId) return;

  setBusy(true);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg";
  statusMsg.textContent = "Extracting current page results...";
  fileInfo.textContent = "";
  stopCrawlBtn.style.display = "none";

  const subfolder = subfolderInput.value.trim() || "SerpyDerpy";
  const saveHtml = saveHtmlCheckbox.checked;
  const saveJson = saveJsonCheckbox.checked;
  const decoyBrowsing = decoyBrowsingCheckbox.checked;
  const decoyType = decoyTypeSelect.value;

  chrome.runtime.sendMessage(
    {
      type: "SAVE_CURRENT_PAGE",
      tabId: activeTabId,
      subfolder,
      saveHtml,
      saveJson,
      decoyBrowsing,
      decoyType
    },
    (res) => {
      if (res && res.ok) {
        displaySuccess(res.query, res.resultsCount, res.filename, res.cleanUrls, 1);
      } else {
        displayError((res && res.error) || "Single page save failed");
      }
    }
  );
});

// Mode 1: Save & Crawl Next Pages from Active Tab
crawlFromTabBtn.addEventListener("click", () => {
  if (!activeTabId) return;

  const pagesToExtract = parseInt(pageCountSelect.value, 10);
  const subfolder = subfolderInput.value.trim() || "SerpyDerpy";
  const saveHtml = saveHtmlCheckbox.checked;
  const saveJson = saveJsonCheckbox.checked;
  const decoyBrowsing = decoyBrowsingCheckbox.checked;
  const decoyType = decoyTypeSelect.value;
  const noPersonalization = noPersonalizationCheckbox.checked;

  setBusy(true);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg";
  statusMsg.textContent = `Starting crawl from active tab for ${pagesToExtract} page(s)...`;
  fileInfo.textContent = "Checking page results...";

  chrome.runtime.sendMessage(
    {
      type: "START_CRAWL_FROM_TAB",
      tabId: activeTabId,
      pagesToExtract,
      subfolder,
      saveHtml,
      saveJson,
      decoyBrowsing,
      decoyType,
      noPersonalization,
      query: activeQuery
    },
    (res) => {
      if (res && res.ok) {
        displaySuccess(
          res.query,
          res.resultsCount,
          res.filename,
          res.cleanUrls,
          res.pagesCrawled
        );
      } else {
        displayError((res && res.error) || "Crawl from tab failed");
      }
    }
  );
});

// Mode 2: Direct Search & Crawl
searchBtn.addEventListener("click", () => {
  const query = queryInput.value.trim();
  if (!query) {
    displayError("Please enter a search query");
    return;
  }

  const pagesToExtract = parseInt(pageCountSelect.value, 10);
  const subfolder = subfolderInput.value.trim() || "SerpyDerpy";
  const reuseTab = reuseTabCheckbox.checked;
  const saveHtml = saveHtmlCheckbox.checked;
  const saveJson = saveJsonCheckbox.checked;
  const decoyBrowsing = decoyBrowsingCheckbox.checked;
  const decoyType = decoyTypeSelect.value;
  const noPersonalization = noPersonalizationCheckbox.checked;

  setBusy(true);
  statusArea.classList.add("visible");
  statusMsg.className = "status-msg";
  statusMsg.textContent = reuseTab
    ? `Searching in dedicated Google tab for "${query}" (${pagesToExtract} page(s))...`
    : `Running search for "${query}" (${pagesToExtract} page(s))...`;
  fileInfo.textContent = "Waiting for initial search results...";

  chrome.runtime.sendMessage(
    {
      type: "SEARCH_AND_CRAWL",
      query,
      pagesToExtract,
      subfolder,
      reuseTab,
      saveHtml,
      saveJson,
      decoyBrowsing,
      decoyType,
      noPersonalization
    },
    (res) => {
      if (res && res.ok) {
        displaySuccess(
          res.query,
          res.resultsCount,
          res.filename,
          res.cleanUrls,
          res.pagesCrawled
        );
      } else {
        displayError((res && res.error) || "Search and crawl failed");
      }
    }
  );
});

queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    searchBtn.click();
  }
});

// Stop Crawl Button
stopCrawlBtn.addEventListener("click", () => {
  stopCrawlBtn.disabled = true;
  stopCrawlBtn.textContent = "Stopping...";
  chrome.runtime.sendMessage({ type: "STOP_CRAWL" }, () => {
    statusMsg.textContent = "Finalizing gathered results...";
  });
});

// Copy URLs Button
copyUrlsBtn.addEventListener("click", () => {
  if (currentCleanUrls.length === 0) return;
  const text = currentCleanUrls.join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const orig = copyUrlsBtn.textContent;
    copyUrlsBtn.textContent = `✓ Copied ${currentCleanUrls.length} URLs to Clipboard!`;
    setTimeout(() => {
      copyUrlsBtn.textContent = orig;
    }, 2200);
  });
});
