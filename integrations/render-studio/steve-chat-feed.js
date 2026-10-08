export const isSteveChatComplete = snapshot => ["completed", "failed", "stopped"].includes(snapshot?.phase);

function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function watchSteveChat({ requestId, post, signal, onUpdate = () => {}, onConnection = () => {}, wait = pause }) {
  let cursor = 0, backoff = 500;
  let snapshot = { requestId, messages: [] };
  while (!signal?.aborted) {
    let result;
    try {
      result = await post({ requestId, after: cursor }, signal);
    } catch (error) {
      if (signal?.aborted) return;
      if (error.status && error.status < 500) {
        onConnection("action-required", error);
        throw error;
      }
      onConnection("reconnecting", error);
      await wait(backoff, signal);
      backoff = Math.min(backoff * 2, 5000);
      continue;
    }
    if (signal?.aborted) return;
    backoff = 500;
    onConnection("connected");
    if (result.reset) {
      if (result.snapshot?.requestId !== requestId) throw new Error("STEVE returned a different request.");
      snapshot = { ...result.snapshot, messages: [...(result.snapshot.messages || [])] };
    }
    for (const event of result.events || []) {
      if (event.requestId && event.requestId !== requestId) throw new Error("STEVE returned a different request.");
      if (event.type === "status") {
        const { cursor: ignoredCursor, type: ignoredType, ...status } = event;
        snapshot = { ...snapshot, ...status };
      } else if (event.type === "message" && event.message?.id) {
        const index = snapshot.messages.findIndex(message => message.id === event.message.id);
        if (index < 0) snapshot.messages.push(event.message);
        else snapshot.messages[index] = event.message;
      }
    }
    cursor = result.cursor;
    onUpdate(structuredClone(snapshot));
    if (isSteveChatComplete(snapshot)) return snapshot;
    await wait(250, signal);
  }
}
