/**
 * SerpyDerpy v2 — Classic IIFE HTML-to-Markdown Extractor
 * Injected into target webpages AFTER Readability.js.
 * Clones document.cloneNode(true) so live DOM is never mutated; preserves untouched
 * rendered HTML, normalizes modern docs DOM, compares Readability vs semantic container,
 * emits valid GitHub Flavored Markdown (GFM) tables, and reports full extraction metrics.
 */
(() => {
  const plainLinks = Boolean(window.__serpyderpyExtractOptions && window.__serpyderpyExtractOptions.plainLinks);

  function cleanWhitespace(str) {
    return String(str || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function normalizeModernDocsDom(doc) {
    for (const spanP of Array.from(doc.querySelectorAll('[data-as="p"]'))) {
      const p = doc.createElement("p");
      while (spanP.firstChild) p.appendChild(spanP.firstChild);
      spanP.replaceWith(p);
    }

    for (const badge of Array.from(doc.querySelectorAll('[data-component-part="update-label"]'))) {
      const h2 = doc.createElement("h2");
      h2.textContent = cleanWhitespace(badge.textContent);
      badge.replaceWith(h2);
    }

    for (const desc of Array.from(doc.querySelectorAll('[data-component-part="update-description"]'))) {
      const p = doc.createElement("p");
      p.textContent = cleanWhitespace(desc.textContent);
      desc.replaceWith(p);
    }

    for (const titleEl of Array.from(
      doc.querySelectorAll(
        '[data-component-part="card-title"], [data-component-part="step-title"], [data-component-part="accordion-title"]'
      )
    )) {
      if (!/^h[1-6]$/i.test(titleEl.tagName)) {
        const h3 = doc.createElement("h3");
        h3.textContent = cleanWhitespace(titleEl.textContent);
        titleEl.replaceWith(h3);
      }
    }

    for (const jumpLink of Array.from(
      doc.querySelectorAll('a[href^="#"][aria-label^="Navigate to"], a.anchor, a.header-anchor, a.hash-link')
    )) {
      jumpLink.remove();
    }

    for (const a of Array.from(doc.querySelectorAll("a"))) {
      const isCard =
        a.classList.contains("card") ||
        a.querySelector("h1, h2, h3, h4, h5, h6, p, [data-component-part='card-content-container']");
      if (isCard) {
        const div = doc.createElement("div");
        while (a.firstChild) div.appendChild(a.firstChild);
        a.replaceWith(div);
      }
    }
  }

  function preCleanDocument(doc) {
    normalizeModernDocsDom(doc);

    const removeSelectors = [
      "script", "style", "noscript", "template", "iframe", "frame",
      "object", "embed", "svg", "canvas", "img", "picture", "source",
      "video", "audio", "track", "map", "area", "figure", "figcaption",
      "form", "input", "textarea", "select", "button", "dialog",
      "nav", "footer", "aside",
      "#navbar", "#sidebar", "#sidebar-content", "#navigation-items",
      "#table-of-contents", "#table-of-contents-layout", "#content-side-layout",
      "#page-context-menu", "#pagination", "#footer", "#banner",
      "[data-layout-item='topbar']", "[data-layout-item='banner']",
      "[data-layout-item='sidebar']", "[data-layout-item='toc']",
      "[data-layout-item='toc-content']", "[data-layout-item='side-panel']",
      "[data-component-part='callout-icon']",
      "[role='navigation']", "[role='banner']", "[role='contentinfo']",
      "[role='complementary']", "[role='dialog']", "[role='alertdialog']",
      "[role='search']", "[aria-modal='true']", "[aria-hidden='true']",
      "[hidden]", ".sr-only",
      ".cookie-banner", ".cookie-consent", "#cookie-banner", "#cookie-consent",
      ".newsletter-signup", ".popup", ".modal", ".ad", ".ads", ".advertisement",
      ".social-share", ".share-buttons", ".related-posts", ".recommended",
      "#comments", ".comments", ".comment-section"
    ];

    try {
      for (const node of doc.querySelectorAll(removeSelectors.join(","))) {
        node.remove();
      }
    } catch (_) {
      for (const sel of removeSelectors) {
        try {
          for (const n of doc.querySelectorAll(sel)) n.remove();
        } catch (_) {}
      }
    }
  }

  function escapeTableCell(str) {
    return String(str || "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n+/g, " ")
      .trim();
  }

  function domToMarkdown(root) {
    function processInline(node) {
      if (!node) return "";
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/\u00A0/g, " ")
          .replace(/[ \t\r\n]+/g, " ");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();
      if (
        [
          "script", "style", "noscript", "svg", "img", "picture",
          "video", "audio", "iframe", "canvas", "button", "input",
          "select", "textarea", "form", "nav", "footer", "aside"
        ].includes(tag)
      ) {
        return "";
      }

      if (tag === "br") return "\n";

      let inner = "";
      for (const child of node.childNodes) {
        inner += processInline(child);
      }

      if (!inner.trim()) return inner;

      if (tag === "strong" || tag === "b") return ` **${inner.trim()}** `;
      if (tag === "em" || tag === "i") return ` *${inner.trim()}* `;
      if (tag === "code") return ` \`${inner.trim()}\` `;
      if (tag === "a") {
        const rawHref = node.getAttribute("href") || "";
        const linkText = inner.trim();
        if (!linkText) return "";
        if (plainLinks || !rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) {
          return linkText;
        }
        try {
          const absUrl = new URL(rawHref, document.baseURI).href;
          if (absUrl.startsWith("http://") || absUrl.startsWith("https://")) {
            return ` [${linkText}](${absUrl}) `;
          }
          return linkText;
        } catch (_) {
          return linkText;
        }
      }
      return inner;
    }

    function normalizeInlineText(text) {
      return text
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/ +\n/g, "\n")
        .replace(/\n +/g, "\n")
        .replace(/ +([.,!?;:])/g, "$1")
        .trim();
    }

    function detectCodeLanguage(preNode) {
      const codeEl = preNode.querySelector("code");
      const cls = `${preNode.className || ""} ${codeEl ? codeEl.className || "" : ""}`;
      const m = cls.match(/\b(?:language|lang)-([a-z0-9_+-]+)\b/i);
      return m ? m[1].toLowerCase() : "";
    }

    function processBlock(node, listDepth = 0) {
      if (!node) return "";
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = cleanWhitespace(node.nodeValue);
        return txt ? txt : "";
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();
      if (
        [
          "script", "style", "noscript", "svg", "img", "picture",
          "video", "audio", "iframe", "canvas", "button", "input",
          "select", "textarea", "form", "nav", "footer", "aside",
          "dialog", "template", "map", "object", "embed"
        ].includes(tag)
      ) {
        return "";
      }

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        const text = normalizeInlineText(processInline(node));
        if (!text) return "";
        return `\n\n${"#".repeat(level)} ${text}\n\n`;
      }

      if (tag === "p") {
        const text = normalizeInlineText(processInline(node));
        if (!text) return "";
        return `\n\n${text}\n\n`;
      }

      if (tag === "pre") {
        const raw = (node.textContent || "").replace(/\r\n/g, "\n").trim();
        if (!raw) return "";
        const lang = detectCodeLanguage(node);
        return `\n\n\`\`\`${lang}\n${raw}\n\`\`\`\n\n`;
      }

      if (tag === "blockquote") {
        const inner = processChildren(node, listDepth).trim();
        if (!inner) return "";
        const quoted = inner
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        return `\n\n${quoted}\n\n`;
      }

      if (tag === "ul" || tag === "ol") {
        const isOrdered = tag === "ol";
        const itemsOut = [];
        let index = 1;
        for (const child of node.children) {
          if (child.tagName && child.tagName.toLowerCase() === "li") {
            const prefix = isOrdered ? `${index}. ` : "- ";
            const indent = "  ".repeat(listDepth);
            const liInline = [];
            const nestedBlocks = [];

            for (const liChild of child.childNodes) {
              if (
                liChild.nodeType === Node.ELEMENT_NODE &&
                ["ul", "ol"].includes(liChild.tagName.toLowerCase())
              ) {
                nestedBlocks.push(processBlock(liChild, listDepth + 1).trimEnd());
              } else if (
                liChild.nodeType === Node.ELEMENT_NODE &&
                ["p", "div"].includes(liChild.tagName.toLowerCase())
              ) {
                liInline.push(normalizeInlineText(processInline(liChild)));
              } else {
                liInline.push(processInline(liChild));
              }
            }

            const mainText = normalizeInlineText(liInline.join(" "));
            let line = mainText ? `${indent}${prefix}${mainText}` : "";
            if (nestedBlocks.length > 0) {
              const nestedStr = nestedBlocks.filter(Boolean).join("\n");
              line = line ? `${line}\n${nestedStr}` : nestedStr;
            }
            if (line.trim()) {
              itemsOut.push(line);
              index++;
            }
          }
        }
        if (itemsOut.length === 0) return "";
        return listDepth === 0 ? `\n\n${itemsOut.join("\n")}\n\n` : `\n${itemsOut.join("\n")}`;
      }

      // Valid GitHub Flavored Markdown (GFM) tables with header separator row (REQ-MD-02 #3)
      if (tag === "table") {
        const rows = Array.from(node.querySelectorAll("tr"));
        const matrix = [];
        for (const tr of rows) {
          const cells = Array.from(tr.children)
            .filter((el) => el.tagName && (el.tagName.toLowerCase() === "th" || el.tagName.toLowerCase() === "td"))
            .map((cell) => escapeTableCell(normalizeInlineText(processInline(cell))));
          if (cells.some((c) => c.length > 0)) {
            matrix.push(cells);
          }
        }
        if (matrix.length === 0) return "";
        const colCount = Math.max(...matrix.map((r) => r.length));
        const normalizedRows = matrix.map((r) => {
          const copy = [...r];
          while (copy.length < colCount) copy.push("");
          return copy;
        });
        const headerLine = `| ${normalizedRows[0].join(" | ")} |`;
        const sepLine = `| ${new Array(colCount).fill("---").join(" | ")} |`;
        const bodyLines = normalizedRows.slice(1).map((r) => `| ${r.join(" | ")} |`);
        return `\n\n${[headerLine, sepLine, ...bodyLines].join("\n")}\n\n`;
      }

      if (tag === "dt") {
        const text = normalizeInlineText(processInline(node));
        return text ? `\n\n**${text}**\n` : "";
      }
      if (tag === "dd") {
        const text = normalizeInlineText(processInline(node));
        return text ? `${text}\n\n` : "";
      }
      if (tag === "hr") return "\n\n---\n\n";
      if (tag === "br") return "\n";

      const hasBlockChildren = Array.from(node.children).some((el) =>
        [
          "p", "div", "section", "article", "main", "header",
          "h1", "h2", "h3", "h4", "h5", "h6",
          "ul", "ol", "li", "table", "blockquote", "pre", "dl", "hr"
        ].includes(el.tagName.toLowerCase())
      );

      if (!hasBlockChildren) {
        const text = normalizeInlineText(processInline(node));
        return text ? `\n\n${text}\n\n` : "";
      }

      return processChildren(node, listDepth);
    }

    function processChildren(parent, listDepth) {
      let out = "";
      for (const child of parent.childNodes) {
        out += processBlock(child, listDepth);
      }
      return out;
    }

    const rawMarkdown = processChildren(root, 0);
    return rawMarkdown
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Capture untouched rendered DOM BEFORE any clone/clean operations (REQ-FETCH-03 step 5)
  const rawHtml =
    "<!DOCTYPE html>\n" +
    (document.documentElement ? document.documentElement.outerHTML : "");
  const warnings = [];

  try {
    let title = cleanWhitespace(document.title || "");

    // Candidate 1: Mozilla Readability on cloned & pre-cleaned document
    let readabilityMarkdown = "";
    if (typeof Readability === "function") {
      try {
        const docForReadability = document.cloneNode(true);
        preCleanDocument(docForReadability);
        const reader = new Readability(docForReadability, {
          charThreshold: 80,
          keepClasses: false
        });
        const article = reader.parse();
        if (article && article.content) {
          if (article.title) title = cleanWhitespace(article.title);
          const tempContainer = document.createElement("div");
          tempContainer.innerHTML = article.content;
          readabilityMarkdown = domToMarkdown(tempContainer);
        }
      } catch (readErr) {
        warnings.push(`Readability error: ${readErr.message || String(readErr)}`);
      }
    }

    // Candidate 2: Direct semantic-container extraction on cloned & pre-cleaned document
    let semanticMarkdown = "";
    const docForSemantic = document.cloneNode(true);
    preCleanDocument(docForSemantic);
    const semanticRoot =
      docForSemantic.querySelector(
        "#content-area, #content, .mdx-content, article, main, [role='main']"
      ) || docForSemantic.body;
    if (semanticRoot) {
      semanticMarkdown = domToMarkdown(semanticRoot);
    }

    // Dual-candidate selection per REQ-MD-01
    let method = "readability";
    let markdownBody = readabilityMarkdown;
    if (
      !markdownBody ||
      markdownBody.length < 120 ||
      semanticMarkdown.length > markdownBody.length * 1.35
    ) {
      if (semanticMarkdown) {
        markdownBody = semanticMarkdown;
        method = "semantic_container";
      }
    }

    // Fallback to visible text if still empty
    if (!markdownBody && document.body) {
      method = "body_innerText";
      markdownBody = (document.body.innerText || "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\u00A0/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      warnings.push("Fell back to document.body.innerText.");
    }

    // Prepend single # Title heading if not already at top (REQ-MD-02 #2)
    if (title && markdownBody) {
      const firstLine = markdownBody.split("\n")[0].replace(/^#+\s*/, "").trim();
      if (
        !firstLine ||
        (!title.toLowerCase().includes(firstLine.toLowerCase()) &&
          !firstLine.toLowerCase().includes(title.toLowerCase()))
      ) {
        markdownBody = `# ${title}\n\n${markdownBody}`;
      }
    }

    return {
      ok: true,
      title: title || "untitled",
      markdownBody: markdownBody || "",
      rawHtml,
      extraction: {
        method,
        rawChars: rawHtml.length,
        markdownChars: (markdownBody || "").length,
        readabilityCandidateChars: readabilityMarkdown.length,
        semanticCandidateChars: semanticMarkdown.length,
        truncated: false,
        warnings
      }
    };
  } catch (err) {
    const fallbackBody = document.body ? (document.body.innerText || "").trim() : "";
    warnings.push(`Extractor exception: ${err && err.message ? err.message : String(err)}`);
    return {
      ok: false,
      error: String(err && err.message ? err.message : err),
      title: cleanWhitespace(document.title || "") || "untitled",
      markdownBody: fallbackBody,
      rawHtml,
      extraction: {
        method: "body_innerText",
        rawChars: rawHtml.length,
        markdownChars: fallbackBody.length,
        readabilityCandidateChars: 0,
        semanticCandidateChars: 0,
        truncated: false,
        warnings
      }
    };
  }
})();
