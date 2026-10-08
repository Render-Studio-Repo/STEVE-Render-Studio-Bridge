import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeSteveReferences, validateSteveImages, MAX_STEVE_IMAGE_BYTES } from "./steve-reference-attachments.js";
const png = "data:image/png;base64,iVBORw0KGgo=";
const bytes = Uint8Array.from(atob(png.split(",")[1]), value => value.charCodeAt(0));
const origin = "https://render3d.app";
const response = () => new Response(bytes, { headers: { "Content-Type": "image/png" } });

test("selected same-origin files use authenticated fetch while foreign images omit credentials", async () => {
  const calls = [];
  const result = await materializeSteveReferences({ origin, images: [
    { name: "local.png", url: "/api/projects/p1/files/local.png" },
    { name: "foreign.png", url: "https://images.example.com/image.png" },
  ] }, {
    fetchSameOrigin: async (url, options) => { calls.push({ kind: "local", url, ...options }); return response(); },
    fetchFn: async (url, options) => { calls.push({ kind: "foreign", url, ...options }); return response(); },
  });
  assert.equal(result[0].data_url, png);
  assert.equal(result.length, 1);
  assert.equal(calls[0].url, "/api/projects/p1/files/local.png");
  assert.equal(calls[0].credentials, "same-origin");
  assert.equal(calls[1].kind, "foreign");
  assert.equal(calls[1].credentials, "omit");
  assert.equal(calls[1].headers, undefined);
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[1].redirect, "error");
});

test("selected image filenames use the captured project and existing file endpoint", async () => {
  let requested;
  const result = await materializeSteveReferences({ origin, projectId: "original", references: [{ type: "image", filename: "Canvas/front view.png" }] }, {
    fetchSameOrigin: async url => { requested = url; return response(); },
  });
  assert.equal(requested, "/api/projects/original/files/Canvas/front%20view.png");
  assert.equal(result[0].data_url, png);
});

test("inline canvas pixels are reused and duplicate selections send one image", async () => {
  const ref = { type: "image", data_url: png, name: "Canvas", role: "canvas" };
  const result = await materializeSteveReferences({ images: [ref], references: [ref] }, { fetchFn: () => { throw new Error("unexpected fetch"); } });
  assert.equal(result.length, 1);
  assert.equal(result[0].data_url, png);
});

test("image count, magic bytes, MIME and decoded size match native limits", async () => {
  assert.deepEqual(validateSteveImages([{ url: png, name: "Canvas" }]), [{ url: png, name: "Canvas" }]);
  assert.throws(() => validateSteveImages(Array(5).fill({ url: png })), /four/);
  assert.throws(() => validateSteveImages([{ url: "data:image/png;base64,YmFk" }]), /readable/);
  assert.throws(() => validateSteveImages([{ url: "data:image/svg+xml;base64,PHN2Zz4=" }]), /valid/);
  const large = "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n" + "a".repeat(MAX_STEVE_IMAGE_BYTES));
  assert.throws(() => validateSteveImages([{ url: large }]), /1 MiB/);
});

test("oversized streaming response cancels the reader instead of buffering the file", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(MAX_STEVE_IMAGE_BYTES + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(materializeSteveReferences({ origin, images: [{ name: "large.png", url: "/large.png" }] }, {
    fetchSameOrigin: async () => new Response(stream, { headers: { "content-type": "image/png" } }),
  }), /1 MiB/);
  assert.equal(cancelled, true);
});

test("redirects, private foreign hosts and failed image fetches block submission", async () => {
  await assert.rejects(materializeSteveReferences({ origin, images: [{ url: "https://10.0.0.1/x.png" }] }), /Cannot load/);
  await assert.rejects(materializeSteveReferences({ origin, images: [{ url: "/x.png" }] }, {
    fetchSameOrigin: async () => ({ ok: true, redirected: true }),
  }), /Could not load/);
  await assert.rejects(materializeSteveReferences({ origin, images: [{ url: "/x.png" }] }, {
    fetchSameOrigin: async () => new Response("missing", { status: 404 }),
  }), /Could not load/);
});
