import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../examples/render-storage-settings.js', import.meta.url), 'utf8');
const { mountSteveStorageSettings } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
class Element {
  constructor(tag, document) { this.tag = tag; this.ownerDocument = document; this.children = []; this.style = {}; this.value = ''; this.textContent = ''; this.hidden = false; }
  setAttribute(k,v) { this[k] = v; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; if (this.tag === 'select') this.value = children[0]?.value ?? ''; }
  remove() { this.removed = true; }
}
const document = { createElement: tag => new Element(tag, document) };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function fixture({ integration, native = true } = {}) {
  const root = new Element('root', document);
  const calls = [];
  let picker = deferred();
  let saved = { autoSave: true, projectId: 'p1', folderId: 'f1' };
  const cleanup = mountSteveStorageSettings(root, { storage: async payload => {
    calls.push(payload);
    switch (payload.action) {
      case 'getSettings': return { ...saved, nativeFolderPicker: native };
      case 'projects': return { projects: [{ id: 'p1', name: 'Project 1' }] };
      case 'folders': return { project: { id: payload.projectId, name: `Project ${payload.projectId}` }, folder: { id: payload.folderId ?? 'root', name: `Folder ${payload.folderId}` }, folders: [{ id: 'child', name: 'Child' }] };
      case 'chooseFolder': return picker.promise;
      case 'setSettings': saved = { autoSave: payload.autoSave, projectId: payload.projectId, folderId: payload.folderId }; return saved;
      default: throw new Error('Unexpected action');
    }
  } }, { fusionIntegration: integration });
  await tick();
  const section = root.children[0];
  const get = text => section.children.find(e => e.textContent === text);
  return { root, section, get, calls, cleanup, resolve: value => picker.resolve(value), reset: () => { picker = deferred(); }, saved: () => saved, status: () => section.children.find(e => e['aria-live'] === 'polite').textContent, browsing: () => section.children.find(e => e.textContent.startsWith('Browsing:')).textContent };
}
{
  const f = await fixture();
  const before = f.browsing();
  f.get('Choose folder in Fusion…').onclick();
  f.get('Choose folder in Fusion…').onclick();
  assert.equal(f.status(), 'Switch to Fusion to choose a folder');
  assert.equal(f.get('Choose folder in Fusion…').disabled, true);
  assert.equal(f.calls.filter(c => c.action === 'chooseFolder').length, 1);
  f.resolve({ cancelled: true }); await tick();
  assert.equal(f.browsing(), before);
  assert.equal(f.saved().folderId, 'f1');
  f.reset(); f.get('Choose folder in Fusion…').onclick();
  f.resolve({ cancelled: false, project: { id: 'p2', name: '<script>unsafe</script>' }, folder: { id: 'f2', name: 'Selected' } }); await tick();
  assert.equal(f.status(), 'Folder selected; click Use this folder to save it.');
  assert.match(f.browsing(), /f2/);
  assert.equal(f.saved().folderId, 'f1');
  assert.equal(f.calls.some(c => c.action === 'setSettings'), false);
  f.get('Use this folder').onclick(); await tick();
  assert.equal(f.saved().folderId, 'f2');
  assert.equal(f.get('Choose folder in Fusion…').hidden, false);
  f.reset(); f.get('Choose folder in Fusion…').onclick(); f.resolve({ cancelled: false }); await tick();
  assert.equal(f.get('Retry').hidden, false);
  assert.match(f.status(), /invalid folder selection/);
  f.reset(); f.get('Retry').onclick(); f.resolve({ cancelled: true }); await tick();
  assert.equal(f.get('Retry').hidden, true);
  f.cleanup(); assert.ok(f.section.removed);
}
{
  let attempts = 0, connects = 0;
  const f = await fixture({ integration: {
    getStatus: async () => { if (++attempts === 1) throw new Error('offline'); return attempts === 2 ? { linked: false } : { linked: true, autodesk_name: '<b>Alice</b>', autodesk_email: 'alice@example.com' }; },
    connect: () => { connects++; }
  } });
  assert.equal(f.get('Retry connection status').hidden, false);
  assert.equal(f.get('Choose folder in Fusion…').disabled, false);
  f.get('Retry connection status').onclick(); await tick();
  assert.equal(f.get('Connect Fusion integration').hidden, false);
  await f.get('Connect Fusion integration').onclick();
  assert.equal(connects, 1);
  f.get('Retry connection status').onclick(); await tick();
  assert.ok(f.get('Fusion integration connected: <b>Alice</b> — alice@example.com'));
  assert.equal(f.get('Connect Fusion integration').hidden, true);
  f.cleanup();
}
{
  const f = await fixture({ native: false });
  assert.equal(f.get('Choose folder in Fusion…').hidden, true);
  f.get('Choose folder in Fusion…').onclick(); await tick();
  assert.equal(f.calls.some(c => c.action === 'chooseFolder'), false);
  f.cleanup();
}
{
  const connection = deferred();
  const f = await fixture({ integration: { getStatus: () => connection.promise, connect() {} } });
  f.get('Choose folder in Fusion…').onclick();
  const text = f.status(); f.cleanup();
  f.resolve({ cancelled: false, project: { id: 'p2' }, folder: { id: 'f2' } });
  connection.resolve({ linked: true, autodesk_name: 'Late' }); await tick();
  assert.equal(f.status(), text);
  assert.equal(f.calls.filter(c => c.action === 'folders').length, 1);
  for (const e of f.section.children.filter(e => e.tag === 'button')) assert.equal(e.onclick, null);
}
console.log('PASS: picker cancellation, selection, explicit save, busy guard, retry, capability gating, integration callbacks/status, safe text, cleanup');
