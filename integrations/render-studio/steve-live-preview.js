import { bindingOwns } from './steve-project-binding.js?v=20261008-completion-placement1';
const sameOwner = (a, b) => Boolean(a?.userId && a?.projectId && a.userId === b?.userId && a.projectId === b?.projectId);

export function validateStevePreview(packet, requestId, afterRevision = 0) {
  if (packet?.requestId !== requestId) throw new Error("STEVE preview belongs to a different request.");
  if (packet.error) throw new Error(String(packet.error).slice(0, 500));
  if (packet.pending) return null;
  if (!Number.isSafeInteger(packet.revision) || packet.revision < 0) throw new Error("Invalid STEVE preview revision.");
  if (packet.revision <= afterRevision && packet.reset !== true) return null;
  if (packet.units !== "mm" || packet.upAxis !== "Z") throw new Error("STEVE preview must use millimetres and Z-up coordinates.");
  if (!Array.isArray(packet.bodies) || packet.bodies.length > 256) throw new Error("Invalid STEVE preview bodies.");
  let vertices = 0, indices = 0;
  const ids = new Set();
  for (const body of packet.bodies) {
    if (!body || typeof body.id !== "string" || !body.id || ids.has(body.id)) throw new Error("Invalid STEVE preview body identity.");
    ids.add(body.id);
    if (!Array.isArray(body.positions) || body.positions.length % 3 || !Array.isArray(body.indices) || body.indices.length % 3) throw new Error("Invalid STEVE preview mesh.");
    vertices += body.positions.length / 3; indices += body.indices.length;
    if (vertices > 450000 || indices > 450000) throw new Error("STEVE preview exceeds the viewer mesh budget.");
    if (!body.positions.every(value => Number.isFinite(value) && Math.abs(value) <= 1e8)) throw new Error("Non-finite STEVE preview geometry.");
    if (!body.indices.every(index => Number.isInteger(index) && index >= 0 && index < body.positions.length / 3)) throw new Error("Invalid STEVE preview triangle index.");
    if (body.color && (!Array.isArray(body.color) || body.color.length !== 3 || !body.color.every(value => Number.isFinite(value) && value >= 0 && value <= 1))) throw new Error("Invalid STEVE preview color.");
  }
  return packet;
}

export class SteveLivePreview {
  constructor({ getOwner, getBinding, post, display, clear, onError = () => {} }) {
    Object.assign(this, { getOwner, getBinding, post, display, clear, onError });
    this.record = null; this.revision = 0; this.hasFramed = false; this.epoch = 0; this.busy = false; this.blocked = false;
  }
  observe(record, { authenticated = false, bindingRevision } = {}) {
    if (this.getBinding && (!authenticated || !bindingOwns(this.getBinding(), record) || bindingRevision !== this.getBinding()?.revision)) return;
    if (!sameOwner(record, this.getOwner())) return;
    if (this.record?.requestId === record.requestId && sameOwner(this.record, record)) {
      if (authenticated === true) this.blocked = false;
      return;
    }
    if (sameOwner(this.record, record) && this.record.createdAt > record.createdAt) return;
    this.clear(); this.epoch++; this.revision = 0; this.hasFramed = false; this.blocked = false;
    this.record = { userId: record.userId, projectId: record.projectId, requestId: record.requestId, createdAt: record.createdAt, bindingRevision };
  }
  bindingMatches(record) { return !this.getBinding || (bindingOwns(this.getBinding(), record) && record?.bindingRevision === this.getBinding()?.revision); }
  async tick() {
    if (this.record && (!sameOwner(this.record, this.getOwner()) || !this.bindingMatches(this.record))) this.reset();
    if (!this.record || this.busy || this.blocked) return;
    const record = this.record, epoch = this.epoch;
    this.busy = true;
    try {
      const packet = await this.post({ requestId: record.requestId, afterRevision: this.revision });
      if (epoch !== this.epoch || !sameOwner(record, this.getOwner()) || !this.bindingMatches(record)) return;
      const snapshot = validateStevePreview(packet, record.requestId, this.revision);
      if (!snapshot) return;
      this.display(snapshot, { first: !this.hasFramed });
      if (snapshot.bodies.some(body => body.indices.length)) this.hasFramed = true;
      this.revision = snapshot.revision;
    } catch (error) {
      if (epoch !== this.epoch || !sameOwner(record, this.getOwner()) || !this.bindingMatches(record)) return;
      if (error.status === 401 || error.status === 403 || error.code === "steve_preview_unavailable") this.blocked = true;
      this.onError(error, record);
    } finally { this.busy = false; }
  }
  reset() { this.epoch++; this.record = null; this.revision = 0; this.blocked = false; this.clear(); }
}

// Inject the host's Three instance; do not introduce another WebGL renderer or scene.
export function createStevePreviewLayer({ THREE, scene, fit = () => {}, place = () => {} }) {
  let root = null, restorePlacement = null, currentPacket = null;
  const dispose = object => object?.traverse(child => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
    else child.material?.dispose();
  });
  const clear = () => { restorePlacement?.(); restorePlacement = null; if (root) { scene.remove(root); dispose(root); root = null; } };
  const refreshPlacement = () => {
    if (!root || !currentPacket) return;
    restorePlacement?.(); restorePlacement = null;
    root.position?.set(0, 0, 0);
    root.updateMatrixWorld?.(true);
    restorePlacement = place(root, currentPacket) || null;
  };
  const display = (packet, { first = false } = {}) => {
    const next = new THREE.Group();
    next.name = "__steve_live_preview__";
    next.userData.stevePreview = true;
    try {
      for (const body of packet.bodies) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(body.positions, 3));
        geometry.setIndex(body.indices);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(...(body.color || [0.65, 0.7, 0.8])), side: THREE.DoubleSide, roughness: 0.65, metalness: 0.1 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = body.name || body.id;
        mesh.userData.steveBodyId = body.id;
        next.add(mesh);
      }
    } catch (error) { dispose(next); throw error; }
    clear(); root = next; currentPacket = packet; scene.add(root);
    try { refreshPlacement(); }
    catch (error) { clear(); throw error; }
    if (first && packet.bodies.some(body => body.indices.length)) fit(root);
  };
  return { display, clear, refreshPlacement };
}
