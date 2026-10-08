import { test } from "node:test";
import assert from "node:assert/strict";
import { SteveResultOpener, savedSteveResult } from "./steve-result-open.js";

function record() {
  return { requestId: "request-1", userId: "user-a", projectId: "render-a",
    resultOpen: { intent: "auto", state: "pending" },
    snapshot: { phase: "completed", save: { state: "saved",
      file: { id: "fusion-file", name: "Motor mount" }, folder: { id: "fusion-folder" }, project: { id: "fusion-project" } } } };
}
function fixture(options = {}) {
  let owner = { userId: "user-a", projectId: "render-a" };
  let stored = null;
  const requests = [], displayed = [], states = [];
  const opener = new SteveResultOpener({
    getOwner: () => owner,
    readRecord: () => structuredClone(stored),
    persist: value => { states.push(value.resultOpen.state); stored = structuredClone(value); options.persist?.(value); },
    lock: async (key, run) => run(),
    api: async (path, init) => {
      requests.push({ path, body: init?.body && JSON.parse(init.body) });
      if (options.api) return options.api(path, init);
      if (path === "/api/autodesk/hubs") return { hubs: [{ id: "hub-wrong" }, { id: "hub-right" }] };
      if (path.includes("hub-wrong")) return { projects: [{ id: "other", name: "fusion-project" }] };
      if (path.endsWith("/projects")) return { projects: [{ id: "fusion-project" }] };
      assert.equal(stored.resultOpen.state, "importing");
      return { project_id: "render-a", filename: "motor-mount.glb", name: "Motor mount" };
    },
    openFile: async (result, guard) => { displayed.push(result); return options.openFile ? options.openFile(result, guard) : true; },
  });
  return { opener, requests, displayed, states, setOwner: next => { owner = next; }, saved: () => stored };
}

test("saved result uses exact Fusion identity, imports into original Render project and opens returned file", async () => {
  const f = fixture(), r = record();
  await f.opener.observe(r);
  const body = f.requests.find(call => call.body).body;
  assert.deepEqual(body, { aps_project_id: "fusion-project", hub_id: "hub-right", folder_id: "fusion-folder",
    item_id: "fusion-file", name: "Motor mount", target_project_id: "render-a", import_bodies: true });
  assert.deepEqual(f.displayed, [{ project_id: "render-a", filename: "motor-mount.glb", name: "Motor mount" }]);
  assert.deepEqual(f.states, ["importing", "imported", "opened"]);
  await f.opener.observe(r);
  await f.opener.open(r, { manual: true });
  assert.equal(f.requests.filter(call => call.body).length, 1);
  assert.equal(f.displayed.length, 2);
});

test("historical recovered records and non-completed jobs never auto import", async () => {
  const f = fixture(), historical = record();
  delete historical.resultOpen;
  await f.opener.observe(historical);
  const active = record(); active.snapshot.phase = "running";
  await f.opener.observe(active);
  assert.deepEqual(f.requests, []);
  await f.opener.open(historical, { manual: true });
  assert.equal(f.requests.filter(call => call.body).length, 1);
});

test("missing save metadata and unchanged file-only results offer manual action", async () => {
  for (const save of [null, { state: "pending" }, { state: "unchanged", file: { id: "file" } }]) {
    const f = fixture(), r = record(); r.snapshot.save = save;
    assert.equal(savedSteveResult(r), null);
    await f.opener.observe(r);
    assert.equal(r.resultOpen.state, "manual");
    assert.deepEqual(f.requests, []);
  }
});

test("project or user switch before completion suppresses automatic import", async () => {
  for (const owner of [{ userId: "user-a", projectId: "render-b" }, { userId: "user-b", projectId: "render-a" }]) {
    const f = fixture(), r = record(); f.setOwner(owner);
    await f.opener.observe(r);
    assert.equal(r.resultOpen.state, "manual");
    assert.deepEqual(f.requests, []);
  }
});

test("context change during hub lookup cannot import", async () => {
  let f;
  f = fixture({ api: async () => {
    f.setOwner({ userId: "user-a", projectId: "render-b" });
    return { hubs: [{ id: "hub" }] };
  } });
  await f.opener.observe(record());
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.displayed, []);
});

test("context change during import keeps the imported result in the original project without navigation", async () => {
  let f;
  f = fixture({ api: async path => {
    if (path.endsWith("/hubs")) return { hubs: [{ id: "hub" }] };
    if (path.endsWith("/projects")) return { projects: [{ id: "fusion-project" }] };
    f.setOwner({ userId: "user-a", projectId: "render-b" });
    return { project_id: "render-a", filename: "result.glb" };
  } });
  const r = record();
  await f.opener.observe(r);
  assert.equal(r.resultOpen.state, "imported");
  assert.deepEqual(f.displayed, []);
  f.setOwner({ userId: "user-a", projectId: "render-a" });
  await f.opener.open(r, { manual: true });
  assert.equal(f.requests.filter(call => call.body).length, 1);
  assert.equal(f.displayed.length, 1);
});

test("lost import response is uncertain and never repeats automatically or manually", async () => {
  const f = fixture({ api: async path => {
    if (path.endsWith("/hubs")) return { hubs: [{ id: "hub" }] };
    if (path.endsWith("/projects")) return { projects: [{ id: "fusion-project" }] };
    throw new TypeError("response lost");
  } });
  const r = record();
  await f.opener.observe(r);
  assert.equal(r.resultOpen.state, "uncertain");
  await f.opener.observe(r);
  await f.opener.open(r, { manual: true });
  assert.equal(f.requests.filter(call => call.body).length, 1);
});

test("persisted import claim suppresses refresh replay even with a stale in-memory record", async () => {
  const f = fixture(), r = record();
  await f.opener.observe(r);
  const stale = record();
  await f.opener.observe(stale);
  assert.equal(f.requests.filter(call => call.body).length, 1);
  assert.equal(f.displayed.length, 1);
});

test("quota failure before import refuses side effect and exposes manual action", async () => {
  const f = fixture({ persist: r => { r.persistenceWarning = "quota"; } }), r = record();
  await f.opener.observe(r);
  assert.equal(r.resultOpen.state, "manual");
  assert.equal(f.requests.filter(call => call.body).length, 0);
});

test("unexpected returned Render project is never opened", async () => {
  const f = fixture({ api: async path => {
    if (path.endsWith("/hubs")) return { hubs: [{ id: "hub" }] };
    if (path.endsWith("/projects")) return { projects: [{ id: "fusion-project" }] };
    return { project_id: "wrong-render-project", filename: "wrong.glb" };
  } });
  const r = record();
  await f.opener.observe(r);
  assert.equal(r.resultOpen.state, "uncertain");
  assert.deepEqual(f.displayed, []);
});

test("failed display reuses the imported file on explicit retry", async () => {
  let fail = true;
  const f = fixture({ openFile: async () => { if (fail) throw new Error("viewer failed"); return true; } }), r = record();
  await f.opener.observe(r);
  assert.equal(r.resultOpen.state, "manual");
  fail = false;
  await f.opener.open(r, { manual: true });
  assert.equal(r.resultOpen.state, "opened");
  assert.equal(f.requests.filter(call => call.body).length, 1);
});

test("concurrent completion callbacks share one import", async () => {
  const f = fixture(), r = record();
  await Promise.all([f.opener.observe(r), f.opener.observe(r)]);
  assert.equal(f.requests.filter(call => call.body).length, 1);
});

test("two tab coordinators serialize one persisted import claim", async () => {
  let stored = null, tail = Promise.resolve(), imports = 0;
  const lock = (key, fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const options = { lock, getOwner: () => ({ userId: "user-a", projectId: "render-a" }),
    persist: value => { stored = structuredClone(value); }, readRecord: () => structuredClone(stored),
    openFile: async () => true,
    api: async path => {
      if (path.endsWith("/hubs")) return { hubs: [{ id: "hub" }] };
      if (path.endsWith("/projects")) return { projects: [{ id: "fusion-project" }] };
      imports++;
      return { project_id: "render-a", filename: "result.glb" };
    },
  };
  await Promise.all([new SteveResultOpener(options).observe(record()), new SteveResultOpener(options).observe(record())]);
  assert.equal(imports, 1);
  assert.equal(stored.resultOpen.state, "opened");
});

test("authentication failure before import stops without retry", async () => {
  const f = fixture({ api: async () => { throw Object.assign(new Error("Reconnect Autodesk"), { status: 401 }); } });
  const r = record();
  await f.opener.observe(r);
  await f.opener.observe(r);
  assert.equal(f.requests.length, 1);
  assert.equal(r.resultOpen.state, "manual");
  assert.match(r.resultOpen.message, /Reconnect Autodesk/);
});

test("same-name Fusion project never substitutes for the saved project ID", async () => {
  const f = fixture({ api: async path => path.endsWith("/hubs")
    ? { hubs: [{ id: "hub" }] } : { projects: [{ id: "wrong-id", name: "fusion-project" }] } });
  const r = record();
  await f.opener.observe(r);
  assert.equal(f.requests.filter(call => call.body).length, 0);
  assert.equal(r.resultOpen.state, "manual");
});
