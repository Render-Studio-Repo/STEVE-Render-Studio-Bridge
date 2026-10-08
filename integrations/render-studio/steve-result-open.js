import { steveProjectBinding } from './steve-project-binding.js?v=20261008-project-lock-p1';

export function savedSteveResult(record) {
  const save = record.snapshot?.save;
  if (record.snapshot?.phase !== "completed" || !["saved", "unchanged"].includes(save?.state)) return null;
  if (!save.file?.id || !save.project?.id || !save.folder?.id) return null;
  return { itemId: String(save.file.id), name: String(save.file.name || "STEVE design"),
    fusionProjectId: String(save.project.id), folderId: String(save.folder.id) };
}

export class SteveResultOpener {
  constructor({ api, getOwner, openFile, persist, readRecord,
    getBindingState = () => steveProjectBinding,
    lock = (key, run) => globalThis.navigator?.locks
      ? globalThis.navigator.locks.request(key, run)
      : Promise.reject(new Error("Open Fusion library to import this result; browser import coordination is unavailable.")),
  }) {
    Object.assign(this, { api, getOwner, openFile, persist, readRecord, lock, getBindingState });
    this.running = new Map();
  }
  isCurrent(record, scope) {
    const owner = this.getOwner();
    if (String(owner.userId || "") !== record.userId || String(owner.projectId || "") !== record.projectId) return false;
    if (scope?.manual) return true;
    const state = this.getBindingState(), binding = state?.binding;
    return Boolean(scope?.revision && binding && !state.changing && state.generation === scope.generation
      && binding.renderUserId === scope.userId && binding.renderProjectId === scope.projectId
      && binding.revision === scope.revision);
  }
  update(record, state, message, extra = {}) {
    record.resultOpen = { ...record.resultOpen, ...extra, state, message };
    this.persist(record);
  }
  observe(record) {
    if (record.snapshot?.phase !== "completed" || record.resultOpen?.intent !== "auto"
      || record.resultOpen.state !== "pending") return Promise.resolve();
    return this.open(record);
  }
  open(record, { manual = false } = {}) {
    const scope = Object.freeze({ manual, userId: record.userId, projectId: record.projectId,
      revision: record.bindingRevision, generation: this.getBindingState()?.generation });
    const key = "render3d:steve-result:" + [record.userId, record.projectId, record.requestId].map(encodeURIComponent).join(":");
    if (this.running.has(key)) return this.running.get(key);
    const run = this.lock(key, async () => {
      const saved = this.readRecord(record);
      if (saved?.resultOpen) record.resultOpen = saved.resultOpen;
      if (!manual && (record.resultOpen?.intent !== "auto" || record.resultOpen?.state !== "pending")) return;
      if (!this.isCurrent(record, scope)) {
        this.update(record, "manual", "Return to the original Render project and choose Open saved design.");
        return;
      }
      if (["importing", "uncertain"].includes(record.resultOpen?.state)) {
        this.update(record, "uncertain", "An import may already exist. Check the original project's files or Fusion library; automatic import will not repeat.");
        return;
      }
      if (record.resultOpen?.result) return this.display(record, record.resultOpen.result, scope);
      const file = savedSteveResult(record);
      if (!file) {
        this.update(record, "manual", "The saved Fusion location is not available yet. Check save status or open Fusion library.");
        return;
      }
      let importing = false;
      try {
        const hubs = await this.api("/api/autodesk/hubs");
        let hubId = "";
        for (const hub of hubs.hubs || []) {
          if (!this.isCurrent(record, scope)) throw new Error("Context changed. Return to the original Render project to open this design.");
          const projects = await this.api("/api/autodesk/hubs/" + encodeURIComponent(hub.id) + "/projects");
          if ((projects.projects || []).some(project => String(project.id) === file.fusionProjectId)) { hubId = hub.id; break; }
        }
        if (!hubId) throw new Error("Saved Fusion project is not available in the linked Autodesk account. Open Fusion library to check the connection.");
        if (!this.isCurrent(record, scope)) throw new Error("Context changed. Return to the original Render project to open this design.");
        this.update(record, "importing", "Opening saved Fusion design in Render…", { file });
        if (record.persistenceWarning) {
          this.update(record, "manual", "Browser storage is unavailable. Restore storage before importing this design.");
          return;
        }
        if (!this.isCurrent(record, scope)) throw new Error('STEVE project lock changed. Choose Open saved design explicitly to import historical results.');
        importing = true;
        const result = await this.api("/api/autodesk/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aps_project_id: file.fusionProjectId, hub_id: hubId, folder_id: file.folderId,
            item_id: file.itemId, name: file.name, target_project_id: record.projectId, import_bodies: true }),
        });
        if (result.project_id !== record.projectId || !result.filename) {
          throw new Error("Import returned an unexpected project or no displayable file. Check the original project's files.");
        }
        this.update(record, "imported", "Saved design imported. Open it in the original Render project.",
          { result: { project_id: result.project_id, filename: result.filename, name: result.name || file.name } });
        await this.display(record, record.resultOpen.result, scope);
      } catch (error) {
        this.update(record, importing && !record.resultOpen?.result ? "uncertain" : "manual", error.message);
      }
    }).catch(error => this.update(record, "manual", error.message)).finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }
  async display(record, result, scope) {
    if (!this.isCurrent(record, scope)) {
      this.update(record, "imported", "Imported into the original project. Return there and choose Open saved design.");
      return;
    }
    const opened = await this.openFile(result, () => this.isCurrent(record, scope));
    if (opened === false || !this.isCurrent(record, scope)) {
      this.update(record, "imported", "Design imported but not displayed. Return to the original project and choose Open saved design.");
      return;
    }
    this.update(record, "opened", "Opened " + result.name + " in Render.");
  }
}

export function mountSteveResultAction({ row, record, opener, refresh, openLibrary = () =>
  globalThis.window?.dispatchEvent(new CustomEvent("render3d:open-fusion-library")) }) {
  const available = savedSteveResult(record) || record.resultOpen?.result;
  const uncertain = ["uncertain", "importing"].includes(record.resultOpen?.state);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn secondary btn-compact";
  button.dataset.steveOpenResult = record.requestId;
  button.textContent = available && !uncertain ? "Open saved design in Render" : "Open Fusion library";
  button.addEventListener("click", async () => {
    if (!available || uncertain || !opener) { openLibrary(); return; }
    button.disabled = true;
    try { await opener.open(record, { manual: true }); }
    finally { button.disabled = false; }
  });
  row.append(button);
  if (!available) {
    const check = document.createElement("button");
    check.type = "button";
    check.className = "btn secondary btn-compact";
    check.textContent = "Check save status";
    check.addEventListener("click", () => { void refresh(); });
    row.append(check);
  }
}
