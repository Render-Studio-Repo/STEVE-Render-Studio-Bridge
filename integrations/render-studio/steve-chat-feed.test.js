import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { watchSteveChat } from "./steve-chat-feed.js";
import { SteveConnector, signSteveSubmission } from "./steve-connector.js";

test("streams request-scoped messages, replaces duplicate IDs and stops at completion", async () => {
  const updates = [], calls = [];
  const replies = [
    { cursor: 1, reset: true, snapshot: { requestId: "request-1", phase: "running", messages: [{ id: "prompt", role: "user", text: "hello" }] } },
    { cursor: 2, events: [{ type: "message", message: { id: "reply", role: "assistant", text: "par" } }] },
    { cursor: 4, events: [{ type: "message", message: { id: "reply", role: "assistant", text: "partial done" } }, { type: "status", phase: "completed" }] },
  ];
  const result = await watchSteveChat({ requestId: "request-1", post: async payload => {
    calls.push(payload); return replies.shift();
  }, onUpdate: snapshot => updates.push(snapshot), wait: async () => {} });
  assert.deepEqual(calls.map(call => call.after), [0, 1, 2]);
  assert.ok(calls.every(call => call.requestId === "request-1"));
  assert.equal(updates[1].messages[1].text, "par");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].text, "partial done");
  assert.equal(result.phase, "completed");
});

test("reconnects without cursor loss and does not retry authorization failures", async () => {
  const connections = [], cursors = [], waits = [];
  let count = 0;
  await watchSteveChat({ requestId: "request-1", post: async payload => {
    cursors.push(payload.after);
    if (++count === 1) return { cursor: 7, events: [] };
    if (count === 2) throw new TypeError("offline");
    return { cursor: 8, events: [{ type: "status", phase: "completed" }] };
  }, onConnection: state => connections.push(state), wait: async ms => waits.push(ms) });
  assert.deepEqual(cursors, [0, 7, 7]);
  assert.ok(connections.includes("reconnecting"));
  assert.deepEqual(waits, [250, 500]);
  let attempts = 0;
  await assert.rejects(watchSteveChat({ requestId: "request-1", post: async () => {
    attempts++; throw Object.assign(new Error("pair again"), { status: 403 });
  } }), /pair again/);
  assert.equal(attempts, 1);
});

test("rejects snapshots belonging to another request and respects abort", async () => {
  await assert.rejects(watchSteveChat({ requestId: "request-1", post: async () => ({
    reset: true, snapshot: { requestId: "other-request", messages: [] },
  }) }), /different request/);
  const controller = new AbortController();
  let count = 0;
  await watchSteveChat({ requestId: "request-1", signal: controller.signal, post: async () => {
    count++; return { cursor: 1, events: [] };
  }, onUpdate: () => controller.abort() });
  assert.equal(count, 1);
});

test("connector signs the events path with fresh authentication IDs and stored pairing secret", async () => {
  const calls = [];
  const connector = new SteveConnector({ cryptoApi: webcrypto,
    secretStore: { read: async () => "test-secret" },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ cursor: 1, reset: true,
        snapshot: { requestId: "request-1", phase: "completed", messages: [] } }) };
    },
  });
  await connector.watch("request-1");
  const { url, options } = calls[0];
  assert.ok(url.endsWith("/v1/events"));
  assert.deepEqual(JSON.parse(options.body), { requestId: "request-1", after: 0 });
  assert.notEqual(options.headers["X-Request-Id"], "request-1");
  assert.equal(options.headers["X-Steve-Signature"], await signSteveSubmission({
    secret: "test-secret", body: options.body, requestId: options.headers["X-Request-Id"],
    timestamp: options.headers["X-Steve-Timestamp"], nonce: options.headers["X-Steve-Nonce"],
    cryptoApi: webcrypto, path: "/v1/events",
  }));
});


test("feed authentication failure clears stale pairing and surfaces reconnect", async () => {
  let cleared = false;
  const connector = new SteveConnector({ cryptoApi: webcrypto,
    secretStore: { read: async () => "old-secret", clear: async () => { cleared = true; } },
    fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "bad signature" } }) }),
  });
  await assert.rejects(connector.watch("request-1"), /Reconnect STEVE/);
  assert.equal(cleared, true);
  assert.equal(connector.secret, null);
  assert.equal(connector.state, "detected");
});
