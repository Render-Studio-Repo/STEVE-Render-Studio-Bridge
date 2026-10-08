import { steveProjectBinding, bindingOwns } from './steve-project-binding.js?v=20261008-completion-placement1';
import { mountSteveActivity } from './steve-activity-ui.js?v=20261008-targeted-reply1';
import { SteveLivePreview, createStevePreviewLayer } from "./steve-live-preview.js?v=20261008-completion-placement1";
import { SteveResultOpener, mountSteveResultAction } from "./steve-result-open.js?v=20261008-completion-placement1";
import { SteveConnector, mountSteveConnector } from "./steve-connector.js?v=20261008-targeted-reply1";
import { isSteveChatComplete } from "./steve-chat-feed.js?v=20261008-steve-chat2";

const PREFIX = "render3d:steveDesignChat:v1:";
const requestPattern = /^[a-zA-Z0-9_-]{8,128}$/;
function ownerKey({ userId, projectId }) {
  if (!userId || !projectId) throw new Error("Sign in and open a Render project first.");
  return PREFIX + encodeURIComponent(userId) + ":" + encodeURIComponent(projectId) + ":";
}
function recordKey(owner, requestId) {
  if (!requestPattern.test(requestId)) throw new Error("Enter a valid STEVE request ID.");
  return ownerKey(owner) + requestId;
}

export class SteveDesignChat {
  constructor({ storage, createConnector = () => new SteveConnector(), onChange = () => {} } = {}) {
    this.storage = storage;
    this.createConnector = createConnector;
    this.onChange = onChange;
    this.running = new Map();
    this.memory = new Map();
    this.notified = new Map();
    this.onSnapshot = () => {};
    this.discovering = new Map();
    this.recoveryConnectors = new Map();
    this.onPreviewRecord = () => {};
  }
  get store() { return this.storage || globalThis.localStorage; }
  records(owner) {
    if (!owner.userId || !owner.projectId) return [];
    const prefix = ownerKey(owner);
    const records = new Map();
    try {
      for (let i = 0; i < this.store.length; i++) {
        const key = this.store.key(i);
        if (!key?.startsWith(prefix)) continue;
        try {
          const record = JSON.parse(this.store.getItem(key));
          if (record.userId === String(owner.userId) && record.projectId === String(owner.projectId)) records.set(key, record);
        } catch {}
      }
    } catch {}
    for (const [key, record] of this.memory) if (key.startsWith(prefix)) records.set(key, record);
    return [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  write(record) {
    const key = recordKey(record, record.requestId);
    this.memory.set(key, record);
    const { persistenceWarning: ignoredWarning, ...saved } = record;
    const serialized = JSON.stringify(saved);
    try {
      const oldCompleted = this.records(record).filter(item => isSteveChatComplete(item.snapshot)
        && item.requestId !== record.requestId).slice(0, -49);
      for (const old of oldCompleted) {
        const oldKey = recordKey(old, old.requestId);
        this.store.removeItem(oldKey);
        this.memory.delete(oldKey);
        this.notified.delete(oldKey);
      }
      if (this.store.getItem(key) !== serialized) this.store.setItem(key, serialized);
      record.persistenceWarning = "";
    } catch {
      record.persistenceWarning = "Browser storage is full or unavailable. This reply is visible now, but its latest text may not survive refresh.";
    }
    const notification = serialized + record.persistenceWarning;
    if (this.notified.get(key) !== notification) {
      this.notified.set(key, notification);
      this.onPreviewRecord(record);
      this.onChange({ userId: record.userId, projectId: record.projectId, requestId: record.requestId });
    }
    return record;
  }
  ingestActivity(snapshot, options = {}) {
    const owner = { userId: snapshot.renderUserId, projectId: snapshot.renderProjectId };
    const previous = this.records(owner).find(record => record.requestId === snapshot.requestId);
    const record = { ...(previous || {}), ...owner, requestId: snapshot.requestId,
      createdAt: previous?.createdAt || snapshot.createdAt || new Date().toISOString(),
      prompt: previous?.prompt || snapshot.messages.find(message => message.role === 'user')?.text || '',
      snapshot, bindingRevision: options.bindingRevision, connection: 'connected', error: '',
      resultOpen: previous?.resultOpen || { intent: 'manual', state: 'manual', message: '' } };
    this.write(record);
    this.onPreviewRecord(record, { authenticated: true, bindingRevision: options.bindingRevision });
  }
  savedRecord(record) {
    try { return JSON.parse(this.store.getItem(recordKey(record, record.requestId))); } catch { return null; }
  }
  remember(owner, requestId, prompt = "") {
    recordKey(owner, requestId);
    const previous = this.records(owner).find(record => record.requestId === requestId);
    if (previous) return previous;
    return this.write({ userId: String(owner.userId), projectId: String(owner.projectId), requestId,
      prompt: String(prompt), createdAt: new Date().toISOString(), snapshot: null, connection: "connecting", error: "" });
  }
  messages(owner, { includeResults = false } = {}) {
    return this.records(owner).flatMap(record => {
      const source = record.snapshot?.messages || [];
      const messages = source.map(message => ({
        role: message.role === "user" ? "user" : "assistant",
        content: message.role === "tool"
          ? [message.title || message.tool || "Tool", message.toolStatus, message.text].filter(Boolean).join(" · ")
          : String(message.text || ""),
        steve: true, requestId: record.requestId, messageId: message.id,
        projectId: record.projectId, userId: record.userId,
      })).filter(message => message.content);
      if (!source.some(message => message.role === "user") && record.prompt) {
        messages.unshift({ role: "user", content: record.prompt, steve: true, projectId: record.projectId, requestId: record.requestId });
      }
      const progress = record.error || record.snapshot?.error || (
        record.connection === "reconnecting" ? "Reconnecting to STEVE…" :
        record.snapshot?.waitingForFusion ? record.snapshot.waitingReason || "Waiting for Fusion…" :
        !isSteveChatComplete(record.snapshot) ? record.snapshot?.status || "Waiting for STEVE reply…" : ""
      );
      if (record.persistenceWarning) messages.push({ role: "assistant", content: record.persistenceWarning,
        steve: true, projectId: record.projectId, requestId: record.requestId });
      if (record.previewStatus) messages.push({ role: "assistant", content: record.previewStatus, runKind: "status",
        steve: true, projectId: record.projectId, requestId: record.requestId });
      if (progress) messages.push({ role: "assistant", content: progress, steve: true,
        projectId: record.projectId, requestId: record.requestId });
      if (includeResults && record.snapshot?.phase === "completed") messages.push({ role: "assistant", steve: true,
        requestId: record.requestId, steveResult: true, projectId: record.projectId,
        content: record.resultOpen?.message || "STEVE finished. Open its saved design when available." });
      return messages;
    });
  }
  watch(record, connector = this.createConnector(), { allowAutoOpen = true } = {}) {
    if (this.activityUserId === record.userId) return Promise.resolve(record.snapshot);
    const key = recordKey(record, record.requestId);
    if (this.running.has(key)) return this.running.get(key).promise;
    const controller = new AbortController();
    const run = { controller };
    this.running.set(key, run);
    run.promise = Promise.resolve().then(() => connector.watch(record.requestId, {
      signal: controller.signal,
      onUpdate: snapshot => { record.snapshot = snapshot; record.error = ""; this.write(record); if (allowAutoOpen) this.onSnapshot(record); },
      onConnection: (connection, error) => {
        if (record.connection === connection && record.error === (error?.message || "")) return;
        record.connection = connection;
        record.error = connection === "connected" ? "" : error?.message || "";
        this.write(record);
      },
    })).catch(error => {
      if (!controller.signal.aborted) {
        record.connection = "action-required";
        record.error = error.status === 404 ? "STEVE no longer has this request, or needs an update. Reconnect and recover by request ID." : error.message;
        this.write(record);
      }
    }).finally(() => this.running.delete(key));
    return run.promise;
  }
  recover(owner, requestId) {
    const record = this.remember({ ...owner }, requestId);
    return this.watch(record, this.createConnector(), { allowAutoOpen: false });
  }
  recoverLatest(owner) {
    owner = { userId: String(owner.userId || ""), projectId: String(owner.projectId || "") };
    const key = ownerKey(owner);
    if (this.activityUserId === owner.userId) return Promise.resolve(this.records(owner).at(-1) || null);
    if (this.discovering.has(key)) return this.discovering.get(key);
    const existing = this.records(owner).at(-1);
    let connector = this.recoveryConnectors.get(key);
    if (!connector) {
      connector = this.createConnector();
      this.recoveryConnectors.set(key, connector);
      if (this.recoveryConnectors.size > 8) this.recoveryConnectors.delete(this.recoveryConnectors.keys().next().value);
    }
    const pending = Promise.resolve().then(() => connector.latest(owner)).then(result => {
      const snapshot = result?.snapshot;
      if (!snapshot) return existing || null;
      if (snapshot.renderUserId !== owner.userId || snapshot.renderProjectId !== owner.projectId) {
        throw new Error("STEVE returned a reply for a different Render user or project; it was not restored.");
      }
      const requestId = String(snapshot.requestId || "");
      if (!requestPattern.test(requestId)) throw new Error("STEVE returned an invalid request ID.");
      const previous = this.records(owner).find(record => record.requestId === requestId);
      const record = previous || this.remember(owner, requestId, snapshot.messages?.find(message => message.role === "user")?.text || "");
      if (!previous) record.resultOpen = { intent: "manual", state: "manual", message: "" };
      record.snapshot = snapshot;
      record.connection = "connected";
      record.error = "";
      this.write(record);
      if (!isSteveChatComplete(snapshot)) void this.watch(record, connector, { allowAutoOpen: false });
      return record;
    }).catch(error => {
      if (error?.status === 404) return existing || null;
      throw error;
    }).finally(() => this.discovering.delete(key));
    this.discovering.set(key, pending);
    return pending;
  }

  resume(owner) {
    return Promise.all(this.records(owner).filter(record => !isSteveChatComplete(record.snapshot) && !record.rejected)
      .map(record => this.watch(record)));
  }
  async submit(integration, { owner, prompt, replyToRequestId, requestId = globalThis.crypto.randomUUID() }) {
    owner = { ...owner };
    if (replyToRequestId && !this.records(owner).some(item => item.requestId === replyToRequestId && !item.rejected)) {
      throw new Error("This STEVE reply does not belong to the current project conversation.");
    }
    const bindingRevision = await integration.prepareSubmission(owner, replyToRequestId);
    const record = this.remember(owner, requestId, prompt);
    record.resultOpen = { intent: "auto", state: "pending", message: "" };
    record.bindingRevision = bindingRevision;
    if (replyToRequestId) record.replyToRequestId = replyToRequestId;
    this.write(record);
    if (record.persistenceWarning) throw new Error("Cannot save the STEVE request ID. Free browser storage before sending.");
    try {
      const result = await integration.submitCurrent({ prompt, requestId, bindingRevision, ...(replyToRequestId ? { replyToRequestId } : {}), owner: { userId: record.userId, projectId: record.projectId } });
      void this.watch(record, integration.connector);
      return result;
    } catch (error) {
      record.error = error.message;
      record.rejected = Boolean(error.status && error.status < 500) || String(error.code || '').startsWith('project_');
      this.write(record);
      if (!record.rejected) void this.watch(record, integration.connector);
      throw error;
    }
  }
  dispose() {
    for (const run of this.running.values()) run.controller.abort();
  }
}

export const steveDesignChat = new SteveDesignChat({
  onChange: detail => globalThis.window?.dispatchEvent(new CustomEvent("render3d:steve-chat-updated", { detail })),
});

export function configureSteveActivity(options) {
  return mountSteveActivity({ ...options, ingest: (snapshot, context) => steveDesignChat.ingestActivity(snapshot, context),
    onAvailability: available => {
      steveDesignChat.activityUserId = available ? String(options.getOwner().userId || '') : '';
      if (available) steveDesignChat.dispose();
    },
  });
}

export function configureSteveLivePreview({ THREE, scene, fit, place, getOwner }) {
  const layer = createStevePreviewLayer({ THREE, scene, fit, place });
  const connector = new SteveConnector();
  const preview = new SteveLivePreview({ getOwner, getBinding: () => steveProjectBinding.binding, post: packet => connector.preview(packet), ...layer,
    onError: (error, owner) => {
      const record = steveDesignChat.records(owner).find(item => item.requestId === owner.requestId);
      if (record && record.previewStatus !== error.message) { record.previewStatus = error.message; steveDesignChat.write(record); }
    },
    display: (packet, options) => {
      layer.display(packet, options);
      const record = steveDesignChat.records(getOwner()).find(item => item.requestId === packet.requestId);
      if (record?.previewStatus) { record.previewStatus = ""; steveDesignChat.write(record); }
    },
  });
  steveDesignChat.onPreviewRecord = (record, options) => {
    preview.observe(record, options);
    if (document.visibilityState !== "hidden") void preview.tick();
  };
  const timer = globalThis.window.setInterval(() => {
    if (document.visibilityState !== "hidden") void preview.tick();
  }, 2000);
  const reset = () => {
    preview.reset();
  };
  let bindingGeneration = steveProjectBinding.generation;
  const unsubscribeBinding = steveProjectBinding.subscribe(() => {
    if (bindingGeneration !== steveProjectBinding.generation) { bindingGeneration = steveProjectBinding.generation; reset(); }
  });
  window.addEventListener("render3d:auth-session", reset);
  window.addEventListener("render3d:project-changed", reset);
  window.addEventListener("pagehide", () => {
    window.clearInterval(timer); unsubscribeBinding(); preview.reset();
    window.removeEventListener("render3d:auth-session", reset);
    window.removeEventListener("render3d:project-changed", reset);
  }, { once: true });
  preview.refreshPlacement = layer.refreshPlacement;
  return preview;
}

let resultOpener = null;
export function configureSteveResultOpening(options) {
  resultOpener = new SteveResultOpener({ ...options,
    persist: record => steveDesignChat.write(record),
    readRecord: record => steveDesignChat.savedRecord(record),
  });
  steveDesignChat.onSnapshot = record => { void resultOpener.observe(record); };
}

export function mountSteveSavedResult(row, item, owner) {
  if (!item.steveResult) return;
  const record = steveDesignChat.records(owner).find(entry => entry.requestId === item.requestId);
  if (record) mountSteveResultAction({ row, record, opener: resultOpener,
    refresh: () => steveDesignChat.recover(owner, record.requestId) });
}

export function mountSteveDesignChat(options) {
  const integration = mountSteveConnector(options);
  return { ...integration, submitCurrent: packet => steveDesignChat.submit(integration, packet) };
}

export function mountSteveReplyRecovery({ host, getOwner }) {
  const panel = document.createElement("details");
  panel.dataset.steveReplyRecovery = "1";
  panel.hidden = true;
  panel.style.minWidth = "0";
  const summary = document.createElement("summary");
  summary.textContent = "Recover STEVE reply";
  const label = document.createElement("label");
  label.textContent = "STEVE request ID ";
  label.style.display = "grid";
  label.style.gap = "4px";
  const input = document.createElement("input");
  input.type = "text";
  input.style.width = "100%";
  input.style.boxSizing = "border-box";
  input.placeholder = "Paste the request ID";
  input.setAttribute("aria-label", "STEVE request ID");
  input.dataset.steveRecoveryRequest = "1";
  label.append(input);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn secondary btn-compact";
  button.textContent = "Recover reply";
  button.dataset.steveRecover = "1";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.style.fontSize = "12px";
  status.style.overflowWrap = "anywhere";
  panel.append(summary, label, button, status);
  host.querySelector(".prompt-design-header > div:first-child").append(panel);
  let recoveryEpoch = 0;
  let activeOwnerKey = "";
  const recoverForCurrentOwner = (refresh = false) => {
    const owner = { ...getOwner() };
    if (!owner.userId || !owner.projectId) {
      recoveryEpoch += 1;
      activeOwnerKey = "";
      panel.hidden = true;
      status.textContent = "";
      return;
    }
    const nextOwnerKey = `${owner.userId}:${owner.projectId}`;
    if (refresh !== true && nextOwnerKey === activeOwnerKey) return;
    activeOwnerKey = nextOwnerKey;
    const epoch = ++recoveryEpoch;
    panel.hidden = true;
    status.textContent = "";
    void steveDesignChat.recoverLatest(owner).then(record => {
      if (epoch !== recoveryEpoch) return;
      if (record) {
        steveDesignChat.onPreviewRecord(record);
        status.textContent = "Connected to this project's STEVE reply.";
        return;
      }
      panel.hidden = false;
    }).catch(error => {
      if (epoch !== recoveryEpoch) return;
      panel.hidden = false;
      status.textContent = error.message;
    });
  };
  const refreshTimer = typeof globalThis.window?.setInterval === "function" ? globalThis.window.setInterval(() => {
    if (globalThis.document?.visibilityState !== "hidden") recoverForCurrentOwner(true);
  }, 3000) : null;
  globalThis.window?.addEventListener("pagehide", () => { if (refreshTimer !== null) globalThis.window.clearInterval(refreshTimer); }, { once: true });
  recoverForCurrentOwner();
  globalThis.window?.addEventListener("render3d:auth-session", recoverForCurrentOwner);
  globalThis.window?.addEventListener("render3d:project-changed", recoverForCurrentOwner);
  button.addEventListener("click", async () => {
    const owner = { ...getOwner() };
    const requestId = input.value.trim();
    button.disabled = true;
    status.textContent = "Reading this request from STEVE…";
    try {
      await steveDesignChat.recover(owner, requestId);
      const record = steveDesignChat.records(owner).find(item => item.requestId === requestId);
      status.textContent = record?.error || record?.persistenceWarning || "Reply recovered for the original Render project.";
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  globalThis.window?.addEventListener("pagehide", () => steveDesignChat.dispose(), { once: true });
}
