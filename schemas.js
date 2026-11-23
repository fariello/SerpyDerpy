/**
 * SerpyDerpy v2 — Resource Classification, Challenge Corroboration,
 * Markdown/JSON/JSONL Builders, Reports, README, and Checkpoint Integrity.
 * Implements Sections 5, 7, 8, and 9.3.
 */

import { sha256Hex, validateRelativePath, MD_EXTENSIONS } from "./naming.js";

export const SCHEMA_VERSION = 2;

export const HTML_EXTENSIONS = new Set(["htm", "html", "xhtml", "shtml"]);
export const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "asciidoc",
  "htm", "html", "xhtml", "shtml",
  "csv", "tsv", "log", "json", "jsonl", "xml", "yaml", "yml",
  "ini", "conf", "cfg", "toml", "css", "js", "ts", "py", "sh", "sql", "svg"
]);
export const KNOWN_BINARY_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "rtf", "epub", "mobi", "zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff",
  "mp3", "wav", "ogg", "flac", "aac", "m4a",
  "mp4", "webm", "mkv", "avi", "mov", "exe", "msi", "dmg", "iso", "bin"
]);

export const MIME_TO_EXT = {
  "text/html": "html",
  "application/xhtml+xml": "xhtml",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "image/svg+xml": "svg",
  "application/javascript": "js",
  "text/javascript": "js",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-7z-compressed": "7z",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/epub+zip": "epub",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm"
};

export function getLocalIsoTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const tzh = pad(Math.floor(Math.abs(tzOffset) / 60));
  const tzm = pad(Math.abs(tzOffset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${tzh}:${tzm}`;
}

export function getLocalDateTimePrefix(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function extractFilenameExt(filenameOrPath) {
  if (!filenameOrPath) return "";
  const base = String(filenameOrPath).split(/[\\/]/).pop() || "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === base.length - 1) return "";
  const ext = base.slice(dotIdx + 1).toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(ext)) return "";
  if (TEXT_EXTENSIONS.has(ext) || KNOWN_BINARY_EXTENSIONS.has(ext)) return ext;
  return "";
}

export function getUrlExtension(url) {
  try {
    return extractFilenameExt(new URL(url).pathname);
  } catch (_) {
    return "";
  }
}

export function parseContentDispositionFilename(headerValue) {
  if (!headerValue) return "";
  const utf8Match = headerValue.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;\r\n]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ""));
    } catch (_) {}
  }
  const plainMatch = headerValue.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\r\n]+)/i);
  const raw = (plainMatch && (plainMatch[1] || plainMatch[2])) || "";
  return raw.trim().replace(/^["']|["']$/g, "");
}

export function stripKnownExtension(name) {
  if (!name) return "";
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = name.slice(dotIdx + 1).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext) || KNOWN_BINARY_EXTENSIONS.has(ext)) {
      return name.slice(0, dotIdx);
    }
  }
  return name;
}

/**
 * Sniff magic bytes for octet-stream or extensionless binary downloads (REQ-FETCH-03 step 3).
 */
export function sniffMagicBytes(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // %PDF-
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) {
    return { ext: "pdf", mime: "application/pdf", kind: "binary" };
  }
  // PK\x03\x04 (zip / docx / xlsx / pptx)
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return { ext: "zip", mime: "application/zip", kind: "binary" };
  }
  // \x89PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { ext: "png", mime: "image/png", kind: "binary" };
  }
  // JPEG \xFF\xD8\xFF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg", kind: "binary" };
  }
  // GIF8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { ext: "gif", mime: "image/gif", kind: "binary" };
  }
  // RIFF....WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp", kind: "binary" };
  }
  // GZIP \x1F\x8B
  if (b[0] === 0x1f && b[1] === 0x8b) {
    return { ext: "gz", mime: "application/gzip", kind: "binary" };
  }
  return null;
}

/**
 * Classify a URL/response into { kind: "html" | "text" | "binary", ext, mime }.
 */
export function classifyResource(url, contentType = "", dispositionFilename = "", sniffedBytes = null) {
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  const dispExt = extractFilenameExt(dispositionFilename);
  const urlExt = getUrlExtension(url);
  const mimeExt = MIME_TO_EXT[mime] || "";

  // Magic-byte sniffing overrides generic application/octet-stream or missing extension
  if (sniffedBytes && (!mime || mime === "application/octet-stream" || (!dispExt && !mimeExt && !urlExt))) {
    const magic = sniffMagicBytes(sniffedBytes);
    if (magic) {
      // Preserve specific Office extension if URL/disposition gave docx/xlsx/pptx for a PK zip
      const ext = magic.ext === "zip" && ["docx", "xlsx", "pptx", "epub", "odt", "ods", "odp"].includes(dispExt || urlExt)
        ? (dispExt || urlExt)
        : magic.ext;
      return { kind: magic.kind, ext, mime: magic.mime };
    }
  }

  const ext = dispExt || mimeExt || urlExt;
  const isHtmlMime = mime === "text/html" || mime === "application/xhtml+xml";
  const isTextMime =
    !isHtmlMime &&
    (mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml" ||
      mime === "application/yaml" ||
      mime === "application/javascript" ||
      mime === "application/ecmascript" ||
      mime === "image/svg+xml" ||
      mime.endsWith("+json") ||
      mime.endsWith("+xml"));

  if (isHtmlMime || (!mime && (HTML_EXTENSIONS.has(ext) || !ext))) {
    return { kind: "html", ext: ext === "htm" ? "htm" : "html", mime };
  }
  if (isTextMime || (!mime && TEXT_EXTENSIONS.has(ext))) {
    return { kind: "text", ext: ext || "txt", mime };
  }
  return { kind: "binary", ext: ext || "bin", mime };
}

/**
 * Corroborated target-page CAPTCHA / Cloudflare / WAF detector per REQ-FETCH-04.
 * Prevents false positives on normal pages with embedded footer reCAPTCHA or docs mentioning "Access Denied".
 */
export function evaluateTargetChallenge({
  url = "",
  httpStatus = null,
  title = "",
  visibleText = "",
  selectors = {}
}) {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerTitle = String(title || "").toLowerCase().trim();
  const text = String(visibleText || "");
  const lowerText = text.toLowerCase();
  const visibleLen = text.replace(/\s+/g, " ").trim().length;

  // 1. Standalone interstitial signatures (always trigger)
  if (selectors.cfChallengeRunning || selectors.cfChallengeForm) {
    return { isChallenge: true, provider: "cloudflare", standalone: true };
  }
  if (
    lowerTitle === "just a moment..." ||
    lowerTitle.includes("attention required! | cloudflare") ||
    lowerTitle === "attention required! | cloudflare"
  ) {
    return { isChallenge: true, provider: "cloudflare", standalone: true };
  }
  if (selectors.cfTurnstileIframe && (visibleLen < 1500 || lowerText.includes("verifying you are human") || lowerText.includes("verify you are human"))) {
    return { isChallenge: true, provider: "cloudflare-turnstile", standalone: true };
  }
  if (lowerUrl.includes("geo.captcha-delivery.com") || selectors.datadomeIframe) {
    return { isChallenge: true, provider: "datadome", standalone: true };
  }
  if (selectors.pxCaptcha) {
    return { isChallenge: true, provider: "perimeterx", standalone: true };
  }
  if (selectors.awsWafCaptcha) {
    return { isChallenge: true, provider: "aws-waf", standalone: true };
  }
  if (selectors.sucuriOrImpervaInterstitial) {
    return { isChallenge: true, provider: "imperva-sucuri", standalone: true };
  }

  // 2. Corroborated generic signatures:
  // Trigger ONLY when paired with HTTP 403/429/503 OR visibleText < 1500 chars OR challenge keywords in title.
  const hasCorroboratingStatus = httpStatus === 403 || httpStatus === 429 || httpStatus === 503;
  const hasShortBody = visibleLen < 1500;
  const hasChallengeTitle =
    lowerTitle.includes("captcha") ||
    lowerTitle.includes("access denied") ||
    lowerTitle.includes("verify you are human") ||
    lowerTitle.includes("are you a robot") ||
    lowerTitle.includes("security check") ||
    lowerTitle.includes("ddos") ||
    lowerTitle.includes("bot verification") ||
    lowerTitle.includes("human verification");

  const corroborated = hasCorroboratingStatus || hasShortBody || hasChallengeTitle;
  if (!corroborated) {
    return { isChallenge: false, provider: null, standalone: false };
  }

  if (selectors.recaptcha) {
    return { isChallenge: true, provider: "recaptcha", standalone: false };
  }
  if (selectors.hcaptcha) {
    return { isChallenge: true, provider: "hcaptcha", standalone: false };
  }
  if (selectors.genericCaptchaForm) {
    return { isChallenge: true, provider: "captcha", standalone: false };
  }
  if (lowerText.includes("verify you are human") || lowerText.includes("checking if the site connection is secure")) {
    return { isChallenge: true, provider: "cloudflare-or-waf", standalone: false };
  }
  if ((lowerTitle.includes("access denied") || lowerText.includes("you don't have permission to access")) && (lowerText.includes("reference #") || selectors.akamaiAbck)) {
    return { isChallenge: true, provider: "akamai", standalone: false };
  }

  return { isChallenge: false, provider: null, standalone: false };
}

/**
 * Escape YAML scalar string cleanly.
 */
function yamlScalar(val) {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  const s = String(val).replace(/\r?\n/g, " ");
  if (/[:#[\]{}&*!|>'"%@`]|^\s|\s$/.test(s) || s === "") {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Build YAML frontmatter for Result Page Markdown per REQ-MD-02 #1.
 */
export function buildResultMarkdownFrontmatter({
  url,
  finalUrl,
  title,
  target,
  searchEngine,
  search,
  rank,
  serpPage,
  retrievedTimestamp,
  contentSha256,
  extractionMethod,
  truncated = false
}) {
  return [
    "---",
    `URL: ${yamlScalar(url)}`,
    `Final-URL: ${yamlScalar(finalUrl || url)}`,
    `Title: ${yamlScalar(title || "untitled")}`,
    `Target: ${yamlScalar(target || null)}`,
    `Search-Engine: ${yamlScalar(searchEngine || null)}`,
    `Search: ${yamlScalar(search || null)}`,
    `Rank: ${yamlScalar(rank ?? null)}`,
    `SERP-Page: ${yamlScalar(serpPage ?? null)}`,
    `Retrieved-Timestamp: ${yamlScalar(retrievedTimestamp)}`,
    `Content-SHA256: ${yamlScalar(contentSha256 || null)}`,
    `Extraction-Method: ${yamlScalar(extractionMethod || null)}`,
    `Truncated: ${yamlScalar(Boolean(truncated))}`,
    "---",
    ""
  ].join("\n");
}

/**
 * Format raw text / Markdown / code files as clean readable Markdown per REQ-MD-02 #6.
 */
export function formatTextAsMarkdown({
  url,
  finalUrl,
  title,
  rawText,
  ext,
  mime,
  target = null,
  searchEngine = null,
  search = null,
  rank = null,
  serpPage = null,
  timestampUtc,
  contentSha256 = null,
  truncated = false
}) {
  const frontmatter = buildResultMarkdownFrontmatter({
    url,
    finalUrl: finalUrl || url,
    title: stripKnownExtension(title || ""),
    target,
    searchEngine,
    search,
    rank,
    serpPage,
    retrievedTimestamp: timestampUtc,
    contentSha256,
    extractionMethod: "raw_text",
    truncated
  });

  let body = String(rawText || "").replace(/\r\n/g, "\n").replace(/\u00A0/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

  if (MD_EXTENSIONS.has(ext) || mime === "text/markdown" || mime === "text/x-markdown") {
    if (body.startsWith("---\n")) {
      const endIdx = body.indexOf("\n---\n", 4);
      if (endIdx !== -1) {
        body = body.slice(endIdx + 5).trim();
      }
    }
    return `${frontmatter}\n${body}\n`;
  }

  const codeLangMap = {
    json: "json",
    jsonl: "json",
    xml: "xml",
    svg: "xml",
    yaml: "yaml",
    yml: "yaml",
    csv: "csv",
    tsv: "tsv",
    css: "css",
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "bash",
    sql: "sql",
    toml: "toml",
    ini: "ini"
  };

  const cleanTitle = stripKnownExtension(title || "");
  const heading = cleanTitle ? `# ${cleanTitle}\n\n` : "";
  const lang = codeLangMap[ext];
  if (lang) {
    return `${frontmatter}\n${heading}\`\`\`${lang}\n${body}\n\`\`\`\n`;
  }
  return `${frontmatter}\n${heading}${body}\n`;
}

/**
 * Build SERP Page Markdown per REQ-MD-03.
 */
export function buildSerpMarkdown({
  targetSlug,
  domain,
  searchEngine,
  searchSlug,
  query,
  serpUrl,
  pageNumber,
  pagesRequested,
  timestampUtc,
  results = [],
  peopleAlsoAsk = [],
  relatedSearches = [],
  zeroResults = false
}) {
  const lines = [
    "---",
    `Target: ${yamlScalar(targetSlug || null)}`,
    `Domain: ${yamlScalar(domain || null)}`,
    `Search-Engine: ${yamlScalar(searchEngine)}`,
    `Search: ${yamlScalar(searchSlug || null)}`,
    `Query: ${yamlScalar(query)}`,
    `SERP-URL: ${yamlScalar(serpUrl)}`,
    `Page: ${pageNumber}`,
    `Pages-Requested: ${pagesRequested}`,
    `Retrieved-Timestamp: ${yamlScalar(timestampUtc)}`,
    `Results-On-Page: ${results.length}`,
    `Zero-Results: ${Boolean(zeroResults)}`,
    "---",
    "",
    `# Search Results: ${query}`,
    ""
  ];

  if (zeroResults || results.length === 0) {
    lines.push("*No organic search results were extracted from this page.*");
    lines.push("");
  } else {
    for (const r of results) {
      const num = String(r.overallRank ?? r.pageRank ?? 1).padStart(2, "0");
      lines.push(`## ${num}. [${r.title || r.resolvedUrl}](${r.resolvedUrl})`);
      const metaParts = [];
      if (r.siteName) metaParts.push(`*${r.siteName}*`);
      if (r.domain && r.domain !== r.siteName) metaParts.push(`\`${r.domain}\``);
      if (r.offDomain) metaParts.push("`off-domain`");
      if (r.duplicateInSameSearch) metaParts.push("`duplicate-in-search`");
      if (metaParts.length > 0) lines.push(metaParts.join(" · "));
      if (r.snippet) {
        lines.push("");
        lines.push(r.snippet);
      }
      if (r.localArtifactFile) {
        lines.push("");
        lines.push(`Local archive: \`${r.localArtifactFile}\``);
      }
      lines.push("");
    }
  }

  if (peopleAlsoAsk.length > 0) {
    lines.push("---", "", "### People Also Ask", "");
    for (const q of peopleAlsoAsk) lines.push(`- ${q}`);
    lines.push("");
  }

  if (relatedSearches.length > 0) {
    lines.push("---", "", "### Related Searches", "");
    for (const q of relatedSearches) lines.push(`- ${q}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build SERP Page JSON per REQ-META-01, REQ-META-02, REQ-META-04.
 */
export function buildSerpJson({
  mode = "campaign",
  extension = { name: "SerpyDerpy", version: "2.0.0" },
  campaign = null,
  environment = {},
  searchMetadata = {},
  decoyBrowsing = { enabled: false, preference: "any", visits: [] },
  files = {},
  results = [],
  peopleAlsoAsk = [],
  relatedSearches = []
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    extension: {
      name: extension.name || "SerpyDerpy",
      version: extension.version || "2.0.0"
    },
    campaign,
    environment: {
      ipAddress: environment.ipAddressRecorded ? environment.ipAddress ?? null : null,
      ipAddressRecorded: Boolean(environment.ipAddressRecorded),
      userAgent: environment.userAgent || "",
      platform: environment.platform || "",
      language: environment.language || "",
      timezone: environment.timezone || ""
    },
    searchMetadata: {
      query: searchMetadata.query || "",
      initialSearchUrl: searchMetadata.initialSearchUrl || "",
      pageUrl: searchMetadata.pageUrl || "",
      pageNumber: searchMetadata.pageNumber || 1,
      pagesRequested: searchMetadata.pagesRequested || 1,
      noPersonalizationApplied: Boolean(searchMetadata.noPersonalizationApplied),
      resultsOnPage: results.length,
      zeroResults: Boolean(searchMetadata.zeroResults),
      queryRewrittenTo: searchMetadata.queryRewrittenTo || null,
      exactMatchLost: Boolean(searchMetadata.exactMatchLost),
      challenge: searchMetadata.challenge || {
        encountered: false,
        provider: null,
        resolvedByHuman: false,
        waitDurationMs: 0
      },
      pagination: {
        hasNextPage: Boolean(searchMetadata.pagination?.hasNextPage),
        endReason: searchMetadata.pagination?.endReason || null
      },
      timestamps: searchMetadata.timestamps || {}
    },
    decoyBrowsing: {
      enabled: Boolean(decoyBrowsing.enabled),
      preference: decoyBrowsing.preference || "any",
      visits: Array.isArray(decoyBrowsing.visits) ? decoyBrowsing.visits : []
    },
    files: {
      relativeDir: files.relativeDir || "",
      markdown: files.markdown || null,
      html: files.html || null,
      json: files.json || null
    },
    results: results.map((r) => ({
      overallRank: r.overallRank,
      pageNumber: r.pageNumber,
      pageRank: r.pageRank,
      title: r.title || "",
      rawHref: r.rawHref || r.resolvedUrl || "",
      resolvedUrl: r.resolvedUrl || "",
      canonicalUrl: r.canonicalUrl || "",
      domain: r.domain || "",
      offDomain: Boolean(r.offDomain),
      duplicateInSameSearch: Boolean(r.duplicateInSameSearch),
      urlDecodeFallback: Boolean(r.urlDecodeFallback),
      siteName: r.siteName || "",
      snippet: r.snippet || "",
      extractedTimestampUtc: r.extractedTimestampUtc || new Date().toISOString()
    })),
    peopleAlsoAsk: Array.isArray(peopleAlsoAsk) ? peopleAlsoAsk : [],
    relatedSearches: Array.isArray(relatedSearches) ? relatedSearches : []
  };
}

/**
 * Build Per-URL Result JSON per REQ-META-01, REQ-META-03, REQ-META-04.
 */
export function buildResultJson({
  mode = "campaign",
  extension = { name: "SerpyDerpy", version: "2.0.0" },
  campaign = null,
  serpContext = null,
  fetchedAt = new Date(),
  processingDurationMs = null,
  attemptNumber = 1,
  url = {},
  resource = {},
  http = {},
  extraction = null,
  challenge = null,
  deduplication = null,
  files = {},
  environment = {}
}) {
  const dt = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  let parsedParts = { protocol: "", hostname: "", pathname: "", search: "" };
  try {
    const u = new URL(url.final || url.requested);
    parsedParts = {
      protocol: u.protocol,
      hostname: u.hostname,
      pathname: u.pathname,
      search: u.search || ""
    };
  } catch (_) {}

  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    extension: {
      name: extension.name || "SerpyDerpy",
      version: extension.version || "2.0.0"
    },
    campaign,
    serpContext,
    fetchedAt: {
      utc: dt.toISOString(),
      local: getLocalIsoTimestamp(dt),
      unixEpochMs: dt.getTime(),
      processingDurationMs: processingDurationMs ?? null,
      attemptNumber
    },
    url: {
      requested: url.requested || "",
      canonical: url.canonical || "",
      final: url.final || url.requested || "",
      finalCanonical: url.finalCanonical || url.canonical || "",
      offDomain: Boolean(url.offDomain),
      ...parsedParts,
      referrer: url.referrer || null
    },
    resource: {
      kind: resource.kind || "html",
      title: resource.title || null,
      fileExtension: resource.fileExtension || null,
      mimeType: resource.mimeType || null,
      characterSet: resource.characterSet || null,
      lastModified: resource.lastModified || null,
      fileSizeBytes: resource.fileSizeBytes ?? null,
      sha256: resource.sha256 ?? null,
      sha256Reason: resource.sha256Reason ?? null
    },
    http: {
      status: http.status ?? null,
      protocol: http.protocol || null,
      headersSource: http.headersSource || "unavailable",
      responseHeaders: http.responseHeaders || {}
    },
    extraction: resource.kind === "binary" ? null : extraction,
    challenge: challenge || {
      encountered: false,
      provider: null,
      resolvedByHuman: false,
      waitDurationMs: 0
    },
    deduplication: deduplication || {
      isDuplicateReference: false,
      canonicalCampaignId: null,
      canonicalOutputRoot: null,
      canonicalArtifactRelPath: null,
      firstFetchedUtc: null,
      firstSeenTaskKey: null
    },
    files: {
      source: files.source ?? null,
      markdown: files.markdown ?? null,
      metadata: files.metadata ?? null
    },
    environment: {
      ipAddress: environment.ipAddressRecorded ? environment.ipAddress ?? null : null,
      ipAddressRecorded: Boolean(environment.ipAddressRecorded),
      userAgent: environment.userAgent || "",
      platform: environment.platform || "",
      language: environment.language || "",
      timezone: environment.timezone || ""
    }
  };
}

/**
 * Build Error / Skip Sidecar JSON per REQ-META-05 #1.
 */
export function buildErrorJson({
  mode = "campaign",
  extension = { name: "SerpyDerpy", version: "2.0.0" },
  campaign = null,
  serpContext = null,
  url = {},
  status = "failed_retryable",
  errorClass = "network_error",
  httpStatus = null,
  reason = "",
  retryable = true,
  attemptCount = 1,
  observedContentLengthBytes = null,
  responseHeaders = {},
  firstAttemptUtc = new Date().toISOString(),
  lastAttemptUtc = new Date().toISOString()
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    extension: {
      name: extension.name || "SerpyDerpy",
      version: extension.version || "2.0.0"
    },
    campaign,
    serpContext,
    url: {
      requested: url.requested || "",
      canonical: url.canonical || "",
      final: url.final || url.requested || "",
      offDomain: Boolean(url.offDomain)
    },
    status,
    errorClass,
    httpStatus: httpStatus ?? null,
    reason: reason || "",
    retryable: Boolean(retryable),
    attemptCount,
    observedContentLengthBytes: observedContentLengthBytes ?? null,
    responseHeaders: responseHeaders || {},
    timestamps: {
      firstAttemptUtc,
      lastAttemptUtc
    }
  };
}

/**
 * Build Site-Capture Manifest per REQ-META-05 #2 and REQ-OPS-09.
 */
export function buildSiteCaptureJson({
  campaignId,
  target,
  capturedAtUtc = new Date().toISOString(),
  cap = 50,
  truncated = false,
  sitemapsDiscoveredCount = 0,
  entries = []
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    campaignId,
    target,
    capturedAtUtc,
    cap,
    truncated: Boolean(truncated),
    sitemapsDiscoveredCount,
    entries
  };
}

/**
 * Build Campaign Summary Export per REQ-META-05 #3.
 */
export function buildCampaignSummaryJson({
  campaign,
  counts,
  exportFiles = {
    searchTasksJsonl: "_exports/search-tasks.jsonl",
    urlLedgerJsonl: "_exports/url-ledger.jsonl"
  }
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    campaignId: campaign.campaignId,
    campaignName: campaign.name,
    outputRoot: campaign.outputRoot,
    rosterVersion: campaign.rosterVersion ?? null,
    queryListVersion: campaign.queryListVersion ?? null,
    status: campaign.status,
    config: campaign.config || {},
    createdAtUtc: campaign.createdAtUtc,
    updatedAtUtc: campaign.updatedAtUtc,
    counts,
    exportFiles
  };
}

/**
 * Format export rows per REQ-META-05 #4.
 */
export function formatSearchTaskExportRow(task) {
  return {
    taskKey: task.taskKey,
    campaignId: task.campaignId,
    targetSlug: task.targetSlug,
    targetDomain: task.targetDomain,
    externalId: task.externalId ?? null,
    searchId: task.searchId ?? null,
    group: task.group ?? null,
    searchSlug: task.searchSlug,
    engine: task.engine,
    scope: task.scope || "target-site",
    template: task.template,
    resolvedQuery: task.resolvedQuery,
    pagesRequested: task.pagesRequested,
    pagesCompleted: task.pagesCompleted,
    status: task.status,
    resultCount: task.resultCount || 0,
    paginationEndReason: task.paginationEndReason ?? null,
    serpRelDir: task.serpRelDir || "",
    updatedAtUtc: task.updatedAtUtc
  };
}

export function formatUrlLedgerExportRow(fetchRow, ledgerRow) {
  return {
    campaignId: fetchRow.campaignId,
    targetSlug: fetchRow.targetSlug,
    externalId: fetchRow.externalId ?? null,
    engine: fetchRow.engine,
    searchSlug: fetchRow.searchSlug,
    overallRank: fetchRow.overallRank,
    requestedUrl: fetchRow.rawUrl,
    canonicalUrl: fetchRow.canonicalUrl,
    finalUrl: ledgerRow?.finalUrl || fetchRow.rawUrl,
    offDomain: Boolean(ledgerRow?.offDomain ?? fetchRow.offDomain),
    status: ledgerRow?.status || fetchRow.status,
    errorClass: ledgerRow?.errorClass ?? fetchRow.errorClass ?? null,
    httpStatus: ledgerRow?.httpStatus ?? null,
    kind: ledgerRow?.kind ?? null,
    mimeType: ledgerRow?.mimeType ?? null,
    fileSizeBytes: ledgerRow?.fileSizeBytes ?? null,
    contentSha256: ledgerRow?.contentSha256 ?? null,
    artifactRelPath: ledgerRow?.canonicalArtifactRelPath ?? fetchRow.artifactRelPath ?? null,
    fetchedAtUtc: ledgerRow?.fetchedAtUtc ?? null
  };
}

/**
 * Build JSONL Checkpoint lines with header, body records, and SHA-256 footer (REQ-META-05 #5, REQ-STATE-07).
 */
export async function buildCheckpointJsonl({
  checkpointKind = "delta",
  seq = 1,
  campaignId,
  exportedAtUtc = new Date().toISOString(),
  records = []
}) {
  const headerLine = JSON.stringify({
    type: "header",
    schemaVersion: SCHEMA_VERSION,
    checkpointKind,
    seq,
    campaignId,
    exportedAtUtc
  });
  const priorLines = [headerLine];
  for (const rec of records) {
    priorLines.push(JSON.stringify({ type: rec.type, data: rec.data }));
  }
  const priorText = priorLines.join("\n") + "\n";
  const hash = await sha256Hex(priorText);
  const footerLine = JSON.stringify({
    type: "footer",
    recordCount: records.length,
    sha256: hash
  });
  return priorText + footerLine + "\n";
}

/**
 * Parse and verify a JSONL checkpoint (REQ-STATE-07 + REQ-UI-04 path validation).
 */
export async function parseAndVerifyCheckpointJsonl(jsonlText) {
  const rawLines = String(jsonlText || "").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (rawLines.length < 2) {
    return { ok: false, error: "Checkpoint file is too short (missing header or footer)." };
  }

  let header;
  let footer;
  try {
    header = JSON.parse(rawLines[0]);
    footer = JSON.parse(rawLines[rawLines.length - 1]);
  } catch (err) {
    return { ok: false, error: `Invalid JSON in checkpoint header/footer: ${err.message}` };
  }

  if (header.type !== "header" || header.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, error: "Unsupported or invalid checkpoint header." };
  }
  if (footer.type !== "footer" || typeof footer.sha256 !== "string") {
    return { ok: false, error: "Missing or invalid checkpoint footer." };
  }

  const bodyLines = rawLines.slice(1, rawLines.length - 1);
  if (footer.recordCount !== bodyLines.length) {
    return {
      ok: false,
      error: `Checkpoint recordCount mismatch: footer declares ${footer.recordCount}, found ${bodyLines.length}.`
    };
  }

  const priorText = rawLines.slice(0, rawLines.length - 1).join("\n") + "\n";
  const actualHash = await sha256Hex(priorText);
  if (actualHash !== footer.sha256) {
    return {
      ok: false,
      error: `Checkpoint SHA-256 verification failed (expected ${footer.sha256}, computed ${actualHash}).`
    };
  }

  const records = [];
  const validTypes = new Set(["campaign", "searchTask", "urlLedger", "fetchQueue", "engineState", "hostState"]);
  for (let i = 0; i < bodyLines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(bodyLines[i]);
    } catch (err) {
      return { ok: false, error: `Invalid JSON on checkpoint line ${i + 2}: ${err.message}` };
    }
    if (!validTypes.has(rec.type) || !rec.data || typeof rec.data !== "object") {
      return { ok: false, error: `Invalid checkpoint record type on line ${i + 2}.` };
    }
    // Validate relative paths against traversal (REQ-UI-04)
    const pathFields = ["outputRoot", "serpRelDir", "canonicalArtifactRelPath", "artifactRelPath"];
    for (const pf of pathFields) {
      if (rec.data[pf] !== undefined && rec.data[pf] !== null && rec.data[pf] !== "") {
        const check = validateRelativePath(rec.data[pf]);
        if (!check.ok) {
          return { ok: false, error: `Unsafe path in checkpoint line ${i + 2} (${pf}): ${check.error}` };
        }
      }
    }
    records.push(rec);
  }

  return { ok: true, header, footer, records };
}

/**
 * Build concise Campaign Report Markdown (<= 200 sample failed/blocked URLs per REQ-OUT-02).
 */
export function buildCampaignReportMarkdown({
  campaign,
  startedAtUtc,
  completedAtUtc,
  countsByEngine = {},
  countsByTarget = [],
  errorCountsByClass = {},
  challengesEncountered = 0,
  offDomainTotal = 0,
  sampleFailedUrls = [],
  totalFailedUrls = 0
}) {
  const cappedSamples = sampleFailedUrls.slice(0, 200);
  const lines = [
    `# SerpyDerpy v2 Campaign Report: ${campaign.name || campaign.campaignId}`,
    "",
    `- **Campaign ID:** \`${campaign.campaignId}\``,
    `- **Status:** \`${campaign.status}\``,
    `- **Output Root:** \`Downloads/${campaign.outputRoot}/\``,
    `- **Started (UTC):** ${startedAtUtc || campaign.createdAtUtc}`,
    `- **Completed (UTC):** ${completedAtUtc}`,
    `- **Challenges Encountered:** ${challengesEncountered}`,
    `- **Off-Domain Results:** ${offDomainTotal}`,
    "",
    "## Search Tasks by Engine",
    "",
    "| Engine | Completed | Pending | Failed | Results |",
    "| --- | ---: | ---: | ---: | ---: |"
  ];

  for (const [eng, c] of Object.entries(countsByEngine)) {
    lines.push(`| ${eng} | ${c.completed || 0} | ${c.pending || 0} | ${c.failed || 0} | ${c.results || 0} |`);
  }

  if (Object.keys(errorCountsByClass).length > 0) {
    lines.push("", "## Errors and Skips by Class", "", "| Error Class | Count |", "| --- | ---: |");
    for (const [cls, n] of Object.entries(errorCountsByClass)) {
      lines.push(`| \`${cls}\` | ${n} |`);
    }
  }

  if (countsByTarget.length > 0) {
    lines.push("", "## Summary by Target", "", "| Target | Searches Done | Fetched | Deduped | Failed | Off-Domain |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const row of countsByTarget) {
      lines.push(`| \`${row.targetSlug}\` | ${row.searchesDone || 0} | ${row.fetched || 0} | ${row.deduped || 0} | ${row.failed || 0} | ${row.offDomain || 0} |`);
    }
  }

  lines.push("", `## Sample Failed / Blocked URLs (${cappedSamples.length} of ${totalFailedUrls})`, "");
  if (cappedSamples.length === 0) {
    lines.push("*None.*");
  } else {
    for (const item of cappedSamples) {
      lines.push(`- \`${item.errorClass || item.status}\` ${item.url} — ${item.reason || ""}`);
    }
  }
  lines.push("", "For the complete URL ledger and task records, inspect `_exports/url-ledger.jsonl` and `_exports/search-tasks.jsonl`.", "");

  return lines.join("\n");
}

/**
 * Build Directory README.md saved once under Downloads/<outputRoot>/README.md (REQ-OUT-02).
 */
export function buildDirectoryReadmeMarkdown(outputRoot, version = "2.0.0") {
  return `# SerpyDerpy v${version} Output Archive (\`Downloads/${outputRoot}/\`)

This directory was created by **SerpyDerpy v${version}** (Chromium Manifest V3 multi-engine domain search and page archiver).

## Directory Layout

- \`<target>/<engine>/<search>/\` — Search result pages and archived target documents for one \`(target, engine, search)\` task (\`<engine>\` is \`google\`, \`bing\`, or \`duckduckgo\`).
- \`<target>/_site/\` — Archived \`robots.txt\`, sitemaps (capped at 50 files), and \`site-capture.json\` captured once all tasks for \`<target>\` finish.
- \`_reports/\` — Concise Markdown campaign reports and rotated execution log segments (\`-partNNNN.log\`).
- \`_state/\` — Incremental JSONL delta checkpoints (\`checkpoint-delta-NNNNNN.jsonl\`) and full streamed snapshots (\`checkpoint-full-YYYYMMDD-hhmmss.jsonl\`).
- \`_exports/\` — Machine-readable \`campaign-summary.json\`, \`search-tasks.jsonl\`, and \`url-ledger.jsonl\`.

## File Naming Inside \`<target>/<engine>/<search>/\`

1. **SERP pages:** \`000-<target>-<engine>-<search>-results.pageNN.[json|md|html]\` (\`NN\` is zero-padded page \`01..20\`).
2. **Archived result pages:** \`NNN-<page title>.[html|htm|pdf|txt|png|raw.md|raw.json|<ext>]\` plus \`NNN-<page title>.md\` (for HTML and text) and \`NNN-<page title>.json\` metadata sidecar (\`NNN\` is zero-padded overall organic rank \`001, 002, ...\`).
3. **Deduplication stubs:** When a canonical URL was already fetched earlier within the freshness window, \`NNN-<page title>.json\` records \`deduplication.isDuplicateReference: true\` and points to \`deduplication.canonicalArtifactRelPath\` (relative to \`Downloads/\`).
4. **Errors and skips:** \`NNN-<page title>.error.json\` records HTTP errors, timeouts, SSRF/denylist skips, oversized files, and user-skipped challenges. If a later retry succeeds, \`NNN-<page title>.json\` supersedes \`NNN-<page title>.error.json\`.

## Traversing This Archive

Start with \`_exports/campaign-summary.json\`, \`_exports/search-tasks.jsonl\`, and \`_exports/url-ledger.jsonl\`. Every \`.json\` sidecar uses \`schemaVersion: 2\` and stores only relative filenames (never machine-local absolute paths).
`;
}
