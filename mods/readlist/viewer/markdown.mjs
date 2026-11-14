// Render untrusted Markdown for the same sandboxed document frame as local HTML.
// Marked parses GFM tables and task lists; this renderer escapes raw HTML and only
// emits URLs which the host has already confined to the selected file's manifest.
// Its root paints both system colors: the sandboxed iframe has a white backing even
// when this document uses a dark color scheme.
import { Marked } from "./marked/marked.esm.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

export function markdownReferences(source) {
  const parser = new Marked({ gfm: true });
  const references = [];
  parser.walkTokens(parser.lexer(source), (token) => {
    if ((token.type === "link" || token.type === "image") && token.href) references.push(token.href);
  });
  return references;
}

export function renderMarkdown(source, name, allowedUrl) {
  const headings = new Map();
  const parser = new Marked({ gfm: true, renderer: {
    html(token) { return escapeHtml(token.text); },
    heading(token) {
      const text = this.parser.parseInline(token.tokens);
      const base = token.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-") || "section";
      const count = headings.get(base) ?? 0;
      headings.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      return `<h${token.depth} id="${escapeHtml(id)}">${text}</h${token.depth}>\n`;
    },
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      const href = allowedUrl(token.href, name, false);
      return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    },
    image(token) {
      const src = allowedUrl(token.href, name, true);
      const alt = escapeHtml(token.text);
      return src ? `<img src="${escapeHtml(src)}" alt="${alt}">` : `<span class="missing-image">${alt}</span>`;
    },
  } });
  const body = parser.parse(source);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(name)}</title><style>
:root{color-scheme:light dark;background:Canvas;color:CanvasText;font:16px/1.55 system-ui,sans-serif}body{max-width:850px;margin:0 auto;padding:24px 32px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}a{color:LinkText}img{max-width:100%;height:auto}pre{overflow:auto;padding:16px;border-radius:6px;background:color-mix(in srgb,CanvasText 8%,Canvas)}code{font:0.9em/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}pre code{font-size:13px}blockquote{margin-left:0;padding-left:16px;border-left:3px solid GrayText;color:GrayText}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid GrayText;padding:6px 10px}th{background:color-mix(in srgb,CanvasText 7%,Canvas)}input[type=checkbox]{margin-right:7px}.missing-image{color:GrayText}
</style><body><article>${body}</article></body></html>`;
}
