export function validateSteveBinding(packet) {
  const binding = packet?.binding;
  if (packet?.version !== 1 || (binding !== null && (!binding
    || !['renderUserId', 'renderProjectId', 'revision'].every(key => typeof binding[key] === 'string' && binding[key].trim())))) {
    throw new Error('Invalid STEVE project binding.');
  }
  return binding === null ? null : Object.freeze({ renderUserId: binding.renderUserId,
    renderProjectId: binding.renderProjectId, revision: binding.revision });
}

export const bindingOwns = (binding, owner) => Boolean(binding && binding.renderUserId === String(owner?.userId || '')
  && binding.renderProjectId === String(owner?.projectId || ''));

export function bindingError(code, binding) {
  const messages = {
    project_unbound: 'Lock STEVE to a project using the viewport lock button before sending.',
    project_mismatch: `STEVE is locked to project #${binding?.renderProjectId || ''}. Open locked project to send. Your draft stays here.`,
    project_binding_changed: 'The STEVE project lock changed. Review the lock and try again.',
    project_busy: 'STEVE is busy. Wait for the current request to finish before changing projects.',
    project_binding_unavailable: 'Update STEVE to use project locking before sending.',
  };
  return Object.assign(new Error(messages[code] || code), { code, status: 409 });
}

export class SteveProjectBinding {
  constructor() {
    this.binding = null; this.known = false; this.generation = 0; this.sequence = 0; this.applied = 0;
    this.listeners = new Set(); this.pending = null; this.changing = false; this.busy = false;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(this); }
  beginRead() { return { generation: this.generation, sequence: ++this.sequence }; }
  current(token) { return token?.generation === this.generation && token.sequence >= this.applied && !this.changing; }
  accept(packet, token = this.beginRead()) {
    if (!this.current(token)) return false;
    const next = validateSteveBinding(packet);
    this.applied = token.sequence;
    const changed = !this.known || JSON.stringify(next) !== JSON.stringify(this.binding);
    this.binding = next; this.known = true;
    if (changed) { this.generation++; this.pending = null; this.busy = false; this.emit(); }
    return true;
  }
  reset() { this.generation++; this.changing = false; this.known = false; this.binding = null; this.pending = null; this.busy = false; this.emit(); }
  async refresh(connector) {
    const token = this.beginRead();
    const packet = await connector.project({ action: 'get' });
    if (!this.accept(packet, token)) throw bindingError('project_binding_changed', this.binding);
    this.busy = Boolean(connector.status?.busy || Number(connector.status?.queueDepth || 0) > 0);
    this.emit();
    return this.binding;
  }
  assertOwner(owner, revision) {
    if (!this.known) throw bindingError('project_binding_unavailable');
    if (!this.binding) throw bindingError('project_unbound');
    if (!bindingOwns(this.binding, owner)) throw bindingError('project_mismatch', this.binding);
    if (revision !== undefined && revision !== this.binding.revision) throw bindingError('project_binding_changed', this.binding);
    if (this.changing) throw bindingError('project_binding_changed', this.binding);
    return this.binding.revision;
  }
  prepare(owner) {
    if (!this.known) throw bindingError('project_binding_unavailable');
    if (!owner?.userId || !owner?.projectId) throw new Error('Sign in and open a Render project first.');
    if (this.busy || this.changing) throw bindingError('project_busy');
    this.pending = Object.freeze({ action: 'bind', renderUserId: String(owner.userId), renderProjectId: String(owner.projectId),
      expectedRevision: this.binding?.revision ?? null });
    this.emit();
    return this.pending;
  }
  cancel() { if (!this.changing) { this.pending = null; this.emit(); } }
  async confirm(connector) {
    const pending = this.pending;
    if (!pending) throw bindingError('project_binding_changed');
    if (this.busy || this.changing) throw bindingError('project_busy');
    this.changing = true;
    const generation = ++this.generation;
    const ownsOperation = () => generation === this.generation && this.pending === pending;
    this.emit();
    try {
      const packet = await connector.project(pending);
      if (!ownsOperation()) throw bindingError('project_binding_changed', this.binding);
      validateSteveBinding(packet);
      this.changing = false; this.pending = null;
      this.accept(packet);
      this.emit();
      return this.binding;
    } catch (error) {
      if (!ownsOperation()) throw bindingError('project_binding_changed', this.binding);
      this.changing = false; this.pending = null; this.emit();
      if (generation === this.generation && !this.changing && this.pending === null) {
        try { await this.refresh(connector); } catch {}
      }
      if (error.status === 409) throw bindingError(error.code, this.binding);
      throw error;
    }
  }
}

export const steveProjectBinding = new SteveProjectBinding();
