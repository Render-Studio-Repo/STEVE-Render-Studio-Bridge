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
        request.onsuccess = () => resolve(request.result ?? null);
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

  async request(path, options = {}) {
    if (!this.fetchFn) throw new TypeError("Fetch is unavailable.");
    const response = await this.fetchFn(`${this.baseUrl}${API_VERSION}${path}`, options);
    const body = await readJson(response);
    if (!response.ok) throw responseError(response, body);
    return body;
  }

  async poll() {
    if (!this.active) return this.snapshot();
    try {
      const status = await this.request("/status", { method: "GET", cache: "no-store" });
      const state = classifySteveStatus(status, { hasSecret: Boolean(this.secret) });
      this.emit(state, { status });
    } catch (error) {
      const state = error?.status === 426 ? "incompatible" : error?.status ? "error" : "unavailable";
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
    if (!this.secret) this.secret = await this.secretStore.read();
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
          this.secret = null;
          await this.secretStore.clear();
          this.emit("detected", { error });
          throw new Error("Reconnect STEVE in the CAD engine menu, then retry here.");
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

  async submit({ prompt, projectId, folderId, designName } = {}) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt) throw new Error("Enter a CAD prompt before sending to STEVE.");
    if (!this.secret) throw new Error("Connect Render Studio to STEVE first.");
    if (this.state !== "ready") throw new Error(STEVE_STATE_VIEW[this.state].recovery);
    const payload = { prompt: cleanPrompt };
    if (projectId) payload.projectId = String(projectId);
    if (folderId) payload.folderId = String(folderId);
    const cleanName = normalizeDesignName(designName);
    if (cleanName) payload.designName = cleanName;
    const body = JSON.stringify(payload);
    const requestId = this.cryptoApi.randomUUID();
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
        this.secret = null;
        try { await this.secretStore.clear(); } catch { /* best effort */ }
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

export function mountSteveConnector({
  root = globalThis.document,
  getPrompt = () => "",
  setPromptStatus = () => {},
  connectorOptions = {},
} = {}) {
  const dot = root?.querySelector?.("[data-steve-status-dot]");
  const label = root?.querySelector?.("[data-steve-status-label]");
  const recovery = root?.querySelector?.("[data-steve-recovery]");
  const context = root?.querySelector?.("[data-steve-context]");
  const designName = root?.querySelector?.("[data-steve-design-name]");
  const pairButton = root?.querySelector?.("[data-steve-connect]");
  const connector = new SteveConnector({
    ...connectorOptions,
    onChange(snapshot) {
      connectorOptions.onChange?.(snapshot);
      if (dot) dot.dataset.tone = snapshot.tone;
      if (label) label.textContent = snapshot.label;
      if (recovery) recovery.textContent = snapshot.state === "unavailable"
        ? preciseUnavailableMessage()
        : snapshot.error?.message || snapshot.recovery;
      const current = snapshot.status?.currentContext || snapshot.status?.context || {};
      const destination = current.projectName || current.folderName
        ? [current.projectName, current.folderName].filter(Boolean).join(" / ")
        : "Current Fusion project and folder";
      if (context) context.textContent = `${destination}. Configure new-document saves in Settings → CAD & files.`;
      if (pairButton) {
        pairButton.hidden = snapshot.state === "ready" || snapshot.state === "busy" || snapshot.state === "connected_not_ready";
        pairButton.disabled = snapshot.state === "pairing";
        pairButton.textContent = snapshot.state === "pairing" ? "Approve in Fusion…" : "Connect STEVE";
      }
    },
  });
  pairButton?.addEventListener?.("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
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
    async submitCurrent() {
      const result = await connector.submit({
        prompt: getPrompt(),
        designName: designName?.value || suggestedDesignName(getPrompt()),
      });
      setPromptStatus("ok", result.message || "Prompt sent to STEVE in Fusion.");
      return result;
    },
  };
}
