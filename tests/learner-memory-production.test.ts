import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore } from "../src/core/ports.ts";

// Exercise real production singletons, but never the developer's records/keys.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-production-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
process.env.OPENROUTER_API_KEY = "test-only";
const { stores, memoryDirectory } = await import("../src/server/stores.ts");
const { newUserMessage, newAnswerResult } = await import("../src/core/native-messages.ts");
const { piModels } = await import("../src/agent/models.ts");
const { persistTurnResult } = await import("../src/server/turn-service.ts");

function call(name: string, id: string): LhMessage {
  return { ...fauxAssistantMessage([fauxToolCall(name, {}, { id })], { stopReason: "toolUse" }), id: `call-${id}` } as LhMessage;
}
function answer(id: string): LhMessage {
  return newAnswerResult(id, "quiz", { kind: "quiz", questionText: "Why?", answers: [], dontKnow: true, answeredAt: "2026-10-25" });
}
function probeDone(): LhMessage[] {
  return [call("probe_done", "probe"), { id: "probe-result", role: "toolResult", toolCallId: "probe", toolName: "probe_done", content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true }, isError: false, timestamp: 1 }];
}

// Existing milestones must be excluded by activation, even with no prior jobs.
const historical = stores.chatStore.createChat("Historical");
stores.chatStore.saveMessages(historical.id, [newUserMessage("Old evidence"), call("quiz", "old"), answer("old")]);
const historicalBytes = fs.readFileSync(path.join(process.env.LH_DATA_DIR, "chats", `${historical.id}.json`), "utf8");
const { learnerMemoryCoordinator: coordinator, resolveMemoryUpdaterEngine } = await import("../src/server/learner-memory-runtime.ts");
const { createChat, deleteChatSession } = await import("../src/server/chats.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { isTurnRunning, beginTurn, endTurn, isSessionDeleting } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { formatLearnerMemory } = await import("../src/core/learner-memory.ts");
const models = piModels();
const native = models.getModels("openrouter")[0]!;
assert.ok(native);
const pin = { provider: "openrouter", id: native.id };
const originalStream = models.streamSimple;

after(() => {
  models.streamSimple = originalStream;
  coordinator.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function chat(kind?: "practice") {
  const record = createChat("Production integration", kind);
  stores.chatStore.saveSettings(record.id, { model: pin });
  return record;
}
async function drain(chatId: string, response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  const turn = runningTurn(chatId);
  if (turn) await new Response(turn.subscribe()).text();
  assert.equal(isTurnRunning(chatId), false);
}

test("production activation is durable, relocatable, no-backfill and transcript-preserving", async () => {
  assert.equal(memoryDirectory, path.join(process.env.LH_DATA_DIR!, "memory"));
  const activation = JSON.parse(fs.readFileSync(path.join(memoryDirectory, ".learner-memory.activation.json"), "utf8"));
  assert.deepEqual(activation.baseline[historical.id], stores.chatStore.getChat(historical.id)!.messages.map((m) => m.id));
  await coordinator.recover();
  assert.equal(coordinator.status(historical.id).length, 0);
  assert.equal(fs.readFileSync(path.join(process.env.LH_DATA_DIR!, "chats", `${historical.id}.json`), "utf8"), historicalBytes);
  const fresh = chat();
  stores.chatStore.saveMessages(fresh.id, [call("quiz", "fresh"), answer("fresh")]);
  await coordinator.recover();
  assert.equal(coordinator.status(fresh.id).length, 1, "recovery closes persist-to-scan crash gap");
  assert.equal((coordinator.status(fresh.id)[0]!.result as { state: string }).state, "deferred");
  await stores.learnerMemoryStore.read();
  assert.ok(fs.existsSync(path.join(memoryDirectory, "teaching-guide.md")));
  assert.ok(fs.existsSync(path.join(memoryDirectory, "knowledge-overview.md")));
});

test("all production conversation branches load full fresh snapshots and expose selective history", async () => {
  for (const kind of ["probe", "teach", "practice"] as const) {
    const record = chat(kind === "practice" ? "practice" : undefined);
    if (kind === "teach") stores.chatStore.saveMessages(record.id, probeDone());
    for (const suffix of ["first", "second"]) {
      const before = await stores.learnerMemoryStore.read();
      const snapshot = await stores.learnerMemoryStore.commit({ ...before, teachingGuide: `Full guide ${kind} ${suffix}`, topics: [{ id: "topic", name: `Topic ${suffix}`, rating: 2.5, notes: "Complete notes", evidence: [] }] }, before.revision);
      const faux = createFauxCore({});
      let calls = 0;
      let observedSystem: unknown;
      let observedTools: string[] = [];
      faux.setResponses([(context) => {
        calls++;
        const system = context.messages.find((message) => message.role === "system");
        observedSystem = system?.content;
        observedTools = system?.toolsAdded?.map((tool) => tool.name) ?? [];
        return fauxAssistantMessage([fauxText("Done")]);
      }]);
      models.streamSimple = faux.streamSimple;
      const messageCount = stores.chatStore.getChat(record.id)!.messages.length;
      await drain(record.id, await handleChatInput(record.id, { type: "text", text: `Hello ${suffix}` }));
      assert.equal(calls, 1);
      assert.ok(typeof observedSystem === "string" && observedSystem.includes(formatLearnerMemory(snapshot)), "complete freshly formatted snapshot reaches the provider");
      assert.ok(observedTools.includes("find_learning_history"));
      assert.ok(observedTools.includes("read_learning_history"));
      const persisted = stores.chatStore.getChat(record.id)!.messages.slice(messageCount);
      const assistant = persisted.filter((message) => message.role === "assistant");
      assert.equal(assistant.length, 1, "this turn persisted its assistant reply");
      assert.equal(assistant[0]!.stopReason, "stop");
      assert.deepEqual(assistant[0]!.content, [fauxText("Done")]);
    }
  }
});

test("shared memory growth from another session triggers compaction against an older usage anchor", async () => {
  const { ensureCompacted, projectedContextTokens } = await import("../src/server/compaction.ts");
  const { activeCompactionOf } = await import("../src/core/index.ts");
  const record = chat();
  const other = chat();
  const evidence = newUserMessage("New learner evidence from another session");
  stores.chatStore.saveMessages(other.id, [evidence]);
  const anchor = { ...fauxAssistantMessage([fauxText("Earlier reply")]), id: "older-usage-anchor" } as LhMessage;
  assert.equal(anchor.role, "assistant");
  if (anchor.role !== "assistant") throw new Error("Expected assistant fixture");
  anchor.usage = { ...anchor.usage, input: 30_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30_010 };
  const messages = [newUserMessage("x".repeat(300_000)), newUserMessage("recent"), anchor];
  stores.chatStore.saveMessages(record.id, messages);
  const before = await stores.learnerMemoryStore.read();
  const dynamicTokens = (snapshot: typeof before) => Math.ceil(("\n\n---\n\n".length + formatLearnerMemory(snapshot).length) / 4);
  const initialTokens = dynamicTokens(before);
  let summaries = 0;
  const deps = {
    chatStore: stores.chatStore,
    engine: {} as never,
    modelId: `${pin.provider}:${pin.id}`,
    kind: "teach" as const,
    thresholdTokens: 30_010 + initialTokens + 1_000,
    systemPromptTokens: 90_000,
    summarize: async () => { summaries++; return { summary: "Earlier discussion.", usage: anchor.usage }; },
  };
  await ensureCompacted({ ...deps, dynamicPromptTokens: initialTokens }, record.id);
  assert.equal(summaries, 0, "unchanged memory does not re-count static instructions or old transcript");
  try {
    const grown = await stores.learnerMemoryStore.commit({ ...before, teachingGuide: `${before.teachingGuide}\n${"New learner evidence. ".repeat(2_000)}`, topics: [...before.topics, { id: "cross-session-growth", name: "Other session evidence", rating: 2, evidence: [{ chatId: other.id, messageId: evidence.id }] }] }, before.revision);
    assert.deepEqual(stores.chatStore.getChat(record.id)!.messages, messages, "other-session memory changes leave this transcript untouched");
    const fresh = await stores.learnerMemoryStore.read();
    assert.equal(fresh.revision, grown.revision);
    await ensureCompacted({ ...deps, dynamicPromptTokens: dynamicTokens(fresh) }, record.id);
    assert.equal(summaries, 1);
    assert.equal(activeCompactionOf(stores.chatStore.getChat(record.id)!.messages)!.details.tokensBefore, projectedContextTokens(messages, deps.systemPromptTokens, dynamicTokens(fresh)));
  } finally {
    const current = await stores.learnerMemoryStore.read();
    await stores.learnerMemoryStore.commit({ ...before, revision: current.revision }, current.revision);
  }
});

test("a successful settled preference queues memory without changing graph/transcript formats", async () => {
  const record = chat();
  const graphBefore = stores.graphStore.readNodes();
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember_learner_preference", { preference: "Use short examples" }, { id: "pref" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Noted")]),
  ]);
  models.streamSimple = faux.streamSimple;
  await drain(record.id, await handleChatInput(record.id, { type: "text", text: "I prefer short examples" }));
  assert.equal(coordinator.status(record.id).length, 1);
  assert.deepEqual(stores.graphStore.readNodes(), graphBefore);
  assert.ok(stores.chatStore.getChat(record.id)!.messages.some((m) => m.role === "toolResult" && m.toolName === "remember_learner_preference"));
});

test("answers without a turn and write-ahead answers scan immediately, even if agent construction fails", async () => {
  const record = chat();
  const batch = { ...fauxAssistantMessage([fauxToolCall("quiz", {}, { id: "q1" }), fauxToolCall("quiz", {}, { id: "q2" })], { stopReason: "toolUse" }), id: "parallel-questions" } as LhMessage;
  stores.chatStore.saveMessages(record.id, [batch]);
  const noBuild = () => { throw new Error("injected construction failure"); };
  const first = await handleChatInput(record.id, { type: "answer", toolCallId: "q1", answer: { kind: "quiz", questionText: "Why?", dontKnow: true, answers: [], answeredAt: "now" } }, noBuild);
  assert.equal(first.status, 200);
  assert.equal(coordinator.status(record.id).length, 1);
  assert.equal(isTurnRunning(record.id), false);
  const second = await handleChatInput(record.id, { type: "answer", toolCallId: "q2", answer: { kind: "quiz", questionText: "Why?", dontKnow: true, answers: [], answeredAt: "now" } }, noBuild);
  assert.equal(second.status, 500);
  assert.equal(coordinator.status(record.id).length, 2, "write-ahead answer is durable despite failed turn start");
  assert.equal(isTurnRunning(record.id), false);
});

test("read/save failures cannot strand liveness or enqueue unpersisted milestones", async () => {
  const record = chat();
  const originalRead = stores.learnerMemoryStore.read;
  try {
    stores.learnerMemoryStore.read = async () => { throw new Error("injected read failure"); };
    assert.equal((await handleChatInput(record.id, { type: "text", text: "hello" })).status, 500);
    assert.equal(isTurnRunning(record.id), false);
    assert.deepEqual(stores.chatStore.getChat(record.id)!.messages, []);
  } finally { stores.learnerMemoryStore.read = originalRead; }
  stores.chatStore.saveMessages(record.id, [call("quiz", "failure")]);
  const originalSave = stores.chatStore.saveMessages;
  try {
    stores.chatStore.saveMessages = () => { throw new Error("injected save failure"); };
    assert.equal((await handleChatInput(record.id, { type: "answer", toolCallId: "failure", answer: { kind: "quiz", dontKnow: true, answers: [], questionText: "Why?", answeredAt: "now" } })).status, 500);
    assert.equal(isTurnRunning(record.id), false);
    assert.equal(coordinator.status(record.id).length, 0);
  } finally { stores.chatStore.saveMessages = originalSave; }
});

test("persistTurnResult distinguishes a durable empty turn, failed save, and missing session", () => {
  const record = chat();
  assert.deepEqual(persistTurnResult(stores.chatStore, record.id, 0, [], false), { persisted: true, messages: [] });
  const failed = { ...stores.chatStore, saveMessages: () => { throw new Error("disk failure"); } } satisfies ChatStore;
  assert.deepEqual(persistTurnResult(failed, record.id, 0, probeDone(), false), { persisted: false, messages: [] });
  assert.deepEqual(persistTurnResult(stores.chatStore, "chat_missing", 0, [], false), { persisted: false, messages: [] });
});

test("a failed settled transcript save never scans its unpersisted preference and still releases the turn", async () => {
  const record = chat();
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember_learner_preference", { preference: "Use diagrams" }, { id: "lost-pref" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Noted")]),
  ]);
  models.streamSimple = faux.streamSimple;
  const originalSave = stores.chatStore.saveMessages;
  let writes = 0;
  stores.chatStore.saveMessages = (id, messages) => {
    if (++writes > 1) throw new Error("injected final persistence failure");
    originalSave(id, messages);
  };
  try {
    await drain(record.id, await handleChatInput(record.id, { type: "text", text: "Use diagrams" }));
    assert.equal(writes, 2);
    assert.equal(coordinator.status(record.id).length, 0);
    assert.equal(stores.chatStore.getChat(record.id)!.messages.length, 1, "only the durable write-ahead input survives");
  } finally { stores.chatStore.saveMessages = originalSave; }
});

test("deferred memory jobs do not block deletion; cleanup is awaited and turn races are excluded", async () => {
  const record = chat();
  const evidence = newUserMessage("Learner evidence");
  stores.chatStore.saveMessages(record.id, [evidence, ...probeDone()]);
  coordinator.scan(record.id);
  await coordinator.run(coordinator.status(record.id)[0]!.id);
  assert.equal((coordinator.status(record.id)[0]!.result as { state: string }).state, "deferred");
  const before = await stores.learnerMemoryStore.read();
  await stores.learnerMemoryStore.commit({ ...before, topics: [{ id: "delete-topic", name: "Preserved assessment", rating: 3, evidence: [{ chatId: record.id, messageId: evidence.id }] }] }, before.revision);
  const originalRemove = stores.learnerMemoryStore.removeSessionReferences;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  stores.learnerMemoryStore.removeSessionReferences = async (chatId) => { entered(); await gate; await originalRemove(chatId); };
  try {
    const deleting = deleteChatSession(record.id, "preserve-graph");
    await waiting;
    assert.equal(isSessionDeleting(record.id), true);
    assert.ok(stores.chatStore.getChat(record.id), "record cannot disappear before memory cleanup");
    assert.equal(beginTurn(record.id), false);
    assert.equal((await handleChatInput(record.id, { type: "text", text: "racing input" })).status, 409);
    release();
    assert.equal((await deleting).ok, true);
    assert.equal(stores.chatStore.getChat(record.id), null);
    assert.deepEqual(coordinator.status(record.id), []);
    assert.deepEqual((await stores.learnerMemoryStore.read()).topics[0]!.evidence, []);
    await coordinator.recover();
    assert.deepEqual((await stores.learnerMemoryStore.read()).topics[0]!.evidence, [], "recovery cannot resurrect references");
  } finally {
    release();
    stores.learnerMemoryStore.removeSessionReferences = originalRemove;
    endTurn(record.id);
  }
});

test("production role resolves cheap fallback, explicit override, key and subscription deferrals", async () => {
  stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: pin } } });
  assert.equal((await resolveMemoryUpdaterEngine()).model.id, pin.id);
  const other = models.getModels("openrouter")[1]!;
  stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: pin } }, agent: { models: { memoryUpdater: { model: { provider: other.provider, id: other.id } } } } });
  assert.equal((await resolveMemoryUpdaterEngine()).model.id, other.id);
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(resolveMemoryUpdaterEngine(), { name: "ProviderKeyMissingError" });
  process.env.OPENROUTER_API_KEY = "test-only";
  for (const provider of ["chatgpt", "github-copilot"]) {
    stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider, id: "unavailable" } } } });
    await assert.rejects(resolveMemoryUpdaterEngine(), { name: "ProviderKeyMissingError" });
  }
  stores.settingsStore.writeSettings({ version: 1 });
});

test("deferred production work resumes through the real cheap-role updater, commits memory and records job usage", async () => {
  const record = chat();
  const evidence = newUserMessage("Prefer brief examples");
  stores.chatStore.saveMessages(record.id, [evidence, ...probeDone()]);
  coordinator.scan(record.id);
  const job = coordinator.status(record.id)[0]!;
  await coordinator.run(job.id);
  assert.equal((stores.jobStore.getJob(job.id)!.result as { state: string }).state, "deferred");
  const originalMessages = stores.chatStore.getChat(record.id)!.messages;
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("submit_learner_memory", {
      teachingGuide: [{ before: "", after: "Prefer brief worked examples." }],
      topics: [{ id: "production-topic", name: "Evidence-backed topic", rating: 2.5, evidence: [{ chatId: record.id, messageId: evidence.id }] }],
    }, { id: "submit" })], { stopReason: "toolUse" }),
  ]);
  models.streamSimple = faux.streamSimple;
  stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: pin } } });
  try {
    await coordinator.run(job.id);
    assert.equal(stores.jobStore.getJob(job.id)!.status, "done");
    assert.ok(stores.jobStore.getJob(job.id)!.usage?.steps);
    const memory = await stores.learnerMemoryStore.read();
    assert.match(memory.teachingGuide, /Prefer brief worked examples/);
    assert.deepEqual(memory.topics.find((topic) => topic.id === "production-topic")?.evidence, [{ chatId: record.id, messageId: evidence.id }]);
    assert.deepEqual(stores.chatStore.getChat(record.id)!.messages, originalMessages, "worker never wakes or appends to the conversation");
  } finally { stores.settingsStore.writeSettings({ version: 1 }); }
});

test("settings, keys and subscription notifications refresh the injected production coordinator", async () => {
  const originalRecover = coordinator.recover;
  let calls = 0;
  coordinator.recover = async () => { calls++; };
  try {
    const { writeSettingsRecord } = await import("../src/server/settings.ts");
    const { saveKey, deleteKey } = await import("../src/server/keys.ts");
    writeSettingsRecord({ version: 1 });
    assert.equal(calls, 1);
    assert.equal(saveKey("OPENROUTER_API_KEY", "test-only-provider-key").ok, true);
    assert.equal(calls, 2);
    deleteKey("OPENROUTER_API_KEY");
    assert.equal(calls, 3);
    const ipc = process.emit.bind(process) as (name: string, value: unknown) => boolean;
    ipc("message", { channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 1 }, status: { available: false, pending: false, allowBackgroundUse: false, activeId: null, accounts: [], error: null } });
    assert.equal(calls, 4);
    ipc("message", { channel: "lh:copilot", kind: "state", status: { available: false, connected: false, pending: false, revision: 1, modelIds: [], device: null, error: null } });
    assert.equal(calls, 5);
  } finally { coordinator.recover = originalRecover; }
});