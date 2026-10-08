const SECRET_KEY = /(?:token|secret|password|authorization|session|signature)|^(?:auth|api[_-]?key|key|passwd|sig|policy|key-pair-id|jwt|x-amz-.+|x-goog-.+)$/i;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

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
    if ([...url.searchParams].some(([key, nested]) => SECRET_KEY.test(key)
      || (/^https?:\/\//i.test(nested) && !publicSteveUrl(nested, { origin, depth: depth + 1 })))) return "";
    if ([...new URLSearchParams(url.hash.slice(1)).keys()].some(key => SECRET_KEY.test(key))) return "";
    if (/\/(?:api|prompt-history)(?:\/|$)/i.test(url.pathname)
      || (origin && url.origin === origin && /\/(?:projects|files|uploads)(?:\/|$)/i.test(url.pathname))) return "";
    return value.trim();
  } catch { return ""; }
}

function bounded(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function referenceUrl(reference, options) {
  if (reference.requires_auth || reference.authenticated || reference.local_only || reference.access === "private") return "";
  for (const candidate of [reference.original_url, reference.url, reference.href, reference.link, reference.pasted,
    reference.image_url, reference.public_url, reference.preview_url]) {
    const url = publicSteveUrl(candidate, options);
    if (url) return url;
  }
  return "";
}

function structuredReference(reference, options) {
  if (!reference || typeof reference !== "object") return null;
  const result = {};
  for (const [source, target, maximum] of [
    ["id", "id", 256], ["token", "token", 256], ["type", "type", 80], ["label", "label", 256],
    ["name", "name", 256], ["filename", "filename", 512], ["stored_name", "stored_name", 512],
    ["source_filename", "source_filename", 512], ["media_type", "media_type", 120], ["mime", "mime", 120],
    ["description", "description", 2000], ["text_content", "text_content", 100000],
    ["canvas_element_id", "canvas_element_id", 256],
  ]) {
    const value = bounded(source === "text_content" ? reference.text_content || reference.text : reference[source], maximum);
    if (value) result[target] = value;
  }
  const url = referenceUrl(reference, options);
  if (url) result.url = url;
  const dataUrl = bounded(reference.data_url, 1_500_000);
  if (dataUrl && IMAGE_DATA_URL.test(dataUrl)) result.data_url = dataUrl;
  return Object.keys(result).length ? result : null;
}

export function serializeStevePrompt({ prompt, references = [], origin = "" } = {}) {
  const options = { origin };
  let text = String(prompt ?? "").replace(/!?\[([^\]]*)\]\(<?(https?:\/\/(?:[^\s()<>]|\([^\s()]*\))+)>(?:\s+"[^"]*")?\)/g, (_, label, url) => publicSteveUrl(url, options) || label)
    .replace(/!?\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\)/g, (_, label, url) => publicSteveUrl(url, options) || label);
  const tokens = new Map();
  for (const reference of references) {
    if (!reference || typeof reference !== "object") continue;
    const url = referenceUrl(reference, options);
    const token = String(reference.token || (reference.id ? "@" + reference.id : ""));
    if (token) {
      tokens.set(token, url || String(reference.label || reference.name || reference.filename || token));
      if (reference.canvas_element_id && token.startsWith("@")) tokens.set("#" + token.slice(1), tokens.get(token));
    }
  }
  if (tokens.size) {
    const escaped = [...tokens.keys()].sort((a, b) => b.length - a.length).map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    text = text.replace(new RegExp("(?:" + escaped.join("|") + ")(?![A-Za-z0-9_-])", "g"), (token, offset, input) => {
      const value = tokens.get(token);
      return (/^https?:/.test(value) && /[A-Za-z0-9_]/.test(input[offset - 1] || "") ? " " : "") + value;
    });
  }
  return text;
}

export async function prepareSteveSubmission(input = {}, options = {}) {
  const { materializeSteveReferences } = await import("./steve-reference-attachments.js?v=20261008-clean-message1");
  const references = await materializeSteveReferences(input, options);
  const normalized = [], seen = new Set();
  let textLength = 0;
  for (const item of references) {
    const text = item.text_content || item.text || "";
    if (String(text).length > 64000) throw new Error("Selected reference text exceeds 64,000 characters. Select a smaller document excerpt.");
    const reference = structuredReference(item, { origin: input.origin || "" });
    if (!reference) continue;
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    textLength += (reference.text_content || "").length;
    if (textLength > 64000) throw new Error("Selected reference text exceeds 64,000 characters. Select fewer documents.");
    normalized.push(reference);
  }
  return { prompt: serializeStevePrompt(input), references: normalized };
}
