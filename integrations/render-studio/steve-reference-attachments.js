import { publicSteveUrl } from "./steve-prompt-text.js?v=20261008-clean-message1";

export const MAX_STEVE_IMAGES = 4;
export const MAX_STEVE_IMAGE_BYTES = 1024 * 1024;
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/;

export function validateSteveImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_STEVE_IMAGES) throw new Error("Attach at most four images to STEVE.");
  return images.map(image => {
    const url = image?.url;
    if (typeof url !== "string" || url.length > 4 * Math.ceil(MAX_STEVE_IMAGE_BYTES / 3) + 32) {
      throw new Error("Use PNG, JPEG, or WebP images under 1 MiB each.");
    }
    const match = DATA_IMAGE.exec(url);
    let bytes;
    try {
      if (!match || match[2].length % 4) throw new Error();
      bytes = atob(match[2]);
    } catch { throw new Error("The selected image is not valid PNG, JPEG, or WebP data."); }
    const valid = match[1] === "png" ? bytes.startsWith("\x89PNG\r\n\x1a\n")
      : match[1] === "jpeg" ? bytes.startsWith("\xff\xd8\xff")
        : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    if (!valid || bytes.length > MAX_STEVE_IMAGE_BYTES) throw new Error("Use readable PNG, JPEG, or WebP images under 1 MiB each.");
    return { url, name: String(image.name || "Reference image").slice(0, 120) };
  });
}

function isImage(item) {
  return item.type === "image" || item.role === "canvas" || item.type === "canvas"
    || String(item.media_type || item.mime || "").startsWith("image/")
    || /^data:image\//.test(item.data_url || "")
    || /\.(png|jpe?g|webp|gif|svg|heic)(?:[?#]|$)/i.test(item.filename || item.name || item.url || "");
}

function selectedFile(item) {
  if (["component", "face", "edge", "corner", "lasso", "path"].includes(item.type)) return false;
  return ["file", "document", "attachment", "image", "canvas"].includes(item.type)
    || Boolean(item.filename || item.stored_name || item.media_type || item.mime || item.data_url);
}

async function readImage(url, name, { origin, fetchFn, fetchSameOrigin, signal, timeoutMs }) {
  let parsed;
  try { parsed = new URL(url, origin); } catch { throw new Error(`Select the image again: ${name}.`); }
  const sameOrigin = parsed.origin === origin;
  const blob = parsed.protocol === "blob:" && sameOrigin;
  if (parsed.username || parsed.password || (!blob && !["http:", "https:"].includes(parsed.protocol))
    || (!sameOrigin && !publicSteveUrl(parsed.href))) throw new Error(`Cannot load this image URL: ${name}.`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  let reader;
  try {
    const fetchImage = sameOrigin && !blob ? fetchSameOrigin : fetchFn;
    const target = sameOrigin && !blob ? parsed.pathname + parsed.search : parsed.href;
    const response = await fetchImage(target, { method: "GET", credentials: sameOrigin && !blob ? "same-origin" : "omit",
      redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
    if (!response.ok || response.redirected) throw new Error(`Could not load selected image: ${name}.`);
    const mime = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error(`Use a PNG, JPEG, or WebP image: ${name}.`);
    if (Number(response.headers.get("content-length")) > MAX_STEVE_IMAGE_BYTES) throw new Error(`Image exceeds 1 MiB: ${name}.`);
    reader = response.body?.getReader();
    if (!reader) throw new Error(`Could not read selected image: ${name}.`);
    let size = 0, binary = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STEVE_IMAGE_BYTES) throw new Error(`Image exceeds 1 MiB: ${name}.`);
      for (let offset = 0; offset < value.length; offset += 8192) {
        binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
      }
    }
    return `data:${mime};base64,${btoa(binary)}`;
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (reader) {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
  }
}

export async function materializeSteveReferences({ references = [], images = [], origin = "", projectId = "" } = {},
  { fetchFn = globalThis.fetch, fetchSameOrigin = fetchFn, signal, timeoutMs = 15000 } = {}) {
  if (!Array.isArray(references) || !Array.isArray(images) || references.length + images.length > 64) {
    throw new Error("Too many selected references. Select only the files needed for this message.");
  }
  const selected = [...images.map(item => ({ ...item, type: "image" })), ...references.filter(item => item && typeof item === "object")];
  const result = [], sources = new Set(), pixels = new Set();
  for (const item of selected) {
    const name = String(item.name || item.label || item.filename || "Reference image").slice(0, 120);
    if (!isImage(item)) {
      if (selectedFile(item) && !item.text_content && !item.text
        && ![item.original_url, item.url, item.href, item.link, item.public_url].some(url => publicSteveUrl(url, { origin }))) throw new Error(`STEVE cannot attach this file type: ${name}. Attach a PNG, JPEG, or WebP image instead.`);
      result.push(item);
      continue;
    }
    let source = item.data_url || item.image_url || item.url || item.preview_url || item.href;
    if (!source && projectId && item.filename) {
      source = `/api/projects/${encodeURIComponent(projectId)}/files/${String(item.filename).split("/").map(encodeURIComponent).join("/")}`;
    }
    if (!source) throw new Error(`Select the image again: ${name}. No image pixels or file URL are available.`);
    if (sources.has(source)) continue;
    sources.add(source);
    if (pixels.size >= MAX_STEVE_IMAGES) throw new Error("Attach at most four images to STEVE.");
    const url = source.startsWith("data:") ? source : await readImage(source, name,
      { origin, fetchFn, fetchSameOrigin, signal, timeoutMs });
    validateSteveImages([{ url, name }]);
    if (pixels.has(url)) continue;
    pixels.add(url);
    result.push({ ...item, data_url: url });
  }
  return result;
}
