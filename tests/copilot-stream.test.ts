import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { copilotConnected, copilotController, refreshCopilotConnection } from "../src/agent/copilot-bridge.ts";
import { modelCatalog, validateModelsSettings } from "../src/server/model-catalog.ts";
import { providerKeyPresent } from "../src/server/keys.ts";
import { callCost, sessionCost, turnCost } from "../src/core/prices.ts";
import { graphCostSummary } from "../src/core/cost-summary.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const originalEnv = process.env.COPILOT_GITHUB_TOKEN;
const ipc = (value: unknown) => (process.emit as (event: string, value: unknown) => boolean)("message", value);
const model = piModels().getModels("github-copilot").find((m) => m.api === "openai-responses")!;
let revision = 1; let connected = true; let leaseFailure = false;
const status = () => ({ available: true, connected, pending: false, revision, modelIds: [model.id], device: null, error: null });
before(async () => {
	assert.ok(model);
	process.env.COPILOT_GITHUB_TOKEN = "ambient-must-not-be-used";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, cb?: () => void) => {
		if (message.channel !== "lh:copilot") { cb?.(); return true; }
		queueMicrotask(() => ipc({ channel: "lh:copilot", id: message.id, op: message.op, ...(message.op === "lease" && leaseFailure ? { ok: false, error: "Authorization failed" } : { ok: true, value: message.op === "status" ? status() : { revision, auth: { apiKey: "leased-copilot-only", baseUrl: "https://api.individual.githubcopilot.com" } } }) }));
		cb?.(); return true;
	} });
	await refreshCopilotConnection();
});
after(() => {
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	if (originalEnv === undefined) delete process.env.COPILOT_GITHUB_TOKEN; else process.env.COPILOT_GITHUB_TOKEN = originalEnv;
});
const context = () => normalizeContext({ messages: [{ role: "user", content: "Explain gravity", timestamp: 1 }] });

test("Copilot readiness and catalog use only the account-available model intersection", () => {
	assert.equal(copilotConnected(), true); assert.equal(providerKeyPresent("github-copilot"), true);
	const catalog = modelCatalog();
	assert.deepEqual(catalog.models.filter((m) => m.provider === "github-copilot").map((m) => m.id), [model.id]);
	assert.equal(validateModelsSettings({ strong: { model: { provider: "github-copilot", id: "unavailable" } } }).ok, false);
	assert.equal(validateModelsSettings({ strong: { model: { provider: "github-copilot", id: model.id } } }).ok, true);
});

test("native transport uses leased OAuth, Copilot identity, and its account endpoint", async () => {
	const engine = piEngineForSpec({ provider: "github-copilot", id: model.id });
	const requests: Request[] = [];
	const result = await engine.streamFn(engine.model, context(), { fetch: async (input, init) => {
		requests.push(new Request(input, init));
		return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "test-response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	} }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.provider, "github-copilot");
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.headers.get("authorization"), "Bearer leased-copilot-only");
	for (const name of ["Editor-Version", "Editor-Plugin-Version", "Copilot-Integration-Id", "User-Agent"]) assert.equal(requests[0]!.headers.get(name), new Headers(model.headers).get(name), name);
	assert.equal(new URL(requests[0]!.url).origin, "https://api.individual.githubcopilot.com");
	assert.equal(result.usage.cost.total, 0);
});

test("auth failures never dispatch with ambient tokens or caller overrides", async () => {
	const engine = piEngineForSpec({ provider: "github-copilot", id: model.id }); let requests = 0;
	const fetch = async () => { requests++; return new Response(); };
	leaseFailure = true;
	assert.equal((await engine.streamFn(engine.model, context(), { fetch }).result()).stopReason, "error");
	leaseFailure = false;
	assert.equal((await engine.streamFn(engine.model, context(), { fetch, apiKey: "override" }).result()).stopReason, "error");
	assert.equal(requests, 0);
});

test("subscription usage never becomes inferred API charges and retains extraction token totals", () => {
	const turn = { id: "t", messageId: "m", at: "now", model: `github-copilot:${model.id}`, steps: [{ inputTokens: 10, outputTokens: 2, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }] };
	assert.equal(callCost(turn.steps[0]!, turn.model), null); assert.equal(turnCost(turn), null);
	assert.deepEqual(sessionCost({ turns: [turn] }), { cost: 0, unpriced: 0, subscription: 1 });
	const summary = graphCostSummary({ chats: [{ title: "lesson", extractions: [{ startedAt: 1, at: "now", durationMs: 1, stages: { extractor: { model: turn.model, steps: turn.steps }, auditor: { model: turn.model, steps: turn.steps } } }] }], sources: [] });
	assert.equal(summary.stages.extraction.copilotRuns, 1); assert.equal(summary.stages.extraction.tokens.inputTokens, 10);
	assert.equal(summary.totalDollars, 0); assert.equal(summary.unpricedRuns, 0);
});

test("disconnect invalidates active streams, cached catalogs, and future engine construction", () => {
	const { controller, release } = copilotController(); connected = false; revision++;
	ipc({ channel: "lh:copilot", kind: "state", status: status() });
	assert.equal(controller.signal.aborted, true); release();
	assert.equal(providerKeyPresent("github-copilot"), false);
	assert.equal(modelCatalog().models.some((m) => m.provider === "github-copilot"), false);
	assert.throws(() => piEngineForSpec({ provider: "github-copilot", id: model.id }));
});