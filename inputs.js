/**
 * SerpyDerpy v2 — Generic Target Roster, Search Specification, & Campaign Input Loader
 * Implements Section 4 (REQ-INPUT-01 through REQ-INPUT-09).
 */

import {
  normalizeDomain,
  isValidDomain,
  sanitizeSegment,
  sha256Hex,
  computeTargetSlug,
  computeSearchSlug,
  computeSegmentCaps,
  validateOutputRoot
} from "./naming.js";
import { DEFAULT_PACING, validatePacingConfig } from "./pacing.js";

export const VALID_ENGINES = ["google", "bing", "duckduckgo"];
export const DEFAULT_PAGES = 3;
export const MIN_PAGES = 1;
export const MAX_PAGES = 20;

/**
 * Simple RFC 4180 compliant CSV parser supporting quoted fields, embedded commas, and escaped quotes.
 */
export function parseCsv(text) {
  const rows = [];
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\r" && next === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i++;
      } else if (ch === "\n" || ch === "\r") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

function parseBool(val, defaultVal = true) {
  if (val === undefined || val === null || val === "") return defaultVal;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return defaultVal;
}

function parsePagesInt(val) {
  if (val === undefined || val === null || val === "") return null;
  const n = Number(val);
  if (!Number.isInteger(n) || n < MIN_PAGES || n > MAX_PAGES) {
    return NaN;
  }
  return n;
}

/**
 * Parse plain-text Target Roster (one domain per line; blank and # comment lines ignored).
 */
export async function parseRosterText(text, targetCap = 36) {
  const lines = String(text ?? "").split(/\r?\n/);
  const targets = [];
  const errors = [];
  const seenDomains = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;

    // Allow optional tab-separated columns: domain [\t name [\t slug [\t externalId]]]
    const cols = raw.split("\t").map((c) => c.trim());
    const domain = normalizeDomain(cols[0]);
    if (!isValidDomain(domain)) {
      errors.push(`Roster line ${lineNum}: invalid domain "${cols[0]}".`);
      continue;
    }
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    const name = cols[1] || null;
    const explicitSlug = cols[2] || null;
    const externalId = cols[3] || null;
    const slugInfo = await computeTargetSlug(explicitSlug || domain, targetCap);

    targets.push({
      domain,
      slug: slugInfo.slug,
      fullSlug: slugInfo.fullSlug,
      name,
      externalId,
      order: targets.length + 1,
      metadata: {},
      enabled: true,
      sourceLine: lineNum
    });
  }

  return { targets, errors, rosterVersion: null };
}

/**
 * Parse Target Roster CSV per REQ-INPUT-03 #2.
 */
export async function parseRosterCsv(text, targetCap = 36) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { targets: [], errors: ["Roster CSV must include a header row and at least one data row."], rosterVersion: null };
  }

  const headers = rows[0].map((h) => String(h).trim());
  const lowerHeaders = headers.map((h) => h.toLowerCase());
  const domainIdx = lowerHeaders.indexOf("domain");
  if (domainIdx === -1) {
    return { targets: [], errors: ['Roster CSV is missing required column "domain".'], rosterVersion: null };
  }

  const knownCols = new Set(["domain", "slug", "name", "external_id", "externalid", "order", "enabled"]);
  const targets = [];
  const errors = [];
  const seenDomains = new Set();

  for (let r = 1; r < rows.length; r++) {
    const lineNum = r + 1;
    const cols = rows[r];
    const rawDomain = (cols[domainIdx] || "").trim();
    const domain = normalizeDomain(rawDomain);
    if (!isValidDomain(domain)) {
      errors.push(`Roster CSV row ${lineNum}: invalid domain "${rawDomain}".`);
      continue;
    }
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    const getCol = (names) => {
      for (const n of names) {
        const idx = lowerHeaders.indexOf(n);
        if (idx !== -1 && cols[idx] !== undefined && String(cols[idx]).trim() !== "") {
          return String(cols[idx]).trim();
        }
      }
      return null;
    };

    const explicitSlug = getCol(["slug"]);
    const name = getCol(["name"]);
    const externalId = getCol(["external_id", "externalid"]);
    const orderRaw = getCol(["order"]);
    const order = orderRaw !== null && Number.isFinite(Number(orderRaw)) ? Number(orderRaw) : targets.length + 1;
    const enabled = parseBool(getCol(["enabled"]), true);

    const metadata = {};
    for (let c = 0; c < headers.length; c++) {
      const hLower = lowerHeaders[c];
      if (!knownCols.has(hLower) && headers[c]) {
        const val = cols[c] !== undefined ? String(cols[c]).trim() : "";
        if (val !== "") {
          metadata[headers[c]] = val;
        }
      }
    }

    const slugInfo = await computeTargetSlug(explicitSlug || domain, targetCap);
    targets.push({
      domain,
      slug: slugInfo.slug,
      fullSlug: slugInfo.fullSlug,
      name,
      externalId,
      order,
      metadata,
      enabled,
      sourceLine: lineNum
    });
  }

  return { targets, errors, rosterVersion: null };
}

/**
 * Parse Target Roster JSON per REQ-INPUT-03 #1.
 */
export async function parseRosterJson(obj, targetCap = 36) {
  const data = typeof obj === "string" ? JSON.parse(obj) : obj;
  if (!data || typeof data !== "object") {
    return { targets: [], errors: ["Roster JSON must be an object or array."], rosterVersion: null };
  }

  const list = Array.isArray(data) ? data : data.targets;
  if (!Array.isArray(list)) {
    return { targets: [], errors: ['Roster JSON must contain a "targets" array.'], rosterVersion: null };
  }

  const targets = [];
  const errors = [];
  const seenDomains = new Set();

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") {
      errors.push(`Roster target[${i}]: must be an object.`);
      continue;
    }
    const domain = normalizeDomain(item.domain);
    if (!isValidDomain(domain)) {
      errors.push(`Roster target[${i}]: invalid domain "${item.domain ?? ""}".`);
      continue;
    }
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    const explicitSlug = item.slug ? String(item.slug).trim() : null;
    const name = item.name !== undefined && item.name !== null && String(item.name).trim() !== ""
      ? String(item.name).trim()
      : null;
    const externalId = item.externalId !== undefined && item.externalId !== null && String(item.externalId).trim() !== ""
      ? String(item.externalId).trim()
      : null;
    const order = Number.isFinite(Number(item.order)) ? Number(item.order) : targets.length + 1;
    const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? { ...item.metadata }
      : {};
    const enabled = parseBool(item.enabled, true);

    const slugInfo = await computeTargetSlug(explicitSlug || domain, targetCap);
    targets.push({
      domain,
      slug: slugInfo.slug,
      fullSlug: slugInfo.fullSlug,
      name,
      externalId,
      order,
      metadata,
      enabled,
      sourceIndex: i
    });
  }

  return {
    targets,
    errors,
    rosterVersion: data.rosterVersion ? String(data.rosterVersion) : null
  };
}

/**
 * Derive deterministic collision-free search slugs per REQ-INPUT-07.
 */
export async function deriveSearchSlugs(searches, searchCap = 40) {
  const prelim = [];
  const counts = new Map();

  for (const s of searches) {
    const rawBasis = s.slug || s.template || s.id || "search";
    const info = await computeSearchSlug(rawBasis, searchCap);
    prelim.push({ search: s, info });
    counts.set(info.slug, (counts.get(info.slug) || 0) + 1);
  }

  const out = [];
  for (const { search, info } of prelim) {
    let finalSlug = info.slug;
    if (counts.get(info.slug) > 1) {
      const h4 = (await sha256Hex(`${search.scope || "target-site"}::${search.template || ""}`)).slice(0, 4);
      const maxPrefix = Math.max(4, searchCap - 5);
      const prefix = info.fullSlug.slice(0, maxPrefix).replace(/[-.\s]+$/g, "") || "s";
      finalSlug = `${prefix}-${h4}`;
    }
    out.push({
      ...search,
      slug: finalSlug,
      fullSlug: info.fullSlug
    });
  }
  return out;
}

function normalizeEnginesList(rawEngines, fallback = VALID_ENGINES) {
  if (!rawEngines) return [...fallback];
  let arr = Array.isArray(rawEngines)
    ? rawEngines
    : String(rawEngines).split(/[;,]+/);
  arr = arr
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => VALID_ENGINES.includes(e));
  return arr.length > 0 ? Array.from(new Set(arr)) : [...fallback];
}

/**
 * Parse plain-text Search Specifications per REQ-INPUT-01 and REQ-INPUT-02.
 * Supports:
 * - Blank and # comment lines ignored
 * - Leading `web:` sets scope = "web"; otherwise scope = "target-site"
 * - Optional tab-separated columns: <template>\t<pages>\t<slug>
 */
export async function parseSearchesText(
  text,
  { campaignDefaultPages = DEFAULT_PAGES, searchCap = 40, defaultEngines = VALID_ENGINES } = {}
) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rawSearches = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cols = trimmed.split("\t").map((c) => c.trim());
    let template = cols[0] || "";
    let scope = "target-site";

    if (/^web:/i.test(template)) {
      scope = "web";
      template = template.slice(4).trim();
    }

    if (!template) {
      errors.push(`Search line ${lineNum}: empty search template.`);
      continue;
    }

    let pages = campaignDefaultPages;
    if (cols[1] !== undefined && cols[1] !== "") {
      const parsedPages = parsePagesInt(cols[1]);
      if (Number.isNaN(parsedPages)) {
        errors.push(`Search line ${lineNum}: pages "${cols[1]}" must be an integer between ${MIN_PAGES} and ${MAX_PAGES}.`);
        continue;
      }
      pages = parsedPages;
    }

    const explicitSlug = cols[2] || null;

    rawSearches.push({
      id: `s-${String(rawSearches.length + 1).padStart(3, "0")}`,
      slug: explicitSlug,
      group: null,
      template,
      pages,
      engines: [...defaultEngines],
      fetchLinks: true,
      scope,
      enabled: true,
      sourceLine: lineNum
    });
  }

  const searches = await deriveSearchSlugs(rawSearches, searchCap);
  return { searches, errors, queryListVersion: null, defaultPages: null };
}

/**
 * Parse Search Specification CSV per REQ-INPUT-03 #4.
 */
export async function parseSearchesCsv(
  text,
  { campaignDefaultPages = DEFAULT_PAGES, searchCap = 40, defaultEngines = VALID_ENGINES } = {}
) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { searches: [], errors: ["Search CSV must include a header row and at least one data row."], queryListVersion: null, defaultPages: null };
  }

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const tplIdx = headers.indexOf("template");
  if (tplIdx === -1) {
    return { searches: [], errors: ['Search CSV is missing required column "template".'], queryListVersion: null, defaultPages: null };
  }

  const rawSearches = [];
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const lineNum = r + 1;
    const cols = rows[r];
    const getCol = (names) => {
      for (const n of names) {
        const idx = headers.indexOf(n);
        if (idx !== -1 && cols[idx] !== undefined && String(cols[idx]).trim() !== "") {
          return String(cols[idx]).trim();
        }
      }
      return null;
    };

    const template = getCol(["template"]);
    if (!template) {
      errors.push(`Search CSV row ${lineNum}: empty template.`);
      continue;
    }

    const pagesRaw = getCol(["pages"]);
    let pages = campaignDefaultPages;
    if (pagesRaw !== null) {
      const parsedPages = parsePagesInt(pagesRaw);
      if (Number.isNaN(parsedPages)) {
        errors.push(`Search CSV row ${lineNum}: pages "${pagesRaw}" must be an integer between ${MIN_PAGES} and ${MAX_PAGES}.`);
        continue;
      }
      pages = parsedPages;
    }

    const scopeRaw = (getCol(["scope"]) || "target-site").toLowerCase();
    if (scopeRaw !== "target-site" && scopeRaw !== "web") {
      errors.push(`Search CSV row ${lineNum}: invalid scope "${scopeRaw}" (expected "target-site" or "web").`);
      continue;
    }

    rawSearches.push({
      id: getCol(["id"]) || `s-${String(rawSearches.length + 1).padStart(3, "0")}`,
      slug: getCol(["slug"]),
      group: getCol(["group"]),
      template,
      pages,
      engines: normalizeEnginesList(getCol(["engines"]), defaultEngines),
      fetchLinks: parseBool(getCol(["fetch_links", "fetchlinks"]), true),
      scope: scopeRaw,
      enabled: parseBool(getCol(["enabled"]), true),
      sourceLine: lineNum
    });
  }

  const searches = await deriveSearchSlugs(rawSearches, searchCap);
  return { searches, errors, queryListVersion: null, defaultPages: null };
}

/**
 * Parse Search Specification JSON per REQ-INPUT-02 and REQ-INPUT-03 #3.
 * Precedence: per-search pages > file-level defaultPages > campaignDefaultPages (3).
 */
export async function parseSearchesJson(
  obj,
  { campaignDefaultPages = DEFAULT_PAGES, searchCap = 40, defaultEngines = VALID_ENGINES } = {}
) {
  const data = typeof obj === "string" ? JSON.parse(obj) : obj;
  if (!data || typeof data !== "object") {
    return { searches: [], errors: ["Search Specification JSON must be an object or array."], queryListVersion: null, defaultPages: null };
  }

  const list = Array.isArray(data) ? data : data.searches;
  if (!Array.isArray(list)) {
    return { searches: [], errors: ['Search Specification JSON must contain a "searches" array.'], queryListVersion: null, defaultPages: null };
  }

  const errors = [];
  let fileDefaultPages = null;
  if (data.defaultPages !== undefined && data.defaultPages !== null) {
    const parsedDef = parsePagesInt(data.defaultPages);
    if (Number.isNaN(parsedDef)) {
      errors.push(`Search JSON defaultPages "${data.defaultPages}" must be an integer between ${MIN_PAGES} and ${MAX_PAGES}.`);
    } else {
      fileDefaultPages = parsedDef;
    }
  }

  const effectiveDefault = fileDefaultPages ?? campaignDefaultPages ?? DEFAULT_PAGES;
  const rawSearches = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") {
      errors.push(`Search[${i}]: must be an object.`);
      continue;
    }
    const template = String(item.template ?? "").trim();
    if (!template) {
      errors.push(`Search[${i}]: missing non-empty "template".`);
      continue;
    }

    let pages = effectiveDefault;
    if (item.pages !== undefined && item.pages !== null) {
      const parsedPages = parsePagesInt(item.pages);
      if (Number.isNaN(parsedPages)) {
        errors.push(`Search[${i}]: pages "${item.pages}" must be an integer between ${MIN_PAGES} and ${MAX_PAGES}.`);
        continue;
      }
      pages = parsedPages;
    }

    const scope = String(item.scope || "target-site").trim().toLowerCase();
    if (scope !== "target-site" && scope !== "web") {
      errors.push(`Search[${i}]: invalid scope "${scope}" (expected "target-site" or "web").`);
      continue;
    }

    rawSearches.push({
      id: item.id ? String(item.id).trim() : `s-${String(rawSearches.length + 1).padStart(3, "0")}`,
      slug: item.slug ? String(item.slug).trim() : null,
      group: item.group !== undefined && item.group !== null && String(item.group).trim() !== ""
        ? String(item.group).trim()
        : null,
      template,
      pages,
      engines: normalizeEnginesList(item.engines, defaultEngines),
      fetchLinks: parseBool(item.fetchLinks, true),
      scope,
      enabled: parseBool(item.enabled, true),
      sourceIndex: i
    });
  }

  const searches = await deriveSearchSlugs(rawSearches, searchCap);
  return {
    searches,
    errors,
    queryListVersion: data.queryListVersion ? String(data.queryListVersion) : null,
    defaultPages: fileDefaultPages
  };
}

/**
 * Extract placeholder tokens from a search template ({domain}, {name}, {slug}, {externalId}, {metadata.<key>}).
 */
export function extractPlaceholders(template) {
  const found = [];
  const re = /\{(domain|name|slug|externalId|metadata\.[a-zA-Z0-9_.-]+)\}/g;
  let m;
  while ((m = re.exec(String(template || ""))) !== null) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * Expand a search template for a specific Target per REQ-INPUT-05, REQ-INPUT-06, and REQ-INPUT-09.
 * `missingPlaceholderMode`: "error" | "fallback-domain-stem" | "skip"
 */
export function expandSearchTemplate(search, target, missingPlaceholderMode = "error") {
  const scope = (search.scope || "target-site").toLowerCase();
  const template = String(search.template || "").trim();

  // REQ-INPUT-09: target-site templates must not contain a site: operator
  if (scope === "target-site" && /\bsite:/i.test(template)) {
    return {
      ok: false,
      error: `Search "${search.id || search.slug}" has scope "target-site" but template contains a "site:" operator. Remove "site:" or set scope to "web".`
    };
  }

  const placeholders = extractPlaceholders(template);
  const missing = [];
  const values = {
    domain: target.domain,
    slug: target.slug,
    name: target.name,
    externalId: target.externalId
  };

  for (const ph of placeholders) {
    if (ph === "domain" || ph === "slug") continue;
    if (ph === "name") {
      if (!target.name) missing.push("name");
    } else if (ph === "externalId") {
      if (!target.externalId) missing.push("externalId");
    } else if (ph.startsWith("metadata.")) {
      const key = ph.slice("metadata.".length);
      const val = target.metadata ? target.metadata[key] : undefined;
      if (val === undefined || val === null || String(val).trim() === "") {
        missing.push(ph);
      } else {
        values[ph] = String(val);
      }
    }
  }

  if (missing.length > 0) {
    if (missingPlaceholderMode === "skip") {
      return { ok: true, skipped: true, missing, resolvedQuery: null };
    }
    if (missingPlaceholderMode === "fallback-domain-stem" && missing.length === 1 && missing[0] === "name") {
      values.name = target.domain.split(".")[0];
    } else {
      return {
        ok: false,
        missing,
        error: `Target "${target.domain}" is missing placeholder value(s): ${missing.join(", ")} for search "${search.slug}".`
      };
    }
  }

  const expanded = template.replace(
    /\{(domain|name|slug|externalId|metadata\.[a-zA-Z0-9_.-]+)\}/g,
    (_full, key) => String(values[key] ?? "")
  );

  const resolvedQuery = scope === "target-site" ? `site:${target.domain} ${expanded}` : expanded;
  return { ok: true, skipped: false, resolvedQuery };
}

/**
 * Full pre-flight validation of Campaign inputs per REQ-INPUT-01..09, REQ-OUT-01, REQ-ENG-08.
 */
export function validateCampaignInputs({
  targets = [],
  searches = [],
  outputRoot = "SerpyDerpy/campaign",
  pacing = DEFAULT_PACING,
  missingPlaceholderMode = "error"
}) {
  const errors = [];
  const warnings = [];
  const missingPlaceholders = [];

  const rootCheck = validateOutputRoot(outputRoot);
  if (!rootCheck.ok) {
    errors.push(`Invalid outputRoot: ${rootCheck.error}`);
  }

  const pacingCheck = validatePacingConfig(pacing);
  if (!pacingCheck.ok) {
    errors.push(...pacingCheck.errors);
  }

  const enabledTargets = targets.filter((t) => t.enabled !== false);
  const enabledSearches = searches.filter((s) => s.enabled !== false);

  if (enabledTargets.length === 0) {
    errors.push("At least one enabled target is required.");
  }
  if (enabledSearches.length === 0) {
    errors.push("At least one enabled search specification is required.");
  }

  // Validate target-site templates and placeholder coverage
  for (const s of enabledSearches) {
    if ((s.scope || "target-site") === "target-site" && /\bsite:/i.test(s.template || "")) {
      errors.push(
        `Search "${s.slug || s.id}" (${s.sourceLine ? `line ${s.sourceLine}` : `index ${s.sourceIndex ?? "?"}`}): scope is "target-site" but template contains "site:". Remove "site:" or set scope to "web".`
      );
      continue;
    }

    for (const t of enabledTargets) {
      const exp = expandSearchTemplate(s, t, missingPlaceholderMode);
      if (!exp.ok && exp.missing && exp.missing.length > 0) {
        missingPlaceholders.push({
          targetDomain: t.domain,
          targetLine: t.sourceLine ?? t.sourceIndex ?? null,
          searchSlug: s.slug,
          missing: exp.missing
        });
      } else if (!exp.ok) {
        errors.push(exp.error);
      }
    }
  }

  if (missingPlaceholders.length > 0) {
    warnings.push(
      `${missingPlaceholders.length} (target, search) pair(s) are missing optional placeholder values (${Array.from(
        new Set(missingPlaceholders.flatMap((m) => m.missing))
      ).join(", ")}). Choose fallback or skip before starting.`
    );
  }

  return {
    ok: errors.length === 0 && (missingPlaceholderMode !== "error" || missingPlaceholders.length === 0),
    errors,
    warnings,
    missingPlaceholders
  };
}

/**
 * Compute pre-run Scope Estimator metrics per REQ-INPUT-08.
 */
export function estimateCampaignScope({
  targets = [],
  searches = [],
  completedTaskKeys = new Set(),
  campaignId = "default",
  pacing = DEFAULT_PACING,
  missingPlaceholderMode = "skip"
}) {
  const enabledTargets = targets.filter((t) => t.enabled !== false);
  const enabledSearches = searches.filter((s) => s.enabled !== false);
  const engineSet = new Set();

  let totalSearchTasks = 0;
  let completedTasks = 0;
  let remainingTasks = 0;
  let remainingSerpPages = 0;

  for (const t of enabledTargets) {
    for (const s of enabledSearches) {
      const exp = expandSearchTemplate(s, t, missingPlaceholderMode);
      if (!exp.ok || exp.skipped) continue;
      const engines = normalizeEnginesList(s.engines);
      for (const eng of engines) {
        engineSet.add(eng);
        totalSearchTasks++;
        const taskKey = `${campaignId}::${t.slug}::${eng}::${s.slug}`;
        if (completedTaskKeys.has(taskKey)) {
          completedTasks++;
        } else {
          remainingTasks++;
          remainingSerpPages += Number(s.pages) || DEFAULT_PAGES;
        }
      }
    }
  }

  const activeEngines = Math.max(1, engineSet.size);
  const meanInterPage = pacing?.serpPageDelay?.mean ?? 7.5;
  const meanInterQuery = pacing?.interQueryDelay?.mean ?? 10;
  const loadOverheadSec = 4;

  // Estimate wall-clock seconds across parallel lanes (excluding CAPTCHA wait time)
  const extraPages = Math.max(0, remainingSerpPages - remainingTasks);
  const totalEngineWorkSec =
    remainingTasks * (loadOverheadSec + meanInterQuery) +
    extraPages * (loadOverheadSec + meanInterPage);
  const estLowSec = Math.round((totalEngineWorkSec / activeEngines) * 0.8);
  const estHighSec = Math.round((totalEngineWorkSec / activeEngines) * 1.45);

  return {
    targets: enabledTargets.length,
    searches: enabledSearches.length,
    engines: Array.from(engineSet),
    totalSearchTasks,
    completedTasks,
    remainingTasks,
    remainingSerpPages,
    estimatedWallClockSecRange: [estLowSec, estHighSec]
  };
}

/**
 * Parse a unified Campaign JSON bundle (REQ-INPUT-04).
 */
export async function parseCampaignJson(obj) {
  const data = typeof obj === "string" ? JSON.parse(obj) : obj;
  if (!data || typeof data !== "object") {
    return { ok: false, errors: ["Campaign JSON must be an object."] };
  }

  const outputRoot = data.outputRoot || `SerpyDerpy/${sanitizeSegment(data.name || "campaign", "campaign", 28)}`;
  const caps = computeSegmentCaps(outputRoot);
  const rosterRes = await parseRosterJson({ targets: data.targets || [], rosterVersion: data.rosterVersion }, caps.targetCap);
  const searchRes = await parseSearchesJson(
    { searches: data.searches || [], defaultPages: data.defaultPages, queryListVersion: data.queryListVersion },
    { campaignDefaultPages: data.defaultPages ?? DEFAULT_PAGES, searchCap: caps.searchCap }
  );

  const errors = [...rosterRes.errors, ...searchRes.errors];
  const rootCheck = validateOutputRoot(outputRoot);
  if (!rootCheck.ok) errors.push(rootCheck.error);

  return {
    ok: errors.length === 0,
    errors,
    campaign: {
      name: data.name || "Untitled Campaign",
      outputRoot: rootCheck.ok ? rootCheck.normalized : outputRoot,
      rosterVersion: rosterRes.rosterVersion,
      queryListVersion: searchRes.queryListVersion,
      defaultPages: searchRes.defaultPages ?? data.defaultPages ?? DEFAULT_PAGES,
      targets: rosterRes.targets,
      searches: searchRes.searches,
      config: data.config || {}
    }
  };
}
