import test from "node:test";
import assert from "node:assert/strict";

import {
  sampleBoundedDelay,
  validateDelayTriple,
  extractQueryRelevanceTerms,
  evaluateDecoyAdRelevance,
  selectSafeDecoy
} from "../pacing.js";

// Deterministic PRNG (mulberry32) so tests are 100% reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("REQ-ENG-08 & V-04: 10,000-draw bounded delay distribution satisfies bounds, mean, and skew direction", () => {
  const cases = [
    { min: 3, max: 30, mean: 7.5, skew: "right" },
    { min: 3, max: 30, mean: 10, skew: "right" },
    { min: 2, max: 30, mean: 5, skew: "right" },
    { min: 3, max: 30, mean: 16.5, skew: "symmetric" },
    { min: 3, max: 30, mean: 24, skew: "left" }
  ];

  for (const c of cases) {
    const rng = mulberry32(12345 + Math.round(c.mean * 100));
    const samples = [];
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const v = sampleBoundedDelay(c.min, c.max, c.mean, rng);
      assert.ok(v >= c.min && v <= c.max, `Draw ${v} out of [${c.min}, ${c.max}]`);
      samples.push(v);
      sum += v;
    }
    const sampleMean = sum / samples.length;
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const relErr = Math.abs(sampleMean - c.mean) / c.mean;
    assert.ok(relErr <= 0.05, `Mean drift too high for ${JSON.stringify(c)}: got ${sampleMean}`);

    if (c.skew === "right") {
      assert.ok(median < sampleMean, `Expected right-skew median (${median}) < mean (${sampleMean})`);
    } else if (c.skew === "left") {
      assert.ok(median > sampleMean, `Expected left-skew median (${median}) > mean (${sampleMean})`);
    }
  }

  // Reject mean <= min or mean >= max (OQ-19)
  assert.equal(validateDelayTriple({ min: 3, max: 30, mean: 3 }).ok, false);
  assert.equal(validateDelayTriple({ min: 3, max: 30, mean: 30 }).ok, false);
  assert.equal(validateDelayTriple({ min: 3, max: 30, mean: 2 }).ok, false);
  assert.equal(validateDelayTriple({ min: 3, max: 30, mean: 31 }).ok, false);
  assert.equal(validateDelayTriple({ min: 3, max: 30, mean: 25 }).ok, true);
});

test("REQ-ENG-07 & V-04: decoy ad relevance, short term preservation (ai/ml/ev), and <= 1.5% cap over 1,000 visits", () => {
  const terms = extractQueryRelevanceTerms('site:toyota.com "EV" and AI factory robotics filetype:pdf');
  assert.ok(terms.includes("ev"));
  assert.ok(terms.includes("ai"));
  assert.ok(terms.includes("factory"));
  assert.ok(!terms.includes("and"));
  assert.ok(!terms.includes("toyota.com"));

  // Relevant ad by keyword ("ai")
  const rel1 = evaluateDecoyAdRelevance(
    { url: "https://vendor.example/cloud", title: "Enterprise AI Governance", displayUrl: "vendor.example", adText: "" },
    'site:princeton.edu "AI" policy',
    "princeton.edu"
  );
  assert.equal(rel1.relevant, true);

  // Relevant ad by target domain
  const rel2 = evaluateDecoyAdRelevance(
    { url: "https://execed.princeton.edu/promo", title: "Executive Leadership", displayUrl: "princeton.edu", adText: "" },
    "site:princeton.edu robotics",
    "princeton.edu"
  );
  assert.equal(rel2.relevant, true);

  // Irrelevant ad must be rejected
  const irrel = evaluateDecoyAdRelevance(
    { url: "https://shoes.example/sale", title: "Running Shoes 50% Off", displayUrl: "shoes.example", adText: "Best sneakers" },
    'site:princeton.edu "AI" policy',
    "princeton.edu"
  );
  assert.equal(irrel.relevant, false);

  // 1,000 simulated decoy visits: <= 15 ads, 0 irrelevant ads, 0 locked-host decoys
  const rng = mulberry32(9999);
  const lockedHosts = new Set(["locked.example"]);
  const candidates = [
    { url: "https://shoes.example/sale", type: "sponsored", title: "Buy Running Shoes", displayUrl: "shoes.example", adText: "" },
    { url: "https://aivendor.example/tools", type: "sponsored", title: "AI Policy Management", displayUrl: "aivendor.example", adText: "" },
    { url: "https://locked.example/page", type: "organic", title: "Locked Host Page" },
    { url: "https://princeton.edu/ai/policy", type: "organic", title: "Princeton AI Policy" }
  ];

  let totalDecoys = 0;
  let totalAds = 0;
  let irrelevantAds = 0;
  let lockedHits = 0;

  for (let i = 0; i < 1000; i++) {
    const pick = selectSafeDecoy({
      candidates,
      preference: "sponsored",
      resolvedQuery: 'site:princeton.edu "AI" policy',
      targetDomain: "princeton.edu",
      adVisits: totalAds,
      decoyVisits: totalDecoys,
      isCandidateAllowed: (c) => !lockedHosts.has(new URL(c.url).hostname),
      rng
    });
    assert.ok(pick, "Expected a decoy pick");
    totalDecoys++;
    if (pick.type === "sponsored") {
      totalAds++;
      if (pick.url.includes("shoes.example")) irrelevantAds++;
    }
    if (pick.url.includes("locked.example")) lockedHits++;
  }

  assert.ok(totalAds <= 15, `Ad count ${totalAds} exceeded 1.5% cap (15 of 1000)`);
  assert.equal(irrelevantAds, 0, "Irrelevant ad was selected");
  assert.equal(lockedHits, 0, "Locked host was opened as decoy");
});
