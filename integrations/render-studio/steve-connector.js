import { steveProjectBinding, bindingError } from './steve-project-binding.js?v=20261008-completion-placement1';
import { watchSteveChat } from "./steve-chat-feed.js?v=20261008-steve-chat2";
const DEFAULT_BASE_URL = "http://127.0.0.1:38173";
const API_VERSION = "/v1";
const SECRET_DB = "render-studio-steve";
const SECRET_STORE = "connection";
const SECRET_KEY = "pairing-secret";

export const STEVE_CONNECTION_STATES = Object.freeze([
  "unavailable",
  "detected",
  "pairing",
  "connected_not_ready",
  "ready",
  "busy",
  "incompatible",
  "error",
]);

export const STEVE_STATE_VIEW = Object.freeze({
  unavailable: {
    tone: "red",
    label: "Not connected",
    recovery: "Install STEVE, open Autodesk Fusion, sign in, and start the STEVE add-in.",
  },
  detected: {
    tone: "amber",
    label: "STEVE detected",
    recovery: "Connect this browser, then approve the request inside Fusion.",
  },
  pairing: {
    tone: "amber",
    label: "Waiting for approval",
    recovery: "Approve Render Studio in the STEVE dialog inside Fusion.",
  },
  connected_not_ready: {
    tone: "amber",
    label: "Connected, not ready",
    recovery: "Finish signing in to STEVE's AI provider inside Fusion.",
  },
  ready: {
    tone: "green",
    label: "Ready in Fusion",
    recovery: "Edits target the open Fusion document. New documents use your Fusion autosave settings.",
  },
  busy: {
    tone: "amber",
    label: "STEVE is busy",
    recovery: "The current job must finish before another prompt can be sent.",
  },
  incompatible: {
    tone: "red",
    label: "Update required",
    recovery: "Update STEVE to a bridge version compatible with Render Studio.",
  },
  error: {
    tone: "red",
    label: "Connection error",
    recovery: "Restart the STEVE add-in in Fusion, then connect again.",
  },
});

function responseError(response, body) {
  const detail = body?.error && typeof body.error === "object" ? body.error : body;
  const error = new Error(detail?.message || (typeof body?.error === "string" ? body.error : "") || `STEVE returned ${response.status}.`);
  error.status = response.status;
  error.code = detail?.code || "";
  return error;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function classifySteveStatus(status, { hasSecret = false } = {}) {
  const phase = String(status?.phase || "").toLowerCase();
  const major = Number.parseInt(String(status?.version || "1").split(".")[0], 10);
  if (Number.isFinite(major) && major !== 1) return "incompatible";
  if (phase === "incompatible") return "incompatible";
  if (phase === "error") return "error";
  if (phase === "pairing" || status?.pairingId) return "pairing";
  if (!status?.fusionRunning) return "unavailable";
  if (!hasSecret || !status?.connected) return "detected";
  if (status?.busy || Number(status?.queueDepth || 0) > 0) return "busy";
  if (!status?.providerReady || !status?.ready) return "connected_not_ready";
  return "ready";
}

export function normalizeDesignName(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 96);
}

export function suggestedDesignName(prompt, now = new Date()) {
  const words = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const stem = words.join("-") || "steve-design";
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  return normalizeDesignName(`${stem}-${stamp}`);
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomNonce(cryptoApi) {
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function signSteveSubmission({
  secret,
  body,
  requestId,
  timestamp,
  nonce,
  cryptoApi = globalThis.crypto,
  path = `${API_VERSION}/submissions`,
}) {
  const encoder = new TextEncoder();
  const bodyHash = bytesToHex(await cryptoApi.subtle.digest("SHA-256", encoder.encode(body)));
  const canonical = `POST\n${path}\n${timestamp}\n${nonce}\n${requestId}\n${bodyHash}`;
  const key = await cryptoApi.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await cryptoApi.subtle.sign("HMAC", key, encoder.encode(canonical)));
}

export function createIndexedDbSecretStore(indexedDb = globalThis.indexedDB) {
  function open() {
    return new Promise((resolve, reject) => {
      if (!indexedDb) return reject(new Error("IndexedDB is unavailable."));
      const request = indexedDb.open(SECRET_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SECRET_STORE)) {
          request.result.createObjectStore(SECRET_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open STEVE secret storage."));
    });
  }
  async function transact(mode, run) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(SECRET_STORE, mode);
        const request = run(tx.objectStore(SECRET_STORE));
        tx.oncomplete = () => resolve(request.result ?? null);
        tx.onabort = () => reject(tx.error || new Error("STEVE secret storage transaction aborted."));
        request.onerror = () => reject(request.error || new Error("STEVE secret storage failed."));
      });
    } finally {
      db.close();
    }
  }
  return {
    read: () => transact("readonly", (store) => store.get(SECRET_KEY)),
    write: (secret) => transact("readwrite", (store) => store.put(secret, SECRET_KEY)),
    clear: () => transact("readwrite", (store) => store.delete(SECRET_KEY)),
  };
}

export class SteveConnector {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchFn = globalThis.fetch?.bind(globalThis),
    cryptoApi = globalThis.crypto,
    secretStore = createIndexedDbSecretStore(),
    pollMs = 2500,
    pairingPollMs = 1000,
    onChange = () => {},
    schedule = globalThis.setTimeout?.bind(globalThis),
    cancelSchedule = globalThis.clearTimeout?.bind(globalThis),
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchFn = fetchFn;
    this.cryptoApi = cryptoApi;
    this.secretStore = secretStore;
    this.pollMs = pollMs;
    this.pairingPollMs = pairingPollMs;
    this.onChange = onChange;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.state = "unavailable";
    this.status = null;
    this.active = false;
    this.timer = null;
    this.secret = null;
    this.error = null;
    this.authFailure = null;
    this.authRetryAt = 0;
    this.authFailures = 0;
    this.authVerifiedAt = 0;
    this.reconnectNeeded = false;
  }

  snapshot() {
    return { state: this.state, status: this.status, error: this.error, ...STEVE_STATE_VIEW[this.state] };
  }

  emit(state, { status = this.status, error = null } = {}) {
    if (!STEVE_CONNECTION_STATES.includes(state)) throw new Error(`Unknown STEVE state: ${state}`);
    this.state = state;
    this.status = status;
    this.error = error;
    this.onChange(this.snapshot());
    return this.snapshot();
  }

  async activate() {
    if (this.active) return this.snapshot();
    this.active = true;
    try { this.secret = await this.secretStore.read(); } catch { this.secret = null; }
    await this.poll();
    return this.snapshot();
  }

  deactivate() {
    this.active = false;
    if (this.timer) this.cancelSchedule?.(this.timer);
    this.timer = null;
  }

  queuePoll(delay = this.pollMs) {
    if (!this.active || !this.schedule) return;
    if (this.timer) this.cancelSchedule?.(this.timer);
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  async refreshSecret() {
    try {
      const secret = await this.secretStore.read();
      if (secret !== this.secret) {
        this.authFailure = null; this.authRetryAt = 0; this.authFailures = 0;
        this.authVerifiedAt = 0; this.reconnectNeeded = false;
      }
      this.secret = secret || null;
    } catch { /* Keep the in-memory credential during a temporary IndexedDB failure. */ }
    return this.secret;
  }

  async request(path, options = {}) {
    if (!this.fetchFn) throw new TypeError("Fetch is unavailable.");
    const signed = Boolean(options.headers?.["X-Steve-Signature"]);
    const recoveryRead = path === "/events" || path === "/preview" || path === "/ping" || path === "/project" || path === "/activity";
    if (signed && recoveryRead && this.authFailure && Date.now() < this.authRetryAt) throw this.authFailure;
    const response = await this.fetchFn(`${this.baseUrl}${API_VERSION}${path}`, options);
    const body = await readJson(response);
    if (!response.ok) {
      const error = responseError(response, body);
      if (signed && (error.status === 401 || error.status === 403)) {
        this.authVerifiedAt = 0;
        this.reconnectNeeded = error.code === "invalid_signature";
        this.authFailures += 1;
        this.authRetryAt = Date.now() + Math.min(30000, 3000 * 2 ** Math.min(4, this.authFailures - 1));
        error.message = "STEVE authentication is unavailable. Saved pairing is retained; chat will retry automatically. Use Connect if pairing was revoked.";
        this.authFailure = error;
      }
      throw error;
    }
    if (signed) { this.authFailure = null; this.authRetryAt = 0; this.authFailures = 0; this.authVerifiedAt = Date.now(); this.reconnectNeeded = false; }
    return body;
  }

  async probePairing() {
    if (this.authFailure && Date.now() < this.authRetryAt) throw this.authFailure;
    const body = "{}";
    const requestId = this.cryptoApi.randomUUID(), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomNonce(this.cryptoApi);
    const signature = await signSteveSubmission({ secret: this.secret, body, requestId,
      timestamp, nonce, cryptoApi: this.cryptoApi, path: "/v1/ping" });
    const result = await this.request("/ping", { method: "POST", body, signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "X-Request-Id": requestId,
        "X-Steve-Timestamp": timestamp, "X-Steve-Nonce": nonce, "X-Steve-Signature": signature } });
    if (result?.authenticated !== true) {
      this.authVerifiedAt = 0;
      throw new Error("STEVE did not confirm the saved pairing.");
    }
    return result;
  }

  async poll() {
    if (!this.active) return this.snapshot();
    try {
      await this.refreshSecret();
      const status = await this.request("/status", { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (this.secret && status?.fusionRunning && status?.connected && status?.capabilities?.authPing === true) await this.probePairing();
      if (!status?.fusionRunning || !status?.connected) this.authVerifiedAt = 0;
      const state = classifySteveStatus(status, { hasSecret: Boolean(this.secret) && !this.authFailure });
      this.emit(state, { status });
    } catch (error) {
      this.authVerifiedAt = 0;
      const state = error?.status === 401 || error?.status === 403 ? "detected" : error?.status === 426 ? "incompatible" : error?.status ? "error" : "unavailable";
      this.emit(state, { status: null, error });
    } finally {
      this.queuePoll();
    }
    return this.snapshot();
  }

  async pair() {
    this.emit("pairing");
    try {
      const started = await this.request("/pairing/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const pairingId = started.pairingId;
      if (!pairingId) throw new Error("STEVE did not return a pairing ID.");
      this.status = { ...(this.status || {}), ...started, pairingId };
      return await this.completePairing(pairingId);
    } catch (error) {
      this.emit(error?.status === 426 ? "incompatible" : "error", { error });
      throw error;
    }
  }

  async completePairing(pairingId) {
    while (this.active) {
      try {
        const completed = await this.request("/pairing/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingId }),
        });
        if (!completed.secret) throw new Error("STEVE approved pairing without a secret.");
        this.secret = completed.secret;
        await this.secretStore.write(this.secret);
        this.authFailure = null; this.authRetryAt = 0; this.authFailures = 0;
        await this.poll();
        return this.snapshot();
      } catch (error) {
        if (error?.status === 409 || error?.code === "pairing_pending") {
          await new Promise((resolve) => this.schedule(resolve, this.pairingPollMs));
          continue;
        }
        if (error?.status === 403) this.emit("detected", { error });
        else this.emit("error", { error });
        throw error;
      }
    }
    return this.snapshot();
  }

  async storage(payload, { requestId = this.cryptoApi.randomUUID() } = {}) {
    await this.refreshSecret();
    if (!this.secret) throw new Error("Connect STEVE in the CAD engine menu, then retry here.");
    const post = async (path, value, id) => {
      const body = JSON.stringify(value);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomNonce(this.cryptoApi);
      const signature = await signSteveSubmission({ secret: this.secret, body, requestId: id,
        timestamp, nonce, cryptoApi: this.cryptoApi, path: `${API_VERSION}${path}` });
      try {
        return await this.request(path, { method: "POST", body, signal: AbortSignal.timeout(payload.action === "chooseFolder" ? 600000 : 15000), headers: {
          "Content-Type": "application/json", "X-Request-Id": id, "X-Steve-Timestamp": timestamp,
          "X-Steve-Nonce": nonce, "X-Steve-Signature": signature,
        } });
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          this.emit("detected", { error });
          throw error;
        }
        if (error.status === 404) throw new Error("Update and restart the STEVE add-in to use Fusion storage settings.");
        throw error;
      }
    };
    let result = await post("/storage", payload, requestId);
    const deadline = Date.now() + (payload.action === "chooseFolder" ? 600000 : 30000);
    while (result.pending) {
      if (Date.now() > deadline) {
        const error = new Error("Fusion is still processing this setting. Refresh to check its saved value.");
        error.requestId = requestId;
        throw error;
      }
      await new Promise(resolve => this.schedule(resolve, 250));
      result = await post("/storage/result", { requestId }, this.cryptoApi.randomUUID());
    }
    if (result.error) throw new Error(result.error);
    return result.result;
  }

  async watch(requestId, options = {}) {
    await this.refreshSecret();
    if (!this.secret) throw new Error("Connect Render Studio to STEVE first.");
    try {
      return await watchSteveChat({ ...options, requestId, post: async (payload, signal) => {
      await this.refreshSecret();
      if (!this.secret) throw Object.assign(new Error("Connect Render Studio to STEVE first."), { status: 401 });
      const body = JSON.stringify(payload);
      const id = this.cryptoApi.randomUUID();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomNonce(this.cryptoApi);
      const signature = await signSteveSubmission({ secret: this.secret, body, requestId: id,
        timestamp, nonce, cryptoApi: this.cryptoApi, path: "/v1/events" });
      return this.request("/events", { method: "POST", body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", "X-Request-Id": id,
          "X-Steve-Timestamp": timestamp, "X-Steve-Nonce": nonce, "X-Steve-Signature": signature } });
      } });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        this.emit("detected", { error });
      }
      throw error;
    }
  }

  async preview({ requestId, afterRevision = 0 }) {
    if (!this.previewCapability) {
      const status = await this.request("/status", { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (status?.capabilities?.livePreview !== true) {
        const error = new Error("Update the STEVE bridge to view live Fusion geometry.");
        error.code = "steve_preview_unavailable"; throw error;
      }
      this.previewCapability = true;
    }
    await this.refreshSecret();
    if (!this.secret) throw Object.assign(new Error("Reconnect STEVE to view live Fusion geometry."), { status: 401 });
    const body = JSON.stringify({ requestId, afterRevision });
    const id = this.cryptoApi.randomUUID(), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomNonce(this.cryptoApi);
    const signature = await signSteveSubmission({ secret: this.secret, body, requestId: id,
      timestamp, nonce, cryptoApi: this.cryptoApi, path: "/v1/preview" });
    try {
      return await this.request("/preview", { method: "POST", body, signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", "X-Request-Id": id,
          "X-Steve-Timestamp": timestamp, "X-Steve-Nonce": nonce, "X-Steve-Signature": signature } });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        this.previewCapability = false;
        this.emit("detected", { error });
      }
      throw error;
    }
  }

  async latest(owner) {
    const renderProjectId = String(owner?.projectId || "");
    const renderUserId = String(owner?.userId || "");
    if (!renderProjectId || !renderUserId) throw new Error("Sign in and open a Render project first.");
    const status = await this.request("/status", { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (status?.capabilities?.projectChatHistory !== true) {
      const error = new Error("This STEVE bridge needs an update for automatic project chat recovery. Existing request IDs can still be recovered below.");
      error.code = "steve_project_history_unavailable";
      throw error;
    }
    await this.refreshSecret();
    if (!this.secret) throw new Error("Connect Render Studio to STEVE first.");
    const body = JSON.stringify({ renderProjectId, renderUserId, after: 0 });
    const id = this.cryptoApi.randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonce(this.cryptoApi);
    const signature = await signSteveSubmission({ secret: this.secret, body, requestId: id,
      timestamp, nonce, cryptoApi: this.cryptoApi, path: "/v1/events" });
    try {
      return await this.request("/events", { method: "POST", body, signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", "X-Request-Id": id,
          "X-Steve-Timestamp": timestamp, "X-Steve-Nonce": nonce, "X-Steve-Signature": signature } });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        this.emit("detected", { error });
      }
      throw error;
    }
  }

  async project(payload = { action: 'get' }) {
    await this.refreshSecret();
    if (!this.secret) throw new Error('Connect Render Studio to STEVE first.');
    if (this.authFailure && Date.now() < this.authRetryAt) throw this.authFailure;
    const status = await this.request('/status', { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    this.status = status;
    if (status?.capabilities?.projectBinding !== true) throw bindingError('project_binding_unavailable');
    const body = JSON.stringify(payload);
    const requestId = this.cryptoApi.randomUUID(), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomNonce(this.cryptoApi);
    const signature = await signSteveSubmission({ secret: this.secret, body, requestId, timestamp, nonce,
      cryptoApi: this.cryptoApi, path: '/v1/project' });
    return this.request('/project', { method: 'POST', body, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId,
        'X-Steve-Timestamp': timestamp, 'X-Steve-Nonce': nonce, 'X-Steve-Signature': signature } });
  }

  async prepareSubmission(owner, bindingRevision, replyToRequestId) {
    await steveProjectBinding.refresh(this);
    const binding = steveProjectBinding.binding;
    if (!replyToRequestId && bindingRevision === undefined && !binding) {
      steveProjectBinding.prepare(owner);
      await steveProjectBinding.confirm(this);
    }
    if (!replyToRequestId && bindingRevision === undefined && binding && steveProjectBinding.availableForProjectChange
      && binding.renderUserId === String(owner?.userId || '')
      && binding.renderProjectId !== String(owner?.projectId || '')) {
      steveProjectBinding.prepare(owner, { requireAvailable: true });
      await steveProjectBinding.confirm(this);
    }
    return steveProjectBinding.assertOwner(owner, bindingRevision);
  }

  async submit({ prompt, projectId, folderId, renderProjectId, renderUserId, bindingRevision, replyToRequestId, designName, requestId = this.cryptoApi.randomUUID() } = {}) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt) throw new Error("Enter a CAD prompt before sending to STEVE.");
    await this.refreshSecret();
    if (!this.secret) throw new Error("Connect Render Studio to STEVE first.");
    if (this.state !== "ready" && !(this.state === "busy" && replyToRequestId)) throw new Error(STEVE_STATE_VIEW[this.state].recovery);
    if (!renderProjectId || !renderUserId) throw new Error("Both Render project and user IDs are required.");
    const revision = await this.prepareSubmission({ userId: renderUserId, projectId: renderProjectId }, bindingRevision, replyToRequestId);
    const payload = { prompt: cleanPrompt, renderProjectId: String(renderProjectId), renderUserId: String(renderUserId),
      bindingRevision: revision };
    if (replyToRequestId) {
      if (this.status?.capabilities?.replyToRequest !== true) throw new Error("Update STEVE in Fusion to resume this conversation safely.");
      payload.replyToRequestId = String(replyToRequestId);
    }
    if (projectId) payload.projectId = String(projectId);
    if (folderId) payload.folderId = String(folderId);
    const cleanName = normalizeDesignName(designName);
    if (cleanName) payload.designName = cleanName;
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonce(this.cryptoApi);
    const signature = await signSteveSubmission({
      secret: this.secret,
      body,
      requestId,
      timestamp,
      nonce,
      cryptoApi: this.cryptoApi,
    });
    this.emit("busy");
    try {
      const result = await this.request("/submissions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
          "X-Steve-Timestamp": timestamp,
          "X-Steve-Nonce": nonce,
          "X-Steve-Signature": signature,
        },
        body,
      });
      this.queuePoll(250);
      return { ...result, requestId };
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        this.emit("detected", { error });
      } else {
        this.emit("error", { error });
      }
      throw error;
    }
  }
}

function preciseUnavailableMessage() {
  return "Render Studio could not reach STEVE at 127.0.0.1:38173. Install STEVE, open Autodesk Fusion, sign in, and start the add-in. Your browser may also be blocking local-network access.";
}

export function deriveSteveSetupState({ fusionLinked = false, steveState = "unavailable", fusionTabAttached = false } = {}) {
  return {
    fusionLinked: !!fusionLinked,
    fusionTabAttached: !!fusionTabAttached,
    canConnectSteve: !!fusionLinked,
    steveConnected: ["connected_not_ready", "ready", "busy"].includes(String(steveState)),
  };
}

function isFusionTabAttached() {
  try {
    const state = JSON.parse(localStorage.getItem("render3d:cadLibraryDock:v1") || "{}");
    return !!state?.fusion?.attached;
  } catch {
    return false;
  }
}

function ensureSteveSetupDialog(root) {
  let dialog = root?.getElementById?.("steve-setup-dialog");
  if (dialog) return dialog;
  dialog = root?.createElement?.("div");
  if (!dialog) return null;
  dialog.id = "steve-setup-dialog";
  dialog.className = "auth-modal steve-setup-dialog hidden";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "steve-setup-title");
  dialog.innerHTML = `
    <div class="auth-backdrop" data-steve-setup-close></div>
    <div class="auth-card app-dialog-card steve-setup-card">
      <button type="button" class="auth-close" data-steve-setup-close aria-label="Close">&times;</button>
      <p class="workspace-manage-eyebrow">Fusion workflow</p>
      <h2 id="steve-setup-title" class="app-dialog-title">Set up STEVE</h2>
      <div class="steve-setup-tabs" role="tablist" aria-label="STEVE setup steps">
        <button type="button" role="tab" data-steve-setup-tab="fusion" aria-selected="true">1. Fusion 360</button>
        <button type="button" role="tab" data-steve-setup-tab="steve" aria-selected="false">2. STEVE</button>
        <button type="button" role="tab" data-steve-setup-tab="home" aria-selected="false">3. Project home</button>
      </div>
      <section class="steve-setup-pane" data-steve-setup-pane="fusion">
        <h3>Connect Fusion 360 first</h3>
        <p data-steve-fusion-status>Checking your Autodesk connection…</p>
        <div class="steve-setup-actions">
          <button type="button" class="btn primary" data-steve-connect-fusion>Connect Fusion 360</button>
          <button type="button" class="btn secondary" data-steve-add-fusion-tab>Add Fusion tab to viewport</button>
        </div>
        <p class="muted small">The tab stays at the lower-left viewport edge so you can reopen Fusion projects without leaving your model.</p>
      </section>
      <section class="steve-setup-pane hidden" data-steve-setup-pane="steve">
        <h3>Connect STEVE</h3>
        <p data-steve-setup-recovery>Install STEVE, open Autodesk Fusion, sign in, and start the add-in.</p>
        <button type="button" class="btn primary" data-steve-connect>Connect STEVE</button>
        <label class="steve-setup-field">Design name
          <input type="text" maxlength="96" data-steve-design-name placeholder="Auto-generated from your prompt" />
        </label>
      </section>
      <section class="steve-setup-pane hidden" data-steve-setup-pane="home">
        <h3>Select a project home</h3>
        <p>Choose the Fusion hub, project, and folder used by this Render Studio project.</p>
        <button type="button" class="btn primary" data-steve-open-project-homes>Open project homes</button>
        <p class="muted small" data-steve-context>Choose a Fusion project home before sending work to STEVE.</p>
      </section>
    </div>
  `;
  root.body?.appendChild?.(dialog);
  return dialog;
}

export function mountSteveConnector({
  root = globalThis.document,
  getPrompt = () => "",
  setPromptStatus = () => {},
  getFusionStatus = async () => ({ linked: false }),
  connectFusion = () => {},
  connectorOptions = {},
} = {}) {
  const setupDialog = ensureSteveSetupDialog(root);
  const dot = root?.querySelector?.("[data-steve-status-dot]");
  const label = root?.querySelector?.("[data-steve-status-label]");
  const recovery = root?.querySelector?.("[data-steve-recovery]");
  const setupButton = root?.querySelector?.("[data-steve-setup]");
  const context = setupDialog?.querySelector?.("[data-steve-context]");
  const setupRecovery = setupDialog?.querySelector?.("[data-steve-setup-recovery]");
  const designName = setupDialog?.querySelector?.("[data-steve-design-name]");
  const pairButton = setupDialog?.querySelector?.("[data-steve-connect]");
  const fusionStatus = setupDialog?.querySelector?.("[data-steve-fusion-status]");
  const connectFusionButton = setupDialog?.querySelector?.("[data-steve-connect-fusion]");
  const addFusionTabButton = setupDialog?.querySelector?.("[data-steve-add-fusion-tab]");
  let fusionLinked = false;
  let lastSnapshot = { state: "unavailable", recovery: STEVE_STATE_VIEW.unavailable.recovery };

  function selectSetupTab(tab) {
    const next = ["fusion", "steve", "home"].includes(tab) ? tab : "fusion";
    setupDialog?.querySelectorAll?.("[data-steve-setup-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.steveSetupTab === next));
    });
    setupDialog?.querySelectorAll?.("[data-steve-setup-pane]").forEach((pane) => {
      pane.classList.toggle("hidden", pane.dataset.steveSetupPane !== next);
    });
  }

  function renderSetupState() {
    const state = deriveSteveSetupState({
      fusionLinked,
      steveState: lastSnapshot.state,
      fusionTabAttached: isFusionTabAttached(),
    });
    if (fusionStatus) fusionStatus.textContent = state.fusionLinked
      ? "Fusion 360 is connected."
      : "Fusion 360 is required before STEVE can connect.";
    if (connectFusionButton) connectFusionButton.hidden = state.fusionLinked;
    if (addFusionTabButton) {
      addFusionTabButton.disabled = !state.fusionLinked || state.fusionTabAttached;
      addFusionTabButton.textContent = state.fusionTabAttached ? "Fusion tab added" : "Add Fusion tab to viewport";
    }
    if (pairButton) {
      pairButton.hidden = state.steveConnected;
      pairButton.disabled = !state.canConnectSteve || lastSnapshot.state === "pairing";
      pairButton.textContent = lastSnapshot.state === "pairing" ? "Approve in Fusion…" : "Connect STEVE";
    }
    if (setupRecovery) setupRecovery.textContent = lastSnapshot.state === "unavailable"
      ? preciseUnavailableMessage()
      : lastSnapshot.error?.message || lastSnapshot.recovery;
    if (recovery) recovery.textContent = state.fusionLinked
      ? (state.steveConnected ? "Fusion and STEVE are ready." : "Fusion connected. Finish STEVE setup.")
      : "Connect Fusion 360 first, then finish STEVE setup.";
  }

  async function refreshFusionStatus() {
    if (fusionStatus) fusionStatus.textContent = "Checking your Autodesk connection…";
    try {
      const status = await getFusionStatus();
      fusionLinked = !!status?.linked;
    } catch {
      fusionLinked = false;
    }
    renderSetupState();
    return fusionLinked;
  }

  const connector = new SteveConnector({
    ...connectorOptions,
    onChange(snapshot) {
      lastSnapshot = snapshot;
      connectorOptions.onChange?.(snapshot);
      if (dot) dot.dataset.tone = snapshot.tone;
      if (label) label.textContent = snapshot.label;
      const current = snapshot.status?.currentContext || snapshot.status?.context || {};
      const destination = current.projectName || current.folderName
        ? [current.projectName, current.folderName].filter(Boolean).join(" / ")
        : "Current Fusion project and folder";
      if (context) context.textContent = `${destination}. Configure new-document saves in Settings → CAD & files.`;
      renderSetupState();
    },
  });
  setupDialog?.querySelectorAll?.("[data-steve-setup-close]").forEach((button) => {
    button.addEventListener("click", () => setupDialog.classList.add("hidden"));
  });
  setupDialog?.querySelectorAll?.("[data-steve-setup-tab]").forEach((button) => {
    button.addEventListener("click", () => selectSetupTab(button.dataset.steveSetupTab));
  });
  setupButton?.addEventListener?.("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setupDialog?.classList.remove("hidden");
    selectSetupTab("fusion");
    if (designName && !designName.value) designName.value = suggestedDesignName(getPrompt());
    void refreshFusionStatus();
  });
  connectFusionButton?.addEventListener?.("click", () => {
    setupDialog?.classList.add("hidden");
    connectFusion();
  });
  addFusionTabButton?.addEventListener?.("click", () => {
    window.dispatchEvent(new CustomEvent("render3d:attach-cad-library", { detail: { cadId: "fusion", open: false } }));
    renderSetupState();
  });
  setupDialog?.querySelector?.("[data-steve-open-project-homes]")?.addEventListener?.("click", () => {
    setupDialog.classList.add("hidden");
    window.dispatchEvent(new CustomEvent("render3d:open-fusion-library"));
  });
  pairButton?.addEventListener?.("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!await refreshFusionStatus()) {
      selectSetupTab("fusion");
      setPromptStatus("error", "Connect Fusion 360 before connecting STEVE.");
      return;
    }
    void connector.pair().catch((error) => setPromptStatus("error", error?.message || "Could not connect STEVE."));
  });
  return {
    connector,
    async setActive(active) {
      if (active) {
        if (designName && !designName.value) designName.value = suggestedDesignName(getPrompt());
        return connector.activate();
      }
      connector.deactivate();
      return connector.snapshot();
    },
    prepareSubmission: (owner, replyToRequestId) => connector.prepareSubmission(owner, undefined, replyToRequestId),
    async submitCurrent({ prompt = getPrompt(), requestId, owner, bindingRevision, replyToRequestId } = {}) {
      steveProjectBinding.assertOwner(owner, bindingRevision);
      const result = await connector.submit({
        prompt,
        requestId,
        renderProjectId: owner?.projectId,
        renderUserId: owner?.userId,
        bindingRevision,
        replyToRequestId,
        designName: designName?.value || suggestedDesignName(prompt),
      });
      setPromptStatus("ok", result.message || "Prompt sent to STEVE in Fusion.");
      return result;
    },
  };
}
