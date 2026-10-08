import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { SteveProjectBinding, steveProjectBinding, bindingError } from './steve-project-binding.js?v=20261008-project-lock-p1';
import { SteveActivity } from './steve-activity.js';
import { SteveConnector, signSteveSubmission } from './steve-connector.js?v=20261008-project-lock-p1';
import { SteveDesignChat } from './steve-design-chat.js';
import { SteveLivePreview } from './steve-live-preview.js';

const owner = { userId: 'alice', projectId: 'project-a' };
const bound = (project = 'project-a', revision = 'revision-a') => ({ version: 1,
  binding: { renderUserId: 'alice', renderProjectId: project, revision } });
const record = (project = 'project-a', id = 'request-1') => ({ renderUserId: 'alice', renderProjectId: project,
  requestId: id, phase: 'completed', messages: [{ id: 'reply', role: 'assistant', text: 'Done' }] });
const feed = (project = 'project-a', revision = 'revision-a', records = [record(project)]) => ({
  ...bound(project, revision), epoch: revision, cursor: 1, reset: true, requests: records,
});
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const storage = () => { const values = new Map(); return {
  get length() { return values.size; }, key: i => [...values.keys()][i],
  getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
}; };

test('navigation reads never bind; cancel preserves native lock; confirm sends exact idle CAS', async () => {
  const state = new SteveProjectBinding(), calls = [];
  let native = bound();
  const connector = { status: { busy: false }, project: async packet => {
    calls.push(packet);
    if (packet.action === 'bind') native = bound(packet.renderProjectId, 'revision-b');
    return native;
  } };
  await state.refresh(connector);
  const viewed = { ...owner, projectId: 'project-b' };
  await state.refresh(connector);
  assert.equal(state.binding.renderProjectId, 'project-a');
  state.prepare(viewed); state.cancel();
  assert.equal(state.binding.revision, 'revision-a');
  assert.ok(calls.every(call => call.action === 'get'));
  state.prepare(viewed);
  await state.confirm(connector);
  assert.deepEqual(calls.at(-1), { action: 'bind', renderUserId: 'alice', renderProjectId: 'project-b', expectedRevision: 'revision-a' });
  assert.equal(state.binding.renderProjectId, 'project-b');
});

test('first binding is explicit with null CAS; busy and stale changes cannot overwrite', async () => {
  const state = new SteveProjectBinding(); state.accept({ version: 1, binding: null });
  assert.throws(() => state.assertOwner(owner), { code: 'project_unbound' });
  assert.deepEqual(state.prepare(owner), { action: 'bind', renderUserId: 'alice', renderProjectId: 'project-a', expectedRevision: null });
  state.busy = true;
  await assert.rejects(state.confirm({ project() { assert.fail('busy must not write'); } }), { code: 'project_busy' });
  state.busy = false;
  const calls = [];
  await assert.rejects(state.confirm({ status: {}, project: async packet => {
    calls.push(packet);
    if (packet.action === 'bind') throw bindingError('project_binding_changed');
    return bound('project-b', 'other-browser');
  } }), { code: 'project_binding_changed' });
  assert.equal(state.binding.revision, 'other-browser');
  assert.equal(state.pending, null);
  assert.equal(calls.filter(call => call.action === 'bind').length, 1);
});

test('multiple-browser changed binding clears activity, cards, selection before ingestion; stale response ignored', async () => {
  const state = new SteveProjectBinding(), order = [];
  let next = feed();
  const activity = new SteveActivity({ bindingState: state, getUserId: () => 'alice', read: async () => next,
    ingest: rec => order.push('ingest:' + rec.renderProjectId),
    onChange: a => { if (!a.records.size && !a.cards.length && a.selected === null) order.push('clear'); } });
  await activity.tick(); activity.select('request-1'); activity.cards = [{ requestId: 'request-1', text: 'old' }];
  order.length = 0; next = feed('project-b', 'revision-b'); await activity.tick();
  assert.deepEqual(order.slice(0, 2), ['clear', 'ingest:project-b']);
  assert.equal(activity.selected, null);
  let release;
  activity.read = () => new Promise(resolve => release = resolve);
  const pending = activity.tick();
  state.accept(bound('project-a', 'revision-a2'));
  release(feed('project-b', 'revision-b')); await pending;
  assert.equal(state.binding.revision, 'revision-a2');
  assert.equal(activity.records.size, 0);
  activity.dispose();
});

test('out-of-bound records reject before ingestion, including null binding', async () => {
  const state = new SteveProjectBinding(); let ingested = 0, next = feed('project-a', 'revision-a', [record('project-b')]);
  const activity = new SteveActivity({ bindingState: state, getUserId: () => 'alice', read: async () => next, ingest: () => ingested++ });
  await assert.rejects(activity.tick(), /owner/);
  next = { ...feed(), binding: null };
  await assert.rejects(activity.tick(), /owner/);
  assert.equal(ingested, 0); activity.dispose();
});

test('wrong-project Send fails before remember, history sync, settings, or submission', async () => {
  const state = new SteveProjectBinding(); state.accept(bound());
  const store = storage(), chat = new SteveDesignChat({ storage: store });
  chat.syncHistory = async () => assert.fail('no history');
  await assert.rejects(chat.submit({ prepareSubmission: async current => state.assertOwner(current),
    submitCurrent: async () => assert.fail('no submission') },
    { owner: { ...owner, projectId: 'project-b' }, prompt: 'keep my draft', requestId: 'request-1' }), /Open locked project/);
  assert.equal(store.length, 0); assert.equal(chat.memory.size, 0);
});

test('late preview cannot apply across A-B-A while viewport stays A; cached history never seeds preview', async () => {
  let binding = bound().binding, release, displayed = 0;
  const preview = new SteveLivePreview({ getOwner: () => owner, getBinding: () => binding,
    clear() {}, display: () => displayed++, post: () => new Promise(resolve => release = resolve) });
  const rec = { ...owner, requestId: 'request-1', createdAt: '2026-10-08' };
  preview.observe(rec); assert.equal(preview.record, null);
  preview.observe(rec, { authenticated: true, bindingRevision: 'revision-a' });
  const pending = preview.tick();
  binding = bound('project-b', 'revision-b').binding;
  binding = bound('project-a', 'revision-a2').binding;
  release({ requestId: 'request-1', revision: 1, units: 'mm', upAxis: 'Z', bodies: [] });
  await pending; assert.equal(displayed, 0);
  preview.reset(); preview.observe(rec); assert.equal(preview.record, null);
});

test('signed project get and bind use exact bodies/path; submission carries native revision and rejects old capability', async () => {
  steveProjectBinding.reset();
  const calls = [];
  const connector = new SteveConnector({ cryptoApi: webcrypto, secretStore: { read: async () => 'secret' },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/status')) return response({ capabilities: { projectBinding: true } });
      if (url.endsWith('/project')) return response(bound());
      return response({ accepted: true });
    } });
  connector.state = 'ready';
  await connector.project({ action: 'get' });
  await connector.project({ action: 'bind', renderUserId: 'alice', renderProjectId: 'project-a', expectedRevision: null });
  const projectCalls = calls.filter(call => call.url.endsWith('/project'));
  assert.equal(projectCalls[0].options.body, '{"action":"get"}');
  assert.equal(projectCalls[1].options.body, '{"action":"bind","renderUserId":"alice","renderProjectId":"project-a","expectedRevision":null}');
  for (const { options } of projectCalls) {
    const h = options.headers;
    assert.equal(h['X-Steve-Signature'], await signSteveSubmission({ secret: 'secret', body: options.body,
      requestId: h['X-Request-Id'], timestamp: h['X-Steve-Timestamp'], nonce: h['X-Steve-Nonce'],
      cryptoApi: webcrypto, path: '/v1/project' }));
  }
  await connector.submit({ prompt: 'fake transport only', renderUserId: 'alice', renderProjectId: 'project-a' });
  assert.equal(JSON.parse(calls.at(-1).options.body).bindingRevision, 'revision-a');
  connector.state = 'ready';
  await assert.rejects(connector.submit({ prompt: 'fake', renderUserId: 'alice', renderProjectId: 'project-a', bindingRevision: 'stale' }),
    { code: 'project_binding_changed' });
  const old = new SteveConnector({ cryptoApi: webcrypto, secretStore: { read: async () => 'secret' },
    fetchFn: async url => { assert.ok(url.endsWith('/status')); return response({ capabilities: {} }); } });
  old.state = 'ready';
  await assert.rejects(old.submit({ prompt: 'fake', renderUserId: 'alice', renderProjectId: 'project-a' }), /Update STEVE/);
});

test('late get cannot restore an obsolete native binding', async () => {
  const state = new SteveProjectBinding(); state.accept(bound());
  let release;
  const old = state.refresh({ project: () => new Promise(resolve => release = resolve) });
  state.accept(bound('project-b', 'revision-b'));
  release(bound()); await assert.rejects(old, { code: 'project_binding_changed' });
  assert.equal(state.binding.renderProjectId, 'project-b');
});

test('lock UI navigation never writes; cancel and idle confirmation use the captured CAS', async () => {
  const { mountSteveActivity } = await import('./steve-activity-ui.js?v=20261008-project-lock-p1');
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = new Map();
      this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0; }
    setAttribute(k,v) { this.attrs[k] = v; }
    append(...nodes) { this.children.push(...nodes); if (this.tag === 'select' && !this.value) this.value = this.children[0]?.value || ''; }
    prepend(...nodes) { this.children.unshift(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    remove() {}
    async click() { if (!this.disabled) await this.handlers.get('click')?.({}); }
  }
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = { head: new Node('head'), createElement: name => new Node(name), createTextNode: text => ({ textContent: text }) };
  let native = bound(), viewport = { ...owner };
  const state = new SteveProjectBinding(), writes = [], host = new Node('main');
  const connector = { status: { busy: false }, project: async packet => {
    if (packet.action === 'bind') { writes.push(packet); native = bound(packet.renderProjectId, 'revision-b'); }
    return native;
  } };
  const walk = node => [node, ...(node.children || []).flatMap(walk)];
  const button = label => walk(host).find(node => node.tag === 'button' && node.textContent === label);
  let ui;
  try {
    ui = mountSteveActivity({ host, getOwner: () => viewport, getProjects: () => [{ id: 'project-a', name: 'Mount' }, { id: 'project-b', name: 'Test' }],
      projectLabel: id => id === 'project-a' ? 'Mount' : 'Test', bindingState: state, projectConnector: connector,
      read: async () => ({ ...native, epoch: native.binding.revision, cursor: 1, reset: true, requests: [] }),
      ingest() {}, onAvailability() {}, openProject: async (id, current) => { if (current()) viewport.projectId = id; } });
    await new Promise(resolve => setImmediate(resolve));
    viewport.projectId = 'project-b'; window.dispatchEvent(new Event('render3d:project-changed'));
    assert.equal(writes.length, 0);
    assert.match(walk(host).find(node => node.dataset?.steveLockBadge).textContent, /Mount #project-a/);
    await button('Open locked project').click(); assert.equal(viewport.projectId, 'project-a'); assert.equal(writes.length, 0);
    const select = walk(host).find(node => node.tag === 'select'); select.value = 'project-b';
    await button('Change project').click();
    assert.ok(walk(host).some(node => /from Mount #project-a to Test #project-b/.test(node.textContent)));
    await button('Cancel').click(); assert.equal(state.pending, null); assert.equal(writes.length, 0);
    await button('Change project').click(); await button('Confirm project lock').click();
    assert.deepEqual(writes, [{ action: 'bind', renderUserId: 'alice', renderProjectId: 'project-b', expectedRevision: 'revision-a' }]);
    assert.equal(viewport.projectId, 'project-a');
    assert.match(walk(host).find(node => node.dataset?.steveLockBadge).textContent, /Test #project-b/);
  } finally { ui?.dispose(); globalThis.window = oldWindow; globalThis.document = oldDocument; }
});

for (const rejects of [false, true]) test('late confirm ' + (rejects ? 'failure' : 'success') + ' after reset cannot restore binding or clobber a new operation', async () => {
  const state = new SteveProjectBinding(); state.accept(bound()); state.prepare({ ...owner, projectId: 'project-b' });
  let finishOld, finishNew, recoveryReads = 0;
  const old = state.confirm({ project: packet => {
    if (packet.action === 'get') { recoveryReads++; return Promise.resolve(bound()); }
    return new Promise((resolve, reject) => { finishOld = rejects ? () => reject(bindingError('project_binding_changed')) : () => resolve(bound('project-b', 'obsolete')); });
  } });
  const oldResult = assert.rejects(old);
  state.reset();
  assert.equal(state.changing, false);
  state.accept(bound('project-a', 'fresh-session'));
  state.prepare({ ...owner, projectId: 'project-b' });
  const fresh = state.confirm({ project: () => new Promise(resolve => { finishNew = resolve; }) });
  finishOld(); await oldResult;
  assert.equal(state.binding.revision, 'fresh-session');
  assert.equal(state.changing, true);
  assert.equal(state.pending.expectedRevision, 'fresh-session');
  assert.equal(recoveryReads, 0);
  finishNew(bound('project-b', 'fresh-confirm')); await fresh;
  assert.equal(state.binding.revision, 'fresh-confirm');
});

test('late confirm after reset alone leaves unknown binding cleared', async () => {
  const state = new SteveProjectBinding(); state.accept(bound()); state.prepare(owner);
  let finish; const pending = state.confirm({ project: () => new Promise(resolve => finish = resolve) });
  const result = assert.rejects(pending);
  state.reset(); finish(bound()); await result;
  assert.equal(state.binding, null); assert.equal(state.known, false); assert.equal(state.changing, false);
});

test('reset while failed confirmation rereads native authority rejects the recovery response', async () => {
  const state = new SteveProjectBinding(); state.accept(bound()); state.prepare(owner);
  let releaseRecovery, enteredRecovery;
  const entered = new Promise(resolve => enteredRecovery = resolve);
  const pending = state.confirm({ project: async packet => {
    if (packet.action === 'bind') throw bindingError('project_binding_changed');
    enteredRecovery();
    return new Promise(resolve => releaseRecovery = resolve);
  } });
  const result = assert.rejects(pending);
  await entered; state.reset(); state.accept(bound('project-b', 'new-session'));
  releaseRecovery(bound()); await result;
  assert.equal(state.binding.revision, 'new-session'); assert.equal(state.changing, false);
});
