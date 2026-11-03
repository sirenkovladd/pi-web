import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// A fresh composer's first send, with the user switching to another session at
// each step of its startup (#1146). Switching unmounts the composer, which
// closes its event stream; the prompt must still reach the new session.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

async function sendAndSwitch(stage) {
  const creation = Promise.withResolvers();
  const acceptance = Promise.withResolvers();
  const commands = [];
  const sources = [];
  const created = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") return creation.promise;
    if (url === "/api/agent/s1" && command) {
      commands.push(command.type);
      return command.type === "prompt" ? acceptance.promise : json({ success: true });
    }
    if (url === "/api/agent/s1") return json({ running: true, state: { isStreaming: true, isPromptRunning: true } });
    throw new Error(`unexpected fetch ${url} ${init.body ?? ""}`);
  };

  const hook = renderHook(useAgentSession, {
    session: null,
    newSessionCwd: "/project",
    newSessionDraftKey: "new:draft",
    onSessionCreated: (session) => created.push(session.id),
  });
  await settle();
  hook.flush();
  const originalError = console.error;
  console.error = () => {};
  try {
    const sending = hook.result.handleSend("first message");
    await settle();
    if (stage === "creating") hook.unmount();
    creation.resolve(json({ sessionId: "s1" }));
    await settle();
    if (stage === "connecting") hook.unmount();
    else sources.at(-1)?.connect();
    await settle();
    if (stage === "prompting") hook.unmount();
    acceptance.resolve(json({ success: true, data: null }));
    await sending;
    await settle();
  } finally {
    console.error = originalError;
    for (const source of sources) source.close();
  }
  if (stage === "mounted") hook.unmount();
  return { commands, created, opened: sources.length };
}

for (const stage of ["mounted", "creating", "connecting", "prompting"]) {
  test(`a first prompt reaches its new session when the user switches away (${stage})`, async () => {
    const result = await sendAndSwitch(stage);
    assert.deepEqual(result.commands, ["prompt"]);
    assert.deepEqual(result.created, ["s1"]);
  });
}

test("a composer unmounted before its session exists opens no event stream for it", async () => {
  assert.equal((await sendAndSwitch("creating")).opened, 0);
  assert.equal((await sendAndSwitch("mounted")).opened, 1);
});

test("a background send prompts the new session and flags its creation background", async () => {
  const creation = Promise.withResolvers();
  const acceptance = Promise.withResolvers();
  const commands = [];
  const created = [];
  const sources = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") return creation.promise;
    if (url === "/api/agent/s1" && command) {
      commands.push(command.type);
      return command.type === "prompt" ? acceptance.promise : json({ success: true });
    }
    if (url === "/api/agent/s1") return json({ running: true, state: { isStreaming: true, isPromptRunning: true } });
    throw new Error(`unexpected fetch ${url} ${init.body ?? ""}`);
  };
  const hook = renderHook(useAgentSession, {
    session: null,
    newSessionCwd: "/project",
    newSessionDraftKey: "new:draft",
    onSessionCreated: (session, key, options) => created.push([session.id, options]),
  });
  await settle();
  hook.flush();
  const originalError = console.error;
  console.error = () => {};
  try {
    const sending = hook.result.handleSendBackground("background message");
    await settle();
    creation.resolve(json({ sessionId: "s1" }));
    await settle();
    sources.at(-1)?.connect();
    await settle();
    acceptance.resolve(json({ success: true, data: null }));
    await sending;
    await settle();
  } finally {
    console.error = originalError;
    for (const source of sources) source.close();
    hook.unmount();
  }
  assert.deepEqual(commands, ["prompt"], "the prompt goes out like a foreground send");
  assert.deepEqual(created, [["s1", { background: true }]], "creation carries the background flag for the selection skip");
});

test("a background creation refreshes the list without selecting the session", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const handleSessionCreated = ");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n  const ", start + 1));
  assert.match(body, /options\?: \{ background\?: boolean \}/);
  assert.match(body, /if \(options\?\.background\) return;/);
  assert.match(body, /setRefreshKey\(\(k\) => k \+ 1\)/);
});

test("consecutive background sends mint a session each once the previous run settled", async () => {
  let created = 0;
  const acceptances = [];
  const commands = [];
  const backgrounded = [];
  const sources = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") {
      created += 1;
      return json({ sessionId: `s${created}` });
    }
    const prompt = url.match(/^\/api\/agent\/(s\d+)$/);
    if (prompt && command) {
      commands.push(`${prompt[1]}:${command.type}`);
      if (command.type === "prompt") {
        const gate = Promise.withResolvers();
        acceptances.push(gate);
        return gate.promise;
      }
      return json({ success: true });
    }
    if (prompt) return json({ running: true, state: { isStreaming: true, isPromptRunning: true } });
    throw new Error(`unexpected fetch ${url} ${init.body ?? ""}`);
  };
  const hook = renderHook(useAgentSession, {
    session: null,
    newSessionCwd: "/project",
    newSessionDraftKey: "new:draft",
    onSessionCreated: (session, key, options) => backgrounded.push([session.id, options]),
  });
  await settle();
  hook.flush();
  const originalError = console.error;
  console.error = () => {};
  try {
    const first = hook.result.handleSendBackground("first background");
    await settle();
    sources.at(-1)?.connect();
    await settle();
    acceptances.at(-1)?.resolve(json({ success: true, data: null }));
    await first;
    await settle();
    sources.at(-1)?.onmessage?.({ data: JSON.stringify({ type: "prompt_done" }) });
    await settle();
    const second = hook.result.handleSendBackground("second background");
    await settle();
    sources.at(-1)?.connect();
    await settle();
    acceptances.at(-1)?.resolve(json({ success: true, data: null }));
    await second;
    await settle();
  } finally {
    console.error = originalError;
    for (const source of sources) source.close();
    hook.unmount();
  }
  assert.deepEqual(commands.filter((command) => command.endsWith(":prompt")), ["s1:prompt", "s2:prompt"]);
  assert.deepEqual(backgrounded, [["s1", { background: true }], ["s2", { background: true }]]);
});
