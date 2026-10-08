import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SteveConnector,
  classifySteveStatus,
  deriveSteveSetupState,
  normalizeDesignName,
  signSteveSubmission,
  suggestedDesignName,
} from "./steve-connector.js";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "connector-fragment.html"), "utf8");
const source = readFileSync(join(here, "steve-connector.js"), "utf8");

test("CAD picker keeps STEVE compact and opens the Fusion-first setup flow", () => {
  assert.match(html, /data-cad-engine="steve"/);
  assert.match(html, /data-steve-status-dot/);
  assert.match(html, /data-steve-setup>View setup/);
  assert.match(source, /data-steve-setup-tab="fusion"/);
  assert.match(source, /data-steve-setup-tab="steve"/);
  assert.match(source, /data-steve-setup-tab="home"/);
  assert.match(source, /Connect Fusion 360 first/);
  assert.match(source, /Add Fusion tab to viewport/);
  assert.match(source, /Open project homes/);
  assert.match(html, /https:\/\/github\.com\/wprojects\/STEVE-Render-Studio-Bridge/);
});

test("Fusion connection is the prerequisite for STEVE", () => {
  assert.deepEqual(deriveSteveSetupState({ fusionLinked: false, steveState: "detected" }), {
    fusionLinked: false,
    fusionTabAttached: false,
    canConnectSteve: false,
    steveConnected: false,
  });
  assert.equal(deriveSteveSetupState({ fusionLinked: true, steveState: "ready", fusionTabAttached: true }).canConnectSteve, true);
  assert.equal(deriveSteveSetupState({ fusionLinked: true, steveState: "ready", fusionTabAttached: true }).steveConnected, true);
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test("status response maps into the explicit connection state machine", () => {
  assert.equal(classifySteveStatus({ version: "1.0.0", fusionRunning: false }), "unavailable");
  assert.equal(classifySteveStatus({ version: "1.0.0", fusionRunning: true }), "detected");
  assert.equal(classifySteveStatus({ version: "1.0.0", fusionRunning: true, pairingId: "p1" }), "pairing");
  assert.equal(classifySteveStatus({ version: "1.0.0", fusionRunning: true, connected: true }, { hasSecret: true }), "connected_not_ready");
  assert.equal(classifySteveStatus({ version: "1.0.0", fusionRunning: true, connected: true, providerReady: true, ready: true }, { hasSecret: true }), "ready");
  assert.equal(classifySteveStatus({ version: "1.0.0", fusionRunning: true, connected: true, providerReady: true, ready: true, queueDepth: 1 }, { hasSecret: true }), "busy");
  assert.equal(classifySteveStatus({ version: "2.0.0", fusionRunning: true }), "incompatible");
  assert.equal(classifySteveStatus({ version: "1.0.0", phase: "error", fusionRunning: true }), "error");
});

test("design name is editable-safe and predictably suggested", () => {
  assert.equal(normalizeDesignName("  Clamp / Bracket?!  "), "Clamp Bracket");
  assert.equal(suggestedDesignName("Create an adjustable desk clamp", new Date("2026-09-30T12:00:00Z")), "create-an-adjustable-desk-clamp-20260930");
});

test("submission signature uses the exact body and canonical protocol order", async () => {
  const body = '{"prompt":"make a bracket","designName":"bracket-1"}';
  const signature = await signSteveSubmission({
    secret: "test-secret",
    body,
    requestId: "request-1",
    timestamp: "1790800000",
    nonce: "00112233445566778899aabbccddeeff",
    cryptoApi: webcrypto,
  });
  assert.equal(signature, "a721318f883b141d03de7ffb0d25960937f230c0e5d98840b57e45da7475f893");
});

test("pairing waits for Fusion approval and stores the returned secret", async () => {
  const writes = [];
  const calls = [];
  const replies = [
    response(200, { pairingId: "pair-1" }),
    response(409, { code: "pairing_pending" }),
    response(200, { secret: "paired-secret" }),
    response(200, { version: "1.0.0", fusionRunning: true, connected: true, providerReady: true, ready: true }),
  ];
  const connector = new SteveConnector({
    fetchFn: async (url, options) => { calls.push([url, options]); if (url.endsWith("/storage")) return response(202, { pending: true }); return replies.shift(); },
    secretStore: { read: async () => writes.at(-1) || null, write: async (value) => writes.push(value), clear: async () => {} },
    schedule: (fn) => { queueMicrotask(fn); return 1; },
    cancelSchedule: () => {},
  });
  connector.active = true;
  await connector.pair();
  connector.deactivate();
  assert.equal(connector.state, "ready");
  assert.deepEqual(writes, ["paired-secret"]);
  assert.equal(calls[0][0], "http://127.0.0.1:38173/v1/pairing/request");
  assert.equal(calls[1][1].body, '{"pairingId":"pair-1"}');
});

test("ready connector submits the exact compact payload with auth headers", async () => {
  let captured;
  const connector = new SteveConnector({
    fetchFn: async (url, options) => { captured = { url, options }; return response(202, { accepted: true }); },
    cryptoApi: {
      subtle: webcrypto.subtle,
      randomUUID: () => "request-fixed",
      getRandomValues: (bytes) => bytes.fill(1),
    },
    secretStore: { read: async () => "secret", write: async () => {}, clear: async () => {} },
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  connector.secret = "secret";
  connector.state = "ready";
  const result = await connector.submit({
    prompt: "Make a hinge",
    projectId: "project-1",
    folderId: "folder-2",
    designName: "Hinge A",
  });
  assert.equal(result.requestId, "request-fixed");
  assert.equal(captured.url, "http://127.0.0.1:38173/v1/submissions");
  assert.equal(captured.options.body, '{"prompt":"Make a hinge","projectId":"project-1","folderId":"folder-2","designName":"Hinge A"}');
  assert.equal(captured.options.headers["X-Request-Id"], "request-fixed");
  assert.match(captured.options.headers["X-Steve-Signature"], /^[0-9a-f]{64}$/);
});

test("storage RPC signs each route and polls with a fresh request ID", async () => {
  const calls = [];
  let id = 0;
  const connector = new SteveConnector({
    cryptoApi: { subtle: webcrypto.subtle, getRandomValues: b => webcrypto.getRandomValues(b), randomUUID: () => `rpc-${++id}` },
    secretStore: { read: async () => "secret", clear: async () => {} },
    schedule: fn => { queueMicrotask(fn); return 1; },
    fetchFn: async (url, options) => {
      calls.push({url, options});
      return response(200, calls.length === 1 ? {pending: true} : {pending: false, result: {autoSave: true}});
    },
  });
  assert.deepEqual(await connector.storage({action: "getSettings"}), {autoSave: true});
  assert.equal(calls[0].url, "http://127.0.0.1:38173/v1/storage");
  assert.equal(calls[1].url, "http://127.0.0.1:38173/v1/storage/result");
  assert.notEqual(calls[0].options.headers["X-Request-Id"], calls[1].options.headers["X-Request-Id"]);
  assert.equal(calls[1].options.body, '{"requestId":"rpc-1"}');
  for (const {url, options} of calls) {
    const headers = options.headers;
    assert.equal(headers["X-Steve-Signature"], await signSteveSubmission({secret: "secret", body: options.body,
      requestId: headers["X-Request-Id"], timestamp: headers["X-Steve-Timestamp"], nonce: headers["X-Steve-Nonce"],
      path: new URL(url).pathname, cryptoApi: webcrypto}));
  }
});

test("storage rejects stale pairing and main-thread errors", async () => {
  let cleared = false;
  const connector = new SteveConnector({ cryptoApi: webcrypto,
    secretStore: {read: async () => "expired", clear: async () => {cleared = true;}},
    fetchFn: async () => response(401, {error: "bad signature"}) });
  await assert.rejects(connector.storage({action:"getSettings"}), /Saved pairing is retained/);
  assert.equal(cleared, false);
  connector.secret = "current";
  connector.secretStore.read = async () => "current";
  connector.fetchFn = async () => response(200, {pending:false,error:"Folder is inaccessible"});
  await assert.rejects(connector.storage({action:"folders"}), /Folder is inaccessible/);
});

test("old bridge never receives unsupported project lookup", async () => {
  const paths = [];
  const connector = new SteveConnector({ fetchFn: async url => {
    paths.push(url); return response(200, { capabilities: { chatEvents: true } });
  } });
  await assert.rejects(connector.latest({ userId: "alice", projectId: "a" }), /needs an update/);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /status$/);
});

test("latest retains stored pairing on 401", async () => {
  let cleared = false;
  const connector = new SteveConnector({ cryptoApi: webcrypto,
    secretStore: { read: async () => "secret", clear: async () => { cleared = true; } },
    fetchFn: async url => url.endsWith("/status")
      ? response(200, { capabilities: { projectChatHistory: true } }) : response(401, { error: "unauthorized" }),
  });
  await assert.rejects(connector.latest({ userId: "alice", projectId: "a" }), /Saved pairing is retained/);
  assert.equal(cleared, false);
  assert.equal(connector.secret, "secret");
});

test("submission keeps Autodesk and Render identities separate and requires owner pair", async () => {
  let body;
  const connector = new SteveConnector({ cryptoApi: webcrypto, fetchFn: async (url, options) => {
    body = JSON.parse(options.body); return response(200, { accepted: true });
  } });
  connector.secret = "secret"; connector.state = "ready";
  await assert.rejects(connector.submit({ prompt: "design", renderProjectId: "render-a" }), /Both Render/);
  await connector.submit({ prompt: "design", projectId: "fusion-p", folderId: "fusion-f",
    renderProjectId: "render-a", renderUserId: "alice", requestId: "request-123" });
  assert.deepEqual(body, { prompt: "design", projectId: "fusion-p", folderId: "fusion-f",
    renderProjectId: "render-a", renderUserId: "alice" });
});

test("preview signs request-scoped revisions and gates older bridges", async () => {
  const calls = [];
  const connector = new SteveConnector({ cryptoApi: webcrypto,
    secretStore: { read: async () => "secret", clear: async () => {} },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return response(200, url.endsWith("/status") ? { capabilities: { livePreview: true } }
        : { requestId: "request-123", revision: 7, unchanged: true });
    },
  });
  await connector.preview({ requestId: "request-123", afterRevision: 7 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /v1\/preview$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { requestId: "request-123", afterRevision: 7 });
  assert.match(calls[1].options.headers["X-Steve-Signature"], /^[0-9a-f]{64}$/);
  let oldCalls = 0;
  const old = new SteveConnector({ fetchFn: async () => { oldCalls++; return response(200, { capabilities: {} }); } });
  await assert.rejects(old.preview({ requestId: "request-123" }), /Update the STEVE/);
  assert.equal(oldCalls, 1);
});

test("latest request discovery is signed and scoped to the active Render project", async () => {
  let captured;
  const connector = new SteveConnector({
    fetchFn: async (url, options) => {
      if (url.endsWith("/v1/status")) return response(200, { capabilities: { projectChatHistory: true } });
      captured = { url, options }; return response(200, {
        snapshot: { requestId: "request-found", phase: "running", messages: [] },
      });
    },
    cryptoApi: {
      subtle: webcrypto.subtle,
      randomUUID: () => "poll-fixed",
      getRandomValues: bytes => bytes.fill(2),
    },
    secretStore: { read: async () => "secret", clear: async () => {} },
  });
  const result = await connector.latest({ projectId: "project-88b644e1", userId: "user-1" });
  assert.equal(result.snapshot.requestId, "request-found");
  assert.equal(captured.url, "http://127.0.0.1:38173/v1/events");
  assert.equal(captured.options.body, '{"renderProjectId":"project-88b644e1","renderUserId":"user-1","after":0}');
  assert.match(captured.options.headers["X-Steve-Signature"], /^[0-9a-f]{64}$/);
});

test("recovery retains pairing through restart, backs off, and adopts another tab approval", async () => {
  let stored = "old", calls = 0, cleared = 0, restored = false;
  const connector = new SteveConnector({ cryptoApi: webcrypto,
    secretStore: { read: async () => stored, clear: async () => { cleared++; } },
    fetchFn: async url => {
      if (url.endsWith("/status")) return response(200, { capabilities: { projectChatHistory: true } });
      calls++;
      return restored ? response(200, { snapshot: { requestId: "request-1" } })
        : response(401, { error: { code: "not_paired", message: "Restarting" } });
    },
  });
  const owner = { userId: "alice", projectId: "a" };
  await assert.rejects(connector.latest(owner));
  await assert.rejects(connector.latest(owner));
  assert.equal(calls, 1); assert.equal(cleared, 0); assert.equal(stored, "old");
  connector.authRetryAt = 0; restored = true;
  await connector.latest(owner);
  assert.equal(calls, 2); assert.equal(connector.authFailure, null);
  connector.authFailure = Object.assign(new Error("old rejected"), { status: 403 });
  connector.authRetryAt = Date.now() + 30000; stored = "new-approved";
  await connector.latest(owner);
  assert.equal(connector.secret, "new-approved"); assert.equal(calls, 3);
});

test("status polling rereads browser pairing without starting approval or deleting credentials", async () => {
  let stored = null; const paths = [];
  const connector = new SteveConnector({
    secretStore: { read: async () => stored, clear: async () => { throw new Error("must not clear"); } },
    schedule: () => 1, cancelSchedule: () => {},
    fetchFn: async url => { paths.push(url); return response(200, { version: "1.0.0", fusionRunning: true, connected: true, ready: true, providerReady: true }); },
  });
  await connector.activate(); assert.equal(connector.state, "detected");
  stored = "approved-in-other-tab"; await connector.poll(); assert.equal(connector.state, "ready");
  assert.ok(paths.every(path => path.endsWith("/status") || path.endsWith("/storage")));
  assert.ok(paths.every(path => !path.endsWith("/ping")));
  connector.deactivate();
});

test("403 origin rejection cannot erase a newer secret written while an older request is in flight", async () => {
  let stored = "old"; let clears = 0;
  const connector = new SteveConnector({ cryptoApi: webcrypto,
    secretStore: { read: async () => stored, clear: async () => { clears++; } },
    fetchFn: async url => {
      if (url.endsWith("/status")) return response(200, { capabilities: { projectChatHistory: true } });
      stored = "new-approved"; return response(403, { error: { code: "origin_denied" } });
    },
  });
  await assert.rejects(connector.latest({ userId: "alice", projectId: "a" }));
  assert.equal(stored, "new-approved"); assert.equal(clears, 0);
  await connector.refreshSecret();
  assert.equal(connector.secret, "new-approved"); assert.equal(connector.authFailure, null);
});

test("public ready status cannot verify an invalid stored key; capability-gated signed ping clears same-connector failure after backoff", async () => {
  let accepted = false, probes = 0, clears = 0;
  const connector = new SteveConnector({ cryptoApi: webcrypto, schedule: () => 1, cancelSchedule: () => {},
    secretStore: { read: async () => "saved-key", clear: async () => { clears++; } },
    fetchFn: async (url, options) => {
      if (url.endsWith("/status")) return response(200, { fusionRunning: true, connected: true, ready: true, providerReady: true, capabilities: { authPing: true } });
      assert.ok(url.endsWith("/ping"));
      assert.deepEqual(JSON.parse(options.body), {});
      assert.match(options.headers["X-Steve-Signature"], /^[0-9a-f]{64}$/);
      probes++;
      return accepted ? response(200, { authenticated: true }) : response(401, { code: "invalid_signature" });
    },
  });
  await connector.activate();
  assert.equal(connector.state, "detected"); assert.equal(connector.reconnectNeeded, true);
  await connector.poll(); assert.equal(probes, 1);
  accepted = true; connector.authRetryAt = 0;
  await connector.poll(); assert.equal(probes, 2); assert.equal(connector.state, "ready");
  assert.equal(connector.reconnectNeeded, false); assert.equal(clears, 0);
  await connector.poll(); assert.equal(probes, 3);
  connector.deactivate();
});
