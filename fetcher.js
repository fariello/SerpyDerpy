/**
 * SerpyDerpy v2 — Offscreen-Backed Multi-Format Fetcher, Download Verifier,
 * Disk-Error Circuit Breaker, Target-Page Challenge Guard, and _site/ Capturer.
 * Implements Section 7 (REQ-FETCH-01..05), REQ-META-04, REQ-OPS-02, REQ-OPS-09, REQ-OPS-10.
 */

import {
  canonicalizeUrl,
  checkUrlSafety,
  isOffDomain,
  sha256Hex,
  sanitizeSegment,
  buildResultRelativePaths,
  DEFAULT_DENYLIST_PATTERNS,
  DEFAULT_BLOCKED_EXTENSIONS
} from "./naming.js";
import {
  classifyResource,
  evaluateTargetChallenge,
  buildResultMarkdownFrontmatter,
  formatTextAsMarkdown,
  buildResultJson,
  buildErrorJson,
  buildSiteCaptureJson,
  stripKnownExtension
} from "./schemas.js";

export const DEFAULT_MAX_FILE_BYTES = 250 * 1024 * 1024; // 250 MB (OQ-05)
export const DEFAULT_MAX_HTML_BYTES = 50 * 1024 * 1024;  // 50 MB DOM snapshot ceiling
export const SITE_CAPTURE_FILE_CAP = 50;
export const SITE_CAPTURE_MAX_FILE_BYTES = 50 * 1024 * 1024;

const DISK_FATAL_ERRORS = new Set([
  "FILE_NO_SPACE",
  "FILE_ACCESS_DENIED",
  "FILE_SECURITY_CHECK_FAILED"
]);

let offscreenCreatePromise = null;
let consecutiveLocalWriteFailures = 0;
let diskErrorCallback = null;

// Track campaign-created download IDs strictly so personal/Interactive downloads are NEVER erased (REQ-OPS-02)
const campaignDownloadIds = new Set();

// Track webNavigation.onErrorOccurred errors per tabId (REQ-FETCH-03 step 5)
const tabNavigationErrors = new Map();

export function initNavigationErrorTracker() {
  if (typeof chrome !== "undefined" && chrome.webNavigation && chrome.webNavigation.onErrorOccurred) {
    chrome.webNavigation.onErrorOccurred.addListener((details) => {
      if (details && details.frameId === 0 && typeof details.tabId === "number") {
        tabNavigationErrors.set(details.tabId, {
          error: details.error || "net::ERR_FAILED",
          url: details.url || "",
          timeStamp: details.timeStamp || Date.now()
        });
      }
    });
  }
}

export function setDiskErrorCallback(cb) {
  diskErrorCallback = cb;
}

export function resetDiskErrorCounter() {
  consecutiveLocalWriteFailures = 0;
}

// Opt-in public IP cache (REQ-META-04: default OFF; zero network requests unless enabled)
let cachedPublicIp = { ip: null, fetchedAtMs: 0 };

export async function getEnvironmentInfo({ recordPublicIp = false } = {}) {
  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (_) {}

  let ipAddress = null;
  const ipAddressRecorded = Boolean(recordPublicIp);

  if (ipAddressRecorded) {
    const now = Date.now();
    if (cachedPublicIp.ip && now - cachedPublicIp.fetchedAtMs < 3600 * 1000) {
      ipAddress = cachedPublicIp.ip;
    } else {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3500);
        const res = await fetch("https://api.ipify.org?format=json", { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
          const j = await res.json();
          if (j && j.ip) {
            ipAddress = j.ip;
            cachedPublicIp = { ip: j.ip, fetchedAtMs: now };
          }
        }
      } catch (_) {}
    }
  }

  return {
    ipAddress,
    ipAddressRecorded,
    userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
    platform: (typeof navigator !== "undefined" && navigator.platform) || "",
    language: (typeof navigator !== "undefined" && navigator.language) || "",
    timezone
  };
}

/**
 * Ensure the singleton offscreen document exists (REQ-FETCH-03).
 */
export async function ensureOffscreenDocument() {
  if (typeof chrome === "undefined" || !chrome.offscreen) {
    throw new Error("chrome.offscreen API is unavailable.");
  }
  if (offscreenCreatePromise) return offscreenCreatePromise;

  offscreenCreatePromise = (async () => {
    try {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL("offscreen.html")]
      });
      if (existing && existing.length > 0) return;
    } catch (_) {}

    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Stream large downloads with SHA-256 verification and create Blob URLs for chrome.downloads."
      });
    } catch (err) {
      if (!String(err?.message || err).includes("Only a single offscreen document")) {
        throw err;
      }
    }
  })().finally(() => {
    offscreenCreatePromise = null;
  });

  return offscreenCreatePromise;
}

export async function sendToOffscreen(payload) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...payload, target: "offscreen" });
}

function getDownloadItem(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      resolve(items && items[0] ? items[0] : null);
    });
  });
}

/**
 * Wait strictly for chrome.downloads completion and verify danger === "safe" and fileSize (REQ-FETCH-03 step 3).
 */
function waitForDownloadVerified(downloadId, expectedBytes = null, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
    };

    const fail = (errMsg, errCode = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error(errMsg || "Download failed");
      err.downloadErrorCode = errCode;
      reject(err);
    };

    const succeed = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      const item = await getDownloadItem(downloadId);
      if (!item) {
        reject(new Error("Download record vanished before verification."));
        return;
      }
      if (item.danger && item.danger !== "safe" && item.danger !== "accepted") {
        const err = new Error(`Download flagged dangerous: ${item.danger}`);
        err.downloadErrorCode = "FILE_SECURITY_CHECK_FAILED";
        reject(err);
        return;
      }
      const actualSize =
        typeof item.fileSize === "number" && item.fileSize >= 0
          ? item.fileSize
          : typeof item.totalBytes === "number" && item.totalBytes >= 0
          ? item.totalBytes
          : null;

      if (expectedBytes !== null && actualSize !== null && actualSize !== expectedBytes) {
        reject(new Error(`Downloaded byte count mismatch: expected ${expectedBytes}, got ${actualSize}.`));
        return;
      }

      resolve({
        downloadId,
        fileSize: actualSize,
        mime: item.mime || "",
        filename: item.filename || "",
        finalUrl: item.finalUrl || ""
      });
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        succeed();
      } else if (delta.state?.current === "interrupted") {
        const code = delta.error?.current || "INTERRUPTED";
        fail(`Download interrupted: ${code}`, code);
      }
    };

    const timer = setTimeout(() => {
      fail("Download verification timed out.", "TIMEOUT");
    }, timeoutMs);

    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.search({ id: downloadId }, (items) => {
      if (items && items[0]) {
        if (items[0].state === "complete") succeed();
        else if (items[0].state === "interrupted") {
          fail(`Download interrupted: ${items[0].error || "INTERRUPTED"}`, items[0].error || "INTERRUPTED");
        }
      }
    });
  });
}

function handleLocalWriteOutcome(ok, err = null) {
  if (ok) {
    consecutiveLocalWriteFailures = 0;
    return;
  }
  const code = err?.downloadErrorCode || "";
  const msg = String(err?.message || "");
  const isFatal =
    DISK_FATAL_ERRORS.has(code) ||
    msg.includes("FILE_NO_SPACE") ||
    msg.includes("FILE_ACCESS_DENIED") ||
    msg.includes("FILE_SECURITY_CHECK_FAILED");

  consecutiveLocalWriteFailures++;
  if ((isFatal || consecutiveLocalWriteFailures >= 5) && typeof diskErrorCallback === "function") {
    diskErrorCallback({
      code: code || "LOCAL_WRITE_FAILURE",
      message: msg || "Repeated local download write failures",
      consecutiveFailures: consecutiveLocalWriteFailures
    });
  }
}

/**
 * Download an offscreen Blob URL to `filename` (relative to Downloads/) with conflictAction: "overwrite",
 * strict verification, Blob revocation, and scoped history erase (REQ-OPS-02, REQ-OPS-10).
 */
export async function downloadBlobUrlVerified({
  blobUrl,
  filename,
  expectedBytes = null,
  isCampaign = true,
  eraseFromHistory = true,
  revokeAfter = true
}) {
  let downloadId = null;
  try {
    downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename,
          conflictAction: "overwrite",
          saveAs: false
        },
        (id) => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message || "chrome.downloads.download failed"));
          } else {
            resolve(id);
          }
        }
      );
    });

    if (isCampaign) {
      campaignDownloadIds.add(downloadId);
    }

    const verified = await waitForDownloadVerified(downloadId, expectedBytes);
    handleLocalWriteOutcome(true);

    if (isCampaign && eraseFromHistory && campaignDownloadIds.has(downloadId)) {
      try {
        await chrome.downloads.erase({ id: downloadId });
      } catch (_) {}
      campaignDownloadIds.delete(downloadId);
    }

    return verified;
  } catch (err) {
    handleLocalWriteOutcome(false, err);
    throw err;
  } finally {
    if (revokeAfter && blobUrl) {
      sendToOffscreen({ type: "OFFSCREEN_REVOKE_BLOB", blobUrl }).catch(() => {});
    }
  }
}

/**
 * Download a string (Markdown, JSON, HTML, JSONL, log) via offscreen Blob URL with full verification.
 */
export async function downloadTextVerified({
  content,
  filename,
  mimeType = "text/plain;charset=utf-8",
  isCampaign = true,
  eraseFromHistory = true
}) {
  const blobRes = await sendToOffscreen({
    type: "OFFSCREEN_CREATE_TEXT_BLOB",
    content,
    mimeType
  });
  if (!blobRes || !blobRes.ok) {
    throw new Error("Failed to create offscreen Blob URL.");
  }
  const verified = await downloadBlobUrlVerified({
    blobUrl: blobRes.blobUrl,
    filename,
    expectedBytes: blobRes.byteLength,
    isCampaign,
    eraseFromHistory,
    revokeAfter: true
  });
  return {
    ...verified,
    byteLength: blobRes.byteLength,
    sha256: blobRes.sha256
  };
}

/**
 * Download chunked string array (for large streamed JSONL exports / full checkpoints).
 */
export async function downloadChunkedTextVerified({
  chunks,
  filename,
  mimeType = "application/x-ndjson;charset=utf-8",
  isCampaign = true,
  eraseFromHistory = true
}) {
  const blobRes = await sendToOffscreen({
    type: "OFFSCREEN_CREATE_CHUNKED_BLOB",
    chunks,
    mimeType
  });
  if (!blobRes || !blobRes.ok) {
    throw new Error("Failed to create chunked offscreen Blob URL.");
  }
  return downloadBlobUrlVerified({
    blobUrl: blobRes.blobUrl,
    filename,
    expectedBytes: blobRes.byteLength,
    isCampaign,
    eraseFromHistory,
    revokeAfter: true
  });
}

/**
 * Wrap chrome.scripting.executeScript with a strict 20s timeout (REQ-FETCH-03 step 5).
 */
export function executeScriptWithTimeout(details, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`executeScript timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    chrome.scripting.executeScript(details).then(
      (res) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    );
  });
}

export function waitForTabComplete(tabId, timeoutMs = 30000) {
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
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || tab.status === "complete") finish();
    });
  });
}

/**
 * Injected human pointer/mouse/scroll activity during settle wait (REQ-FETCH-03 step 5).
 */
export function simulateHumanActivityFunc(durationMs) {
  return new Promise((resolve) => {
    const endTime = Date.now() + durationMs;
    let curX = Math.floor(window.innerWidth * 0.3 + Math.random() * window.innerWidth * 0.4);
    let curY = Math.floor(window.innerHeight * 0.3 + Math.random() * window.innerHeight * 0.4);

    function dispatchPoint(x, y) {
      const init = {
        clientX: x,
        clientY: y,
        screenX: x + (window.screenX || 0),
        screenY: y + (window.screenY || 0),
        bubbles: true,
        cancelable: true,
        view: window
      };
      const el = document.elementFromPoint(x, y) || document.body || document.documentElement;
      if (el) {
        try {
          if (window.PointerEvent) el.dispatchEvent(new PointerEvent("pointermove", init));
          el.dispatchEvent(new MouseEvent("mousemove", init));
        } catch (_) {}
      }
    }

    function step() {
      if (Date.now() >= endTime) {
        resolve();
        return;
      }
      const maxW = Math.max(300, window.innerWidth - 40);
      const maxH = Math.max(300, window.innerHeight - 40);
      const targetX = Math.max(20, Math.min(maxW, curX + (Math.random() - 0.5) * 320));
      const targetY = Math.max(20, Math.min(maxH, curY + (Math.random() - 0.5) * 220));
      const steps = 5 + Math.floor(Math.random() * 5);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        dispatchPoint(
          Math.round(curX + (targetX - curX) * t),
          Math.round(curY + (targetY - curY) * t)
        );
      }
      curX = targetX;
      curY = targetY;
      if (Math.random() < 0.4) {
        const dy = (Math.random() < 0.7 ? 1 : -1) * Math.floor(80 + Math.random() * 150);
        window.scrollBy({ top: dy, behavior: "smooth" });
      }
      setTimeout(step, Math.min(250 + Math.floor(Math.random() * 400), Math.max(50, endTime - Date.now())));
    }
    step();
  });
}

/**
 * Injected probe returning document metadata, navigation timing status, PDF embed flag, and challenge selectors.
 */
function probeLoadedTabFunc() {
  const navEntry =
    performance && typeof performance.getEntriesByType === "function"
      ? performance.getEntriesByType("navigation")[0]
      : null;

  const bodyText = document.body ? document.body.innerText || "" : "";
  const selectors = {
    cfChallengeRunning: Boolean(document.querySelector("#challenge-running, #cf-challenge-running")),
    cfChallengeForm: Boolean(document.querySelector("#challenge-form, form[action*='__cf_chl']")),
    cfTurnstileIframe: Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"]')),
    datadomeIframe: Boolean(document.querySelector('iframe[src*="captcha-delivery.com"]')),
    pxCaptcha: Boolean(document.querySelector("#px-captcha")),
    awsWafCaptcha: Boolean(document.querySelector('#captcha-container[data-aws-waf], script[src*="awswaf"]')),
    sucuriOrImpervaInterstitial: Boolean(
      document.querySelector('iframe[src*="_Incapsula_Resource"], meta[name="ROBOTS"][content*="NOINDEX"] ~ #main-iframe')
    ),
    recaptcha: Boolean(document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha')),
    hcaptcha: Boolean(document.querySelector('iframe[src*="hcaptcha"], .h-captcha')),
    genericCaptchaForm: Boolean(document.querySelector('form[action*="captcha"], #captcha-form')),
    akamaiAbck: Boolean(document.cookie && document.cookie.includes("_abck") && /access denied/i.test(document.title || ""))
  };

  return {
    url: window.location.href,
    contentType: document.contentType || "",
    characterSet: document.characterSet || "",
    lastModified: document.lastModified || "",
    referrer: document.referrer || "",
    title: document.title || "",
    visibleText: bodyText.slice(0, 8000),
    hasPdfEmbed: Boolean(document.querySelector('embed[type="application/pdf"]')),
    selectors,
    navigation: navEntry
      ? {
          responseStatus: typeof navEntry.responseStatus === "number" ? navEntry.responseStatus : null,
          nextHopProtocol: navEntry.nextHopProtocol || ""
        }
      : null
  };
}

/**
 * Close a tab safely after clearing window.onbeforeunload so beforeunload dialogs never block (REQ-FETCH-03 step 5).
 */
export async function safeCloseTab(tabId) {
  if (tabId == null) return;
  try {
    await executeScriptWithTimeout(
      {
        target: { tabId },
        func: () => {
          window.onbeforeunload = null;
        }
      },
      2500
    );
  } catch (_) {}
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {}
  tabNavigationErrors.delete(tabId);
}

/**
 * Complete multi-format fetch & archive pipeline for one URL (REQ-FETCH-03, REQ-FETCH-04, REQ-META-03, REQ-META-05).
 */
export async function fetchAndArchiveUrl({
  requestedUrl,
  canonicalUrl,
  mode = "campaign",
  campaignContext = null,
  serpContext = null,
  outputRoot,
  relDirOverride = null,
  targetSlug = "target",
  targetDomain = "",
  engine = "google",
  searchSlug = "search",
  overallRank = 1,
  serpTitle = "",
  attemptNumber = 1,
  firstAttemptUtc = new Date().toISOString(),
  windowId = undefined,
  config = {},
  onChallengeDetected = null,
  onFinalCanonicalCheck = null
}) {
  const startedMs = Date.now();
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : { name: "SerpyDerpy", version: "2.0.0" };
  const extInfo = { name: manifest.name || "SerpyDerpy", version: manifest.version || "2.0.0" };
  const isCampaign = mode === "campaign";
  const eraseFromHistory = isCampaign && config.eraseDownloadHistory !== false;
  const maxBytes = (config.maxFileSizeMb ?? 250) * 1024 * 1024;
  const maxHtmlBytes = (config.maxHtmlSizeMb ?? 50) * 1024 * 1024;
  const denylistPatterns = config.denylistPatterns || DEFAULT_DENYLIST_PATTERNS;
  const blockedExtensions = config.blockedExtensions || DEFAULT_BLOCKED_EXTENSIONS;
  const envInfo = await getEnvironmentInfo({ recordPublicIp: Boolean(config.recordPublicIp) });

  const writeErrorSidecar = async ({
    finalUrl = requestedUrl,
    status = "failed_retryable",
    errorClass = "network_error",
    httpStatus = null,
    reason = "",
    retryable = true,
    observedContentLengthBytes = null,
    responseHeaders = {}
  }) => {
    const offDom = isOffDomain(finalUrl || requestedUrl, targetDomain);
    const paths = buildResultRelativePaths({
      outputRoot,
      relDirOverride,
      targetSlug,
      engine,
      searchSlug,
      overallRank,
      title: serpTitle || requestedUrl,
      ext: "json",
      kind: "binary"
    });
    const errObj = buildErrorJson({
      mode,
      extension: extInfo,
      campaign: campaignContext,
      serpContext,
      url: { requested: requestedUrl, canonical: canonicalUrl, final: finalUrl, offDomain: offDom },
      status,
      errorClass,
      httpStatus,
      reason,
      retryable,
      attemptCount: attemptNumber,
      observedContentLengthBytes,
      responseHeaders,
      firstAttemptUtc,
      lastAttemptUtc: new Date().toISOString()
    });
    await downloadTextVerified({
      content: JSON.stringify(errObj, null, 2),
      filename: paths.errorJson,
      mimeType: "application/json;charset=utf-8",
      isCampaign,
      eraseFromHistory
    });
    return {
      ok: false,
      status,
      errorClass,
      httpStatus,
      reason,
      retryable,
      offDomain: offDom,
      finalUrl,
      finalCanonicalUrl: canonicalizeUrl(finalUrl) || canonicalUrl,
      artifactRelPath: paths.errorJson
    };
  };

  // Step 0: Pre-flight URL safety (REQ-OPS-06)
  const safety = checkUrlSafety(requestedUrl, denylistPatterns, blockedExtensions);
  if (!safety.allowed) {
    return writeErrorSidecar({
      status: safety.status,
      errorClass: safety.errorClass,
      reason: safety.reason,
      retryable: false
    });
  }

  // Step 1: Pre-flight offscreen HEAD probe
  let headRes = null;
  try {
    headRes = await sendToOffscreen({ type: "OFFSCREEN_HEAD_PROBE", url: requestedUrl, timeoutMs: 5000 });
  } catch (_) {}

  if (headRes && headRes.ok) {
    const postHeadSafety = checkUrlSafety(headRes.finalUrl || requestedUrl, denylistPatterns, blockedExtensions);
    if (!postHeadSafety.allowed) {
      return writeErrorSidecar({
        finalUrl: headRes.finalUrl,
        status: postHeadSafety.status,
        errorClass: postHeadSafety.errorClass,
        httpStatus: headRes.status,
        reason: `Post-redirect blocked: ${postHeadSafety.reason}`,
        retryable: false,
        responseHeaders: headRes.headers
      });
    }

    // Permanent HTTP errors from HEAD
    if (headRes.status === 404 || headRes.status === 410 || headRes.status === 401) {
      return writeErrorSidecar({
        finalUrl: headRes.finalUrl,
        status: "failed_permanent",
        errorClass: "http_4xx",
        httpStatus: headRes.status,
        reason: `HEAD returned HTTP ${headRes.status}`,
        retryable: false,
        responseHeaders: headRes.headers
      });
    }
    if (headRes.status === 429 || headRes.status === 503) {
      return writeErrorSidecar({
        finalUrl: headRes.finalUrl,
        status: "failed_retryable",
        errorClass: headRes.status === 429 ? "http_4xx" : "http_5xx",
        httpStatus: headRes.status,
        reason: `HEAD returned HTTP ${headRes.status}`,
        retryable: true,
        responseHeaders: headRes.headers
      });
    }

    // Step 2: Size guard on HEAD Content-Length
    if (headRes.contentLength !== null && maxBytes > 0 && headRes.contentLength > maxBytes) {
      return writeErrorSidecar({
        finalUrl: headRes.finalUrl,
        status: "skipped_too_large",
        errorClass: "too_large",
        httpStatus: headRes.status,
        reason: `HEAD Content-Length (${headRes.contentLength} bytes) exceeds limit (${maxBytes} bytes).`,
        retryable: false,
        observedContentLengthBytes: headRes.contentLength,
        responseHeaders: headRes.headers
      });
    }

    // Redirect aliasing check before downloading (REQ-STATE-02)
    const headFinalCanon = canonicalizeUrl(headRes.finalUrl || requestedUrl) || canonicalUrl;
    if (headFinalCanon !== canonicalUrl && typeof onFinalCanonicalCheck === "function") {
      const aliasHit = await onFinalCanonicalCheck(headFinalCanon);
      if (aliasHit && aliasHit.dedupHandled) {
        return aliasHit;
      }
    }

    // Step 3 & 4: Direct offscreen streaming for binary or text when HEAD succeeded (2xx)
    if (headRes.httpOk) {
      const info = classifyResource(headRes.finalUrl || requestedUrl, headRes.contentType, headRes.dispositionFilename);
      if (info.kind === "binary" || (headRes.isAttachment && info.kind !== "text") || info.kind === "text") {
        const streamRes = await saveDirectOffscreenResource({
          url: headRes.finalUrl || requestedUrl,
          requestedUrl,
          canonicalUrl,
          headInfo: headRes,
          expectedKind: info.kind === "text" && !headRes.isAttachment ? "text" : "binary",
          mode,
          extInfo,
          campaignContext,
          serpContext,
          outputRoot,
          relDirOverride,
          targetSlug,
          targetDomain,
          engine,
          searchSlug,
          overallRank,
          serpTitle,
          attemptNumber,
          startedMs,
          maxBytes,
          isCampaign,
          eraseFromHistory,
          envInfo,
          denylistPatterns,
          blockedExtensions,
          writeErrorSidecar
        });
        if (streamRes && !streamRes.fallThroughToTab) {
          return streamRes;
        }
      }
    }
  }

  // Step 5: HTML Tab loading & extraction (or fallback when HEAD failed / 405 / 403 / WAF)
  let tabId = null;
  let challengeRecord = { encountered: false, provider: null, resolvedByHuman: false, waitDurationMs: 0 };

  try {
    const createOpts = { url: requestedUrl, active: false };
    if (typeof windowId === "number") createOpts.windowId = windowId;
    const tab = await chrome.tabs.create(createOpts);
    tabId = tab.id;
    tabNavigationErrors.delete(tabId);

    // Prevent Chrome/Edge from discarding active or challenged tabs
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    } catch (_) {}

    await waitForTabComplete(tabId, 30000);

    // Check webNavigation.onErrorOccurred (DNS, TLS, connection refused)
    const navErr = tabNavigationErrors.get(tabId);
    if (navErr) {
      return await writeErrorSidecar({
        finalUrl: navErr.url || requestedUrl,
        status: "failed_retryable",
        errorClass: "network_error",
        reason: `Navigation failed: ${navErr.error}`,
        retryable: true
      });
    }

    // Randomized settle wait with realistic mouse & scroll simulation
    const minSettle = Math.max(0, Number(config.settleWaitMin ?? 7));
    const maxSettle = Math.max(minSettle, Number(config.settleWaitMax ?? 21));
    const settleMs = Math.round((minSettle + Math.random() * (maxSettle - minSettle)) * 1000);
    if (settleMs > 0) {
      try {
        await executeScriptWithTimeout(
          { target: { tabId }, func: simulateHumanActivityFunc, args: [settleMs] },
          settleMs + 15000
        );
      } catch (_) {
        await new Promise((r) => setTimeout(r, settleMs));
      }
    }

    let currentTab = await chrome.tabs.get(tabId).catch(() => null);
    let effectiveUrl = (currentTab && currentTab.url) || requestedUrl;

    // Re-check SSRF & denylist on post-redirect finalUrl
    const postNavSafety = checkUrlSafety(effectiveUrl, denylistPatterns, blockedExtensions);
    if (!postNavSafety.allowed) {
      return await writeErrorSidecar({
        finalUrl: effectiveUrl,
        status: postNavSafety.status,
        errorClass: postNavSafety.errorClass,
        reason: `Post-navigation blocked: ${postNavSafety.reason}`,
        retryable: false
      });
    }

    // Probe loaded tab
    let probed = null;
    try {
      const pRes = await executeScriptWithTimeout({ target: { tabId }, func: probeLoadedTabFunc }, 20000);
      probed = pRes?.[0]?.result || null;
    } catch (_) {}

    let httpStatus = probed?.navigation?.responseStatus ?? headRes?.status ?? null;

    // Corroborated challenge check (REQ-FETCH-04)
    let challengeCheck = evaluateTargetChallenge({
      url: effectiveUrl,
      httpStatus,
      title: probed?.title || currentTab?.title || "",
      visibleText: probed?.visibleText || "",
      selectors: probed?.selectors || {}
    });

    if (challengeCheck.isChallenge) {
      const chalStart = Date.now();
      challengeRecord = {
        encountered: true,
        provider: challengeCheck.provider,
        resolvedByHuman: false,
        waitDurationMs: 0
      };

      if (typeof onChallengeDetected === "function") {
        const decision = await onChallengeDetected({
          tabId,
          url: effectiveUrl,
          provider: challengeCheck.provider,
          pollResolved: async () => {
            try {
              const tObj = await chrome.tabs.get(tabId);
              const pr = await executeScriptWithTimeout({ target: { tabId }, func: probeLoadedTabFunc }, 15000);
              const d = pr?.[0]?.result;
              if (!d) return false;
              const chk = evaluateTargetChallenge({
                url: tObj.url || d.url,
                httpStatus: d.navigation?.responseStatus ?? null,
                title: d.title,
                visibleText: d.visibleText,
                selectors: d.selectors
              });
              return !chk.isChallenge;
            } catch (_) {
              return false;
            }
          }
        });

        challengeRecord.waitDurationMs = Date.now() - chalStart;
        if (decision === "skipped") {
          return await writeErrorSidecar({
            finalUrl: effectiveUrl,
            status: "failed_permanent",
            errorClass: "blocked_by_user",
            httpStatus,
            reason: `User skipped ${challengeCheck.provider} challenge.`,
            retryable: false
          });
        }
        if (decision === "aborted") {
          return { ok: false, aborted: true, status: "pending" };
        }

        // Challenge resolved by human: wait 2.5s and re-probe
        challengeRecord.resolvedByHuman = true;
        await new Promise((r) => setTimeout(r, 2500));
        currentTab = await chrome.tabs.get(tabId).catch(() => null);
        effectiveUrl = (currentTab && currentTab.url) || effectiveUrl;
        const pRes2 = await executeScriptWithTimeout({ target: { tabId }, func: probeLoadedTabFunc }, 20000);
        probed = pRes2?.[0]?.result || probed;
        httpStatus = probed?.navigation?.responseStatus ?? null;
      } else {
        return await writeErrorSidecar({
          finalUrl: effectiveUrl,
          status: "failed_retryable",
          errorClass: "waf_challenge",
          httpStatus,
          reason: `Detected ${challengeCheck.provider} challenge.`,
          retryable: true
        });
      }
    }

    // Check HTTP error status on loaded tab (REQ-FETCH-03 step 5)
    if (typeof httpStatus === "number" && httpStatus >= 400) {
      const permanent = [401, 403, 404, 410].includes(httpStatus);
      return await writeErrorSidecar({
        finalUrl: effectiveUrl,
        status: permanent ? "failed_permanent" : "failed_retryable",
        errorClass: httpStatus >= 500 ? "http_5xx" : "http_4xx",
        httpStatus,
        reason: `Page returned HTTP ${httpStatus}`,
        retryable: !permanent
      });
    }

    // Redirect aliasing check on effectiveUrl (REQ-STATE-02)
    const finalCanonicalUrl = canonicalizeUrl(effectiveUrl) || canonicalUrl;
    if (finalCanonicalUrl !== canonicalUrl && typeof onFinalCanonicalCheck === "function") {
      const aliasHit = await onFinalCanonicalCheck(finalCanonicalUrl);
      if (aliasHit && aliasHit.dedupHandled) {
        return aliasHit;
      }
    }

    // Re-classify after load (detect embedded PDF or plain text)
    let info = classifyResource(effectiveUrl, probed?.contentType || "", "");
    if (probed?.hasPdfEmbed) {
      info = { kind: "binary", ext: "pdf", mime: "application/pdf" };
    }

    if (info.kind === "binary" || info.kind === "text") {
      // Retry offscreen fetch now that any WAF clearance cookie is stored in browser profile
      const direct = await saveDirectOffscreenResource({
        url: effectiveUrl,
        requestedUrl,
        canonicalUrl,
        headInfo: headRes,
        expectedKind: info.kind,
        mode,
        extInfo,
        campaignContext,
        serpContext,
        outputRoot,
        relDirOverride,
        targetSlug,
        targetDomain,
        engine,
        searchSlug,
        overallRank,
        serpTitle: probed?.title || serpTitle,
        attemptNumber,
        startedMs,
        maxBytes,
        isCampaign,
        eraseFromHistory,
        envInfo,
        denylistPatterns,
        blockedExtensions,
        writeErrorSidecar,
        challengeRecord,
        allowDirectChromeDownloadFallback: info.kind === "binary"
      });
      if (direct && !direct.fallThroughToTab) {
        return direct;
      }
    }

    // Extract HTML via Readability.js + markdown_extractor.js (classic scripts)
    await executeScriptWithTimeout(
      {
        target: { tabId },
        func: (plainLinks) => {
          window.__serpyderpyExtractOptions = { plainLinks };
        },
        args: [Boolean(config.plainLinks)]
      },
      10000
    );
    await executeScriptWithTimeout({ target: { tabId }, files: ["Readability.js"] }, 20000);
    const extRes = await executeScriptWithTimeout({ target: { tabId }, files: ["markdown_extractor.js"] }, 20000);
    const payload = extRes?.[0]?.result || null;

    if (!payload || (!payload.markdownBody && !payload.rawHtml)) {
      return await writeErrorSidecar({
        finalUrl: effectiveUrl,
        status: "failed_retryable",
        errorClass: "network_error",
        httpStatus,
        reason: payload?.error || "Empty DOM extraction result",
        retryable: true
      });
    }

    const rawHtmlBytes = new TextEncoder().encode(payload.rawHtml || "").byteLength;
    if (maxHtmlBytes > 0 && rawHtmlBytes > maxHtmlBytes) {
      return await writeErrorSidecar({
        finalUrl: effectiveUrl,
        status: "skipped_too_large",
        errorClass: "too_large",
        httpStatus,
        reason: `Rendered HTML (${rawHtmlBytes} bytes) exceeds DOM snapshot ceiling (${maxHtmlBytes} bytes).`,
        retryable: false,
        observedContentLengthBytes: rawHtmlBytes
      });
    }

    const title = payload.title || probed?.title || serpTitle || effectiveUrl;
    const offDom = isOffDomain(effectiveUrl, targetDomain);
    const paths = buildResultRelativePaths({
      outputRoot,
      relDirOverride,
      targetSlug,
      engine,
      searchSlug,
      overallRank,
      title,
      ext: info.ext === "htm" ? "htm" : "html",
      kind: "html"
    });

    const fetchedAt = new Date();
    const htmlDl = await downloadTextVerified({
      content: payload.rawHtml,
      filename: paths.source,
      mimeType: "text/html;charset=utf-8",
      isCampaign,
      eraseFromHistory
    });

    const frontmatter = buildResultMarkdownFrontmatter({
      url: requestedUrl,
      finalUrl: effectiveUrl,
      title,
      target: isCampaign ? targetSlug : null,
      searchEngine: engine,
      search: isCampaign ? searchSlug : null,
      rank: overallRank,
      serpPage: serpContext?.pageNumber ?? null,
      retrievedTimestamp: fetchedAt.toISOString(),
      contentSha256: htmlDl.sha256,
      extractionMethod: payload.extraction?.method || "readability",
      truncated: Boolean(payload.extraction?.truncated)
    });
    const fullMarkdown = `${frontmatter}\n${(payload.markdownBody || "").trim()}\n`;

    await downloadTextVerified({
      content: fullMarkdown,
      filename: paths.md,
      mimeType: "text/markdown;charset=utf-8",
      isCampaign,
      eraseFromHistory
    });

    const metaObj = buildResultJson({
      mode,
      extension: extInfo,
      campaign: campaignContext,
      serpContext,
      fetchedAt,
      processingDurationMs: Date.now() - startedMs,
      attemptNumber,
      url: {
        requested: requestedUrl,
        canonical: canonicalUrl,
        final: effectiveUrl,
        finalCanonical: finalCanonicalUrl,
        offDomain: offDom,
        referrer: probed?.referrer || null
      },
      resource: {
        kind: "html",
        title,
        fileExtension: info.ext === "htm" ? "htm" : "html",
        mimeType: probed?.contentType || headRes?.contentType || "text/html",
        characterSet: probed?.characterSet || "UTF-8",
        lastModified: probed?.lastModified || null,
        fileSizeBytes: htmlDl.byteLength,
        sha256: htmlDl.sha256,
        sha256Reason: null
      },
      http: {
        status: httpStatus,
        protocol: probed?.navigation?.nextHopProtocol || null,
        headersSource: headRes?.headers && Object.keys(headRes.headers).length > 0 ? "http-head" : "unavailable",
        responseHeaders: headRes?.headers || {}
      },
      extraction: payload.extraction,
      challenge: challengeRecord,
      files: {
        source: paths.basenames.source,
        markdown: paths.basenames.md,
        metadata: paths.basenames.json
      },
      environment: envInfo
    });

    await downloadTextVerified({
      content: JSON.stringify(metaObj, null, 2),
      filename: paths.json,
      mimeType: "application/json;charset=utf-8",
      isCampaign,
      eraseFromHistory
    });

    return {
      ok: true,
      status: "fetched",
      kind: "html",
      title,
      mimeType: metaObj.resource.mimeType,
      fileSizeBytes: htmlDl.byteLength,
      contentSha256: htmlDl.sha256,
      httpStatus,
      offDomain: offDom,
      finalUrl: effectiveUrl,
      finalCanonicalUrl,
      artifactRelPath: paths.json,
      sourceRelPath: paths.source,
      mdRelPath: paths.md,
      challenge: challengeRecord
    };
  } catch (err) {
    return await writeErrorSidecar({
      status: "failed_retryable",
      errorClass: String(err?.message || "").includes("timed out") ? "timeout" : "download_error",
      reason: err?.message || String(err),
      retryable: true
    });
  } finally {
    await safeCloseTab(tabId);
  }
}

async function saveDirectOffscreenResource({
  url,
  requestedUrl,
  canonicalUrl,
  headInfo,
  expectedKind,
  mode,
  extInfo,
  campaignContext,
  serpContext,
  outputRoot,
  relDirOverride,
  targetSlug,
  targetDomain,
  engine,
  searchSlug,
  overallRank,
  serpTitle,
  attemptNumber,
  startedMs,
  maxBytes,
  isCampaign,
  eraseFromHistory,
  envInfo,
  denylistPatterns,
  blockedExtensions,
  writeErrorSidecar,
  challengeRecord = null,
  allowDirectChromeDownloadFallback = false
}) {
  const res = await sendToOffscreen({
    type: "OFFSCREEN_FETCH_STREAM",
    url,
    maxBytes,
    decodeText: expectedKind === "text"
  });

  if (res && res.tooLarge) {
    return writeErrorSidecar({
      finalUrl: res.finalUrl || url,
      status: "skipped_too_large",
      errorClass: "too_large",
      httpStatus: res.httpStatus,
      reason: res.error,
      retryable: false,
      observedContentLengthBytes: res.observedBytes,
      responseHeaders: res.headers || {}
    });
  }

  if (!res || !res.ok) {
    // If binary WAF fallback is allowed after tab clearance, fall back to direct chrome.downloads with sha256: null
    if (allowDirectChromeDownloadFallback) {
      const offDom = isOffDomain(url, targetDomain);
      const info = classifyResource(url, headInfo?.contentType || "", headInfo?.dispositionFilename || "");
      const title = stripKnownExtension(headInfo?.dispositionFilename || "") || serpTitle || url;
      const paths = buildResultRelativePaths({
        outputRoot,
        relDirOverride,
        targetSlug,
        engine,
        searchSlug,
        overallRank,
        title,
        ext: info.ext,
        kind: "binary"
      });
      const dl = await downloadBlobUrlVerified({
        blobUrl: url,
        filename: paths.source,
        expectedBytes: null,
        isCampaign,
        eraseFromHistory,
        revokeAfter: false
      });
      const fetchedAt = new Date();
      const metaObj = buildResultJson({
        mode,
        extension: extInfo,
        campaign: campaignContext,
        serpContext,
        fetchedAt,
        processingDurationMs: Date.now() - startedMs,
        attemptNumber,
        url: {
          requested: requestedUrl,
          canonical: canonicalUrl,
          final: dl.finalUrl || url,
          finalCanonical: canonicalizeUrl(dl.finalUrl || url) || canonicalUrl,
          offDomain: offDom
        },
        resource: {
          kind: "binary",
          title,
          fileExtension: info.ext,
          mimeType: dl.mime || info.mime || null,
          fileSizeBytes: dl.fileSize,
          sha256: null,
          sha256Reason: `Direct browser download fallback after offscreen fetch failed: ${res?.error || "unknown"}`
        },
        http: {
          status: headInfo?.status ?? null,
          headersSource: headInfo?.headers ? "http-head" : "unavailable",
          responseHeaders: headInfo?.headers || {}
        },
        challenge: challengeRecord,
        files: { source: paths.basenames.source, markdown: null, metadata: paths.basenames.json },
        environment: envInfo
      });
      await downloadTextVerified({
        content: JSON.stringify(metaObj, null, 2),
        filename: paths.json,
        mimeType: "application/json;charset=utf-8",
        isCampaign,
        eraseFromHistory
      });
      return {
        ok: true,
        status: "fetched",
        kind: "binary",
        title,
        mimeType: metaObj.resource.mimeType,
        fileSizeBytes: dl.fileSize,
        contentSha256: null,
        httpStatus: headInfo?.status ?? null,
        offDomain: offDom,
        finalUrl: dl.finalUrl || url,
        finalCanonicalUrl: canonicalizeUrl(dl.finalUrl || url) || canonicalUrl,
        artifactRelPath: paths.json
      };
    }
    // Otherwise let caller fall through to tab-based loading (handles WAF / JS challenges)
    return { fallThroughToTab: true };
  }

  const finalUrl = res.finalUrl || url;
  const postSafety = checkUrlSafety(finalUrl, denylistPatterns, blockedExtensions);
  if (!postSafety.allowed) {
    sendToOffscreen({ type: "OFFSCREEN_REVOKE_BLOB", blobUrl: res.blobUrl }).catch(() => {});
    return writeErrorSidecar({
      finalUrl,
      status: postSafety.status,
      errorClass: postSafety.errorClass,
      httpStatus: res.httpStatus,
      reason: `Post-fetch redirect blocked: ${postSafety.reason}`,
      retryable: false,
      responseHeaders: res.headers
    });
  }

  const kind = res.classified?.kind === "text" && !res.isAttachment ? "text" : "binary";
  const ext = res.classified?.ext || (kind === "text" ? "txt" : "bin");
  const title = stripKnownExtension(res.dispositionFilename || "") || serpTitle || finalUrl;
  const offDom = isOffDomain(finalUrl, targetDomain);
  const paths = buildResultRelativePaths({
    outputRoot,
    relDirOverride,
    targetSlug,
    engine,
    searchSlug,
    overallRank,
    title,
    ext,
    kind
  });

  // Save untouched original source file via Blob URL with exact byte verification
  await downloadBlobUrlVerified({
    blobUrl: res.blobUrl,
    filename: paths.source,
    expectedBytes: res.byteLength,
    isCampaign,
    eraseFromHistory,
    revokeAfter: true
  });

  const fetchedAt = new Date();
  let extraction = null;

  if (kind === "text") {
    const mdContent = formatTextAsMarkdown({
      url: requestedUrl,
      finalUrl,
      title,
      rawText: res.text || "",
      ext,
      mime: res.classified?.mime || res.contentType,
      target: isCampaign ? targetSlug : null,
      searchEngine: engine,
      search: isCampaign ? searchSlug : null,
      rank: overallRank,
      serpPage: serpContext?.pageNumber ?? null,
      timestampUtc: fetchedAt.toISOString(),
      contentSha256: res.sha256,
      truncated: false
    });

    await downloadTextVerified({
      content: mdContent,
      filename: paths.md,
      mimeType: "text/markdown;charset=utf-8",
      isCampaign,
      eraseFromHistory
    });

    extraction = {
      method: "raw_text",
      rawChars: (res.text || "").length,
      markdownChars: mdContent.length,
      readabilityCandidateChars: 0,
      semanticCandidateChars: 0,
      truncated: false,
      warnings: res.decodeWarnings || []
    };
  }

  const finalCanonicalUrl = canonicalizeUrl(finalUrl) || canonicalUrl;
  const metaObj = buildResultJson({
    mode,
    extension: extInfo,
    campaign: campaignContext,
    serpContext,
    fetchedAt,
    processingDurationMs: Date.now() - startedMs,
    attemptNumber,
    url: {
      requested: requestedUrl,
      canonical: canonicalUrl,
      final: finalUrl,
      finalCanonical: finalCanonicalUrl,
      offDomain: offDom
    },
    resource: {
      kind,
      title,
      fileExtension: ext,
      mimeType: res.classified?.mime || res.contentType || null,
      characterSet: res.characterSet || null,
      fileSizeBytes: res.byteLength,
      sha256: res.sha256,
      sha256Reason: null
    },
    http: {
      status: res.httpStatus,
      headersSource: "http-get",
      responseHeaders: res.headers || {}
    },
    extraction,
    challenge: challengeRecord,
    files: {
      source: paths.basenames.source,
      markdown: kind === "text" ? paths.basenames.md : null,
      metadata: paths.basenames.json
    },
    environment: envInfo
  });

  await downloadTextVerified({
    content: JSON.stringify(metaObj, null, 2),
    filename: paths.json,
    mimeType: "application/json;charset=utf-8",
    isCampaign,
    eraseFromHistory
  });

  return {
    ok: true,
    status: "fetched",
    kind,
    title,
    mimeType: metaObj.resource.mimeType,
    fileSizeBytes: res.byteLength,
    contentSha256: res.sha256,
    httpStatus: res.httpStatus,
    offDomain: offDom,
    finalUrl,
    finalCanonicalUrl,
    artifactRelPath: paths.json,
    sourceRelPath: paths.source,
    mdRelPath: kind === "text" ? paths.md : null,
    challenge: challengeRecord
  };
}

/**
 * End-of-Target robots.txt and sitemap capture per REQ-OPS-09.
 * Saves under Downloads/<outputRoot>/<Target>/_site/ (cap 50 files, rejects HTML WAF pages).
 */
export async function captureTargetSiteMetadata({
  campaignId,
  outputRoot,
  target,
  eraseFromHistory = true
}) {
  const siteDir = `${outputRoot}/${target.slug}/_site`;
  const entries = [];
  let savedCount = 0;
  let truncated = false;
  const discoveredSitemaps = new Set();

  const isHtmlContent = (contentType, textSample) => {
    const ct = String(contentType || "").toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
    const trimmed = String(textSample || "").trimStart().slice(0, 200).toLowerCase();
    return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
  };

  const fetchSiteFile = async (url, kind, suggestedName) => {
    if (savedCount >= SITE_CAPTURE_FILE_CAP) {
      truncated = true;
      return { saved: false, text: null };
    }
    const safety = checkUrlSafety(url, [], []);
    if (!safety.allowed) {
      entries.push({
        url,
        kind,
        httpStatus: null,
        savedFile: null,
        fileSizeBytes: null,
        sha256: null,
        retrievedAtUtc: new Date().toISOString(),
        error: safety.reason
      });
      return { saved: false, text: null };
    }

    const res = await sendToOffscreen({
      type: "OFFSCREEN_FETCH_STREAM",
      url,
      maxBytes: SITE_CAPTURE_MAX_FILE_BYTES,
      decodeText: !url.toLowerCase().endsWith(".gz"),
      gunzipXml: url.toLowerCase().endsWith(".gz")
    });

    if (!res || !res.ok) {
      entries.push({
        url,
        kind,
        httpStatus: res?.httpStatus ?? null,
        savedFile: null,
        fileSizeBytes: null,
        sha256: null,
        retrievedAtUtc: new Date().toISOString(),
        error: res?.error || "Fetch failed"
      });
      return { saved: false, text: null };
    }

    // Reject HTML challenge/error pages masquerading as robots.txt or XML sitemap
    if (isHtmlContent(res.contentType, res.text)) {
      sendToOffscreen({ type: "OFFSCREEN_REVOKE_BLOB", blobUrl: res.blobUrl }).catch(() => {});
      entries.push({
        url,
        kind,
        httpStatus: res.httpStatus,
        savedFile: null,
        fileSizeBytes: res.byteLength,
        sha256: null,
        retrievedAtUtc: new Date().toISOString(),
        error: "Rejected HTML response (likely WAF or error page) instead of robots.txt/sitemap"
      });
      return { saved: false, text: null };
    }

    const relPath = `${siteDir}/${suggestedName}`;
    await downloadBlobUrlVerified({
      blobUrl: res.blobUrl,
      filename: relPath,
      expectedBytes: res.byteLength,
      isCampaign: true,
      eraseFromHistory,
      revokeAfter: true
    });
    savedCount++;

    entries.push({
      url,
      kind,
      httpStatus: res.httpStatus,
      savedFile: suggestedName,
      fileSizeBytes: res.byteLength,
      sha256: res.sha256,
      retrievedAtUtc: new Date().toISOString(),
      error: null
    });

    return { saved: true, text: res.text || "" };
  };

  // 1. robots.txt
  const robotsUrl = `https://${target.domain}/robots.txt`;
  const robotsRes = await fetchSiteFile(robotsUrl, "robots", "robots.txt");
  if (robotsRes.saved && robotsRes.text) {
    for (const line of robotsRes.text.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m && m[1]) discoveredSitemaps.add(m[1].trim());
    }
  }

  // Fallback to /sitemap.xml if robots.txt listed none
  if (discoveredSitemaps.size === 0) {
    discoveredSitemaps.add(`https://${target.domain}/sitemap.xml`);
  }

  // 2. Fetch top-level sitemaps and one level of child sitemaps if sitemapindex
  const childSitemaps = new Set();
  let smIndex = 0;

  for (const smUrl of Array.from(discoveredSitemaps)) {
    if (savedCount >= SITE_CAPTURE_FILE_CAP) {
      truncated = true;
      break;
    }
    smIndex++;
    const isGz = smUrl.toLowerCase().endsWith(".gz");
    const name = `sitemap-${String(smIndex).padStart(2, "0")}-${sanitizeSegment(
      smUrl.split("/").pop() || "sitemap",
      "sitemap",
      32
    )}${isGz && !smUrl.toLowerCase().endsWith(".xml.gz") ? ".gz" : ""}`;
    const filename = name.endsWith(".xml") || name.endsWith(".gz") || name.endsWith(".txt") ? name : `${name}.xml`;

    const smRes = await fetchSiteFile(smUrl, "sitemap", filename);
    if (smRes.saved && smRes.text && /<sitemapindex\b/i.test(smRes.text)) {
      entries[entries.length - 1].kind = "sitemap_index";
      const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
      let match;
      while ((match = locRe.exec(smRes.text)) !== null) {
        const childUrl = match[1].trim();
        if (childUrl && !discoveredSitemaps.has(childUrl)) {
          childSitemaps.add(childUrl);
        }
      }
    }
  }

  // One level deep only for sitemap indexes
  for (const childUrl of Array.from(childSitemaps)) {
    discoveredSitemaps.add(childUrl);
    if (savedCount >= SITE_CAPTURE_FILE_CAP) {
      truncated = true;
      break;
    }
    smIndex++;
    const isGz = childUrl.toLowerCase().endsWith(".gz");
    const stem = sanitizeSegment(childUrl.split("/").pop() || "child", "sitemap", 30);
    const filename =
      stem.endsWith(".xml") || stem.endsWith(".gz") || stem.endsWith(".txt")
        ? `sitemap-${String(smIndex).padStart(2, "0")}-${stem}`
        : `sitemap-${String(smIndex).padStart(2, "0")}-${stem}.${isGz ? "xml.gz" : "xml"}`;
    await fetchSiteFile(childUrl, "sitemap", filename);
  }

  const manifestObj = buildSiteCaptureJson({
    campaignId,
    target: {
      domain: target.domain,
      slug: target.slug,
      name: target.name ?? null,
      externalId: target.externalId ?? null
    },
    cap: SITE_CAPTURE_FILE_CAP,
    truncated,
    sitemapsDiscoveredCount: discoveredSitemaps.size,
    entries
  });

  await downloadTextVerified({
    content: JSON.stringify(manifestObj, null, 2),
    filename: `${siteDir}/site-capture.json`,
    mimeType: "application/json;charset=utf-8",
    isCampaign: true,
    eraseFromHistory
  });

  return manifestObj;
}
