/**
 * SerpyDerpy v2 — Naming, URL Canonicalization, Path Budgeting, and URL Safety
 * Pure ES module usable in MV3 Service Worker, Dashboard, Popup, and Node.js tests.
 */

export const MAX_RELATIVE_PATH_LENGTH = 185;
export const MAX_OUTPUT_ROOT_LENGTH = 60;

export const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
]);

export const TRACKING_QUERY_PARAMS = new Set([
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "srsltid", "_ga"
]);

export const DEFAULT_BLOCKED_EXTENSIONS = [
  "exe", "msi", "bat", "cmd", "ps1", "vbs", "scr", "com", "dll", "dmg", "pkg",
  "mp4", "mov", "iso"
];

export const DEFAULT_DENYLIST_PATTERNS = [
  "/Shibboleth.sso/",
  "/cas/login"
];

export const MD_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/**
 * Compute lowercase hex SHA-256 over a string or Uint8Array/ArrayBuffer.
 */
export async function sha256Hex(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new TextEncoder().encode(String(input ?? ""));
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Sanitize a single path or filename segment per REQ-OUT-07.
 * - NFKD normalize, strip diacritics, zero-width chars, and ASCII control chars.
 * - Lowercase for Windows/POSIX parity.
 * - Replace illegal Windows chars and whitespace with '-'.
 * - Collapse repeated '-', trim leading/trailing '-', spaces, and periods.
 * - Prefix reserved Windows device names with '_'.
 */
export function sanitizeSegment(raw, fallback = "item", maxLen = null) {
  let s = String(raw ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[<>:"/\\|?*\s]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");

  if (!s) {
    s = fallback;
  }

  // Check reserved Windows device names (even if followed by a dot)
  const baseBeforeDot = s.split(".")[0];
  if (WINDOWS_RESERVED_NAMES.has(baseBeforeDot)) {
    s = `_${s}`;
  }

  if (typeof maxLen === "number" && maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/^[-.\s]+|[-.\s]+$/g, "");
    if (!s) s = fallback.slice(0, maxLen);
    const truncatedBase = s.split(".")[0];
    if (WINDOWS_RESERVED_NAMES.has(truncatedBase)) {
      s = `_${s}`.slice(0, maxLen);
    }
  }

  return s;
}

/**
 * Validate any user-supplied or checkpoint-imported relative path (REQ-UI-04).
 */
export function validateRelativePath(relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    return { ok: false, error: "Path must be a non-empty string." };
  }
  const trimmed = relPath.trim();
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return { ok: false, error: "Path must not contain a Windows drive prefix." };
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return { ok: false, error: "Path must be relative (no leading slash)." };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, error: "Path must use forward slashes only." };
  }
  if (/[\x00-\x1F\x7F<>:"|?*]/.test(trimmed)) {
    return { ok: false, error: "Path contains illegal characters." };
  }
  const parts = trimmed.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      return { ok: false, error: `Invalid path segment "${part}".` };
    }
    const base = part.toLowerCase().split(".")[0];
    if (WINDOWS_RESERVED_NAMES.has(base)) {
      return { ok: false, error: `Reserved Windows device name "${part}" is not allowed.` };
    }
  }
  return { ok: true, normalized: parts.join("/") };
}

/**
 * Validate Campaign outputRoot per REQ-OUT-01.
 */
export function validateOutputRoot(outputRoot) {
  const base = validateRelativePath(outputRoot);
  if (!base.ok) return base;
  if (base.normalized.length > MAX_OUTPUT_ROOT_LENGTH) {
    return {
      ok: false,
      error: `outputRoot must be at most ${MAX_OUTPUT_ROOT_LENGTH} characters (got ${base.normalized.length}).`
    };
  }
  return { ok: true, normalized: base.normalized };
}

/**
 * Normalize a raw domain string (strip protocol, www., trailing slash/path).
 */
export function normalizeDomain(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // Strip protocol if present
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch (_) {
      s = s.replace(/^https?:\/\//i, "");
    }
  }
  // Strip trailing slashes only (keep any embedded path so isValidDomain catches it)
  s = s.replace(/\/+$/, "").toLowerCase();
  if (s.startsWith("www.")) {
    s = s.slice(4);
  }
  return s;
}

/**
 * Validate normalized domain name (must have valid labels and a TLD, no scheme/path/port).
 */
export function isValidDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  if (domain.length > 253) return false;
  if (/[/:\\?#@\s]/.test(domain)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$|^xn--[a-z0-9-]{2,59}$/.test(tld)) return false;
  return true;
}

/**
 * Compute segment caps dynamically for outputRoot lengths > 30 (REQ-OUT-08).
 */
export function computeSegmentCaps(outputRoot) {
  const rootLen = String(outputRoot || "").length;
  const overflow = Math.max(0, rootLen - 30);
  const reduction = Math.ceil(overflow / 2);
  return {
    targetCap: 36,
    engineCap: 10,
    searchCap: Math.max(16, 40 - reduction),
    titleCap: Math.max(16, 55 - reduction)
  };
}

/**
 * Compute collision-free truncated Target slug per REQ-OUT-08 and Section 4.2.
 * Replaces dots with '-' (e.g. toyota.com -> toyota-com); if exceeding cap,
 * truncates to (cap - 5) + '-' + first 4 hex of SHA-256(fullSlug).
 */
export async function computeTargetSlug(rawSlugOrDomain, cap = 36) {
  const fullSlug = sanitizeSegment(String(rawSlugOrDomain ?? "").replace(/\./g, "-"), "target");
  if (fullSlug.length <= cap) {
    return { slug: fullSlug, fullSlug, shortened: false };
  }
  const h4 = (await sha256Hex(fullSlug)).slice(0, 4);
  const prefix = fullSlug.slice(0, Math.max(1, cap - 5)).replace(/[-.\s]+$/g, "") || "t";
  return { slug: `${prefix}-${h4}`, fullSlug, shortened: true };
}

/**
 * Compute collision-free search slug truncated to searchCap.
 */
export async function computeSearchSlug(rawSlug, cap = 40) {
  const fullSlug = sanitizeSegment(String(rawSlug ?? "").replace(/\./g, "-"), "search");
  if (fullSlug.length <= cap) {
    return { slug: fullSlug, fullSlug, shortened: false };
  }
  const h4 = (await sha256Hex(fullSlug)).slice(0, 4);
  const prefix = fullSlug.slice(0, Math.max(1, cap - 5)).replace(/[-.\s]+$/g, "") || "s";
  return { slug: `${prefix}-${h4}`, fullSlug, shortened: true };
}

/**
 * Zero-pad page number to at least 2 digits (01..20).
 */
export function padPage(pageNumber) {
  return String(Math.max(1, Number(pageNumber) || 1)).padStart(2, "0");
}

/**
 * Zero-pad overall rank to at least 3 digits (001..099, 100..).
 */
export function padRank(overallRank) {
  return String(Math.max(1, Number(overallRank) || 1)).padStart(3, "0");
}

/**
 * Build deterministic SERP relative paths within Downloads/ per REQ-OUT-03 and REQ-OUT-08.
 * Enforces total relative path <= 185 characters for longest extension (.html / .json).
 */
export async function buildSerpRelativePaths({
  outputRoot,
  targetSlug,
  fullTargetSlug,
  engine,
  searchSlug,
  fullSearchSlug,
  pageNumber
}) {
  const cleanRoot = validateOutputRoot(outputRoot).normalized || "SerpyDerpy/campaign";
  const cleanEngine = sanitizeSegment(engine, "engine", 10);
  const cleanTarget = sanitizeSegment(targetSlug, "target");
  const cleanSearch = sanitizeSegment(searchSlug, "search");
  const pageStr = padPage(pageNumber);

  const relDir = `${cleanRoot}/${cleanTarget}/${cleanEngine}/${cleanSearch}`;
  const longestExt = ".html";
  const standardBase = `000-${cleanTarget}-${cleanEngine}-${cleanSearch}-results.page${pageStr}`;

  let fileBase = standardBase;
  let shortened = false;

  if (relDir.length + 1 + standardBase.length + longestExt.length > MAX_RELATIVE_PATH_LENGTH) {
    shortened = true;
    const h6 = (
      await sha256Hex(`${fullTargetSlug || cleanTarget}/${cleanEngine}/${fullSearchSlug || cleanSearch}`)
    ).slice(0, 6);

    const fixedSuffix = `-${h6}-results.page${pageStr}`;
    const maxBaseLen = MAX_RELATIVE_PATH_LENGTH - relDir.length - 1 - longestExt.length;
    // Pattern: 000-<tPart>-<engine>-<sPart><fixedSuffix>
    const fixedOverhead = 4 + cleanEngine.length + 2 + fixedSuffix.length;
    const avail = maxBaseLen - fixedOverhead;

    if (avail < 2) {
      // Extreme long-outputRoot fallback: 000-<engine>-<h6 >-results.pageNN
      fileBase = `000-${cleanEngine}${fixedSuffix}`;
    } else {
      let tPart = cleanTarget;
      let sPart = cleanSearch;

      // Shorten sPart first (down to 12 chars if space allows)
      if (tPart.length + sPart.length > avail) {
        const targetS = Math.max(Math.min(12, Math.floor(avail / 2)), avail - tPart.length);
        if (sPart.length > targetS) {
          sPart = sPart.slice(0, targetS).replace(/[-.\s]+$/g, "") || "s";
        }
      }
      // Then shorten tPart
      if (tPart.length + sPart.length > avail) {
        const targetT = Math.max(1, avail - sPart.length);
        if (tPart.length > targetT) {
          tPart = tPart.slice(0, targetT).replace(/[-.\s]+$/g, "") || "t";
        }
      }
      // Final clamp if still over avail
      if (tPart.length + sPart.length > avail) {
        const half = Math.max(1, Math.floor(avail / 2));
        tPart = tPart.slice(0, half).replace(/[-.\s]+$/g, "") || "t";
        sPart = sPart.slice(0, Math.max(1, avail - tPart.length)).replace(/[-.\s]+$/g, "") || "s";
      }

      fileBase = `000-${tPart}-${cleanEngine}-${sPart}${fixedSuffix}`;
    }
  }

  return {
    relDir,
    fileBase,
    shortened,
    json: `${relDir}/${fileBase}.json`,
    md: `${relDir}/${fileBase}.md`,
    html: `${relDir}/${fileBase}.html`,
    basenames: {
      json: `${fileBase}.json`,
      md: `${fileBase}.md`,
      html: `${fileBase}.html`
    }
  };
}

/**
 * Build deterministic Result Page relative paths within Downloads/ per REQ-OUT-04, REQ-OUT-06, REQ-OUT-08.
 * Enforces total relative path <= 185 characters across all companion extensions (.error.json, .raw.json, .raw.markdown, etc.).
 */
export function buildResultRelativePaths({
  outputRoot,
  targetSlug,
  engine,
  searchSlug,
  overallRank,
  title,
  ext = "html",
  kind = "html",
  relDirOverride = null
}) {
  const cleanRoot = validateOutputRoot(outputRoot).normalized || "SerpyDerpy/campaign";
  const caps = computeSegmentCaps(cleanRoot);
  const relDir =
    relDirOverride ||
    `${cleanRoot}/${sanitizeSegment(targetSlug, "target")}/${sanitizeSegment(engine, "engine", 10)}/${sanitizeSegment(searchSlug, "search")}`;

  const rankStr = padRank(overallRank);
  const cleanExt = sanitizeSegment(ext || "bin", "bin", 12).replace(/^\.+/, "") || "bin";

  let sourceExt = cleanExt;
  if (kind === "html") {
    sourceExt = cleanExt === "htm" ? "htm" : "html";
  } else if (kind === "text") {
    if (MD_EXTENSIONS.has(cleanExt)) {
      sourceExt = `raw.${cleanExt}`;
    } else if (cleanExt === "json") {
      sourceExt = "raw.json";
    } else {
      sourceExt = cleanExt || "txt";
    }
  } else {
    sourceExt = cleanExt || "bin";
  }

  const longestSuffixLen = Math.max(
    ".error.json".length,
    `.${sourceExt}`.length,
    ".json".length,
    ".md".length
  );

  const availForTitle = Math.max(
    8,
    Math.min(
      caps.titleCap,
      MAX_RELATIVE_PATH_LENGTH - relDir.length - 1 - (rankStr.length + 1) - longestSuffixLen
    )
  );

  const titleSlug = sanitizeSegment(title, "untitled", availForTitle);
  const fileBase = `${rankStr}-${titleSlug}`;

  const sourceBasename = `${fileBase}.${sourceExt}`;
  const mdBasename = kind === "html" || kind === "text" ? `${fileBase}.md` : null;
  const jsonBasename = `${fileBase}.json`;
  const errorJsonBasename = `${fileBase}.error.json`;

  return {
    relDir,
    fileBase,
    source: `${relDir}/${sourceBasename}`,
    md: mdBasename ? `${relDir}/${mdBasename}` : null,
    json: `${relDir}/${jsonBasename}`,
    errorJson: `${relDir}/${errorJsonBasename}`,
    basenames: {
      source: sourceBasename,
      md: mdBasename,
      json: jsonBasename,
      errorJson: errorJsonBasename
    }
  };
}

/**
 * Build Interactive Mode relative paths (REQ-INT-02, REQ-INT-03).
 */
export function buildInteractiveBaseDir(subfolder) {
  const checked = validateOutputRoot(subfolder || "SerpyDerpy/Interactive");
  return checked.ok ? checked.normalized : "SerpyDerpy/Interactive";
}

/**
 * Canonicalize a URL per REQ-STATE-02:
 * - Lowercase scheme and hostname
 * - Remove default ports (:80 for http, :443 for https)
 * - Strip URL fragments (#...)
 * - Remove tracking params (utm_*, fbclid, gclid, msclkid, mc_cid, mc_eid, srsltid, _ga)
 * - Sort remaining query params by (key, value)
 * - Normalize trailing slash on root path ("/")
 */
export function canonicalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_) {
    return "";
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return "";
  }

  const hostname = parsed.hostname.toLowerCase();
  let port = parsed.port;
  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    port = "";
  }

  // Filter and sort query parameters
  const pairs = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    const kl = k.toLowerCase();
    if (kl.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(kl)) {
      continue;
    }
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  const sortedParams = new URLSearchParams();
  for (const [k, v] of pairs) {
    sortedParams.append(k, v);
  }
  const searchStr = sortedParams.toString();

  // Root path normalized to "/"
  let pathname = parsed.pathname || "/";
  if (pathname === "") pathname = "/";

  const hostPort = port ? `${hostname}:${port}` : hostname;
  return `${protocol}//${hostPort}${pathname}${searchStr ? `?${searchStr}` : ""}`;
}

/**
 * Determine whether a URL or hostname is off-domain relative to targetDomain (REQ-OPS-06).
 */
export function isOffDomain(urlOrHost, targetDomain) {
  const normTarget = normalizeDomain(targetDomain);
  if (!normTarget) return false;
  let host = "";
  try {
    host = urlOrHost.includes("://")
      ? new URL(urlOrHost).hostname.toLowerCase()
      : String(urlOrHost || "").toLowerCase();
  } catch (_) {
    return true;
  }
  if (!host) return true;
  if (host === normTarget) return false;
  if (host.endsWith(`.${normTarget}`)) return false;
  return true;
}

/**
 * Parse an IPv4 address string into 4 octets, or return null if not a literal IPv4 address.
 * Handles standard dotted-quad as well as decimal/hex/octal forms normalized by URL().
 */
function parseIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIpv4(octets) {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateIpv6(rawHost) {
  // URL.hostname wraps IPv6 in brackets: [::1]
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1" || host === "0:0:0:0:0:0:0:0") {
    return true;
  }
  // Mapped IPv4 ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (host.startsWith("::ffff:")) {
    const tail = host.slice(7);
    const v4 = parseIpv4(tail);
    if (v4) return isPrivateIpv4(v4);
    const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return isPrivateIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
    }
  }
  // Unique local addresses fc00::/7 (fc00..fdff)
  const firstGroup = host.split(":")[0];
  if (firstGroup && /^f[cd][0-9a-f]{2}$/.test(firstGroup.padStart(4, "0"))) {
    return true;
  }
  // Link-local fe80::/10 (fe80..febf)
  if (firstGroup && /^fe[89ab][0-9a-f]$/.test(firstGroup.padStart(4, "0"))) {
    return true;
  }
  return false;
}

/**
 * Check URL against REQ-OPS-06:
 * - HTTP/HTTPS only
 * - SSRF private-network guard (localhost, *.local, *.internal, private IPv4/IPv6)
 * - Configurable denylist patterns and blocked extensions
 */
export function checkUrlSafety(
  rawUrl,
  denylistPatterns = DEFAULT_DENYLIST_PATTERNS,
  blockedExtensions = DEFAULT_BLOCKED_EXTENSIONS
) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { allowed: false, status: "skipped_policy", errorClass: "denylist", reason: "Empty URL" };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_) {
    return { allowed: false, status: "skipped_policy", errorClass: "denylist", reason: "Invalid URL" };
  }

  const proto = parsed.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    return {
      allowed: false,
      status: "skipped_policy",
      errorClass: "denylist",
      reason: `Disallowed URL scheme: ${proto}`
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return {
      allowed: false,
      status: "skipped_policy",
      errorClass: "ssrf_blocked",
      reason: `Private or local hostname blocked: ${host}`
    };
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 && isPrivateIpv4(ipv4)) {
    return {
      allowed: false,
      status: "skipped_policy",
      errorClass: "ssrf_blocked",
      reason: `Private IPv4 address blocked: ${host}`
    };
  }

  if (isPrivateIpv6(host)) {
    return {
      allowed: false,
      status: "skipped_policy",
      errorClass: "ssrf_blocked",
      reason: `Private IPv6 address blocked: ${host}`
    };
  }

  // Extension check on URL pathname
  const extSet = new Set((blockedExtensions || []).map((e) => String(e).toLowerCase().replace(/^\./, "")));
  const lastSeg = (parsed.pathname || "").split("/").pop() || "";
  const dotIdx = lastSeg.lastIndexOf(".");
  if (dotIdx > 0 && dotIdx < lastSeg.length - 1) {
    const ext = lastSeg.slice(dotIdx + 1).toLowerCase();
    if (extSet.has(ext)) {
      return {
        allowed: false,
        status: "skipped_policy",
        errorClass: "denylist",
        reason: `Blocked file extension: .${ext}`
      };
    }
  }

  // Pattern checks (case-insensitive substring or regex)
  const hrefLower = parsed.href.toLowerCase();
  for (const pat of denylistPatterns || []) {
    const p = String(pat || "").trim();
    if (!p) continue;
    if (p.startsWith("/") && p.endsWith("/") && p.length > 2 && p.indexOf("/", 1) === p.length - 1) {
      // Treat `/Shibboleth.sso/` as substring path match unless explicitly `regex:...`
      if (hrefLower.includes(p.toLowerCase())) {
        return {
          allowed: false,
          status: "skipped_policy",
          errorClass: "denylist",
          reason: `Matched denylist pattern: ${p}`
        };
      }
    } else if (p.startsWith("regex:")) {
      try {
        const re = new RegExp(p.slice(6), "i");
        if (re.test(parsed.href)) {
          return {
            allowed: false,
            status: "skipped_policy",
            errorClass: "denylist",
            reason: `Matched denylist regex: ${p}`
          };
        }
      } catch (_) {}
    } else if (hrefLower.includes(p.toLowerCase())) {
      return {
        allowed: false,
        status: "skipped_policy",
        errorClass: "denylist",
        reason: `Matched denylist pattern: ${p}`
      };
    }
  }

  return { allowed: true, host, canonicalUrl: canonicalizeUrl(parsed.href) };
}
