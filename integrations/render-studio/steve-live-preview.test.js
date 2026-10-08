import { test } from "node:test";
import assert from "node:assert/strict";
import { SteveLivePreview, createStevePreviewLayer, validateStevePreview } from "./steve-live-preview.js";

const packet = (revision = 1) => ({
  requestId: "request-1",
  revision,
  units: "mm",
  upAxis: "Z",
  bodies: [{ id: "body-1", name: "Bracket", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }],
});

test("STEVE preview accepts a bounded Z-up millimetre mesh and rejects identity drift", () => {
  assert.equal(validateStevePreview(packet(), "request-1")?.revision, 1);
  assert.equal(validateStevePreview(packet(1), "request-1", 1), null);
  assert.throws(() => validateStevePreview(packet(), "request-2"), /different request/);
  assert.throws(() => validateStevePreview({ ...packet(), upAxis: "Y" }, "request-1"), /Z-up/);
});

test("live previews stay pinned to their original user and Render project", async () => {
  let owner = { userId: "user-1", projectId: "project-1" };
  let displayCount = 0;
  let clearCount = 0;
  const preview = new SteveLivePreview({
    getOwner: () => owner,
    post: async () => packet(),
    display: () => { displayCount += 1; },
    clear: () => { clearCount += 1; },
  });
  preview.observe({ ...owner, requestId: "request-1", createdAt: 1 });
  await preview.tick();
  assert.equal(displayCount, 1);
  owner = { userId: "user-1", projectId: "project-2" };
  await preview.tick();
  assert.equal(preview.record, null);
  assert.equal(clearCount, 2);
});

test("preview layer reuses the host scene and disposes replaced geometry", () => {
  const removed = [];
  const scene = { add(value) { this.value = value; }, remove(value) { removed.push(value); } };
  class Group { constructor() { this.children = []; this.userData = {}; this.position = { x: 0, y: 0, z: 0, set(x,y,z) { Object.assign(this,{x,y,z}); } }; } add(value) { this.children.push(value); } traverse(fn) { fn(this); this.children.forEach(fn); } }
  class BufferGeometry { setAttribute() {} setIndex() {} computeVertexNormals() {} computeBoundingBox() {} computeBoundingSphere() {} dispose() { this.disposed = true; } }
  class Material { dispose() { this.disposed = true; } }
  class Mesh { constructor(geometry, material) { this.geometry = geometry; this.material = material; this.userData = {}; } }
  const THREE = { Group, BufferGeometry, Float32BufferAttribute: class {}, MeshStandardMaterial: Material, Color: class {}, Mesh, DoubleSide: 2 };
  let fitted = 0, restored = 0;
  const placements = [];
  const layer = createStevePreviewLayer({ THREE, scene, fit: () => { fitted += 1; },
    place: (root, snapshot) => {
      assert.equal(scene.value, root);
      assert.equal(root.children.length, 1);
      root.position.x += 100;
      placements.push({ root, revision: snapshot.revision, restored });
      return () => { restored++; };
    } });
  layer.display(packet(), { first: true });
  const first = scene.value;
  layer.display(packet(2));
  assert.equal(fitted, 1);
  assert.deepEqual(removed, [first]);
  assert.equal(first.children[0].geometry.disposed, true);
  assert.deepEqual(placements.map(p => [p.revision, p.restored]), [[1, 0], [2, 1]]);
  assert.notEqual(placements[0].root, placements[1].root);
  layer.refreshPlacement();
  assert.equal(scene.value.position.x, 100);
  assert.equal(restored, 2);
  assert.equal(placements.length, 3);
  layer.clear();
  assert.equal(restored, 3);
  layer.clear();
  layer.refreshPlacement();
  assert.equal(restored, 3);
});


test("bridge restart accepts a lower or equal full revision only with reset without reframing", async () => {
  const owner = { userId: "alice", projectId: "render-a" };
  const base = { requestId: "request-reset", units: "mm", upAxis: "Z",
    bodies: [{ id: "b", positions: [0,0,0,1,0,0,0,1,0], indices: [0,1,2] }] };
  const packets = [{ ...base, revision: 8 }, { ...base, revision: 1 },
    { ...base, revision: 1, reset: true }, { ...base, revision: 1, reset: true }];
  const shown = [];
  const preview = new SteveLivePreview({ getOwner: () => owner, post: async () => packets.shift(),
    display: (packet, options) => shown.push({ packet, options }), clear: () => {},
    onError: error => { throw error; } });
  preview.observe({ ...owner, requestId: base.requestId, createdAt: "2026-10-08" });
  for (let i = 0; i < 4; i++) await preview.tick();
  assert.equal(shown.length, 3);
  assert.equal(preview.revision, 1);
  assert.deepEqual(shown.map(value => value.options.first), [true, false, false]);
  assert.throws(() => validateStevePreview({ requestId: base.requestId, revision: 1, reset: true, unchanged: true }, base.requestId, 8));
  assert.throws(() => validateStevePreview({ ...base, requestId: "wrong", revision: 1, reset: true }, base.requestId, 8));
});

test("authentication errors stay blocked until a signed project recovery succeeds", async () => {
  const owner = { userId: "alice", projectId: "render-a" };
  const record = { ...owner, requestId: "request-1", createdAt: 1 };
  let calls = 0, paired = false, shown = 0;
  const preview = new SteveLivePreview({ getOwner: () => owner,
    post: async () => { calls++; if (!paired) throw Object.assign(new Error("Pair again"), { status: 401 }); return packet(); },
    display: () => shown++, clear: () => {} });
  preview.observe(record);
  await preview.tick();
  assert.equal(preview.blocked, true);
  paired = true;
  preview.observe(record);
  await preview.tick();
  assert.equal(calls, 1);
  preview.observe(record, { authenticated: true });
  await preview.tick();
  assert.equal(calls, 2);
  assert.equal(shown, 1);
});
