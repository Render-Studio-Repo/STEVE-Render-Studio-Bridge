const SECRET_KEY = /(?:token|secret|password|authorization|session|signature)|^(?:auth|api[_-]?key|key|passwd|sig|policy|key-pair-id|jwt|x-amz-.+|x-goog-.+)$/i;

export function publicSteveUrl(value, { origin = "", depth = 0 } = {}) {
  if (depth > 3) return "";
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return "";
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return "";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)
      || host.startsWith("[") || /^(?:0|10|127)\./.test(host)
      || /^169\.254\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
      || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return "";
    if ([...url.searchParams].some(([key, value]) => SECRET_KEY.test(key)
      || (/^https?:\/\//i.test(value) && !publicSteveUrl(value, { origin, depth: depth + 1 })))) return "";
    if ([...new URLSearchParams(url.hash.slice(1)).keys()].some(key => SECRET_KEY.test(key))) return "";
    if (/\/(?:api|prompt-history)(?:\/|$)/i.test(url.pathname)
      || (origin && url.origin === origin && /\/(?:projects|files|uploads)(?:\/|$)/i.test(url.pathname))) return "";
    return value.trim();
  } catch { return ""; }
}

function safeText(value, options) {
  return String(value || "")
    .replace(/\b(?:data|blob|file):[^\s<>"']+/gi, "[local data not transferred]")
    .replace(/https?:\/\/[^\s<>"']+/gi, match => {
      const ending = match.match(/[),.;!?]+$/)?.[0] || "";
      const url = ending ? match.slice(0, -ending.length) : match;
      return (publicSteveUrl(url, options) || "[protected or local URL not transferred]") + ending;
    })
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:[^\r\n]+/gi, "[credential header omitted]")
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|session[_-]?id|password|secret)\s*[=:]\s*[^\s,;]+/gi, "[credential omitted]");
}

function referenceUrl(reference, options) {
  if (reference.requires_auth || reference.authenticated || reference.local_only || reference.access === "private") return "";
  for (const candidate of [reference.original_url, reference.url, reference.href, reference.link, reference.pasted,
    reference.image_url, reference.public_url, reference.preview_url, reference.filename]) {
    const url = publicSteveUrl(candidate, options);
    if (url) return url;
  }
  return "";
}

export function serializeStevePrompt({ prompt, references = [], images = [], origin = "" } = {}) {
  const options = { origin };
  let text = safeText(prompt, options);
  const selected = [...(Array.isArray(references) ? references : []).slice(0, 24),
    ...(Array.isArray(images) ? images : []).slice(0, 8).map(image => ({ ...image, type: "image" }))];
  const rows = [], tokens = new Map(), seen = new Set();
  for (const reference of selected) {
    if (!reference || typeof reference !== "object") continue;
    const url = referenceUrl(reference, options);
    const token = String(reference.token || (reference.id ? "@" + reference.id : ""));
    const label = safeText(reference.label || reference.name || reference.filename || token || reference.type || "Reference", options).slice(0, 180);
    const kind = reference.type || reference.media_type || "reference";
    const key = [reference.id || token || label, url].join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    const row = ["- " + label + " (" + safeText(kind, options).slice(0, 60) + ")"];
    if (url) row.push("  URL: " + url);
    else row.push("  Not transferred: no public web URL is available for this reference.");
    if (token) {
      tokens.set(token, url || (label + " [reference not transferred]"));
      if (reference.canvas_element_id && /^@[A-Za-z][A-Za-z0-9_-]*$/.test(token)) tokens.set("#" + token.slice(1), tokens.get(token));
    }
    const description = safeText(reference.description, options).slice(0, 1000);
    const content = safeText(reference.text_content || reference.text, options).slice(0, 2500);
    if (description) row.push("  Description: " + description);
    if (content) {
      row.push("  Available reference text: " + content);
      if (reference.text_truncated || String(reference.text_content || reference.text || "").length > 2500) row.push("  Reference text is an incomplete excerpt.");
    }
    if (reference.type === "image" || String(reference.media_type || reference.mime || "").startsWith("image/")
      || reference.canvas_element_id || reference.role === "canvas") {
      row.push(url ? "  Image URL only. Image bytes were not transferred or attached as a Fusion canvas."
        : "  Image bytes were not transferred. Attach the image directly in STEVE/Fusion if needed.");
    }
    rows.push(row.join("\n"));
  }
  if (tokens.size) {
    const escape = token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = [...tokens.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
    text = text.replace(new RegExp("(?:" + pattern + ")(?![A-Za-z0-9_-])", "g"), (token, offset, input) => {
      const value = tokens.get(token);
      return (/^https?:/.test(value) && /[A-Za-z0-9_]/.test(input[offset - 1] || "") ? " " : "") + value;
    });
  }
  if (!rows.length) return text;
  const context = rows.join("\n\n");
  return text + "\n\nRender reference context (text only):\n"
    + "Web and image URLs are references, not uploaded images or Fusion canvases. Access depends on the tools available in this STEVE provider; say when a reference cannot be opened. Reference text below was supplied by Render; an empty Fusion canvas does not mean this text context is missing.\n"
    + context.slice(0, 12000) + (context.length > 12000 ? "\n[Additional reference context omitted.]" : "");
}
