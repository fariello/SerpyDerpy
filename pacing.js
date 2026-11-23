/**
 * SerpyDerpy v2 — Bounded Configurable-Skew Delay Distribution & Decoy Ad Policy
 * Implements REQ-ENG-07 (ad relevance & 1.5% cap) and REQ-ENG-08 (truncated exponential).
 */

export const DEFAULT_PACING = {
  serpPageDelay: { min: 3, max: 30, mean: 7.5 },
  interQueryDelay: { min: 3, max: 30, mean: 10 },
  sameHostFetchDelay: { min: 2, max: 30, mean: 5 },
  settleWait: { min: 7, max: 21 },
  coffeeBreakEveryMin: 15,
  coffeeBreakEveryMax: 25,
  coffeeBreakDurationMin: 120,
  coffeeBreakDurationMax: 300,
  softHourlyPageCap: 0,
  decoyEnabled: { google: true, bing: false, duckduckgo: false },
  decoyProbability: 0.45,
  decoyMinSec: 3,
  decoyMaxSec: 33
};

export const DECOY_AD_MAX_RATIO = 0.015;

export const AD_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "for", "on", "with", "at",
  "by", "from", "as", "is", "are", "was", "were", "be", "been", "that", "this", "it"
]);

/**
 * Mean of the truncated exponential distribution on [0, 1] with parameter lambda:
 *   f(u) = lambda * exp(lambda * u) / (exp(lambda) - 1)
 *   E[U] = 1 / (1 - exp(-lambda)) - 1 / lambda
 * Strictly increasing from 0 (lambda -> -inf) through 0.5 (lambda = 0) to 1 (lambda -> +inf).
 */
export function truncatedExpUnitMean(lambda) {
  if (Math.abs(lambda) < 1e-7) {
    // Taylor series: 1/2 + lambda/12 - lambda^3/720
    return 0.5 + lambda / 12 - (lambda * lambda * lambda) / 720;
  }
  if (lambda > 700) {
    return 1 - 1 / lambda;
  }
  if (lambda < -700) {
    return -1 / lambda;
  }
  if (lambda > 0) {
    return 1 / (-Math.expm1(-lambda)) - 1 / lambda;
  }
  // lambda < 0: exp(lambda) / (exp(lambda) - 1) - 1 / lambda
  const e = Math.exp(lambda);
  return e / (e - 1) - 1 / lambda;
}

/**
 * Solve for lambda such that truncatedExpUnitMean(lambda) == targetUnitMean in (0, 1).
 */
export function solveTruncatedExpLambda(min, max, mean) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(mean)) {
    throw new Error("Delay parameters min, max, and mean must be finite numbers.");
  }
  if (!(min < mean && mean < max)) {
    throw new Error(`Invalid delay parameters: require min < mean < max (got min=${min}, mean=${mean}, max=${max}).`);
  }

  const target = (mean - min) / (max - min);
  if (Math.abs(target - 0.5) < 1e-12) {
    return 0;
  }

  // Bracket lambda
  let lo, hi;
  if (target < 0.5) {
    hi = 0;
    lo = -1;
    while (truncatedExpUnitMean(lo) > target && lo > -1e9) {
      lo *= 2;
    }
  } else {
    lo = 0;
    hi = 1;
    while (truncatedExpUnitMean(hi) < target && hi < 1e9) {
      hi *= 2;
    }
  }

  // Bisection to full double precision
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const val = truncatedExpUnitMean(mid);
    if (val < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * Draw a single sample in [min, max] from the bounded truncated exponential distribution
 * with exact mean `mean` (REQ-ENG-08).
 */
export function sampleBoundedDelay(min, max, mean, rng = Math.random) {
  const lambda = solveTruncatedExpLambda(min, max, mean);
  // Clamp U away from exact 0/1 edges for numerical safety
  const rawU = rng();
  const U = Math.min(1 - 1e-15, Math.max(1e-15, rawU));

  let u;
  if (Math.abs(lambda) < 1e-7) {
    u = U;
  } else if (lambda < -700) {
    // Exponential approximation near 0: -ln(1 - U) / (-lambda)
    u = Math.min(1, -Math.log1p(-U) / -lambda);
  } else if (lambda > 700) {
    // Mirror near 1: 1 + ln(U) / lambda
    u = Math.max(0, 1 + Math.log(U) / lambda);
  } else {
    // Exact inverse CDF: u = ln(1 + U * (exp(lambda) - 1)) / lambda
    u = Math.log1p(U * Math.expm1(lambda)) / lambda;
  }

  const clamped = Math.min(1, Math.max(0, u));
  return min + clamped * (max - min);
}

/**
 * Validate a delay triple { min, max, mean } per REQ-ENG-08.
 */
export function validateDelayTriple(triple, label = "delay") {
  if (!triple || typeof triple !== "object") {
    return { ok: false, error: `${label} must be an object with min, max, mean.` };
  }
  const { min, max, mean } = triple;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(mean)) {
    return { ok: false, error: `${label}: min, max, and mean must be finite numbers.` };
  }
  if (min < 0) {
    return { ok: false, error: `${label}: min must be >= 0.` };
  }
  if (!(min < mean && mean < max)) {
    return {
      ok: false,
      error: `${label}: requires min < mean < max (got min=${min}, mean=${mean}, max=${max}).`
    };
  }
  return { ok: true };
}

/**
 * Validate complete pacing configuration.
 */
export function validatePacingConfig(pacing) {
  const errors = [];
  for (const [key, label] of [
    ["serpPageDelay", "SERP page delay"],
    ["interQueryDelay", "Inter-query delay"],
    ["sameHostFetchDelay", "Same-host fetch delay"]
  ]) {
    const res = validateDelayTriple(pacing?.[key], label);
    if (!res.ok) errors.push(res.error);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Extract significant search terms from a query for REQ-ENG-07 ad relevance.
 * Strips search operators (site:, filetype:, inurl:, intitle:), quotes, and stopwords,
 * while preserving short domain terms like "ai", "ml", "ev".
 */
export function extractQueryRelevanceTerms(query) {
  const cleaned = String(query || "")
    .replace(/\b(?:site|filetype|inurl|intitle|ext|related|cache):\S+/gi, " ")
    .replace(/["'“”‘’()[\]{},.;:!?/\\|+=-]+/g, " ")
    .toLowerCase();

  const terms = [];
  const seen = new Set();
  for (const token of cleaned.split(/\s+/)) {
    const t = token.trim();
    if (!t || t.length < 2) continue;
    if (AD_STOPWORDS.has(t)) continue;
    if (!seen.has(t)) {
      seen.add(t);
      terms.push(t);
    }
  }
  return terms;
}

/**
 * Check if a sponsored ad candidate is search-relevant per REQ-ENG-07.
 * Eligible if its title, displayUrl, or adText contains at least one query term,
 * OR its destination host is targetDomain or a subdomain of it.
 */
export function evaluateDecoyAdRelevance(adCandidate, resolvedQuery, targetDomain = "") {
  if (!adCandidate || !adCandidate.url) {
    return { relevant: false, reason: "Missing ad candidate or URL" };
  }

  // 1. Host match against targetDomain
  const normTarget = String(targetDomain || "").trim().toLowerCase().replace(/^www\./, "");
  if (normTarget) {
    try {
      const host = new URL(adCandidate.url).hostname.toLowerCase();
      if (host === normTarget || host.endsWith(`.${normTarget}`)) {
        return { relevant: true, reason: `target-domain-match:${normTarget}` };
      }
    } catch (_) {}
  }

  // 2. Keyword match in title, displayUrl, or adText (word-boundary match for short tokens)
  const terms = extractQueryRelevanceTerms(resolvedQuery);
  const haystack = `${adCandidate.title || ""} ${adCandidate.displayUrl || ""} ${adCandidate.adText || ""}`.toLowerCase();

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i");
    if (re.test(haystack)) {
      return { relevant: true, reason: `query-term-match:${term}` };
    }
  }

  return { relevant: false, reason: "No query term or target domain match" };
}

/**
 * Enforce the 1.5% per-engine ad decoy cap (REQ-ENG-07 #3).
 */
export function canVisitAdDecoy(adVisits, decoyVisits) {
  const ads = Number(adVisits) || 0;
  const total = Number(decoyVisits) || 0;
  return (ads + 1) / (total + 1) <= DECOY_AD_MAX_RATIO;
}

/**
 * Select a decoy candidate honoring REQ-ENG-07:
 * - Never selects an irrelevant ad.
 * - Enforces (adVisits + 1) / (decoyVisits + 1) <= 0.015.
 * - Filters out candidates failing safety/host-lock predicate `isCandidateAllowed`.
 */
export function selectSafeDecoy({
  candidates,
  preference = "any",
  resolvedQuery = "",
  targetDomain = "",
  adVisits = 0,
  decoyVisits = 0,
  isCandidateAllowed = () => true,
  rng = Math.random
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const allowedCandidates = candidates.filter((c) => c && c.url && isCandidateAllowed(c));
  if (allowedCandidates.length === 0) return null;

  const organics = allowedCandidates.filter((c) => c.type !== "sponsored");
  const adAllowedByCap = canVisitAdDecoy(adVisits, decoyVisits);

  let relevantAds = [];
  if (adAllowedByCap && preference !== "organic") {
    for (const c of allowedCandidates) {
      if (c.type === "sponsored") {
        const rel = evaluateDecoyAdRelevance(c, resolvedQuery, targetDomain);
        if (rel.relevant) {
          relevantAds.push({ ...c, relevanceReason: rel.reason });
        }
      }
    }
  }

  let pool = [];
  if (preference === "sponsored") {
    pool = relevantAds.length > 0 ? relevantAds : organics;
  } else if (preference === "organic") {
    pool = organics;
  } else {
    pool = [...organics, ...relevantAds];
  }

  if (pool.length === 0) return null;
  const idx = Math.floor(rng() * pool.length);
  return pool[idx];
}
