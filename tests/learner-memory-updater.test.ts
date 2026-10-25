import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ChatRecord, JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { concludedByDismissalPair, newAnswerResult, newThinkingMessage, newUserMessage } from "../src/core/native-messages.ts";
import { CONCLUDE_ACK_TEXT } from "../src/core/contracts/chat.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { createLearnerMemoryStore } from "../src/store/learner-memory.ts";
import {
	applyLearnerMemoryPatch, runLearnerMemoryUpdater, validateLearnerMemoryPatch,
	type LearnerMemoryPatch, type LearnerMemoryUpdateInput,
} from "../src/agent/subagents/learner-memory.ts";
import {
	createLearnerMemoryCoordinator, detectLearnerMemoryMilestones,
	LEARNER_MEMORY_PREFERENCE_TOOL, learnerMemoryMilestoneId,
	type LearnerMemoryCoordinatorDeps,
} from "../src/server/learner-memory.ts";

function call(name: string, id = name, args: unknown = {}): LhMessage {
	return { id: `call-message-${id}`, role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE MODEL REASONING", thinkingSignature: "private" }, { type: "toolCall", id, name, arguments: args }], timestamp: 1 } as LhMessage;
}
function result(name: string, id = name, details: unknown = { ok: true }, isError = false): LhMessage {
	return { id: `result-${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: name === "conclude" ? CONCLUDE_ACK_TEXT : JSON.stringify(details) }], details, isError, timestamp: 2 } as LhMessage;
}
function answer(name = "quiz", id = name): LhMessage {
	const value = newAnswerResult(id, name, { kind: name === "quiz" ? "quiz" : "explain", questionText: "Why?", dontKnow: false, text: "Because of conservation", answers: [], answeredAt: "2026-10-25" });
	return { ...value, id: `answer-${id}` };
}
const emptyPatch: LearnerMemoryPatch = { teachingGuide: [], topics: [] };
const unusedEngine = {} as PiEngine;

/** Files survive coordinator and port re-creation; no production singleton,
 * provider, teacher callback, chat creation or turn runner is involved. */
function fixture(activate = true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-worker-"));
	const chats = new Map<string, ChatRecord>();
	let sequence = 0;
	let clock = 1_000;
	const coordinators: ReturnType<typeof createLearnerMemoryCoordinator>[] = [];
	const chatStore = {
		getChat: (id: string) => chats.get(id) ?? null,
		listChats: () => [...chats.values()],
		createChat: () => { throw new Error("Worker must never create a conversation"); },
	} as unknown as ChatStore;
	const filename = (id: string) => path.join(root, `${id}.json`);
	const makeJobs = (): JobStore => {
		const getJob = (id: string): JobRecord | null => fs.existsSync(filename(id)) ? JSON.parse(fs.readFileSync(filename(id), "utf8")) : null;
		const listJobs = (chatId: string): JobRecord[] => fs.readdirSync(root).filter((f) => f.endsWith(".json")).map((f) => getJob(f.slice(0, -5))!).filter((job) => job.chatId === chatId);
		return {
			createJob(init) {
				const job: JobRecord = { ...init, id: `job_${++sequence}`, status: "running", activity: init.activity ?? "starting", createdAt: "now", updatedAt: "now" };
				fs.writeFileSync(filename(job.id), JSON.stringify(job)); return job;
			},
			getJob,
			updateJob(id, patch) { const job = getJob(id); if (!job) return null; const next = { ...job, ...patch }; fs.writeFileSync(filename(id), JSON.stringify(next)); return next; },
			listJobs,
			findJobByToolCallId: (chatId, id) => listJobs(chatId).find((j) => j.toolCallId === id) ?? null,
			deleteJobsForChat(chatId) { const jobs = listJobs(chatId); for (const job of jobs) fs.unlinkSync(filename(job.id)); return jobs.length; },
		};
	};
	const jobStore = makeJobs();
	const memoryStore = createLearnerMemoryStore(path.join(root, "memory"));
	function coordinator(overrides: Partial<LearnerMemoryCoordinatorDeps> = {}) {
		const worker = createLearnerMemoryCoordinator({ chatStore, jobStore, memoryStore, memoryDirectory: path.join(root, "memory"), resolveEngine: () => unusedEngine,
			runUpdater: async () => emptyPatch, autoRun: false, now: () => clock, retryDelaysMs: [100, 200], ...overrides });
		coordinators.push(worker); return worker;
	}
	function chat(id = "chat-a", messages: LhMessage[] = [newUserMessage("I prefer diagrams"), call("probe_done"), result("probe_done")], kind?: "practice") {
		const record = { id, title: id, messages, kind } as ChatRecord;
		chats.set(id, record); return record;
	}
	if (activate) coordinator().activate();
	return { root, chats, chat, chatStore, jobStore, makeJobs, memoryStore, coordinator,
		advance: (ms = 1_000) => { clock += ms; },
		cleanup: () => { for (const c of coordinators) c.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("milestones require actual successful completions; never teacher poses, prose or skips", () => {
	assert.deepEqual(detectLearnerMemoryMilestones([call("quiz"), call("probe_done"), call("conclude")], "practice"), []);
	assert.deepEqual(detectLearnerMemoryMilestones([call("probe_done"), result("probe_done", "probe_done", { ok: false }), call("explain"), result("explain", "explain", { kind: "explain", dismissed: true, answeredAt: "now" })]), []);
	assert.deepEqual(detectLearnerMemoryMilestones([call("quiz"), result("quiz", "quiz", null)]), [], "question-posed placeholder isn't an answer");
	assert.deepEqual(detectLearnerMemoryMilestones([call("probe_done"), result("probe_done", "probe_done", { ok: true }, true)]), []);
	assert.deepEqual(detectLearnerMemoryMilestones([result("probe_done")]), [], "orphan result isn't a milestone");
	assert.deepEqual(detectLearnerMemoryMilestones([call("conclude", "skip", { outcome: "dismissed" }), result("conclude", "skip", null)], "practice"), [], "synthetic dismissed conclude ack is not successful practice");
	assert.deepEqual(detectLearnerMemoryMilestones(concludedByDismissalPair("problem"), "practice"), []);
	const messages = [call("probe_done"), result("probe_done"), call("quiz"), answer("quiz"), call("recall"), answer("recall"), call("explain"), answer("explain"), call("conclude"), result("conclude", "conclude", null), call(LEARNER_MEMORY_PREFERENCE_TOOL), result(LEARNER_MEMORY_PREFERENCE_TOOL)];
	assert.deepEqual(detectLearnerMemoryMilestones(messages, "practice").map((m) => m.kind), ["probe", "answer", "answer", "answer", "practice", "preference"]);
	assert.equal(detectLearnerMemoryMilestones(messages).some((m) => m.kind === "practice"), false);
	assert.equal(detectLearnerMemoryMilestones([...messages, result("probe_done")], "practice").length, 6, "duplicate results dedupe by call");
});

test("scan durably queues once; run and recover don't create chats, messages, or teacher wakes", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); const original = JSON.stringify(chat.messages); let calls = 0;
		const worker = f.coordinator({ runUpdater: async () => { calls++; return emptyPatch; } });
		worker.scan(chat.id); worker.scan(chat.id);
		assert.equal(worker.status(chat.id).length, 1);
		const job = worker.status(chat.id)[0]!;
		assert.match(job.toolCallId, /^memory_[a-f0-9]{64}$/);
		await Promise.all([worker.run(job.id), worker.run(job.id)]);
		assert.equal(calls, 1); assert.equal(worker.status(chat.id)[0]!.status, "done");
		worker.dispose();
		await f.coordinator({ jobStore: f.makeJobs(), runUpdater: async () => { throw new Error("must not rerun completed milestone"); } }).recover();
		assert.equal(JSON.stringify(chat.messages), original); assert.equal(f.chats.size, 1);
	} finally { f.cleanup(); }
});

test("recovery scans durable messages and repairs persist→enqueue and create→descriptor gaps", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); let calls = 0;
		const milestone = detectLearnerMemoryMilestones(chat.messages)[0]!;
		f.jobStore.createJob({ kind: "memory" as JobRecord["kind"], chatId: chat.id, toolCallId: learnerMemoryMilestoneId(chat.id, milestone) });
		const worker = f.coordinator({ jobStore: f.makeJobs(), runUpdater: async () => { calls++; return emptyPatch; } });
		await worker.recover(); assert.equal(calls, 1); assert.equal(worker.status(chat.id).length, 1);
		f.chat("chat-b"); await worker.recover(); assert.equal(calls, 2);
	} finally { f.cleanup(); }
});

test("global read/model/commit serialization spans coordinator instances and sessions", async () => {
	const f = fixture();
	try {
		f.chat("a"); f.chat("b"); let active = 0; let max = 0;
		const revisions: number[] = [];
		const updater: LearnerMemoryCoordinatorDeps["runUpdater"] = async (input) => {
			active++; max = Math.max(max, active); revisions.push(input.memory.revision);
			await new Promise<void>((resolve) => setImmediate(resolve)); active--;
			return { teachingGuide: [], topics: [{ id: input.chatId, name: input.chatId, rating: 2.5, evidence: [{ chatId: input.chatId, messageId: input.evidence[0]!.messageId }] }] };
		};
		const a = f.coordinator({ runUpdater: updater }); const b = f.coordinator({ runUpdater: updater });
		a.scan("a"); b.scan("b");
		await Promise.all([a.run(a.status("a")[0]!.id), b.run(b.status("b")[0]!.id)]);
		assert.equal(max, 1); assert.deepEqual(revisions, [0, 1]);
		assert.deepEqual((await f.memoryStore.read()).topics.map((t) => t.id), ["a", "b"]);
	} finally { f.cleanup(); }
});

test("all learner evidence since processed milestone, paired question context, no provider reasoning", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); const seen: LearnerMemoryUpdateInput[] = [];
		const worker = f.coordinator({ runUpdater: async (input) => { seen.push(input); return emptyPatch; } });
		worker.scan(chat.id); await worker.run(worker.status(chat.id)[0]!.id);
		const reading = newUserMessage("My working: conservation of energy");
		chat.messages.push(call("quiz", "q", { question: "What is conserved?", explanation: "Teacher explanation" }), reading, answer("quiz", "q"));
		worker.scan(chat.id); await worker.run(worker.status(chat.id).find((j) => j.status === "running")!.id);
		assert.ok(seen[1]);
		assert.deepEqual(seen[1].evidence.map((e) => e.messageId), [reading.id, "answer-q"]);
		assert.match(JSON.stringify(seen[1].context), /What is conserved/);
		assert.doesNotMatch(JSON.stringify(seen), /PRIVATE MODEL REASONING|thinkingSignature/);
		assert.doesNotMatch(JSON.stringify(seen[1].evidence), /Teacher explanation/);
	} finally { f.cleanup(); }
});

test("practice thinking and explicit preference use durable milestones, not mere poses", async () => {
	const f = fixture();
	try {
		const thinking = newThinkingMessage("p", "I factored out x");
		const chat = f.chat("practice", [newUserMessage("Help"), call("problem", "p"), result("problem", "p", null), thinking], "practice");
		const inputs: LearnerMemoryUpdateInput[] = [];
		const worker = f.coordinator({ runUpdater: async (input) => { inputs.push(input); return emptyPatch; } });
		worker.scan(chat.id); assert.equal(worker.status(chat.id).length, 0);
		chat.messages.push(call("conclude"), result("conclude", "conclude", null));
		worker.scan(chat.id); await worker.run(worker.status(chat.id)[0]!.id);
		assert.ok(inputs[0]!.evidence.some((e) => e.kind === "practice-thinking" && e.messageId === thinking.id));
		chat.messages.push(newUserMessage("Prefer short examples"), call(LEARNER_MEMORY_PREFERENCE_TOOL, "pref", { preference: "Short examples" }), result(LEARNER_MEMORY_PREFERENCE_TOOL, "pref"));
		worker.notifyPreference(chat.id); await worker.run(worker.status(chat.id).find((j) => j.status === "running")!.id);
		assert.equal(inputs[1]!.milestone.kind, "preference");
	} finally { f.cleanup(); }
});

test("transient failures retry at persisted deadlines, max three model calls across restarts", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); let calls = 0;
		const runUpdater = async () => { calls++; throw Object.assign(new Error("rate limited"), { status: 429 }); };
		const first = f.coordinator({ runUpdater }); first.scan(chat.id); const id = first.status(chat.id)[0]!.id;
		await first.run(id); await first.run(id); assert.equal(calls, 1);
		first.dispose(); const second = f.coordinator({ jobStore: f.makeJobs(), runUpdater });
		await second.recover(); assert.equal(calls, 1);
		f.advance(100); await second.run(id); assert.equal(calls, 2);
		f.advance(199); await second.run(id); assert.equal(calls, 2);
		f.advance(1); await second.run(id); assert.equal(calls, 3);
		assert.equal(second.status(chat.id)[0]!.status, "error");
		f.advance(); await second.recover(); assert.equal(calls, 3);
	} finally { f.cleanup(); }
});

test("invalid structured output is terminal, never retried or committed", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); let calls = 0;
		const worker = f.coordinator({ runUpdater: async () => { calls++; return { teachingGuide: [], topics: [{ id: "x", name: "X", rating: 9, evidence: [] }] }; } });
		worker.scan(chat.id); await worker.recover(); await worker.recover();
		assert.equal(calls, 1); assert.equal(worker.status(chat.id)[0]!.status, "error"); assert.equal((await f.memoryStore.read()).revision, 0);
	} finally { f.cleanup(); }
});

test("missing model/key defers without spending attempt budget; explicit recovery resumes", async () => {
	for (const missing of [new ModelsNotConfiguredError(["cheap"]), new ProviderKeyMissingError("openrouter", ["cheap"])]) {
		const f = fixture();
		try {
			const chat = f.chat(); let configured = false; let calls = 0;
			const worker = f.coordinator({ resolveEngine: () => { if (!configured) throw missing; return unusedEngine; }, runUpdater: async () => { calls++; return emptyPatch; } });
			worker.scan(chat.id); const id = worker.status(chat.id)[0]!.id; await worker.run(id);
			const job = worker.status(chat.id)[0]!; assert.equal(job.status, "running");
			assert.equal((job.result as { state: string }).state, "deferred"); assert.equal((job.result as { attempts: number }).attempts, 0); assert.equal(calls, 0);
			configured = true; await worker.recover(); assert.equal(calls, 1); assert.equal(worker.status(chat.id)[0]!.status, "done");
		} finally { f.cleanup(); }
	}
});

test("money channel persists every model call, including failed runs and retries", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); let calls = 0;
		const worker = f.coordinator({ runUpdater: async (_input, options) => {
			calls++; options.onUsage?.({ input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, "test:model");
			if (calls === 1) throw Object.assign(new Error("unavailable"), { status: 503 }); return emptyPatch;
		} });
		worker.scan(chat.id); const id = worker.status(chat.id)[0]!.id;
		await worker.run(id); f.advance(); await worker.run(id);
		const usage = worker.status(chat.id)[0]!.usage!;
		assert.equal(usage.steps, 2); assert.equal(usage.inputTokens, 20); assert.equal(usage.outputTokens, 6); assert.equal(usage.model, "test:model");
	} finally { f.cleanup(); }
});

test("write-ahead commit recovery doesn't rerun model or append the guide twice", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); let crash = true; let calls = 0;
		const jobs: JobStore = { ...f.jobStore, updateJob(id, patch) {
			if (crash && patch.status === "done") { crash = false; throw new Error("simulated completion write failure"); }
			return f.jobStore.updateJob(id, patch);
		} };
		const worker = f.coordinator({ jobStore: jobs, runUpdater: async () => { calls++; return { teachingGuide: [{ before: "", after: "Use diagrams." }], topics: [] }; } });
		worker.scan(chat.id); const id = worker.status(chat.id)[0]!.id; await worker.run(id);
		// A process crash would leave committing/running. Restore that durable
		// pre-completion state rather than the caught in-process terminal failure.
		const saved = f.jobStore.getJob(id)!;
		f.jobStore.updateJob(id, { status: "running", result: { ...(saved.result as object), state: "committing" } });
		worker.dispose(); await f.coordinator({ jobStore: f.makeJobs(), runUpdater: async () => { throw new Error("must not rerun committed patch"); } }).recover();
		assert.equal(calls, 1); assert.equal((await f.memoryStore.read()).teachingGuide, "Use diagrams."); assert.equal((await f.memoryStore.read()).revision, 1);
		assert.equal(f.jobStore.getJob(id)!.status, "done");
	} finally { f.cleanup(); }
});

test("independent edits cause CAS re-read/reasoning, preserving unrelated memory", async () => {
	const f = fixture();
	try {
		const chat = f.chat(); let calls = 0;
		const worker = f.coordinator({ runUpdater: async () => {
			if (++calls === 1) { const current = await f.memoryStore.read(); await f.memoryStore.commit({ ...current, teachingGuide: "Manual preference." }, current.revision); }
			return { teachingGuide: [{ before: "", after: "Use diagrams." }], topics: [] };
		} });
		worker.scan(chat.id); const id = worker.status(chat.id)[0]!.id; await worker.run(id);
		f.advance(); await worker.run(id); assert.equal(calls, 2);
		assert.equal((await f.memoryStore.read()).teachingGuide, "Manual preference.\nUse diagrams.");
	} finally { f.cleanup(); }
});

test("deleted session or removed job during a model call cannot recreate evidence", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		const worker = f.coordinator({ runUpdater: async () => { f.chats.delete(chat.id); f.jobStore.deleteJobsForChat(chat.id); return { teachingGuide: [{ before: "", after: "Stale" }], topics: [] }; } });
		worker.scan(chat.id); await worker.run(worker.status(chat.id)[0]!.id);
		assert.equal((await f.memoryStore.read()).revision, 0); assert.equal(worker.status(chat.id).length, 0);
	} finally { f.cleanup(); }
});

test("first activation ignores history and recovery retains post-cutover crash gaps", async () => {
	const f = fixture(false);
	try {
		const chat = f.chat();
		const worker = f.coordinator();
		await worker.recover();
		assert.equal(worker.status(chat.id).length, 0);
		worker.dispose();
		const fresh = newUserMessage("New learning after activation");
		chat.messages.push(fresh, call("quiz", "new"), answer("quiz", "new"));
		const inputs: LearnerMemoryUpdateInput[] = [];
		const restarted = f.coordinator({ jobStore: f.makeJobs(), runUpdater: async (input) => { inputs.push(input); return emptyPatch; } });
		await restarted.recover();
		assert.equal(inputs.length, 1);
		assert.deepEqual(inputs[0]!.evidence.map((e) => e.messageId), [fresh.id, "answer-new"]);
		assert.equal(restarted.status(chat.id).length, 1);
		assert.equal(restarted.status(chat.id)[0]!.status, "done");
	} finally { f.cleanup(); }
});

test("activation excludes old evidence even when no old milestone existed", async () => {
	const f = fixture(false);
	try {
		const chat = f.chat("old", [newUserMessage("Historical learner text"), call("probe_done")]);
		const inputs: LearnerMemoryUpdateInput[] = [];
		const worker = f.coordinator({ runUpdater: async (input) => { inputs.push(input); return emptyPatch; } });
		worker.activate();
		chat.messages.push(result("probe_done"));
		await worker.recover();
		assert.equal(inputs.length, 1);
		assert.deepEqual(inputs[0]!.evidence, []);
	} finally { f.cleanup(); }
});

test("cancelJob aborts the updater signal, remains terminal, never commits or reruns", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		let signal: AbortSignal | undefined;
		const worker = f.coordinator({ runUpdater: async (_input, options) => {
			signal = options.signal;
			started();
			await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
			return { teachingGuide: [{ before: "", after: "Must not commit" }], topics: [] };
		} });
		worker.scan(chat.id);
		const id = worker.status(chat.id)[0]!.id;
		const run = worker.run(id);
		await ready;
		assert.equal(worker.cancelJob(id), true);
		assert.equal(signal!.aborted, true);
		await run;
		await worker.recover();
		assert.equal(worker.status(chat.id)[0]!.status, "error");
		assert.equal((await f.memoryStore.read()).revision, 0);
	} finally { f.cleanup(); }
});

test("deletion preserves learned memory, removes only session references, and survives restart", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		await f.memoryStore.commit({ revision: 0, teachingGuide: "Keep preference", topics: [{ id: "t", name: "Topic", rating: 3, evidence: [{ chatId: chat.id, messageId: "m" }, { chatId: "other", messageId: "n" }] }] }, 0);
		const worker = f.coordinator();
		worker.scan(chat.id);
		await worker.deleteSession(chat.id);
		// Even before the owning composition removes the chat, it cannot requeue.
		worker.scan(chat.id);
		assert.equal(worker.status(chat.id)[0]!.status, "error");
		f.chats.delete(chat.id); f.jobStore.deleteJobsForChat(chat.id);
		worker.dispose();
		await f.coordinator().recover();
		const memory = await f.memoryStore.read();
		assert.equal(memory.teachingGuide, "Keep preference");
		assert.equal(memory.topics[0]!.rating, 3);
		assert.deepEqual(memory.topics[0]!.evidence, [{ chatId: "other", messageId: "n" }]);
	} finally { f.cleanup(); }
});

test("deletion racing an updater kills spend and cannot resurrect references", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		const worker = f.coordinator({ runUpdater: async (input, options) => {
			started();
			await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
			return { teachingGuide: [], topics: [{ id: "t", name: "Topic", rating: 3, evidence: [{ chatId: chat.id, messageId: input.evidence[0]!.messageId }] }] };
		} });
		worker.scan(chat.id);
		const run = worker.run(worker.status(chat.id)[0]!.id);
		await ready;
		await worker.deleteSession(chat.id);
		await run;
		assert.deepEqual((await f.memoryStore.read()).topics, []);
	} finally { f.cleanup(); }
});

test("deletion waits behind an in-flight commit then removes its references without erasing learning", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		let started!: () => void; let release!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const memoryStore = { ...f.memoryStore, async commit(...args: Parameters<typeof f.memoryStore.commit>) {
			started(); await gate; return f.memoryStore.commit(...args);
		} };
		const worker = f.coordinator({ memoryStore, runUpdater: async (input) => ({ teachingGuide: [{ before: "", after: "Keep learning" }], topics: [{ id: "t", name: "Topic", rating: 3, evidence: [{ chatId: chat.id, messageId: input.evidence[0]!.messageId }] }] }) });
		worker.scan(chat.id);
		const id = worker.status(chat.id)[0]!.id;
		const running = worker.run(id);
		await ready;
		const deleting = worker.deleteSession(chat.id);
		release();
		await Promise.all([running, deleting]);
		const memory = await f.memoryStore.read();
		assert.equal(memory.teachingGuide, "Keep learning");
		assert.deepEqual(memory.topics[0]!.evidence, []);
		assert.equal(worker.status(chat.id)[0]!.status, "error");
	} finally { f.cleanup(); }
});

test("durable deletion tombstone repairs a crash before reference cleanup", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		await f.memoryStore.commit({ revision: 0, teachingGuide: "Keep", topics: [{ id: "t", name: "Topic", rating: 3, evidence: [{ chatId: chat.id, messageId: "m" }] }] }, 0);
		// A hard process crash does not execute deleteSession's catch/rollback.
		const activationFile = path.join(f.root, "memory", ".learner-memory.activation.json");
		const activation = JSON.parse(fs.readFileSync(activationFile, "utf8"));
		activation.deleted.push(chat.id);
		fs.writeFileSync(activationFile, JSON.stringify(activation));
		f.chats.delete(chat.id); f.jobStore.deleteJobsForChat(chat.id);
		await f.coordinator().recover();
		const memory = await f.memoryStore.read();
		assert.equal(memory.teachingGuide, "Keep");
		assert.deepEqual(memory.topics[0]!.evidence, []);
	} finally { f.cleanup(); }
});

test("recovery globally orders deferred milestones by source time/index, not job or session activity", async () => {
	const f = fixture();
	try {
		const a = f.chat("a", [call("probe_done", "a1"), result("probe_done", "a1"), call("probe_done", "a2"), result("probe_done", "a2"), call("probe_done", "a3"), result("probe_done", "a3")]);
		const b = f.chat("b", [call("probe_done", "b1"), result("probe_done", "b1")]);
		a.messages.forEach((m, i) => { m.timestamp = i < 2 ? 100 : 300; });
		b.messages.forEach((m) => { m.timestamp = 200; });
		const chatStore = { ...f.chatStore, listChats: () => [b, a] } as unknown as ChatStore;
		const jobStore = { ...f.jobStore, listJobs: (id: string) => f.jobStore.listJobs(id).reverse() };
		const deferred = f.coordinator({ chatStore, jobStore, resolveEngine: () => { throw new ModelsNotConfiguredError(["cheap"]); } });
		await deferred.recover();
		for (const chat of [a, b]) for (const job of deferred.status(chat.id)) assert.equal((job.result as { state: string }).state, "deferred");
		deferred.dispose();
		// Include a persist→enqueue gap and autoRun: scan must not jump the queue.
		b.messages.push({ ...call("probe_done", "b2"), timestamp: 400 }, { ...result("probe_done", "b2"), timestamp: 400 });
		const seen: string[] = [];
		const worker = f.coordinator({ chatStore, jobStore, autoRun: true, runUpdater: async (input) => { seen.push(input.milestone.messageId); return emptyPatch; } });
		await worker.recover();
		assert.deepEqual(seen, ["result-a1", "result-b1", "result-a2", "result-a3", "result-b2"]);
		await worker.recover();
		assert.equal(seen.length, 5);
	} finally { f.cleanup(); }
});

test("failed reference cleanup rolls back deletion durably without repeating canceled milestones", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		const worker = f.coordinator({ memoryStore: { ...f.memoryStore, removeSessionReferences: async () => { throw new Error("cleanup failed"); } } });
		worker.scan(chat.id);
		await assert.rejects(worker.deleteSession(chat.id), /cleanup failed/);
		assert.equal(worker.status(chat.id)[0]!.status, "error");
		worker.dispose();
		let calls = 0;
		const restarted = f.coordinator({ runUpdater: async () => { calls++; return emptyPatch; } });
		await restarted.recover();
		assert.equal(calls, 0);
		chat.messages.push(call("probe_done", "future"), result("probe_done", "future"));
		await restarted.recover();
		assert.equal(calls, 1);
	} finally { f.cleanup(); }
});

test("owning chat deletion failure can restore after job removal, preserving learning and future eligibility", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		await f.memoryStore.commit({ revision: 0, teachingGuide: "Keep", topics: [{ id: "t", name: "Topic", rating: 3, evidence: [{ chatId: chat.id, messageId: "m" }] }] }, 0);
		let calls = 0;
		const worker = f.coordinator({ runUpdater: async () => { calls++; return emptyPatch; } });
		worker.scan(chat.id);
		await worker.deleteSession(chat.id);
		f.jobStore.deleteJobsForChat(chat.id);
		await worker.cancelDeletion(chat.id);
		await worker.restoreSession(chat.id); // Idempotent alias; no new baseline cutover.
		await worker.recover();
		assert.equal(calls, 0);
		assert.equal(worker.status(chat.id).length, 0);
		const memory = await f.memoryStore.read();
		assert.equal(memory.teachingGuide, "Keep");
		assert.deepEqual(memory.topics[0]!.evidence, []);
		chat.messages.push(call("probe_done", "future"), result("probe_done", "future"));
		await worker.recover();
		assert.equal(calls, 1);
		await worker.deleteSession(chat.id);
		f.chats.delete(chat.id);
		await worker.restoreSession(chat.id);
		const activation = JSON.parse(fs.readFileSync(path.join(f.root, "memory", ".learner-memory.activation.json"), "utf8"));
		assert.ok(activation.deleted.includes(chat.id), "missing session must stay tombstoned");
	} finally { f.cleanup(); }
});

test("rollback waits for deletion and an in-flight commit before enabling future work", async () => {
	const f = fixture();
	try {
		const chat = f.chat();
		let started!: () => void; let release!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const worker = f.coordinator({ memoryStore: { ...f.memoryStore, async commit(...args: Parameters<typeof f.memoryStore.commit>) { started(); await gate; return f.memoryStore.commit(...args); } },
			runUpdater: async (input) => ({ teachingGuide: [], topics: [{ id: "t", name: "Topic", rating: 3, evidence: [{ chatId: chat.id, messageId: input.evidence[0]!.messageId }] }] }) });
		worker.scan(chat.id);
		const running = worker.run(worker.status(chat.id)[0]!.id);
		await ready;
		const deleting = worker.deleteSession(chat.id);
		const restoring = worker.restoreSession(chat.id);
		release();
		await Promise.all([running, deleting, restoring]);
		assert.deepEqual((await f.memoryStore.read()).topics[0]!.evidence, []);
		assert.equal(worker.status(chat.id)[0]!.status, "error");
		await worker.recover();
		assert.deepEqual((await f.memoryStore.read()).topics[0]!.evidence, []);
	} finally { f.cleanup(); }
});

test("patch validation rejects forged/model citations, malformed fields, duplicate topics; preserves unrelated data", () => {
	const input: LearnerMemoryUpdateInput = { chatId: "c", milestone: { messageId: "a", kind: "answer" }, memory: { revision: 0, teachingGuide: "Keep this.", topics: [{ id: "unrelated", name: "Unrelated", rating: 4, evidence: [] }] }, evidence: [{ messageId: "learner", kind: "learner", value: "hello" }], context: [] };
	const topic = { id: "t", name: "Topic", rating: 2.25, confidence: 70, evidence: [{ chatId: "c", messageId: "learner" }] };
	assert.throws(() => validateLearnerMemoryPatch({ teachingGuide: [], topics: [{ ...topic, evidence: [{ chatId: "c", messageId: "teacher" }] }] }, input), /non-learner evidence/);
	assert.throws(() => validateLearnerMemoryPatch({ teachingGuide: [], topics: [topic, topic] }, input), /duplicate/);
	assert.throws(() => validateLearnerMemoryPatch({ teachingGuide: [], topics: [], extra: true }, input), /fields/);
	assert.throws(() => validateLearnerMemoryPatch({ teachingGuide: [], topics: [{ ...topic, confidence: 100 }] }, input), /confidence/);
	const patch = validateLearnerMemoryPatch({ teachingGuide: [{ before: "", after: "Add this." }], topics: [topic] }, input);
	const after = applyLearnerMemoryPatch(input.memory, patch);
	assert.equal(after.teachingGuide, "Keep this.\nAdd this."); assert.equal(after.topics[0]!.id, "unrelated");
	assert.deepEqual(applyLearnerMemoryPatch(after, patch), after);
	assert.throws(() => applyLearnerMemoryPatch(input.memory, { teachingGuide: [{ before: "missing", after: "new" }], topics: [] }), /no longer matches/);
});

test("real submit-agent seam accepts structured patch with faux engine, no live provider", async () => {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_learner_memory", { ...emptyPatch }, { id: "submit" })], { stopReason: "toolUse" })]);
	let steps = 0;
	const input: LearnerMemoryUpdateInput = { chatId: "c", milestone: { messageId: "m", kind: "probe" }, memory: { teachingGuide: "", topics: [], revision: 0 }, evidence: [], context: [] };
	assert.deepEqual(await runLearnerMemoryUpdater(input, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, onUsage: () => { steps++; } }), emptyPatch);
	assert.equal(steps, 1);
});