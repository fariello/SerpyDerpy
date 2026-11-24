import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RELATIVE_PATH_LENGTH,
  sanitizeSegment,
  validateOutputRoot,
  validateRelativePath,
  computeTargetSlug,
  buildSerpRelativePaths,
  buildResultRelativePaths,
  canonicalizeUrl,
  isOffDomain,
  checkUrlSafety
} from "../naming.js";

test("REQ-OUT-07: sanitizeSegment handles illegal Windows chars, Unicode, and reserved device names", () => {
  assert.equal(sanitizeSegment("CON"), "_con");
  assert.equal(sanitizeSegment("NUL.txt"), "_nul.txt");
  assert.equal(sanitizeSegment("com9"), "_com9");
  assert.equal(sanitizeSegment("  Hello: World? <2026> | Café  "), "hello-world-2026-cafe");
  assert.equal(sanitizeSegment("...///..."), "item");
});

test("REQ-OUT-01 & REQ-UI-04: validateOutputRoot and validateRelativePath block traversal and drive letters", () => {
  assert.equal(validateOutputRoot("SerpyDerpy/auto-robotics").ok, true);
  assert.equal(validateOutputRoot("../escape").ok, false);
  assert.equal(validateOutputRoot("C:/Windows/System32").ok, false);
  assert.equal(validateOutputRoot("/leading/slash").ok, false);
  assert.equal(validateOutputRoot("back\\slash").ok, false);
  assert.equal(validateOutputRoot("a".repeat(61)).ok, false);
  assert.equal(validateRelativePath("SerpyDerpy/x/../../evil.json").ok, false);
  assert.equal(validateRelativePath("SerpyDerpy/ok/001-doc.json").ok, true);
});

test("REQ-OUT-08: long Target slugs truncate with collision-free 4-hex hash", async () => {
  const a = await computeTargetSlug("university-of-california-santa-barbara-campus-north-west-engineering", 36);
  const b = await computeTargetSlug("university-of-california-santa-barbara-campus-south-east-humanities", 36);
  assert.equal(a.shortened, true);
  assert.equal(b.shortened, true);
  assert.ok(a.slug.length <= 36);
  assert.ok(b.slug.length <= 36);
  assert.notEqual(a.slug, b.slug);
});

test("REQ-OUT-03, REQ-OUT-04, REQ-OUT-06, REQ-OUT-08: 200-char stress test stays <= 185 chars", async () => {
  const longRoot = "SerpyDerpy/" + "x".repeat(44); // 55 chars (<= 60)
  const longTarget = await computeTargetSlug("organization-" + "alpha-beta-".repeat(20), 36);
  const longSearch = "super-long-search-query-" + "keyword-".repeat(25);
  const longTitle = "Annual Report on Global Manufacturing Robotics and Artificial Intelligence ".repeat(4);

  const serp = await buildSerpRelativePaths({
    outputRoot: longRoot,
    targetSlug: longTarget.slug,
    fullTargetSlug: longTarget.fullSlug,
    engine: "duckduckgo",
    searchSlug: sanitizeSegment(longSearch, "search", 28),
    fullSearchSlug: sanitizeSegment(longSearch, "search"),
    pageNumber: 11
  });

  assert.ok(serp.html.length <= MAX_RELATIVE_PATH_LENGTH, `SERP HTML path too long: ${serp.html.length}`);
  assert.ok(serp.json.length <= MAX_RELATIVE_PATH_LENGTH, `SERP JSON path too long: ${serp.json.length}`);
  assert.ok(serp.basenames.json.startsWith("000-"));
  assert.ok(serp.basenames.json.endsWith("-results.page11.json"));

  const resHtml = buildResultRelativePaths({
    outputRoot: longRoot,
    targetSlug: longTarget.slug,
    engine: "duckduckgo",
    searchSlug: sanitizeSegment(longSearch, "search", 28),
    overallRank: 7,
    title: longTitle,
    ext: "html",
    kind: "html"
  });
  assert.ok(resHtml.source.length <= MAX_RELATIVE_PATH_LENGTH);
  assert.ok(resHtml.errorJson.length <= MAX_RELATIVE_PATH_LENGTH);
  assert.ok(resHtml.basenames.source.startsWith("007-"));

  // Raw JSON source must save as .raw.json so it never collides with metadata .json
  const resJson = buildResultRelativePaths({
    outputRoot: "SerpyDerpy/test",
    targetSlug: "toyota-com",
    engine: "google",
    searchSlug: "api-spec",
    overallRank: 12,
    title: "Data Feed",
    ext: "json",
    kind: "text"
  });
  assert.equal(resJson.basenames.source, "012-data-feed.raw.json");
  assert.equal(resJson.basenames.md, "012-data-feed.md");
  assert.equal(resJson.basenames.json, "012-data-feed.json");

  // Raw Markdown source saves as .raw.md
  const resMd = buildResultRelativePaths({
    outputRoot: "SerpyDerpy/test",
    targetSlug: "toyota-com",
    engine: "google",
    searchSlug: "readme",
    overallRank: 100,
    title: "Project Guide",
    ext: "md",
    kind: "text"
  });
  assert.equal(resMd.basenames.source, "100-project-guide.raw.md");
  assert.equal(resMd.basenames.md, "100-project-guide.md");
});

test("REQ-STATE-02 & REQ-OPS-06: URL canonicalization, off-domain detection, SSRF, and denylist", () => {
  const c1 = canonicalizeUrl("HTTPS://Example.EDU:443/path?b=2&utm_source=google&a=1&gclid=xyz#section");
  const c2 = canonicalizeUrl("https://example.edu/path?a=1&b=2&fbclid=999");
  assert.equal(c1, "https://example.edu/path?a=1&b=2");
  assert.equal(c1, c2);

  // Percent-encoded unreserved characters (%7E -> ~) and Drupal numeric cache-busters (?1785855171=)
  assert.equal(
    canonicalizeUrl("https://www.cs.princeton.edu/%7Earvindn/talks/MIT-STS-AI-snakeoil.pdf"),
    canonicalizeUrl("https://www.cs.princeton.edu/~arvindn/talks/MIT-STS-AI-snakeoil.pdf")
  );
  assert.equal(
    canonicalizeUrl("https://www.umass.edu/registrar/sites/default/files/2026-08/academicregs.pdf?1785855171="),
    "https://www.umass.edu/registrar/sites/default/files/2026-08/academicregs.pdf"
  );

  assert.equal(isOffDomain("https://ai.princeton.edu/policy", "princeton.edu"), false);
  assert.equal(isOffDomain("https://princeton.edu/", "princeton.edu"), false);
  assert.equal(isOffDomain("https://campusgroups.com/princeton", "princeton.edu"), true);
  assert.equal(isOffDomain("https://notprinceton.edu/", "princeton.edu"), true);

  // SSRF private-network blocking (V-09)
  for (const bad of [
    "http://localhost/admin",
    "http://127.0.0.1:8080/secret",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.5.4/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "https://printer.local/",
    "https://service.internal/"
  ]) {
    const chk = checkUrlSafety(bad);
    assert.equal(chk.allowed, false, `Expected SSRF block for ${bad}`);
    assert.equal(chk.errorClass, "ssrf_blocked", `Expected ssrf_blocked for ${bad}`);
  }

  // Executable & non-HTTP schemes blocked
  for (const bad of [
    "https://example.edu/installer.exe",
    "https://example.edu/setup.msi",
    "https://example.edu/script.ps1",
    "https://example.edu/Shibboleth.sso/Login",
    "mailto:test@example.edu",
    "javascript:alert(1)"
  ]) {
    const chk = checkUrlSafety(bad);
    assert.equal(chk.allowed, false, `Expected policy block for ${bad}`);
    assert.equal(chk.errorClass, "denylist");
  }

  assert.equal(checkUrlSafety("https://princeton.edu/ai/report.pdf").allowed, true);
});
