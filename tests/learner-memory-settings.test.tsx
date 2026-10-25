import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AgentSection, composeMemoryUpdater } from "../components/settings/agent-section.tsx";
import { ROLE_SLOT, sanitizeUserSettings, type AgentSettings, type ModelsSettings } from "../src/core/settings.ts";
import type { ModelCatalogEntry } from "../src/core/contracts/models.ts";
import { resolveRoleSpec, resolveSettings } from "../src/core/settings-resolution.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";

describe("learner-memory role settings", () => {
	it("defaults to Cheap without a factory model and resolves independent overrides", () => {
		assert.equal(ROLE_SLOT.memoryUpdater, "cheap");
		assert.equal(resolveRoleSpec("memoryUpdater", null), undefined);
		const models: ModelsSettings = { cheap: { model: { provider: "zai", id: "cheap" }, thinkingLevel: "low" } };
		const fallback = { provider: "zai", id: "cheap", thinkingLevel: "low" };
		assert.deepEqual(resolveRoleSpec("memoryUpdater", { version: 1, models }), fallback);
		assert.deepEqual(resolveSettings({ version: 1, models }).agent.models.memoryUpdater, fallback);
		const modelOnly = { model: { provider: "openai", id: "override" } };
		assert.deepEqual(resolveRoleSpec("memoryUpdater", { version: 1, models, agent: { models: { memoryUpdater: modelOnly } } }), {
			provider: "openai", id: "override", thinkingLevel: "low",
		});
		assert.deepEqual(resolveRoleSpec("memoryUpdater", { version: 1, models, agent: { models: { memoryUpdater: { thinkingLevel: "high" } } } }), {
			provider: "zai", id: "cheap", thinkingLevel: "high",
		});
		assert.deepEqual(resolveRoleSpec("memoryUpdater", { version: 1, agent: { models: { memoryUpdater: modelOnly } } }), {
			provider: "openai", id: "override", thinkingLevel: undefined,
		});
	});

	it("validates the new override as a known role and sanitizes malformed fields", () => {
		const override = { model: { provider: "openai", id: "memory" }, thinkingLevel: "high" as const };
		const parsed = parseAgentSettingsBody({ models: { memoryUpdater: override } });
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.settings.models?.memoryUpdater, override);
		assert.deepEqual(sanitizeUserSettings({ version: 1, agent: parsed.settings })?.agent?.models?.memoryUpdater, override);
		for (const bad of [null, "model", { model: { id: "missing-provider" } }, { thinkingLevel: 3 }]) {
			assert.equal(parseAgentSettingsBody({ models: { memoryUpdater: bad } }).ok, false);
		}
		const cleaned = sanitizeUserSettings({ version: 1, agent: { models: { memoryUpdater: { model: { id: "missing-provider" }, thinkingLevel: 3 } } } });
		assert.equal(cleaned?.agent?.models?.memoryUpdater, undefined);
	});

	it("composes picks and resets without changing other settings or mutating input", () => {
		const agent: AgentSettings = { tools: { demo: false }, models: { researcher: { thinkingLevel: "high" }, memoryUpdater: { thinkingLevel: "low" } } };
		const before = structuredClone(agent);
		const override = { model: { provider: "openai", id: "memory" }, thinkingLevel: "medium" as const };
		const picked = composeMemoryUpdater(agent, override);
		assert.deepEqual(picked.models?.memoryUpdater, override);
		assert.deepEqual(picked.models?.researcher, agent.models?.researcher);
		assert.deepEqual(picked.tools, agent.tools);
		assert.deepEqual(composeMemoryUpdater(picked, undefined), { ...agent, models: { researcher: { thinkingLevel: "high" } } });
		assert.deepEqual(agent, before);
	});
});

describe("dedicated learner-memory settings control", () => {
	it("shows inheritance or a stored override even without the catalog", () => {
		const render = (agent?: AgentSettings) => renderToStaticMarkup(<AgentSection agent={agent} models={undefined} graph={undefined} compaction={undefined} onSectionChange={() => {}} onModelsChange={() => {}} onCompactionChange={() => {}} />);
		const inherited = render();
		assert.ok(inherited.includes('data-testid="role-row-memoryUpdater"'));
		assert.ok(inherited.includes("Cheap slot"));
		assert.ok(!inherited.includes('data-testid="role-reset-memoryUpdater"'));
		const overridden = render({ models: { memoryUpdater: { model: { provider: "openai", id: "unavailable-model" }, thinkingLevel: "high" } } });
		assert.ok(overridden.includes("unavailable-model"));
		assert.ok(overridden.includes('data-testid="role-reset-memoryUpdater"'));
		assert.ok(overridden.includes(">high</span>"));
	});

	it("uses the shared catalog/levels, writes only the agent override, and resets to Cheap", async () => {
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1280 });
		Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 800 });
		const globals = globalThis as Record<string, unknown>;
		const previous = new Map<string, PropertyDescriptor | undefined>();
		const entry: ModelCatalogEntry = {
			provider: "openai", id: "memory-model", name: "Memory model", input: ["text"],
			contextWindow: 32000, maxTokens: 4096, reasoning: true, supportedLevels: ["off", "low", "high"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		const models: ModelsSettings = { cheap: { model: { provider: "zai", id: "cheap-model" }, thinkingLevel: "medium" } };
		const bodies: Record<string, unknown> = {
			"/api/models": { models: [entry], slots: { strong: null, cheap: models.cheap, vision: null } },
			"/api/settings/prompts": { prober: [], teacher: [] },
			"/api/keys": { keys: [] },
			"/api/search": { available: false, engine: null, reason: "No search key" },
		};
		for (const [key, value] of Object.entries({
			window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
			Element: dom.window.Element, CustomEvent: dom.window.CustomEvent,
			requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
			IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async (url: string) => {
				assert.ok(url in bodies, `unexpected request: ${url}`);
				return new Response(JSON.stringify(bodies[url]));
			},
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		const { createRoot } = await import("react-dom/client");
		const root = createRoot(document.getElementById("root")!);
		let agent: AgentSettings = { tools: { demo: false }, models: { researcher: { thinkingLevel: "high" } } };
		let slotWrites = 0;
		const render = () => root.render(<AgentSection agent={agent} models={models} graph={undefined} compaction={undefined} onSectionChange={(next) => { agent = next; render(); }} onModelsChange={() => { slotWrites++; }} onCompactionChange={() => {}} />);
		const click = (testid: string) => act(() => {
			const element = document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
			assert.ok(element, `missing ${testid}`);
			element.click();
		});
		try {
			await act(async () => { render(); });
			click("role-model-memoryUpdater");
			const option = document.querySelector<HTMLButtonElement>('[data-testid="role-model-menu-memoryUpdater"] li button');
			assert.ok(option);
			assert.ok(option.textContent?.includes("Memory model"));
			act(() => { option.click(); });
			assert.deepEqual(agent.models?.memoryUpdater?.model, { provider: entry.provider, id: entry.id });
			assert.equal(agent.models?.memoryUpdater?.thinkingLevel, "medium", "existing level rides the model swap, matching the slot picker");
			assert.equal(document.querySelector('[data-testid="role-model-menu-memoryUpdater"]'), null);
			click("role-thinking-memoryUpdater");
			assert.equal(document.querySelector('[data-testid="thinking-option-medium"]'), null, "only catalog-supported levels");
			click("thinking-option-high");
			assert.equal(agent.models?.memoryUpdater?.thinkingLevel, "high");
			click("role-reset-memoryUpdater");
			assert.equal(agent.models?.memoryUpdater, undefined);
			assert.deepEqual(agent.models?.researcher, { thinkingLevel: "high" });
			assert.deepEqual(agent.tools, { demo: false });
			assert.equal(slotWrites, 0);
			assert.equal(document.querySelectorAll('[data-testid^="slot-row-"]').length, 3);
		} finally {
			act(() => { root.unmount(); });
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete globals[key];
			}
		}
	});
});