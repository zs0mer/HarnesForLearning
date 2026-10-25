import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runLearnerMemoryUpdater, type LearnerMemoryUpdateInput } from "../src/agent/subagents/learner-memory.ts";
import type { PiEngine } from "../src/agent/models.ts";

const input: LearnerMemoryUpdateInput = {
	chatId: "c", milestone: { messageId: "m", kind: "assessment" },
	memory: { teachingGuide: "", topics: [], revision: 0 }, evidence: [], context: [],
};
const patch = { teachingGuide: [], topics: [] };

it("updater sends all six exact rubric anchors and accepts omitted cancellation", async () => {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_learner_memory", patch)], { stopReason: "toolUse" })]);
	let prompt = "";
	let steps = 0;
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			prompt = JSON.stringify(context);
			return faux.streamSimple(model, context, options);
		},
	};
	assert.deepEqual(await runLearnerMemoryUpdater(input, { engine, onUsage: () => { steps++; } }), patch);
	for (const anchor of [
		"0: Evidence indicates the learner is not aware of the topic at all.",
		"1: Recognizes the topic or knows that this body of knowledge exists.",
		"2: Has encountered its content and can independently reconstruct some steps.",
		"3: Can retrieve some content from memory and reason out additional portions.",
		"4: Can recall or independently derive nearly all of the material.",
		"5: Has achieved mastery of the material.",
	]) assert.ok(prompt.includes(anchor), anchor);
	assert.ok(prompt.includes("Intermediate values express partial attainment rather than rounding"));
	assert.equal(steps, 1);
});

it("updater cancellation reaches the shared runner and provider signal", async () => {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_learner_memory", patch)], { stopReason: "toolUse" })]);
	const controller = new AbortController();
	let providerSignal: AbortSignal | undefined;
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			providerSignal = options?.signal;
			controller.abort();
			return faux.streamSimple(model, context, options);
		},
	};
	await assert.rejects(runLearnerMemoryUpdater(input, { engine, signal: controller.signal }), { name: "AbortError" });
	assert.equal(providerSignal?.aborted, true);
});