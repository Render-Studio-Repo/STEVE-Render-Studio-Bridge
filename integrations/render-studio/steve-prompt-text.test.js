import { test } from "node:test";
import assert from "node:assert/strict";
import { publicSteveUrl, serializeStevePrompt } from "./steve-prompt-text.js";

test("actual Amazon-style chip expands to its stored URL without changing surrounding wording", () => {
  const prompt = "Make a mount for this pcb@amazon-B0BM3BFZ35-s2s9g9\nand preserve the reference sketch.";
  const reference = { id: "url:amazon-B0BM3BFZ35-s2s9g9", type: "url", token: "@amazon-B0BM3BFZ35-s2s9g9",
    label: "Octopus Pro PCB", original_url: "https://www.amazon.com/dp/B0BM3BFZ35?th=1",
    url: "https://www.amazon.com/dp/B0BM3BFZ35", description: "Board reference" };
  const result = serializeStevePrompt({ prompt, references: [reference] });
  assert.ok(result.startsWith("Make a mount for this pcb https://www.amazon.com/dp/B0BM3BFZ35?th=1\nand preserve the reference sketch."));
  assert.match(result, /Description: Board reference/);
  assert.doesNotMatch(result, /@amazon-B0BM3BFZ35-s2s9g9/);
  assert.equal(reference.token, "@amazon-B0BM3BFZ35-s2s9g9");
});

test("plain prompt without references is preserved exactly", () => {
  const prompt = "Keep  two spaces.\n\nUse 4 mm holes.";
  assert.equal(serializeStevePrompt({ prompt }), prompt);
});

test("attached reference absent from prompt still supplies its real source and text", () => {
  const result = serializeStevePrompt({ prompt: "Use this motor.", references: [{
    id: "motor-doc", token: "@manual", type: "document", filename: "CL86T.pdf", label: "CL86T manual",
    url: "https://manufacturer.example.com/manual.pdf", text_content: "Connector pin 1: PUL+",
  }] });
  assert.match(result, /URL: https:\/\/manufacturer.example.com\/manual.pdf/);
  assert.match(result, /Available reference text: Connector pin 1: PUL\+/);
});

test("public image URL is text context and never represented as transferred image bytes", () => {
  const result = serializeStevePrompt({ prompt: "Follow @photo.", references: [{
    id: "photo", type: "image", token: "@photo", label: "Side view", url: "https://images.example.com/view.png",
  }], images: [{ id: "front", name: "Front view", url: "https://images.example.com/front.jpg", data_url: "data:image/jpeg;base64,private" }] });
  assert.ok(result.startsWith("Follow https://images.example.com/view.png."));
  assert.match(result, /https:\/\/images.example.com\/front.jpg/);
  assert.match(result, /Image URL only. Image bytes were not transferred/);
  assert.doesNotMatch(result, /base64|private/);
});

test("protected project image, blob and canvas remain explicitly unavailable", () => {
  const result = serializeStevePrompt({ prompt: "Use @canvas.", origin: "https://render3d.app", references: [{
    id: "canvas-image:1", type: "image", token: "@canvas", label: "Orientation", canvas_element_id: "shape-1",
    url: "https://render3d.app/api/projects/p1/files/Canvas/front.png", data_url: "data:image/png;base64,PRIVATE",
  }], images: [{ id: "blob", name: "Local photo", url: "blob:https://render3d.app/123", stored_name: "secret.png" }] });
  assert.match(result, /Orientation \[reference not transferred\]/);
  assert.match(result, /Image bytes were not transferred. Attach the image directly/);
  assert.doesNotMatch(result, /base64|PRIVATE|blob:|\/api\/projects|secret.png/);
});

test("a chip ID alone never becomes an invented Amazon URL", () => {
  const result = serializeStevePrompt({ prompt: "Use @amazon-B0BM3BFZ35.", references: [{
    id: "amazon-B0BM3BFZ35", type: "component", token: "@amazon-B0BM3BFZ35", label: "PCB",
  }] });
  assert.match(result, /PCB \[reference not transferred\]/);
  assert.doesNotMatch(result, /https?:/);
});

test("credentials and signed links are not serialized from prompt or structured reference text", () => {
  const result = serializeStevePrompt({ prompt: "See https://example.com/image?token=PRIVATE_TOKEN", references: [{
    id: "private", type: "link", label: "Manual", url: "https://user:password@example.com/manual",
    original_url: "https://cdn.example.com/image?X-Amz-Signature=SIGNED_SECRET",
    description: "Authorization: Bearer SECRET_HEADER",
    text_content: "Dimensions 30 mm.\napi_key=SECRET_KEY\nhttps://example.com/#access_token=FRAGMENT_SECRET",
    authorization: "DO_NOT_COPY_OBJECT", cookie: "SESSION_VALUE",
  }] });
  assert.match(result, /Dimensions 30 mm/);
  for (const secret of ["PRIVATE_TOKEN", "password@", "SIGNED_SECRET", "SECRET_HEADER", "SECRET_KEY", "FRAGMENT_SECRET", "DO_NOT_COPY_OBJECT", "SESSION_VALUE"]) assert.ok(!result.includes(secret), secret);
});

test("local addresses and private-reference flags are refused without rewriting them into public URLs", () => {
  for (const url of ["http://localhost/x", "http://127.0.0.1/x", "http://10.1.2.3/x", "http://192.168.1.1/x",
    "http://172.20.0.1/x", "http://machine.local/x", "http://[::1]/x", "/api/files/x", "file:///tmp/a.png"]) {
    assert.equal(publicSteveUrl(url), "", url);
  }
  const result = serializeStevePrompt({ prompt: "Use the photo.", images: [{
    id: "protected", name: "Protected photo", url: "https://images.example.com/private.png", requires_auth: true,
  }] });
  assert.doesNotMatch(result, /https:\/\/images.example.com/);
  assert.match(result, /Not transferred/);
});

test("token matching respects longer chips and reference context is bounded and deduplicated", () => {
  const ref = { id: "1", token: "@part", label: "Part", type: "link", url: "https://example.com/part", text_content: "x".repeat(3000) };
  const result = serializeStevePrompt({ prompt: "@part-long @part", references: [ref, ref] });
  assert.ok(result.startsWith("@part-long https://example.com/part"));
  assert.equal(result.split("- Part (link)").length - 1, 1);
  assert.match(result, /incomplete excerpt/);
  assert.ok(result.length < 4000);
});

test("nested redirect credentials and session variants cannot escape URL filtering", () => {
  for (const url of [
    "https://example.com/?auth_token=hidden",
    "https://example.com/?session_key=hidden",
    "https://example.com/?jwt=hidden",
    "https://example.com/?redirect=https%3A%2F%2Fexample.net%2F%3Ftoken%3Dhidden",
    "http://100.64.0.1/image.png",
  ]) assert.equal(publicSteveUrl(url), "", url);
  assert.equal(publicSteveUrl("https://example.com/?model=CL86T&version=4"), "https://example.com/?model=CL86T&version=4");
});
