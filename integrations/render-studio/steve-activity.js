import { signSteveSubmission } from './steve-connector.js?v=20261008-steve-auth-ping1';

export async function readSteveActivity(connector, { renderUserId, after }, signal) {
  if (!renderUserId || !Number.isSafeInteger(after) || after < 0) throw new Error('Invalid STEVE activity scope.');
  await connector.refreshSecret();
  if (!connector.secret) return null;
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const status = await connector.request('/status', { method: 'GET', cache: 'no-store', signal: timeout });
  if (status?.capabilities?.activityFeed !== true) return null;
  if (connector.authFailure && Date.now() < connector.authRetryAt) throw connector.authFailure;
  const body = JSON.stringify({ renderUserId, after });
  const requestId = connector.cryptoApi.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = connector.cryptoApi.randomUUID().replaceAll('-', '');
  const signature = await signSteveSubmission({ secret: connector.secret, body, requestId, timestamp, nonce,
    cryptoApi: connector.cryptoApi, path: '/v1/activity' });
  return connector.request('/activity', { method: 'POST', body, signal: timeout, headers: {
    'Content-Type': 'application/json', 'X-Request-Id': requestId, 'X-Steve-Timestamp': timestamp,
    'X-Steve-Nonce': nonce, 'X-Steve-Signature': signature,
  } });
}

export function validateSteveActivity(packet, userId) {
  if (packet?.version !== 1 || typeof packet.epoch !== 'string' || !packet.epoch || !Number.isSafeInteger(packet.cursor) || packet.cursor < 0
    || typeof packet.reset !== 'boolean' || !Array.isArray(packet.requests) || packet.requests.length > 64) {
    throw new Error('Invalid STEVE activity feed.');
  }
  const ids = new Set();
  for (const record of packet.requests) {
    if (record?.renderUserId !== userId || typeof record.renderProjectId !== 'string' || !record.renderProjectId
      || !/^[a-zA-Z0-9_-]{8,128}$/.test(record.requestId) || ids.has(record.requestId)
      || !Array.isArray(record.messages) || record.messages.length > 2048) throw new Error('Invalid STEVE activity owner.');
    ids.add(record.requestId);
    const messages = new Set();
    for (const message of record.messages) {
      if (typeof message?.id !== 'string' || !message.id || messages.has(message.id)
        || !['user', 'assistant', 'tool', 'system'].includes(message.role)
        || (message.text != null && typeof message.text !== 'string')) throw new Error('Invalid STEVE activity message.');
      messages.add(message.id);
    }
  }
  return packet;
}

const completedReplies = record => record.messages.filter(message => message.role === 'assistant' && message.text?.trim()
  && message.streaming !== true && (record.phase === 'completed' || message.complete === true || message.status === 'completed'));

export class SteveActivity {
  constructor({ getUserId, read, ingest = () => {}, onChange = () => {}, onAvailability = () => {},
    schedule = globalThis.setTimeout.bind(globalThis), cancel = globalThis.clearTimeout.bind(globalThis) }) {
    Object.assign(this, { getUserId, read, ingest, onChange, onAvailability, schedule, cancel });
    this.userId = ''; this.feedEpoch = ''; this.cursor = 0; this.initialized = false; this.records = new Map();
    this.seen = new Map(); this.cards = []; this.selected = null; this.epoch = 0; this.timer = null; this.pending = null; this.active = false;
  }
  reset() {
    this.epoch++; this.pending?.abort(); this.pending = null;
    this.userId = String(this.getUserId() || ''); this.feedEpoch = ''; this.cursor = 0; this.initialized = false;
    this.records.clear(); this.seen.clear(); this.cards = []; this.selected = null;
    this.onAvailability(false); this.onChange(this);
  }
  select(requestId) {
    if (!this.records.has(requestId)) return;
    this.selected = requestId; this.cards = this.cards.filter(card => card.requestId !== requestId); this.onChange(this);
  }
  close() { this.selected = null; this.onChange(this); }
  dismiss(requestId) { this.cards = this.cards.filter(card => card.requestId !== requestId); this.onChange(this); }
  async tick() {
    if (String(this.getUserId() || '') !== this.userId) this.reset();
    if (!this.userId || this.pending) return;
    const controller = new AbortController(), epoch = this.epoch, userId = this.userId;
    this.pending = controller;
    try {
      const packet = await this.read({ renderUserId: userId, after: this.cursor }, controller.signal);
      if (controller.signal.aborted || epoch !== this.epoch || userId !== String(this.getUserId() || '')) return;
      if (!packet) { this.onAvailability(false); return; }
      validateSteveActivity(packet, userId);
      if (this.feedEpoch && packet.epoch !== this.feedEpoch && this.cursor !== 0) {
        this.feedEpoch = packet.epoch; this.cursor = 0; return;
      }
      this.feedEpoch = packet.epoch;
      for (const record of packet.requests) {
        const previous = this.records.get(record.requestId);
        if (previous && previous.renderProjectId !== record.renderProjectId) throw new Error('STEVE request changed project.');
      }
      if (!packet.reset && packet.cursor < this.cursor) throw new Error('STEVE activity cursor moved backwards.');
      const quiet = !this.initialized;
      if (packet.reset) this.records.clear();
      this.onAvailability(true);
      for (const record of packet.requests) {
        this.records.delete(record.requestId); this.records.set(record.requestId, record);
        const seen = this.seen.get(record.requestId) || new Set();
        const fresh = completedReplies(record).filter(message => !seen.has(message.id));
        for (const message of completedReplies(record)) seen.add(message.id);
        this.seen.set(record.requestId, seen);
        if (!quiet && fresh.length && this.selected !== record.requestId) {
          this.cards = this.cards.filter(card => card.requestId !== record.requestId);
          this.cards.push({ requestId: record.requestId, text: fresh.at(-1).text.slice(0, 240) });
          this.cards = this.cards.slice(-3);
        }
        this.ingest(record);
      }
      while (this.records.size > 64) {
        const id = this.records.keys().next().value; this.records.delete(id); this.seen.delete(id);
      }
      while (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value);
      this.cards = this.cards.filter(card => this.records.has(card.requestId));
      if (!this.records.has(this.selected)) this.selected = null;
      this.cursor = packet.cursor; this.initialized = true; this.onChange(this);
    } finally { if (this.pending === controller) this.pending = null; }
  }
  start() {
    if (this.active) return;
    this.active = true;
    const loop = async () => {
      try { await this.tick(); } catch { /* Transient bridge failures retain the cursor and retry. */ }
      if (this.active) this.timer = this.schedule(loop, 2000);
    };
    void loop();
  }
  dispose() {
    this.active = false; this.cancel(this.timer); this.timer = null; this.reset();
  }
}
