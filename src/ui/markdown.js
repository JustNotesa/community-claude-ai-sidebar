// Minimal, dependency-free, XSS-safe Markdown -> HTML renderer for chat bubbles.
// Strategy: escape ALL HTML first, then re-introduce a small, fixed set of
// formatting. No raw HTML from the model is ever interpreted.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(text) {
  let t = text;
  // inline code
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // bold then italic
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  // links [text](http...) — only http/https
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return t;
}

/** Render Markdown text to an HTML string. Input is treated as untrusted. */
export function renderMarkdown(src) {
  const escaped = escapeHtml(src || "");
  const lines = escaped.split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null; // "ul" | "ol" | null

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const fence = raw.match(/^```(\w*)\s*$/);
    if (fence) {
      if (inCode) {
        out.push(
          `<pre data-lang="${codeLang}"><code>${codeBuf.join("\n")}</code></pre>`
        );
        inCode = false;
        codeBuf = [];
        codeLang = "";
      } else {
        closeList();
        inCode = true;
        codeLang = fence[1] || "";
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }

    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length + 2; // h3..h6 to keep bubble hierarchy sane
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (ul) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    if (raw.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }

  if (inCode) {
    out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
  }
  closeList();
  return out.join("\n");
}
