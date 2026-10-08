import { SteveProjectBinding, steveProjectBinding } from './steve-project-binding.js?v=20261008-completion-placement1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { SteveActivity, readSteveActivity } from './steve-activity.js';
import { SteveConnector, signSteveSubmission } from './steve-connector.js?v=20261008-completion-placement1';
import { SteveDesignChat } from './steve-design-chat.js';
import { SteveLivePreview } from './steve-live-preview.js';

const snapshot = (requestId = 'request-1', project = 'project-a', text = 'Ready', phase = 'completed') => ({
  requestId, renderUserId: 'alice', renderProjectId: project, threadId: 'thread-1', phase,
  messages: [{ id: 'reply-1', role: 'assistant', text }],
});
const packet = (requests = [], cursor = 1, reset = false, epoch = 'epoch-1') => ({ version: 1, binding: { renderUserId: 'alice', renderProjectId: 'project-a', revision: 'revision-a' }, epoch, cursor, reset, requests });
function fixture() {
  let userId = 'alice', next = packet(), ingested = [];
  const activity = new SteveActivity({ bindingState: new SteveProjectBinding(), getUserId: () => userId, read: async () => next, ingest: s => ingested.push(s) });
  return { activity, ingested, user: value => userId = value, feed: value => next = value };
}

test('first snapshot is quiet, chunks deduplicate, only completed unseen replies notify once', async () => {
  const f = fixture(); f.feed(packet([snapshot()])); await f.activity.tick(); assert.equal(f.activity.cards.length, 0);
  f.feed(packet([snapshot('request-2', 'project-a', 'partial', 'running')], 2)); await f.activity.tick();
  f.feed(packet([snapshot('request-2', 'project-a', 'partial more', 'running')], 3)); await f.activity.tick();
  assert.equal(f.activity.cards.length, 0);
  f.feed(packet([snapshot('request-2', 'project-a', 'Final question?')], 4)); await f.activity.tick();
  assert.deepEqual(f.activity.cards, [{ requestId: 'request-2', text: 'Final question?' }]);
  await f.activity.tick(); assert.equal(f.activity.cards.length, 1);
  f.activity.dismiss('request-2'); await f.activity.tick(); assert.equal(f.activity.cards.length, 0);
});

test('restart cursor collision rereads after zero and reset keeps dedup while notifying unseen replies', async () => {
  const f = fixture(); f.feed(packet([snapshot()], 20)); await f.activity.tick();
  f.feed(packet([], 20, false, 'epoch-2')); await f.activity.tick(); assert.equal(f.activity.cursor, 0);
  let sent;
  f.activity.read = async query => { sent = query; return packet([snapshot(), snapshot('request-2')], 20, true, 'epoch-2'); };
  await f.activity.tick(); assert.deepEqual(sent, { renderUserId: 'alice', after: 0 });
  assert.deepEqual(f.activity.cards.map(c => c.requestId), ['request-2']);
  f.activity.dismiss('request-2'); await f.activity.tick(); assert.equal(f.activity.cards.length, 0);
  const reload = fixture(); reload.feed(packet([snapshot(), snapshot('request-2')], 20, true, 'epoch-2'));
  await reload.activity.tick(); assert.equal(reload.activity.cards.length, 0);
});

test('wrong user and moved request project reject whole packet before ingestion', async () => {
  const f = fixture(); await f.activity.tick();
  f.feed(packet([snapshot(), { ...snapshot('request-2'), renderUserId: 'bob' }], 2));
  await assert.rejects(f.activity.tick(), /owner/); assert.equal(f.ingested.length, 0);
  f.feed(packet([snapshot()], 3)); await f.activity.tick();
  f.feed(packet([snapshot('request-2'), snapshot('request-1', 'wrong-project')], 4));
  await assert.rejects(f.activity.tick(), /owner/); assert.equal(f.ingested.length, 1);
});

test('account switch and dispose discard late responses and clear popup', async () => {
  const f = fixture(); let finish; f.activity.read = () => new Promise(resolve => finish = resolve);
  const pending = f.activity.tick(); f.user('bob'); finish(packet([snapshot()])); await pending;
  assert.equal(f.ingested.length, 0);
  f.activity.reset(); assert.equal(f.activity.userId, 'bob'); assert.equal(f.activity.records.size, 0);
  f.user('alice'); f.activity.read = () => new Promise(resolve => finish = resolve);
  const second = f.activity.tick(); f.activity.dispose(); finish(packet([snapshot()])); await second;
  assert.equal(f.ingested.length, 0); assert.equal(f.activity.selected, null);
});

test('single timer is canceled on disposal and cards stay bounded', async () => {
  const f = fixture(); let scheduled = 0, canceled;
  f.activity.schedule = () => ++scheduled; f.activity.cancel = id => canceled = id;
  f.activity.start(); f.activity.start(); await new Promise(resolve => setImmediate(resolve)); assert.equal(scheduled, 1);
  f.feed(packet(Array.from({ length: 8 }, (_, i) => snapshot(`request-${i}`)), 2)); await f.activity.tick();
  assert.equal(f.activity.cards.length, 3); f.activity.select('request-7');
  assert.equal(f.activity.selected, 'request-7'); assert.equal(f.activity.cards.length, 2);
  f.activity.close(); assert.equal(f.activity.selected, null);
  f.activity.dispose(); assert.equal(canceled, 1); assert.equal(f.activity.cards.length, 0);
});

test('activity uses exact signed user scope and capability gating, without submissions', async () => {
  const calls = [], store = { read: async () => 'test-secret' };
  const connector = new SteveConnector({ cryptoApi: webcrypto, secretStore: store, fetchFn: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/status') ? { capabilities: { activityFeed: true, projectBinding: true } } : packet() };
  } });
  await readSteveActivity(connector, { renderUserId: 'alice', after: 7 });
  const { url, options } = calls[1]; assert.ok(url.endsWith('/v1/activity'));
  assert.equal(options.body, '{"renderUserId":"alice","after":7}');
  const h = options.headers;
  assert.equal(h['X-Steve-Signature'], await signSteveSubmission({ secret: 'test-secret', body: options.body,
    requestId: h['X-Request-Id'], timestamp: h['X-Steve-Timestamp'], nonce: h['X-Steve-Nonce'], cryptoApi: webcrypto, path: '/v1/activity' }));
  assert.equal(calls.length, 2);
  connector.secretStore.read = async () => null;
  assert.equal(await readSteveActivity(connector, { renderUserId: 'alice', after: 0 }), null); assert.equal(calls.length, 2);
});

test('background ingestion never selects its viewport and preview runs without a chat host', async () => {
  const values = new Map(), owner = { userId: 'alice', projectId: 'project-a' };
  const storage = { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k), setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  let displayed = 0, histories = 0;
  const preview = new SteveLivePreview({ getOwner: () => owner, clear() {}, display: () => displayed++, post: async ({requestId}) => ({ requestId, revision: 1, units: 'mm', upAxis: 'Z', bodies: [] }) });
  const chat = new SteveDesignChat({ storage }); chat.syncHistory = async () => histories++;
  chat.onPreviewRecord = (record, options) => preview.observe(record, options);
  chat.ingestActivity(snapshot('request-1', 'project-b')); await preview.tick(); assert.equal(displayed, 0);
  chat.ingestActivity(snapshot('request-2')); await preview.tick(); assert.equal(displayed, 1);
  assert.equal(histories, 0); assert.equal(chat.records(owner).length, 1);
  assert.equal(owner.projectId, 'project-a'); assert.equal(chat.records({ ...owner, userId: 'bob' }).length, 0);
});

test('visible viewport polls while chat is absent and pagehide disposes timer/listeners', async () => {
  const { configureSteveLivePreview, steveDesignChat } = await import('./steve-design-chat.js');
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const originalPreview = SteveConnector.prototype.preview;
  let tick, cleared = 0, requests = 0;
  const events = new EventTarget();
  events.setInterval = fn => { tick = fn; return 42; }; events.clearInterval = id => { assert.equal(id, 42); cleared++; };
  globalThis.window = events; globalThis.document = { visibilityState: 'visible' };
  SteveConnector.prototype.preview = async ({ requestId }) => { requests++; return { requestId, revision: 1, units: 'mm', upAxis: 'Z', bodies: [] }; };
  const owner = { userId: 'alice', projectId: 'project-a' };
  try {
    configureSteveLivePreview({ host: { isConnected: true, getClientRects: () => [1] }, getOwner: () => owner,
      THREE: { Group: class { constructor() { this.userData = {}; } traverse() {} } }, scene: { add() {}, remove() {} } });
    steveProjectBinding.accept(packet());
    steveDesignChat.ingestActivity(snapshot(), { bindingRevision: 'revision-a' }); await tick(); assert.equal(requests, 1);
    owner.projectId = 'project-b'; await tick(); assert.equal(requests, 1);
    events.dispatchEvent(new Event('pagehide')); assert.equal(cleared, 1);
  } finally {
    SteveConnector.prototype.preview = originalPreview; globalThis.window = oldWindow; globalThis.document = oldDocument;
    steveDesignChat.onPreviewRecord = () => {};
  }
});

test('signed activity authentication failures retain pairing and back off subsequent POSTs', async () => {
  let posts = 0;
  const connector = new SteveConnector({ cryptoApi: webcrypto, secretStore: { read: async () => 'retained-secret' },
    fetchFn: async (url) => {
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ capabilities: { activityFeed: true, projectBinding: true } }) };
      posts++; return { ok: false, status: 401, json: async () => ({ error: { code: 'invalid_signature', message: 'denied' } }) };
    } });
  await assert.rejects(readSteveActivity(connector, { renderUserId: 'alice', after: 0 }), /authentication/);
  assert.equal(connector.authFailures, 1); assert.ok(connector.authRetryAt > Date.now());
  await assert.rejects(readSteveActivity(connector, { renderUserId: 'alice', after: 0 }), /authentication/);
  assert.equal(posts, 1); assert.equal(connector.secret, 'retained-secret');
});

test('activity honors native busy/availability across unchanged revisions and empty deltas', async () => {
  const f = fixture();
  f.feed({ ...packet([snapshot()], 1, true), busy: true, availableForProjectChange: false });
  await f.activity.tick();
  const state = f.activity.bindingState, generation = state.generation;
  f.activity.select('request-1');
  assert.equal(state.busy, true); // Completed records cannot erase export/save work.
  f.feed({ ...packet([], 2), busy: false, availableForProjectChange: true });
  await f.activity.tick();
  assert.equal(state.busy, false);
  assert.equal(state.availableForProjectChange, true);
  assert.equal(state.generation, generation);
  assert.equal(f.activity.selected, 'request-1');
  assert.equal(f.activity.records.size, 1);
  f.feed(packet([], 3)); await f.activity.tick();
  assert.equal(state.availableForProjectChange, false);
  assert.equal(state.generation, generation);
  f.activity.dispose();
});
