import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	composeInstructions, createPracticeAgent, createProberAgent, createTeacherAgent,
	type AgentBuildOptions, type AgentKind,
} from "../src/agent/teacher-agent.ts";
import { listSourceSegments } from "../src/agent/prompt-segments.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LearnerHistoryContext } from "../src/agent/tools/learner-history.ts";
import { rememberLearnerPreferenceTool } from "../src/agent/tools.ts";
import { formatLearnerMemory, type LearnerMemorySnapshot } from "../src/core/learner-memory.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";

const roles = ["prober", "teacher", "practice"] as const;
const snapshot: LearnerMemorySnapshot = {
	teachingGuide: "Explicit preference: use diagrams.\n" + "Complete guide 😀\n".repeat(1200),
	topics: [{
		id: "fractions", name: "Fractions", rating: 2.5, confidence: 72.5,
		notes: "Can add like denominators; unlike denominators remain unassessed.",
		evidence: [{ chatId: "old", messageId: "answer" }],
	}],
	revision: 7,
};

function fixture() {
	const chat: ChatRecord = {
		id: "old", title: "Fractions lesson", createdAt: "2026-10-25", updatedAt: "2026-10-25",
		messages: [{ id: "answer", role: "user", content: "I add equal denominators.", timestamp: 1 }],
	};
	// Only these read methods may be reached. Construction and preference
	// recording must never access adapters, writes, jobs, or the graph.
	const unexpected = (key: PropertyKey): never => { throw new Error(`Unexpected port access: ${String(key)}`); };
	const chats = new Proxy({} as ChatStore, {
		get: (_target, key) => key === "getChat" ? () => chat
			: key === "listChats" ? () => [{ ...chat, messageCount: 1 }]
				: unexpected(key),
	});
	const graph = new Proxy({} as GraphStore, {
		get: (_target, key) => ["readNodes", "readChains", "readSources"].includes(String(key))
			? () => [] : unexpected(key),
	});
	const jobs = new Proxy({} as JobStore, { get: (_target, key) => unexpected(key) });
	const history: LearnerHistoryContext = { graph, chats };
	const context = {
		chatId: "current", chatStore: chats, jobStore: jobs,
		spawn: () => { throw new Error("Unexpected job dispatch"); },
		deliver: () => { throw new Error("Unexpected probe handoff"); },
	};
	return { context, history };
}

function build(kind: AgentKind, opts: AgentBuildOptions, withHistory = false, withLegacyGraph = false) {
	const { context, history } = fixture();
	const ctx = { ...context, ...(withHistory ? { history } : {}) };
	if (kind === "prober") return createProberAgent({ ...ctx, ...(withLegacyGraph ? { graphStore: history.graph } : {}) }, opts);
	if (kind === "teacher") return createTeacherAgent(ctx, opts);
	return createPracticeAgent({
		...ctx,
		...(withLegacyGraph ? { graph: { graphStore: history.graph, chatStore: history.chats } } : {}),
	}, opts);
}

function mockEngine(responses = [fauxAssistantMessage([fauxText("Ready.")])]) {
	const faux = createFauxCore({});
	faux.setResponses(responses);
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			requests.push(context);
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

describe("conversational learner memory wiring", () => {
	for (const kind of roles) {
		for (const promptSwitches of [undefined, {}]) {
			it(`${kind}: full fresh snapshot follows static instructions (${promptSwitches ? "fresh composition" : "cached composition"})`, async () => {
				const { engine, requests } = mockEngine();
				const agent = build(kind, { engine, learnerMemory: snapshot, promptSwitches });
				const expected = `${composeInstructions(kind, promptSwitches)}\n\n---\n\n${formatLearnerMemory(snapshot)}`;
				assert.equal(agent.state.systemPrompt, expected);
				await agent.prompt("Continue the lesson.");
				assert.equal(requests.length, 1);
				assert.ok(JSON.stringify(requests[0]).includes(JSON.stringify(expected).slice(1, -1)), "actual provider request receives the full prompt");
				const changed = { ...snapshot, teachingGuide: "New explicit preference: use text.", revision: 8 };
				const next = build(kind, { engine, learnerMemory: changed, promptSwitches });
				assert.ok(next.state.systemPrompt.endsWith(formatLearnerMemory(changed)));
				assert.ok(!next.state.systemPrompt.includes("Complete guide"), "no previous request's memory leaks through static cache");
				assert.equal(build(kind, { engine, promptSwitches }).state.systemPrompt, composeInstructions(kind, promptSwitches));
			});
		}

		it(`${kind}: shared doctrine loads through discovery, including practice's allowlist`, () => {
			assert.ok(listSourceSegments(kind).some((segment) => segment.path === "shared/18-learner-memory.md"));
			const prompt = composeInstructions(kind);
			assert.match(prompt, /source documents are already loaded in full/);
			assert.match(prompt, /Graph details and old transcripts are loaded selectively/);
			assert.match(prompt, /Never infer knowledge ratings or mastery merely/);
			assert.match(prompt, /Only when the learner explicitly expresses a teaching preference/);
			assert.match(prompt, /Do not call this tool on every turn/);
		});

		it(`${kind}: preference and both history tools run through the actual agent as normal results`, async () => {
			const preference = "Show diagrams before equations.";
			const { engine, requests } = mockEngine([
				fauxAssistantMessage([
					fauxToolCall("remember_learner_preference", { preference }, { id: "pref" }),
					fauxToolCall("find_learning_history", { query: "Fractions" }, { id: "find" }),
					fauxToolCall("read_learning_history", { chatId: "old", messageIds: ["answer"] }, { id: "read" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("I will use diagrams.")]),
			]);
			const agent = build(kind, { engine, learnerMemory: snapshot }, true);
			assert.ok(!agent.state.tools.some((tool) => tool.name === "list_propositions"), "history does not open the legacy graph gate");
			await agent.prompt(preference);
			const results = agent.state.messages.filter((message) => message.role === "toolResult");
			assert.equal(results.length, 3);
			for (const result of results) assert.equal(result.isError, false);
			assert.equal(results[0]!.toolName, "remember_learner_preference");
			assert.deepEqual(results[0]!.details, { ok: true });
			assert.deepEqual(results[0]!.content, [{ type: "text", text: '{"ok":true}' }]);
			assert.ok(JSON.stringify(results[1]!.details).includes("Fractions lesson"));
			assert.ok(JSON.stringify(results[2]!.details).includes("I add equal denominators."));
			assert.equal(requests.length, 2, "normal preference/history results continue the turn, not a question stop");
			assert.ok(JSON.stringify(agent.state.messages).includes(preference), "call arguments and successful milestone remain in the native transcript");
		});

		it(`${kind}: history is optional and independent of existing graph gates`, () => {
			const { engine } = mockEngine();
			const bare = build(kind, { engine });
			assert.ok(bare.state.tools.some((tool) => tool.name === "remember_learner_preference"));
			assert.ok(!bare.state.tools.some((tool) => tool.name.endsWith("learning_history")));
			if (kind !== "teacher") {
				const graphOnly = build(kind, { engine }, false, true);
				assert.ok(graphOnly.state.tools.some((tool) => tool.name === "list_propositions"));
				assert.ok(!graphOnly.state.tools.some((tool) => tool.name.endsWith("learning_history")));
				const both = build(kind, { engine }, true, true);
				assert.ok(both.state.tools.some((tool) => tool.name === "list_propositions"));
				assert.ok(both.state.tools.some((tool) => tool.name === "find_learning_history"));
			}
		});
	}

	it("the bare mock-driven teacher also carries the preference tool", () => {
		const { engine } = mockEngine();
		assert.ok(createTeacherAgent(undefined, { engine }).state.tools.some((tool) => tool.name === "remember_learner_preference"));
	});

	it("preference schema has only the explicit preference field; success is not a terminating placeholder", async () => {
		assert.deepEqual(Object.keys(rememberLearnerPreferenceTool.parameters.properties), ["preference"]);
		assert.deepEqual(rememberLearnerPreferenceTool.parameters.required, ["preference"]);
		assert.match(rememberLearnerPreferenceTool.description, /only when the learner explicitly expresses it/);
		const result = await rememberLearnerPreferenceTool.execute("pref", { preference: "Use diagrams." });
		assert.deepEqual(result.details, { ok: true });
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, undefined);
	});
});