import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { learnerHistoryTools, type LearnerHistoryContext } from "../src/agent/tools/learner-history.ts";
import type { ChatRecord, ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphNode, GraphChain } from "../src/core/contracts/graph.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const node: GraphNode = { id: "n1", name: "Derivatives", statement: "Rates of change", aliases: ["calculus"], createdAt: "2026-10-25", provenance: [{ chatId: "c1", messageId: "m1" }] };
const call = (id: string, callId = "q"): LhMessage => ({ id, role: "assistant", content: [{ type: "toolCall", id: callId, name: "quiz", arguments: { question: "Why?", correctAnswer: "Teacher key" } }], timestamp: 1 }) as unknown as LhMessage;
const answer = (id: string, callId = "q"): LhMessage => ({ id, role: "toolResult", toolCallId: callId, toolName: "quiz", content: [{ type: "text", text: "compact" }], details: { thinking: "Learner reasoning", readingThinking: "Reading trace", confidence: 0, correct: false, dontKnow: true }, isError: false, timestamp: 2 });

function fixture(messages: LhMessage[] = [call("m1"), answer("m2")], nodes = [node], chains: GraphChain[] = []) {
  const chat: ChatRecord = { id: "c1", title: "Calculus lesson", createdAt: "2026-10-25", updatedAt: "2026-10-25", messages };
  const summaries = [chat, { ...chat, id: "practice", title: "Unextracted practice", kind: "practice" }];
  const readonly = new Proxy({}, { get: (_target, key) => { throw new Error(`Unexpected port access: ${String(key)}`); } });
  const ctx = {
    graph: new Proxy(readonly, { get: (target, key) => key === "readNodes" ? () => nodes : key === "readChains" ? () => chains : key === "readSources" ? () => [{ id: "src_notes", filePath: "/never/open", importedAt: "2026-10-25" }] : Reflect.get(target, key) }),
    chats: new Proxy(readonly, { get: (target, key) => key === "getChat" ? (id: string) => id === chat.id ? chat : null : key === "listChats" ? () => summaries as unknown as ChatSummary[] : Reflect.get(target, key) }),
  } as LearnerHistoryContext;
  return { tools: learnerHistoryTools(ctx), chat };
}

async function invoke(tools: ReturnType<typeof learnerHistoryTools>, name: string, args: object): Promise<any> {
  return (await tools[name]!.execute("test", args)).details;
}

describe("learner history readers", () => {
  it("exports only unique read tools; no adapter reads or writes", () => {
    assert.deepEqual(Object.keys(fixture().tools), ["find_learning_history", "read_learning_history"]);
  });
  it("searches merged aliases and retains full provenance, chains and session pointers", async () => {
    const nodes = [node, { ...node, name: "Not renamed", statement: "Later phrasing", provenance: [{ chatId: "src_notes", messageId: "" }] }];
    const chain: GraphChain = { id: "a1", premises: ["n1", "missing"], conclusion: "n2", provenance: node.provenance, createdAt: node.createdAt };
    const { tools } = fixture(undefined, nodes, [chain]);
    const result = await invoke(tools, "find_learning_history", { query: "CALCULUS" });
    assert.equal(result.total, 4);
    assert.equal(result.items[0].evidence.name, node.name);
    assert.ok(result.items[0].evidence.aliases.includes("Later phrasing"));
    assert.deepEqual(result.items[1].evidence.premises, ["n1", "missing"]);
    assert.equal(result.items[3].source.sourceId, "src_notes");
    assert.match(result.warning, /not mastery/);
  });
  it("discovers sessions without graph contributions and filters later sources", async () => {
    const { tools } = fixture();
    const practice = await invoke(tools, "find_learning_history", { query: "unextracted" });
    assert.equal(practice.items[0].source.chatId, "practice");
    const scoped = await invoke(tools, "find_learning_history", { query: "", nodeId: "n1", chatId: "c1" });
    assert.equal(scoped.items[0].source.nodeId, "n1");
    assert.equal((await invoke(tools, "find_learning_history", { query: "no match" })).total, 0);
  });
  it("returns exact native answer details and the related teacher call", async () => {
    const { tools, chat } = fixture();
    const before = JSON.stringify(chat);
    const result = await invoke(tools, "read_learning_history", { chatId: "c1", messageIds: ["m2"] });
    assert.deepEqual(result.items.map((item: any) => item.evidence), chat.messages);
    assert.equal(result.items[0].source.requested, false);
    assert.equal(result.items[1].source.requested, true);
    assert.equal(JSON.stringify(chat), before);
  });
  it("lists source IDs without exposing message content", async () => {
    const { tools } = fixture();
    const result = await invoke(tools, "read_learning_history", { chatId: "c1" });
    assert.equal(result.items[1].source.messageId, "m2");
    assert.ok(!JSON.stringify(result).includes("Learner reasoning"));
  });
  it("binds repeated tool-call IDs to the nearest preceding occurrence", async () => {
    const { tools } = fixture([call("m1"), answer("m2"), call("m3"), answer("m4")]);
    const result = await invoke(tools, "read_learning_history", { chatId: "c1", messageIds: ["m2"] });
    assert.deepEqual(result.items.map((item: any) => item.source.messageId), ["m1", "m2"]);
    assert.equal(result.unselectedMessageCount, 2);
  });
  it("preserves linked practice traces and failed results", async () => {
    const trace: LhMessage = { id: "trace", role: "custom", customType: "practice-thinking", content: "Attempt", details: { problemCallId: "q", text: "Attempt" }, timestamp: 2, display: true };
    const failure = { ...answer("failed"), isError: true } as LhMessage;
    const { tools } = fixture([call("m1"), trace, failure]);
    const result = await invoke(tools, "read_learning_history", { chatId: "c1", messageIds: ["trace"] });
    assert.equal(result.items.length, 3);
    assert.equal(result.items[2].evidence.isError, true);
  });
  it("does not fabricate a pending answer or imported-notes transcript", async () => {
    const { tools } = fixture([call("pending")]);
    assert.equal((await invoke(tools, "read_learning_history", { chatId: "c1", messageIds: ["pending"] })).total, 1);
    await assert.rejects(invoke(tools, "read_learning_history", { chatId: "src_notes", messageIds: ["m1"] }), /Chat not found/);
    await assert.rejects(invoke(tools, "read_learning_history", { chatId: "c1", messageIds: ["pending", "missing"] }), /Unknown message IDs/);
  });
  it("joins practice conclusions and their results to the posed problem", async () => {
    const problem = call("problem", "p");
    const conclude = call("conclude", "done");
    if (problem.role !== "assistant" || conclude.role !== "assistant") throw new Error("bad fixture");
    for (const block of problem.content) if (block.type === "toolCall") block.name = "problem";
    for (const block of conclude.content) if (block.type === "toolCall") block.name = "conclude";
    const { tools } = fixture([problem, { id: "trace", role: "custom", customType: "practice-thinking", content: "Attempt", details: { problemCallId: "p" }, timestamp: 1, display: true }, conclude, answer("done-result", "done")]);
    const result = await invoke(tools, "read_learning_history", { chatId: "c1", messageIds: ["trace"] });
    assert.deepEqual(result.items.map((item: any) => item.source.messageId), ["problem", "trace", "conclude", "done-result"]);
  });
  it("paginates without silently dropping entries", async () => {
    const { tools } = fixture();
    const first = await invoke(tools, "find_learning_history", { query: "", limit: 1 });
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 1);
    const rest = await invoke(tools, "find_learning_history", { query: "", offset: first.nextOffset });
    assert.equal(rest.truncated, false);
    assert.equal(first.items.length + rest.items.length, first.total);
  });
  it("reassembles huge Unicode/escaped JSON evidence exactly within the explicit estimate cap", async () => {
    const message: LhMessage = { id: "long", role: "user", content: '😀\\"\n'.repeat(4000), timestamp: 1 };
    const { tools } = fixture([message]);
    let offset = 0, characterOffset = 0, json = "";
    for (let attempt = 0; attempt < 500; attempt++) {
      const result = await invoke(tools, "read_learning_history", { chatId: "c1", messageIds: ["long"], maxTokens: 1024, offset, characterOffset });
      assert.ok(JSON.stringify(result).length <= 4096);
      json += result.items[0].jsonFragment;
      if (!result.truncated) break;
      offset = result.nextOffset;
      characterOffset = result.nextCharacterOffset;
    }
    assert.deepEqual(JSON.parse(json).evidence, message);
  });
  it("rejects invalid pagination instead of silently clamping", async () => {
    const { tools } = fixture();
    await assert.rejects(invoke(tools, "find_learning_history", { query: "", offset: -1 }), /pagination/);
    await assert.rejects(invoke(tools, "find_learning_history", { query: "", characterOffset: 999999 }), /exceeds/);
  });
});