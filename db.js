/**
 * SerpyDerpy v2 — IndexedDB Persistence Layer (SerpyDerpyDB)
 * Implements Section 9 (REQ-STATE-01 through REQ-STATE-07).
 * Includes pure state-reconciliation and deduplication helpers testable in Node.js.
 */

import { buildCheckpointJsonl, parseAndVerifyCheckpointJsonl } from "./schemas.js";

export const DB_NAME = "SerpyDerpyDB";
export const DB_VERSION = 1;
export const MAX_EVENTS_RING_BUFFER = 5000;

export const STORES = {
  campaigns: "campaigns",
  searchTasks: "searchTasks",
  urlLedger: "urlLedger",
  fetchQueue: "fetchQueue",
  engineState: "engineState",
  hostState: "hostState",
  events: "events"
};

let dbPromise = null;

/**
 * Open or initialize SerpyDerpyDB with all 7 stores and compound indexes (REQ-STATE-01).
 */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (evt) => {
      const db = evt.target.result;

      if (!db.objectStoreNames.contains(STORES.campaigns)) {
        db.createObjectStore(STORES.campaigns, { keyPath: "campaignId" });
      }

      if (!db.objectStoreNames.contains(STORES.searchTasks)) {
        const st = db.createObjectStore(STORES.searchTasks, { keyPath: "taskKey" });
        st.createIndex("byCampaignEngineStatus", ["campaignId", "engine", "status"], { unique: false });
        st.createIndex("byCampaignStatus", ["campaignId", "status"], { unique: false });
        st.createIndex("byTargetSlug", "targetSlug", { unique: false });
        st.createIndex("byCampaignTarget", ["campaignId", "targetSlug"], { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.urlLedger)) {
        const ul = db.createObjectStore(STORES.urlLedger, { keyPath: "ledgerKey" });
        ul.createIndex("byHashFetchedAt", ["canonicalUrlHash", "fetchedAtUtc"], { unique: false });
        ul.createIndex("byHash", "canonicalUrlHash", { unique: false });
        ul.createIndex("byCampaign", "campaignId", { unique: false });
        ul.createIndex("byHost", "host", { unique: false });
        ul.createIndex("byStatus", "status", { unique: false });
        ul.createIndex("byFetchedAt", "fetchedAtUtc", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.fetchQueue)) {
        const fq = db.createObjectStore(STORES.fetchQueue, { keyPath: "fetchKey" });
        fq.createIndex("byCampaignStatus", ["campaignId", "status"], { unique: false });
        fq.createIndex("byCampaignTargetStatus", ["campaignId", "targetSlug", "status"], { unique: false });
        fq.createIndex("byHost", "host", { unique: false });
        fq.createIndex("byHash", "canonicalUrlHash", { unique: false });
        fq.createIndex("byTaskKey", "taskKey", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.engineState)) {
        db.createObjectStore(STORES.engineState, { keyPath: "engineKey" });
      }

      if (!db.objectStoreNames.contains(STORES.hostState)) {
        db.createObjectStore(STORES.hostState, { keyPath: "host" });
      }

      if (!db.objectStoreNames.contains(STORES.events)) {
        const ev = db.createObjectStore(STORES.events, { keyPath: "id", autoIncrement: true });
        ev.createIndex("byCampaign", "campaignId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error("Failed to open SerpyDerpyDB"));
    };
  });
  return dbPromise;
}

/**
 * Open an IndexedDB transaction using { durability: "strict" } for write commits (REQ-STATE-05 #0).
 */
function createTransaction(db, storeNames, mode = "readonly") {
  if (mode === "readwrite") {
    try {
      return db.transaction(storeNames, mode, { durability: "strict" });
    } catch (_) {
      return db.transaction(storeNames, mode);
    }
  }
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction error"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

export async function getRecord(storeName, key) {
  const db = await openDb();
  const tx = createTransaction(db, [storeName], "readonly");
  return reqToPromise(tx.objectStore(storeName).get(key));
}

export async function putRecord(storeName, value) {
  const db = await openDb();
  const tx = createTransaction(db, [storeName], "readwrite");
  tx.objectStore(storeName).put(value);
  await txDone(tx);
  return value;
}

export async function putMany(storeName, values) {
  if (!values || values.length === 0) return;
  const db = await openDb();
  const tx = createTransaction(db, [storeName], "readwrite");
  const store = tx.objectStore(storeName);
  for (const v of values) store.put(v);
  await txDone(tx);
}

export async function getAllRecords(storeName) {
  const db = await openDb();
  const tx = createTransaction(db, [storeName], "readonly");
  return reqToPromise(tx.objectStore(storeName).getAll());
}

export async function getAllByIndex(storeName, indexName, query) {
  const db = await openDb();
  const tx = createTransaction(db, [storeName], "readonly");
  const idx = tx.objectStore(storeName).index(indexName);
  return reqToPromise(query !== undefined ? idx.getAll(query) : idx.getAll());
}

export async function countByIndex(storeName, indexName, query) {
  const db = await openDb();
  const tx = createTransaction(db, [storeName], "readonly");
  const idx = tx.objectStore(storeName).index(indexName);
  return reqToPromise(query !== undefined ? idx.count(query) : idx.count());
}

/**
 * Atomic commit point 1 (REQ-STATE-05 #1):
 * Commit updated Search Task (pagesCompleted, lastSerpUrl, nextRank, etc.) AND newly enqueued fetchQueue items
 * in a single strict-durability transaction.
 */
export async function commitSerpPageAndEnqueue({ searchTask, fetchItems = [], engineState = null }) {
  const db = await openDb();
  const stores = [STORES.searchTasks, STORES.fetchQueue];
  if (engineState) stores.push(STORES.engineState);
  const tx = createTransaction(db, stores, "readwrite");

  tx.objectStore(STORES.searchTasks).put(searchTask);
  const fqStore = tx.objectStore(STORES.fetchQueue);
  for (const item of fetchItems) {
    fqStore.put(item);
  }
  if (engineState) {
    tx.objectStore(STORES.engineState).put(engineState);
  }
  await txDone(tx);
}

/**
 * Atomic commit point 2 (REQ-STATE-05 #2):
 * Commit urlLedger row(s) (supporting redirect aliasing), fetchQueue item, and hostState in one strict transaction.
 */
export async function commitFetchOutcome({ ledgerRows = [], fetchItem, hostState = null }) {
  const db = await openDb();
  const stores = [STORES.urlLedger, STORES.fetchQueue];
  if (hostState) stores.push(STORES.hostState);
  const tx = createTransaction(db, stores, "readwrite");

  const ulStore = tx.objectStore(STORES.urlLedger);
  for (const row of ledgerRows) {
    ulStore.put(row);
  }
  if (fetchItem) {
    tx.objectStore(STORES.fetchQueue).put(fetchItem);
  }
  if (hostState) {
    tx.objectStore(STORES.hostState).put(hostState);
  }
  await txDone(tx);
}

/**
 * Append a structured event to the bounded 5,000-row events ring buffer (REQ-STATE-01 #7).
 */
export async function appendEvent({ campaignId, level = "info", component = "system", message = "", details = null }) {
  const db = await openDb();
  const tx = createTransaction(db, [STORES.events], "readwrite");
  const store = tx.objectStore(STORES.events);
  const entry = {
    timestampUtc: new Date().toISOString(),
    campaignId: campaignId || null,
    level,
    component,
    message,
    details
  };
  store.add(entry);

  // Trim oldest entries if above MAX_EVENTS_RING_BUFFER
  const count = await reqToPromise(store.count());
  if (count > MAX_EVENTS_RING_BUFFER) {
    const excess = count - MAX_EVENTS_RING_BUFFER;
    let deleted = 0;
    await new Promise((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && deleted < excess) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }
  await txDone(tx);
  return entry;
}

/**
 * Pure deduplication and freshness lookup helper (REQ-STATE-03).
 * Evaluates candidate `urlLedger` rows for a canonicalUrlHash against global vs campaign scope and freshnessDays.
 */
export function evaluateLedgerDeduplication({
  ledgerRows = [],
  campaignId,
  globalDedup = true,
  freshnessDays = 30,
  nowMs = Date.now(),
  dedupPolicy = "skip-and-stub"
}) {
  const matching = ledgerRows.filter((row) => {
    if (!row) return false;
    if (!globalDedup && row.campaignId !== campaignId) return false;
    return true;
  });

  if (matching.length === 0) {
    return { action: "fetch", match: null };
  }

  // 1. Check in-flight ownership first (REQ-STATE-03 non-blocking wait)
  const inFlight = matching.find((r) =>
    r.status === "pending" || r.status === "in_progress" || r.status === "paused_challenge"
  );
  if (inFlight) {
    return { action: "waiting_dedup", match: inFlight };
  }

  // Sort newest first by fetchedAtUtc / updatedAtUtc
  const sorted = [...matching].sort((a, b) => {
    const ta = Date.parse(a.fetchedAtUtc || a.updatedAtUtc || 0) || 0;
    const tb = Date.parse(b.fetchedAtUtc || b.updatedAtUtc || 0) || 0;
    return tb - ta;
  });

  const maxAgeMs =
    freshnessDays === null || freshnessDays === undefined || freshnessDays <= 0
      ? Infinity
      : freshnessDays * 24 * 60 * 60 * 1000;

  const isFresh = (row) => {
    const ts = Date.parse(row.fetchedAtUtc || row.updatedAtUtc || 0);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return nowMs - ts <= maxAgeMs;
  };

  // 2. Check newest unexpired fetched record
  const freshFetched = sorted.find((r) => r.status === "fetched" && isFresh(r));
  if (freshFetched) {
    if (dedupPolicy === "refetch-per-search") {
      return { action: "fetch", match: freshFetched };
    }
    return {
      action: dedupPolicy === "skip-silent" ? "skip-silent" : "skip-and-stub",
      match: freshFetched
    };
  }

  // 3. Check unexpired terminal non-retryable disposition (failed_permanent, skipped_too_large, skipped_policy)
  const freshTerminal = sorted.find(
    (r) =>
      (r.status === "failed_permanent" || r.status === "skipped_too_large" || r.status === "skipped_policy") &&
      isFresh(r)
  );
  if (freshTerminal) {
    return { action: "propagate_terminal", match: freshTerminal };
  }

  // 4. Otherwise (expired or failed_retryable): eligible to fetch/retry
  return { action: "fetch", match: sorted[0] || null };
}

/**
 * Look up deduplication disposition directly in IndexedDB (REQ-STATE-03).
 */
export async function lookupUrlDeduplication({
  canonicalUrlHash,
  campaignId,
  globalDedup = true,
  freshnessDays = 30,
  dedupPolicy = "skip-and-stub",
  nowMs = Date.now()
}) {
  const rows = await getAllByIndex(STORES.urlLedger, "byHash", canonicalUrlHash);
  return evaluateLedgerDeduplication({
    ledgerRows: rows,
    campaignId,
    globalDedup,
    freshnessDays,
    dedupPolicy,
    nowMs
  });
}

/**
 * Pure crash / Windows reboot reconciliation logic (REQ-STATE-06).
 * Resets orphaned in_progress searchTasks, fetchQueue, urlLedger, engineState, and hostState locks.
 */
export function reconcileInterruptedCampaignState({
  campaign,
  searchTasks = [],
  fetchQueue = [],
  urlLedger = [],
  engineStates = [],
  hostStates = [],
  isBrowserStartup = true,
  existingTabIds = new Set(),
  onBrowserRestart = "prompt",
  nowIso = new Date().toISOString()
}) {
  const updatedSearchTasks = [];
  const updatedFetchQueue = [];
  const updatedUrlLedger = [];
  const updatedEngineStates = [];
  const updatedHostStates = [];

  for (const st of searchTasks) {
    if (st.status === "in_progress" || (isBrowserStartup && st.status === "paused_challenge")) {
      updatedSearchTasks.push({
        ...st,
        status: "pending",
        updatedAtUtc: nowIso
      });
    }
  }

  for (const fq of fetchQueue) {
    if (fq.status === "in_progress" || fq.status === "waiting_dedup" || (isBrowserStartup && fq.status === "paused_challenge")) {
      updatedFetchQueue.push({
        ...fq,
        status: "pending",
        updatedAtUtc: nowIso
      });
    }
  }

  for (const ul of urlLedger) {
    if (ul.status === "in_progress" || ul.status === "pending" || (isBrowserStartup && ul.status === "paused_challenge")) {
      updatedUrlLedger.push({
        ...ul,
        status: "failed_retryable",
        errorClass: ul.errorClass || "network_error",
        lastError: "Interrupted before completion; eligible for retry",
        updatedAtUtc: nowIso
      });
    }
  }

  for (const es of engineStates) {
    const tabGone = es.activeTabId != null && !existingTabIds.has(es.activeTabId);
    if (isBrowserStartup || tabGone) {
      updatedEngineStates.push({
        ...es,
        status: es.status === "paused_cooldown" && es.cooldownUntilUtc ? "paused_cooldown" : "idle",
        activeTabId: null,
        activeTaskKey: null
      });
    }
  }

  for (const hs of hostStates) {
    if (isBrowserStartup || hs.activeFetchKey || hs.pausedByChallenge) {
      updatedHostStates.push({
        ...hs,
        activeFetchKey: null,
        pausedByChallenge: isBrowserStartup ? false : hs.pausedByChallenge
      });
    }
  }

  let updatedCampaign = { ...campaign, updatedAtUtc: nowIso };
  let action = "none";

  if (campaign.status === "running") {
    if (isBrowserStartup) {
      if (onBrowserRestart === "auto-resume") {
        action = "auto-resume";
      } else {
        updatedCampaign.status = "paused_interrupted";
        action = "prompt";
      }
    } else {
      action = "resume_sw_wake";
    }
  }

  return {
    action,
    campaign: updatedCampaign,
    searchTasks: updatedSearchTasks,
    fetchQueue: updatedFetchQueue,
    urlLedger: updatedUrlLedger,
    engineStates: updatedEngineStates,
    hostStates: updatedHostStates
  };
}

/**
 * Apply startup/wake reconciliation against IndexedDB for all running campaigns.
 */
export async function reconcileAllCampaignsInDb({ isBrowserStartup = true, existingTabIds = new Set() } = {}) {
  const campaigns = await getAllRecords(STORES.campaigns);
  const results = [];

  for (const campaign of campaigns) {
    if (campaign.status !== "running") continue;

    const searchTasks = (await getAllRecords(STORES.searchTasks)).filter((t) => t.campaignId === campaign.campaignId);
    const fetchQueue = (await getAllRecords(STORES.fetchQueue)).filter((f) => f.campaignId === campaign.campaignId);
    const urlLedger = await getAllByIndex(STORES.urlLedger, "byCampaign", campaign.campaignId);
    const engineStates = (await getAllRecords(STORES.engineState)).filter((e) => e.campaignId === campaign.campaignId);
    const hostStates = await getAllRecords(STORES.hostState);

    const reconciled = reconcileInterruptedCampaignState({
      campaign,
      searchTasks,
      fetchQueue,
      urlLedger,
      engineStates,
      hostStates,
      isBrowserStartup,
      existingTabIds,
      onBrowserRestart: campaign.config?.onBrowserRestart || "prompt"
    });

    const db = await openDb();
    const tx = createTransaction(
      db,
      [STORES.campaigns, STORES.searchTasks, STORES.fetchQueue, STORES.urlLedger, STORES.engineState, STORES.hostState],
      "readwrite"
    );
    tx.objectStore(STORES.campaigns).put(reconciled.campaign);
    for (const st of reconciled.searchTasks) tx.objectStore(STORES.searchTasks).put(st);
    for (const fq of reconciled.fetchQueue) tx.objectStore(STORES.fetchQueue).put(fq);
    for (const ul of reconciled.urlLedger) tx.objectStore(STORES.urlLedger).put(ul);
    for (const es of reconciled.engineStates) tx.objectStore(STORES.engineState).put(es);
    for (const hs of reconciled.hostStates) tx.objectStore(STORES.hostState).put(hs);
    await txDone(tx);

    results.push(reconciled);
  }

  return results;
}

/**
 * Incremental Roster / Search update merge per REQ-STATE-04.
 * Preserves unchanged completed tasks; reopens completed tasks whose pagesRequested increased
 * when paginationEndReason === "reached_requested_pages"; warns if slug reused with different resolvedQueryHash.
 */
export function mergeUpdatedSearchTasks({ existingTasks = [], newTasks = [] }) {
  const existingMap = new Map(existingTasks.map((t) => [t.taskKey, t]));
  const toSave = [];
  const slugConflicts = [];
  let unchangedCompleted = 0;
  let reopenedForMorePages = 0;
  let newlyAdded = 0;

  for (const nt of newTasks) {
    const ex = existingMap.get(nt.taskKey);
    if (!ex) {
      toSave.push(nt);
      newlyAdded++;
      continue;
    }

    if (ex.resolvedQueryHash && nt.resolvedQueryHash && ex.resolvedQueryHash !== nt.resolvedQueryHash) {
      slugConflicts.push({
        taskKey: nt.taskKey,
        existingQuery: ex.resolvedQuery,
        newQuery: nt.resolvedQuery
      });
      continue;
    }

    if (ex.status === "completed") {
      if (nt.pagesRequested > ex.pagesCompleted && ex.paginationEndReason === "reached_requested_pages") {
        toSave.push({
          ...ex,
          pagesRequested: nt.pagesRequested,
          status: "pending",
          updatedAtUtc: new Date().toISOString()
        });
        reopenedForMorePages++;
      } else {
        unchangedCompleted++;
      }
    } else {
      toSave.push({
        ...ex,
        pagesRequested: nt.pagesRequested,
        fetchLinks: nt.fetchLinks,
        updatedAtUtc: new Date().toISOString()
      });
    }
  }

  return {
    toSave,
    slugConflicts,
    unchangedCompleted,
    reopenedForMorePages,
    newlyAdded
  };
}

/**
 * Export full campaign state to JSONL checkpoint string (REQ-STATE-07).
 */
export async function exportFullCheckpointJsonl(campaignId, seq = 0) {
  const campaign = await getRecord(STORES.campaigns, campaignId);
  if (!campaign) throw new Error(`Campaign "${campaignId}" not found.`);

  const searchTasks = (await getAllRecords(STORES.searchTasks)).filter((t) => t.campaignId === campaignId);
  const urlLedger = await getAllByIndex(STORES.urlLedger, "byCampaign", campaignId);
  const fetchQueue = (await getAllRecords(STORES.fetchQueue)).filter((f) => f.campaignId === campaignId);
  const engineStates = (await getAllRecords(STORES.engineState)).filter((e) => e.campaignId === campaignId);
  const hostStates = await getAllRecords(STORES.hostState);

  const records = [
    { type: "campaign", data: campaign },
    ...searchTasks.map((data) => ({ type: "searchTask", data })),
    ...urlLedger.map((data) => ({ type: "urlLedger", data })),
    ...fetchQueue.map((data) => ({ type: "fetchQueue", data })),
    ...engineStates.map((data) => ({ type: "engineState", data })),
    ...hostStates.map((data) => ({ type: "hostState", data }))
  ];

  return buildCheckpointJsonl({
    checkpointKind: "full",
    seq,
    campaignId,
    records
  });
}

/**
 * Replay verified JSONL checkpoint files (full + deltas in sequence order) into IndexedDB (REQ-STATE-07).
 */
export async function importCheckpointsIntoDb(jsonlTexts = []) {
  const parsed = [];
  for (const text of jsonlTexts) {
    const res = await parseAndVerifyCheckpointJsonl(text);
    if (!res.ok) return { ok: false, error: res.error };
    parsed.push(res);
  }

  // Sort: full snapshots first, then deltas by seq ascending
  parsed.sort((a, b) => {
    if (a.header.checkpointKind !== b.header.checkpointKind) {
      return a.header.checkpointKind === "full" ? -1 : 1;
    }
    return (a.header.seq || 0) - (b.header.seq || 0);
  });

  const typeToStore = {
    campaign: STORES.campaigns,
    searchTask: STORES.searchTasks,
    urlLedger: STORES.urlLedger,
    fetchQueue: STORES.fetchQueue,
    engineState: STORES.engineState,
    hostState: STORES.hostState
  };

  let importedRecords = 0;
  let campaignId = null;
  const db = await openDb();
  const tx = createTransaction(db, Object.values(typeToStore), "readwrite");

  for (const file of parsed) {
    campaignId = file.header.campaignId || campaignId;
    for (const rec of file.records) {
      const storeName = typeToStore[rec.type];
      if (storeName) {
        tx.objectStore(storeName).put(rec.data);
        importedRecords++;
      }
    }
  }
  await txDone(tx);

  return { ok: true, campaignId, filesImported: parsed.length, importedRecords };
}
