/**
 * SerpyDerpy v2 — Singleton Offscreen Worker
 * Handles offscreen HEAD probes, streaming binary/text fetches with size ceiling,
 * magic-byte sniffing, charset-aware TextDecoder, SHA-256 hashing, gzip decompression,
 * and Blob URL creation/revocation so large payloads never traverse MV3 IPC limits.
 */

import { sha256Hex } from "./naming.js";
import { classifyResource, parseContentDispositionFilename, sniffMagicBytes } from "./schemas.js";

const activeBlobUrls = new Map();

function headersToObject(headers) {
  const obj = {};
  if (!headers || typeof headers.forEach !== "function") return obj;
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

function parseCharsetFromContentType(contentType) {
  const m = String(contentType || "").match(/charset\s*=\s*"?([a-zA-Z0-9._-]+)"?/i);
  return m ? m[1].trim().toLowerCase() : null;
}

function decodeTextBytes(bytes, contentType) {
  const warnings = [];
  let charset = parseCharsetFromContentType(contentType);

  // Check UTF-8 BOM
  if (!charset && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    charset = "utf-8";
  }

  const targetCharset = charset || "utf-8";
  try {
    const dec = new TextDecoder(targetCharset, { fatal: targetCharset === "utf-8" });
    return { text: dec.decode(bytes), charset: targetCharset, warnings };
  } catch (_) {
    try {
      const fallback = new TextDecoder("windows-1252", { fatal: false }).decode(bytes);
      warnings.push(`Invalid ${targetCharset} byte sequence; fell back to windows-1252.`);
      return { text: fallback, charset: "windows-1252", warnings };
    } catch (err2) {
      const fallback = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      warnings.push(`Charset decode fallback (${err2.message || String(err2)}).`);
      return { text: fallback, charset: "utf-8", warnings };
    }
  }
}

async function handleHeadProbe({ url, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      credentials: "include",
      signal: controller.signal
    });
    const headers = headersToObject(res.headers);
    const contentType = res.headers.get("content-type") || "";
    const disp = res.headers.get("content-disposition") || "";
    const contentLengthRaw = res.headers.get("content-length");
    const contentLength =
      contentLengthRaw !== null && /^\d+$/.test(contentLengthRaw.trim())
        ? Number(contentLengthRaw.trim())
        : null;
    return {
      ok: true,
      httpOk: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType,
      dispositionFilename: parseContentDispositionFilename(disp),
      isAttachment: /\battachment\b/i.test(disp),
      contentLength,
      headers
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.name === "AbortError" ? "HEAD timeout" : String(err?.message || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream a remote URL in offscreen context with strict size guard, magic-byte sniffing,
 * SHA-256 computation, optional text decoding, and Blob URL creation.
 */
async function handleFetchStreamAndBlob({
  url,
  maxBytes = 250 * 1024 * 1024,
  timeoutMs = 60000,
  decodeText = false,
  gunzipXml = false,
  blobMimeType = null
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      credentials: "include",
      signal: controller.signal
    });

    const headers = headersToObject(res.headers);
    const contentType = res.headers.get("content-type") || "";
    const disp = res.headers.get("content-disposition") || "";
    const dispositionFilename = parseContentDispositionFilename(disp);
    const contentLengthRaw = res.headers.get("content-length");
    const declaredLength =
      contentLengthRaw !== null && /^\d+$/.test(contentLengthRaw.trim())
        ? Number(contentLengthRaw.trim())
        : null;

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        finalUrl: res.url || url,
        contentType,
        headers,
        error: `HTTP ${res.status}`
      };
    }

    if (declaredLength !== null && maxBytes > 0 && declaredLength > maxBytes) {
      controller.abort();
      return {
        ok: false,
        tooLarge: true,
        observedBytes: declaredLength,
        httpStatus: res.status,
        finalUrl: res.url || url,
        contentType,
        headers,
        error: `Content-Length (${declaredLength} bytes) exceeds limit (${maxBytes} bytes).`
      };
    }

    const chunks = [];
    let totalBytes = 0;

    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          totalBytes += value.byteLength;
          if (maxBytes > 0 && totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch (_) {}
            controller.abort();
            return {
              ok: false,
              tooLarge: true,
              observedBytes: totalBytes,
              httpStatus: res.status,
              finalUrl: res.url || url,
              contentType,
              headers,
              error: `Streamed body exceeded limit (${maxBytes} bytes).`
            };
          }
          chunks.push(value);
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      totalBytes = buf.byteLength;
      if (maxBytes > 0 && totalBytes > maxBytes) {
        return {
          ok: false,
          tooLarge: true,
          observedBytes: totalBytes,
          httpStatus: res.status,
          finalUrl: res.url || url,
          contentType,
          headers,
          error: `Body (${totalBytes} bytes) exceeded limit (${maxBytes} bytes).`
        };
      }
      chunks.push(buf);
    }

    // Merge chunks into single Uint8Array for SHA-256 + sniffing + Blob creation
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }

    const sha256 = await sha256Hex(merged);
    const sniffed = sniffMagicBytes(merged.subarray(0, 16));
    const classified = classifyResource(res.url || url, contentType, dispositionFilename, merged.subarray(0, 16));

    const blob = new Blob([merged], {
      type: blobMimeType || classified.mime || contentType || "application/octet-stream"
    });
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.set(blobUrl, Date.now());

    let text = null;
    let characterSet = null;
    let decodeWarnings = [];

    if (decodeText || classified.kind === "text") {
      const decoded = decodeTextBytes(merged, contentType);
      text = decoded.text;
      characterSet = decoded.charset;
      decodeWarnings = decoded.warnings;
    } else if (gunzipXml && sniffed && sniffed.ext === "gz" && typeof DecompressionStream === "function") {
      try {
        const ds = new DecompressionStream("gzip");
        const decompressedStream = new Blob([merged]).stream().pipeThrough(ds);
        const decompressedBuf = new Uint8Array(await new Response(decompressedStream).arrayBuffer());
        const decoded = decodeTextBytes(decompressedBuf, "application/xml");
        text = decoded.text;
        characterSet = decoded.charset;
      } catch (gzErr) {
        decodeWarnings.push(`Gzip decompression failed: ${gzErr.message || String(gzErr)}`);
      }
    }

    return {
      ok: true,
      httpStatus: res.status,
      finalUrl: res.url || url,
      contentType,
      dispositionFilename,
      isAttachment: /\battachment\b/i.test(disp),
      headers,
      byteLength: totalBytes,
      sha256,
      sniffed,
      classified,
      blobUrl,
      text,
      characterSet,
      decodeWarnings
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.name === "AbortError" ? "Fetch timeout" : String(err?.message || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Blob URL from string content (text, Markdown, HTML, JSON, JSONL) and return its exact UTF-8 byte length & SHA-256.
 */
async function handleCreateTextBlob({ content, mimeType = "text/plain;charset=utf-8" }) {
  const bytes = new TextEncoder().encode(String(content ?? ""));
  const sha256 = await sha256Hex(bytes);
  const blob = new Blob([bytes], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  activeBlobUrls.set(blobUrl, Date.now());
  return {
    ok: true,
    blobUrl,
    byteLength: bytes.byteLength,
    sha256
  };
}

/**
 * Create a Blob URL from an array of string chunks (for streaming large JSONL exports/checkpoints).
 */
async function handleCreateChunkedBlob({ chunks = [], mimeType = "application/x-ndjson;charset=utf-8" }) {
  const blob = new Blob(chunks, { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  activeBlobUrls.set(blobUrl, Date.now());
  return {
    ok: true,
    blobUrl,
    byteLength: blob.size
  };
}

function handleRevokeBlob({ blobUrl }) {
  if (blobUrl && activeBlobUrls.has(blobUrl)) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch (_) {}
    activeBlobUrls.delete(blobUrl);
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;

  if (message.type === "OFFSCREEN_HEAD_PROBE") {
    handleHeadProbe(message).then(sendResponse);
    return true;
  }
  if (message.type === "OFFSCREEN_FETCH_STREAM") {
    handleFetchStreamAndBlob(message).then(sendResponse);
    return true;
  }
  if (message.type === "OFFSCREEN_CREATE_TEXT_BLOB") {
    handleCreateTextBlob(message).then(sendResponse);
    return true;
  }
  if (message.type === "OFFSCREEN_CREATE_CHUNKED_BLOB") {
    handleCreateChunkedBlob(message).then(sendResponse);
    return true;
  }
  if (message.type === "OFFSCREEN_REVOKE_BLOB") {
    sendResponse(handleRevokeBlob(message));
    return true;
  }
});
