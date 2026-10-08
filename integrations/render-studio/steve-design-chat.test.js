import { test } from "node:test";
import assert from "node:assert/strict";
import { SteveDesignChat } from "./steve-design-chat.js";

const owner = { userId: "alice", projectId: "project-a" };
function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) || null, removeItem: key => values.delete(key), setItem: (key, value) => values.set(key, value) };
}
const complete = { requestId: "request-1", phase: "completed",
  messages: [{ id: "prompt", role: "user", text: "original prompt" },
    { id: "tool", role: "tool", title: "Inspect canvas", toolStatus: "completed" },
    { id: "reply", role: "assistant", text: "Need the dimensions." }] };

test("submission persists ID before HTTP and pins prompt/project across navigation", async () => {
  const store = storage();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const chat = new SteveDesignChat({ storage: store });
  const mutableOwner = { ...owner };
  const integration = {
    connector: { watch: async (id, { onUpdate }) => { onUpdate(complete); return complete; } },
    submitCurrent: async packet => {
      assert.equal(chat.records(owner)[0].requestId, "request-1");
      assert.deepEqual(packet, { prompt: "original prompt", requestId: "request-1" });
      await pending; return { requestId: "request-1" };
    },
  };
  const result = chat.submit(integration, { owner: mutableOwner, prompt: "original prompt", requestId: "request-1" });
  mutableOwner.projectId = "project-b";
  release();
  await result;
  await chat.resume(owner);
  assert.equal(chat.messages(owner).filter(item => item.role === "user").length, 1);
  assert.equal(chat.messages(owner).at(-1).content, "Need the dimensions.");
  assert.deepEqual(chat.messages(mutableOwner), []);
  assert.deepEqual(chat.messages({ ...owner, userId: "bob" }), []);
  assert.equal(chat.records(owner)[0].projectId, "project-a");
});

test("recovery reads only known request feed and deduplicates repeated recovery", async () => {
  let watches = 0;
  const chat = new SteveDesignChat({ storage: storage(), createConnector: () => ({
    watch: async (id, { onUpdate }) => { watches++; assert.equal(id, "request-1"); onUpdate(complete); },
  }) });
  await Promise.all([chat.recover(owner, "request-1"), chat.recover(owner, "request-1")]);
  assert.equal(watches, 1);
  await chat.recover(owner, "request-1");
  assert.equal(chat.records(owner).length, 1);
  assert.equal(chat.messages(owner).length, 3);
  assert.equal(chat.messages(owner)[1].content, "Inspect canvas · completed");
});

test("refresh restores saved transcript and resumes unfinished requests only", async () => {
  const store = storage(), watched = [];
  const initial = new SteveDesignChat({ storage: store });
  const record = initial.remember(owner, "request-1", "original prompt");
  record.snapshot = { requestId: "request-1", phase: "running", messages: [{ id: "reply", role: "assistant", text: "Partial" }] };
  initial.write(record);
  const restored = new SteveDesignChat({ storage: store, createConnector: () => ({
    watch: async (id, { onUpdate }) => { watched.push(id); onUpdate(complete); },
  }) });
  assert.equal(restored.messages(owner)[1].content, "Partial");
  await restored.resume(owner);
  await restored.resume(owner);
  assert.deepEqual(watched, ["request-1"]);
  assert.equal(restored.messages(owner).at(-1).content, "Need the dimensions.");
  assert.ok(!store.getItem(store.key(0)).includes("secret"));
});

test("a lost submit response retains ID for recovery and never resubmits", async () => {
  let submits = 0, watches = 0;
  const chat = new SteveDesignChat({ storage: storage() });
  await assert.rejects(chat.submit({
    submitCurrent: async () => { submits++; throw new TypeError("lost response"); },
    connector: { watch: async (id, { onUpdate }) => { watches++; onUpdate(complete); } },
  }, { owner, requestId: "request-1", prompt: "original prompt" }), /lost response/);
  await chat.resume(owner);
  assert.equal(submits, 1);
  assert.equal(watches, 1);
  assert.equal(chat.records(owner)[0].requestId, "request-1");
});

test("permanent feed failures remain actionable and disposal aborts polling", async () => {
  const chat = new SteveDesignChat({ storage: storage(), createConnector: () => ({
    watch: async () => { throw Object.assign(new Error("missing"), { status: 404 }); },
  }) });
  await chat.recover(owner, "request-1");
  assert.match(chat.messages(owner)[0].content, /no longer has this request/);
  assert.equal(chat.records(owner)[0].connection, "action-required");
  let signal;
  const run = chat.watch(chat.records(owner)[0], { watch: async (id, options) => {
    signal = options.signal; await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  } });
  await Promise.resolve();
  chat.dispose();
  await run;
  assert.equal(signal.aborted, true);
});


test("quota failure after acceptance retains live reply without failing submission", async () => {
  const store = storage();
  const save = store.setItem;
  let fail = false;
  store.setItem = (key, value) => { if (fail) throw new Error("quota"); save(key, value); };
  const chat = new SteveDesignChat({ storage: store });
  const result = await chat.submit({
    submitCurrent: async () => { fail = true; return { accepted: true, requestId: "request-1" }; },
    connector: { watch: async (id, { onUpdate }) => onUpdate(complete) },
  }, { owner, prompt: "original prompt", requestId: "request-1" });
  await chat.resume(owner);
  assert.equal(result.accepted, true);
  assert.ok(chat.messages(owner).some(item => item.content === "Need the dimensions."));
  assert.ok(chat.messages(owner).some(item => item.content.includes("storage is full")));
  assert.equal(JSON.parse(store.getItem(store.key(0))).requestId, "request-1");
});

test("initial storage failure blocks submission before HTTP", async () => {
  const store = storage();
  store.setItem = () => { throw new Error("quota"); };
  let sent = false;
  const chat = new SteveDesignChat({ storage: store });
  await assert.rejects(chat.submit({ submitCurrent: async () => { sent = true; } },
    { owner, prompt: "hello", requestId: "request-1" }), /Cannot save/);
  assert.equal(sent, false);
});

test("unchanged snapshots avoid writes and completed records are bounded", () => {
  const store = storage();
  let writes = 0;
  const save = store.setItem;
  store.setItem = (key, value) => { writes++; save(key, value); };
  const chat = new SteveDesignChat({ storage: store });
  const first = chat.remember(owner, "request-1", "hello");
  chat.write(first);
  chat.write(first);
  assert.equal(writes, 1);
  for (let i = 0; i < 55; i++) {
    const record = chat.remember(owner, "request-" + (i + 10));
    record.snapshot = { ...complete, requestId: record.requestId };
    chat.write(record);
  }
  assert.equal(chat.records(owner).filter(record => record.snapshot?.phase === "completed").length, 50);
  assert.ok(chat.records(owner).some(record => record.requestId === "request-1"));
});

test("recovery uses the header slot and captures the clicked ID before awaiting", async () => {
  const { mountSteveReplyRecovery, steveDesignChat } = await import("./steve-design-chat.js");
  const previousDocument = globalThis.document;
  const previousStorage = steveDesignChat.storage;
  const previousConnector = steveDesignChat.createConnector;
  const header = { children: [], append(node) { this.children.push(node); } };
  globalThis.document = { createElement: () => ({
    children: [], dataset: {}, style: {}, listeners: {}, value: "", textContent: "",
    append(...nodes) { this.children.push(...nodes); },
    setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
  }) };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const current = { userId: "recovery-user", projectId: "original-project" };
  steveDesignChat.storage = storage();
  steveDesignChat.createConnector = () => ({ watch: async id => {
    assert.equal(id, "request-original");
    await pending;
    throw new Error("Original request needs reconnect");
  } });
  try {
    mountSteveReplyRecovery({ host: { querySelector: selector => {
      assert.equal(selector, ".prompt-design-header > div:first-child"); return header;
    } }, getOwner: () => current });
    const panel = header.children[0], input = panel.children[1].children[0];
    const button = panel.children[2], status = panel.children[3];
    input.value = "request-original";
    const recovery = button.listeners.click();
    input.value = "request-edited";
    current.projectId = "other-project";
    release();
    await recovery;
    assert.equal(status.textContent, "Original request needs reconnect");
    assert.equal(steveDesignChat.records({ userId: "recovery-user", projectId: "original-project" })[0].requestId, "request-original");
    assert.equal(steveDesignChat.records(current).length, 0);
  } finally {
    globalThis.document = previousDocument;
    steveDesignChat.storage = previousStorage;
    steveDesignChat.createConnector = previousConnector;
  }
});
