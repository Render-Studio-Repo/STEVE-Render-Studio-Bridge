import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareSteveSubmission, publicSteveUrl, serializeStevePrompt } from "./steve-prompt-text.js";

const png = "data:image/png;base64,iVBORw0KGgo=";

test("user wording and whitespace survive while markdown and token links become plain URLs", async () => {
  const result = await prepareSteveSubmission({ prompt: "  Fit pcb@motor\nSee [manual](https://parts.example.com/manual.pdf).  ",
    references: [{ id: "motor", token: "@motor", type: "url", url: "https://parts.example.com/motor" }] });
  assert.equal(result.prompt, "  Fit pcb https://parts.example.com/motor\nSee https://parts.example.com/manual.pdf.  ");
  assert.equal(serializeStevePrompt({ prompt: "  test\nKeep  spaces.  " }), "  test\nKeep  spaces.  ");
});

test("document text and public PDF links remain hidden structured metadata", async () => {
  const result = await prepareSteveSubmission({ prompt: "Use the attached motor.", references: [{
    id: "motor-doc", type: "document", filename: "motor.pdf", label: "Motor manual",
    url: "https://parts.example.com/manual.pdf", text_content: "Shaft diameter: 8 mm",
  }, { type: "document", filename: "catalog.pdf", url: "https://parts.example.com/catalog.pdf" }] });
  assert.equal(result.prompt, "Use the attached motor.");
  assert.equal(result.references[0].text_content, "Shaft diameter: 8 mm");
  assert.equal(result.references[1].url, "https://parts.example.com/catalog.pdf");
});

test("canvas pixels and metadata travel as an attachment, never prompt boilerplate", async () => {
  const result = await prepareSteveSubmission({ prompt: "Follow @canvas.", references: [{
    id: "canvas", token: "@canvas", type: "image", label: "Orientation", canvas_element_id: "shape-1", data_url: png,
  }] });
  assert.equal(result.prompt, "Follow Orientation.");
  assert.equal(result.references[0].data_url, png);
  assert.equal(result.references[0].canvas_element_id, "shape-1");
});

test("implicit electronics component metadata does not add prose or block a plain message", async () => {
  const result = await prepareSteveSubmission({ prompt: "test", references: [{
    id: "electronics_build_sourcing", type: "component", description: "Select electronic parts", label: "Electronics",
  }] });
  assert.equal(result.prompt, "test");
  assert.equal(result.references[0].id, "electronics_build_sourcing");
});

test("unsupported selected binaries fail before send instead of disappearing", async () => {
  await assert.rejects(prepareSteveSubmission({ prompt: "Use this.", references: [{
    type: "document", filename: "drawing.step", url: "/api/projects/p1/files/drawing.step",
  }], origin: "https://render3d.app" }), /drawing.step/);
});

test("metadata is allowlisted, bounded and deduplicated without modifying user text", async () => {
  const ref = { id: "doc", type: "document", text_content: "x".repeat(30000),
    authorization: "Bearer secret", cookie: "private", url: "https://example.com/?token=secret" };
  const result = await prepareSteveSubmission({ prompt: "test", references: [ref, ref] });
  assert.equal(result.prompt, "test");
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].text_content.length, 30000);
  assert.doesNotMatch(JSON.stringify(result.references), /Bearer|cookie|secret/);
});

test("URL filtering rejects private and signed reference URLs without inventing links", () => {
  for (const url of ["http://localhost/x", "http://127.0.0.1/x", "http://10.1.2.3/x", "http://192.168.1.1/x",
    "http://machine.local/x", "http://[::1]/x", "/api/files/x", "file:///tmp/a.png", "https://example.com/?auth_token=hidden"]) {
    assert.equal(publicSteveUrl(url), "", url);
  }
  assert.equal(serializeStevePrompt({ prompt: "Use @part-long and @part", references: [{ token: "@part", label: "Part" }] }), "Use @part-long and Part");
});


test("reference text exceeding the aggregate budget fails without truncating documents", async () => {
  await assert.rejects(prepareSteveSubmission({ prompt: "Use these", references: [
    { id: "first", type: "document", text_content: "a".repeat(40000) },
    { id: "second", type: "document", text_content: "b".repeat(30000) },
  ] }), /64,000/);
  await assert.rejects(prepareSteveSubmission({ references: [{ type: "document", text_content: "a".repeat(64001) }] }), /64,000/);
});
