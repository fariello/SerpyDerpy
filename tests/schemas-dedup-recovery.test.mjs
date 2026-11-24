import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyResource,
  sniffMagicBytes,
  buildSerpJson,
  buildResultJson,
  buildErrorJson,
  buildSiteCaptureJson,
  buildCampaignSummaryJson,
  buildCampaignReportMarkdown,
  buildSkippedFilesReportMarkdown,
  buildCheckpointJsonl,
  parseAndVerifyCheckpointJsonl,
  formatTextAsMarkdown
} from "../schemas.js";
import {
  evaluateLedgerDeduplication,
  reconcileInterruptedCampaignState,
  mergeUpdatedSearchTasks
} from "../db.js";
import { buildSiteSitemapFilename } from "../fetcher.js";
import {
  claimNextFetchCandidate,
  runSingleFlightTargetCapture,
  shouldEnqueueSerpResult
} from "../scheduler.js";

test("REQ-FETCH-03 & V-06: magic-byte sniffing and resource classification", () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
  assert.equal(sniffMagicBytes(pdfBytes).ext, "pdf");

  const classifiedPdf = classifyResource(
    "https://example.edu/download?id=999",
    "application/octet-stream",
    "",
    pdfBytes
  );
  assert.deepEqual(classifiedPdf, { kind: "binary", ext: "pdf", mime: "application/pdf" });

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(classifyResource("https://example.edu/img", "application/octet-stream", "", pngBytes).ext, "png");

  const mdFormatted = formatTextAsMarkdown({
    url: "https://example.edu/doc.md",
    title: "Guide",
    rawText: "---\nold: header\n---\n\n# Real Heading\n\nBody text.",
    ext: "md",
    mime: "text/markdown",
    timestampUtc: "2026-11-22T12:00:00.000Z"
  });
  assert.ok(mdFormatted.startsWith("---\nURL: "));
  assert.equal(mdFormatted.includes("old: header"), false);
  assert.ok(mdFormatted.includes("# Real Heading"));
});

test("REQ-META-01..05 & REQ-OUT-02: v2 schemas, default IP off, and 200-sample report cap", () => {
  const serp = buildSerpJson({
    mode: "interactive",
    campaign: null,
    environment: { ipAddress: "1.2.3.4", ipAddressRecorded: false }
  });
  assert.equal(serp.schemaVersion, 2);
  assert.equal(serp.mode, "interactive");
  assert.equal(serp.environment.ipAddress, null);
  assert.equal(serp.environment.ipAddressRecorded, false);

  const res = buildResultJson({
    mode: "campaign",
    resource: { kind: "binary", fileExtension: "pdf", sha256: "abc" },
    files: { source: "001-report.pdf", markdown: null, metadata: "001-report.json" },
    environment: { ipAddressRecorded: false }
  });
  assert.equal(res.extraction, null);
  assert.equal(res.files.source, "001-report.pdf");
  assert.equal(res.files.markdown, null);

  const err = buildErrorJson({ status: "failed_permanent", errorClass: "blocked_by_user", retryable: false });
  assert.equal(err.schemaVersion, 2);
  assert.equal(err.retryable, false);

  const site = buildSiteCaptureJson({ campaignId: "c1", target: { domain: "mit.edu" }, truncated: true, sitemapsDiscoveredCount: 60 });
  assert.equal(site.cap, 50);
  assert.equal(site.truncated, true);

  const summary = buildCampaignSummaryJson({
    campaign: { campaignId: "c1", name: "Test", outputRoot: "SerpyDerpy/test", status: "completed", createdAtUtc: "2026-11-22T00:00:00Z", updatedAtUtc: "2026-11-22T01:00:00Z" },
    counts: { targets: 1, searchTasksByStatus: { completed: 3 }, fetchTasksByStatus: { completed: 10 }, offDomainResults: 1, challengesEncountered: 0 }
  });
  assert.equal(summary.schemaVersion, 2);

  // Campaign report caps sample failed URLs at 200
  const manyFailed = Array.from({ length: 350 }, (_, i) => ({
    url: `https://example.edu/fail-${i}`,
    status: "failed_permanent",
    errorClass: "http_4xx",
    reason: "404"
  }));
  const report = buildCampaignReportMarkdown({
    campaign: { campaignId: "c1", name: "Big", status: "stopped", outputRoot: "SerpyDerpy/big", createdAtUtc: "2026-11-22T00:00:00Z" },
    completedAtUtc: "2026-11-22T01:00:00Z",
    sampleFailedUrls: manyFailed,
    totalFailedUrls: manyFailed.length
  });
  assert.ok(report.includes("Sample Failed / Blocked URLs (200 of 350)"));
  assert.equal(report.includes("fail-200"), false);
});

test("REQ-STATE-07 & V-07: JSONL checkpoint round-trip, SHA-256 tamper rejection, and path traversal guard", async () => {
  const jsonl = await buildCheckpointJsonl({
    checkpointKind: "delta",
    seq: 4,
    campaignId: "cmp-1",
    records: [
      { type: "campaign", data: { campaignId: "cmp-1", outputRoot: "SerpyDerpy/demo" } },
      { type: "urlLedger", data: { ledgerKey: "cmp-1::h1", canonicalArtifactRelPath: "SerpyDerpy/demo/mit/google/ai/001-doc.json" } }
    ]
  });

  const ok = await parseAndVerifyCheckpointJsonl(jsonl);
  assert.equal(ok.ok, true);
  assert.equal(ok.records.length, 2);
  assert.equal(ok.header.seq, 4);

  // Tamper body -> SHA-256 must reject
  const tampered = jsonl.replace("001-doc.json", "001-hack.json");
  const badHash = await parseAndVerifyCheckpointJsonl(tampered);
  assert.equal(badHash.ok, false);
  assert.ok(badHash.error.includes("SHA-256"));

  // Path traversal inside otherwise-valid SHA-256 checkpoint must still be rejected (REQ-UI-04)
  const evilJsonl = await buildCheckpointJsonl({
    checkpointKind: "full",
    seq: 1,
    campaignId: "cmp-evil",
    records: [
      { type: "campaign", data: { campaignId: "cmp-evil", outputRoot: "../../etc" } }
    ]
  });
  const badPath = await parseAndVerifyCheckpointJsonl(evilJsonl);
  assert.equal(badPath.ok, false);
  assert.ok(badPath.error.includes("Unsafe path"));
});

test("REQ-STATE-03, REQ-STATE-04, REQ-STATE-06 & V-07: dedup scope, freshness expiry, waiting_dedup, incremental merge, and crash reconciliation", () => {
  const nowMs = Date.parse("2026-11-22T12:00:00.000Z");
  const recentIso = "2026-11-20T12:00:00.000Z"; // 2 days old
  const staleIso = "2026-09-01T12:00:00.000Z";  // > 30 days old

  // Global dedup matches across campaigns; disabling global dedup isolates campaign
  const rows = [
    { campaignId: "cmp-old", status: "fetched", fetchedAtUtc: recentIso, canonicalArtifactRelPath: "SerpyDerpy/old/001.json" }
  ];
  assert.equal(
    evaluateLedgerDeduplication({ ledgerRows: rows, campaignId: "cmp-new", globalDedup: true, freshnessDays: 30, nowMs }).action,
    "skip-and-stub"
  );
  assert.equal(
    evaluateLedgerDeduplication({ ledgerRows: rows, campaignId: "cmp-new", globalDedup: false, freshnessDays: 30, nowMs }).action,
    "fetch"
  );

  // Freshness expiry forces re-download
  const staleRows = [{ campaignId: "cmp-new", status: "fetched", fetchedAtUtc: staleIso }];
  assert.equal(
    evaluateLedgerDeduplication({ ledgerRows: staleRows, campaignId: "cmp-new", globalDedup: true, freshnessDays: 30, nowMs }).action,
    "fetch"
  );

  // In-flight ownership returns non-blocking waiting_dedup
  const inFlightRows = [{ campaignId: "cmp-new", status: "in_progress", fetchedAtUtc: null }];
  assert.equal(
    evaluateLedgerDeduplication({ ledgerRows: inFlightRows, campaignId: "cmp-new", globalDedup: true, freshnessDays: 30, nowMs }).action,
    "waiting_dedup"
  );

  // Incremental task merge reopens completed tasks when pagesRequested increases
  const merged = mergeUpdatedSearchTasks({
    existingTasks: [
      { taskKey: "k1", status: "completed", pagesCompleted: 3, pagesRequested: 3, paginationEndReason: "reached_requested_pages", resolvedQueryHash: "h1" },
      { taskKey: "k2", status: "completed", pagesCompleted: 1, pagesRequested: 3, paginationEndReason: "zero_results", resolvedQueryHash: "h2" }
    ],
    newTasks: [
      { taskKey: "k1", pagesRequested: 7, resolvedQueryHash: "h1" },
      { taskKey: "k2", pagesRequested: 7, resolvedQueryHash: "h2" },
      { taskKey: "k3", pagesRequested: 3, resolvedQueryHash: "h3" }
    ]
  });
  assert.equal(merged.reopenedForMorePages, 1);
  assert.equal(merged.unchangedCompleted, 1);
  assert.equal(merged.newlyAdded, 1);

  // Startup crash reconciliation resets orphaned in_progress items & transitions running -> paused_interrupted under prompt
  const rec = reconcileInterruptedCampaignState({
    campaign: { campaignId: "c1", status: "running" },
    searchTasks: [
      { taskKey: "t1", status: "in_progress", pagesCompleted: 2 },
      { taskKey: "t2", status: "completed", pagesCompleted: 3 }
    ],
    fetchQueue: [{ fetchKey: "f1", status: "in_progress" }, { fetchKey: "f2", status: "waiting_dedup" }],
    urlLedger: [{ ledgerKey: "l1", status: "in_progress" }],
    engineStates: [{ engineKey: "c1::google", status: "working", activeTabId: 42 }],
    hostStates: [{ host: "mit.edu", activeFetchKey: "f1", pausedByChallenge: true }],
    isBrowserStartup: true,
    onBrowserRestart: "prompt"
  });
  assert.equal(rec.action, "prompt");
  assert.equal(rec.campaign.status, "paused_interrupted");
  assert.equal(rec.searchTasks.length, 1);
  assert.equal(rec.searchTasks[0].status, "pending");
  assert.equal(rec.searchTasks[0].pagesCompleted, 2);
  assert.equal(rec.fetchQueue.length, 2);
  assert.equal(rec.hostStates[0].activeFetchKey, null);
  assert.equal(rec.hostStates[0].pausedByChallenge, false);
});

test("REQ-OPS-09: _site sitemap filenames always end with .txt to avoid Edge XML prompts", () => {
  assert.equal(buildSiteSitemapFilename(1, "https://princeton.edu/sitemap.xml"), "sitemap-01-sitemap.xml.txt");
  assert.equal(buildSiteSitemapFilename(2, "https://umass.edu/sitemap.xml.gz"), "sitemap-02-sitemap.xml.gz.txt");
  assert.equal(buildSiteSitemapFilename(3, "https://uri.edu/sitemap.txt"), "sitemap-03-sitemap.txt");
  assert.equal(buildSiteSitemapFilename(4, "https://example.edu/sitemap"), "sitemap-04-sitemap.xml.txt");
});

test("REQ-FETCH-02: claimNextFetchCandidate locks host and fetchKey atomically across concurrent workers", async () => {
  const candidates = [
    { fetchKey: "t1::1", host: "www.princeton.edu" },
    { fetchKey: "t1::2", host: "www.princeton.edu" },
    { fetchKey: "t2::1", host: "www.umass.edu" },
    { fetchKey: "t3::1", host: "www.uri.edu" }
  ];
  const activeHostsInMem = new Set();
  const activeFetchKeysInMem = new Set();

  // Simulated async IndexedDB lookup with delayed yield
  const getHostState = async (host) => {
    await new Promise((r) => setTimeout(r, 15));
    if (host === "www.umass.edu") {
      return { host, cooldownUntilUtc: new Date(Date.now() + 60000).toISOString(), pausedByChallenge: false, activeFetchKey: null };
    }
    return null;
  };

  const results = await Promise.all([
    claimNextFetchCandidate({ candidates, activeHostsInMem, activeFetchKeysInMem, getHostState }),
    claimNextFetchCandidate({ candidates, activeHostsInMem, activeFetchKeysInMem, getHostState }),
    claimNextFetchCandidate({ candidates, activeHostsInMem, activeFetchKeysInMem, getHostState })
  ]);

  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((c) => c.chosen.fetchKey).sort(), ["t1::1", "t3::1"]);
  assert.deepEqual(Array.from(activeHostsInMem).sort(), ["www.princeton.edu", "www.uri.edu"]);
  assert.deepEqual(Array.from(activeFetchKeysInMem).sort(), ["t1::1", "t3::1"]);

  // Same-host contention: 3 concurrent workers on one host must yield only 1 claim
  const sameHost = [
    { fetchKey: "s::1", host: "same.edu" },
    { fetchKey: "s::2", host: "same.edu" }
  ];
  const sHosts = new Set();
  const sKeys = new Set();
  const sameHostClaims = (
    await Promise.all([
      claimNextFetchCandidate({ candidates: sameHost, activeHostsInMem: sHosts, activeFetchKeysInMem: sKeys, getHostState }),
      claimNextFetchCandidate({ candidates: sameHost, activeHostsInMem: sHosts, activeFetchKeysInMem: sKeys, getHostState }),
      claimNextFetchCandidate({ candidates: sameHost, activeHostsInMem: sHosts, activeFetchKeysInMem: sKeys, getHostState })
    ])
  ).filter(Boolean);
  assert.equal(sameHostClaims.length, 1);
  assert.equal(sameHostClaims[0].chosen.fetchKey, "s::1");
});

test("SERP off-domain enqueue guard & uncapped end-of-run Skipped Files report", () => {
  // target-site scope drops off-domain SERP links before enqueueing; web scope allows them
  assert.equal(shouldEnqueueSerpResult({ scope: "target-site", offDomain: true, fetchLinks: true }), false);
  assert.equal(shouldEnqueueSerpResult({ scope: "target-site", offDomain: false, fetchLinks: true }), true);
  assert.equal(shouldEnqueueSerpResult({ scope: "web", offDomain: true, fetchLinks: true }), true);
  assert.equal(shouldEnqueueSerpResult({ scope: "web", offDomain: false, fetchLinks: false }), false);

  // Uncapped skipped-files report groups and sorts skipped_too_large largest-first alongside skipped_policy
  const md = buildSkippedFilesReportMarkdown({
    campaign: { campaignId: "cmp-1", name: "Pilot", config: { maxFileSizeMb: 50 } },
    generatedAtUtc: "2026-11-24T05:00:00.000Z",
    skippedItems: [
      {
        targetSlug: "princeton-edu",
        engine: "google",
        searchSlug: "pol01-g",
        status: "skipped_too_large",
        errorClass: "too_large",
        title: "Huge Deck A",
        url: "https://example.edu/a.pdf",
        observedContentLengthBytes: 60 * 1024 * 1024,
        reason: "HEAD Content-Length exceeds limit"
      },
      {
        targetSlug: "umass-edu",
        engine: "bing",
        searchSlug: "pol01-bd",
        status: "skipped_too_large",
        errorClass: "too_large",
        title: "Huge Deck B",
        url: "https://example.edu/b.pdf",
        observedContentLengthBytes: 95 * 1024 * 1024,
        reason: "HEAD Content-Length exceeds limit"
      },
      {
        targetSlug: "uri-edu",
        engine: "google",
        searchSlug: "pol01-g",
        status: "skipped_policy",
        errorClass: "denylist",
        title: "Repo Index",
        url: "https://digitalcommons.uri.edu/2026.html",
        observedContentLengthBytes: null,
        reason: "Matched denylist pattern: digitalcommons."
      }
    ]
  });

  assert.ok(md.includes("Configured `maxFileSizeMb`:** 50 MB"));
  assert.ok(md.includes("Total Skipped Files:** 3 (`2` oversized, `1` policy/denylist)"));
  assert.ok(md.includes("95.00 MB"));
  assert.ok(md.includes("60.00 MB"));
  assert.ok(md.indexOf("95.00 MB") < md.indexOf("60.00 MB"), "Oversized files should sort largest-first");
  assert.ok(md.includes("https://digitalcommons.uri.edu/2026.html"));
});

test("REQ-OPS-09: runSingleFlightTargetCapture runs _site capture at most once across concurrent callers", async () => {
  const inFlightKeys = new Set();
  const completedKeys = new Set();
  let runCount = 0;

  const trigger = (isAlreadyCaptured = false) =>
    runSingleFlightTargetCapture({
      inFlightKeys,
      completedKeys,
      key: "cmp-1::princeton-edu",
      isAlreadyCaptured,
      fn: async () => {
        runCount++;
        await new Promise((r) => setTimeout(r, 20));
      }
    });

  // 3 engine lanes + fetch sweep trigger concurrently
  const results = await Promise.all([trigger(), trigger(), trigger(), trigger()]);
  assert.equal(runCount, 1);
  assert.deepEqual(results, [true, false, false, false]);
  assert.equal(inFlightKeys.size, 0);
  assert.equal(completedKeys.has("cmp-1::princeton-edu"), true);

  // Subsequent call after completion (or when DB already lists target) is a no-op
  assert.equal(await trigger(false), false);
  assert.equal(await trigger(true), false);
  assert.equal(runCount, 1);
});
