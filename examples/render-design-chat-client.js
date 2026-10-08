/** Browser-only client. Reuse Render's existing pairing secret; never persist it in localStorage. */
export function createSteveChatClient({secret, baseUrl = 'http://127.0.0.1:38173'}) {
  const encoder = new TextEncoder();
  const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
  const key = crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  async function signedPost(path, payload, requestId = crypto.randomUUID(), signal) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const digest = hex(await crypto.subtle.digest('SHA-256', encoder.encode(body)));
    const signature = hex(await crypto.subtle.sign('HMAC', await key,
      encoder.encode(`POST\n${path}\n${timestamp}\n${nonce}\n${requestId}\n${digest}`)));
    const response = await fetch(baseUrl + path, {method:'POST', signal, headers:{
      'Content-Type':'application/json', 'X-Request-Id':requestId,
      'X-Steve-Timestamp':timestamp, 'X-Steve-Nonce':nonce, 'X-Steve-Signature':signature,
    }, body});
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error?.message || `STEVE HTTP ${response.status}`);
      error.code = result.error?.code; error.status = response.status; throw error;
    }
    return result;
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  return {
    // Use the SAME requestId when retrying the SAME submission after a lost HTTP response.
    submit: (requestId, payload, signal) => signedPost('/v1/submissions', payload, requestId, signal),
    async watch(requestId, {onUpdate, onConnection = () => {}, signal} = {}) {
      let cursor = 0, snapshot = {requestId, messages:[]}, backoff = 500;
      while (!signal?.aborted) {
        let result;
        try {
          result = await signedPost('/v1/events', {requestId, after:cursor}, undefined, signal);
        } catch (error) {
          if (signal?.aborted) return;
          if (error.status && error.status < 500) { onConnection('action-required', error); throw error; }
          onConnection('reconnecting', error);
          await delay(backoff); backoff = Math.min(backoff * 2, 5000); continue;
        }
        backoff = 500; onConnection('connected');
        if (result.reset) snapshot = result.snapshot;
        for (const event of result.events) {
          if (event.type === 'status') {
            const {cursor:ignoredCursor, type:ignoredType, ...status} = event;
            snapshot = {...snapshot, ...status};
          } else if (event.type === 'message') {
            const index = snapshot.messages.findIndex(m => m.id === event.message.id);
            const messages = [...snapshot.messages];
            if (index < 0) messages.push(event.message); else messages[index] = event.message;
            snapshot = {...snapshot, messages};
          }
        }
        cursor = result.cursor;
        // Render text safely as text/escaped Markdown. Never insert tool text as raw HTML.
        onUpdate(structuredClone(snapshot));
        if (['completed', 'failed', 'stopped'].includes(snapshot.phase)) return snapshot;
        await delay(250);
      }
    },
  };
}
