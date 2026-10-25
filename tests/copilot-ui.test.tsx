import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CopilotConnection, COPILOT_NOTICE } from "../components/settings/copilot-connection.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { useModelCatalog } from "../components/model-picker.tsx";
import { GraphCostControl } from "../components/graph-view.tsx";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import type { CopilotStatus, ModelCatalogResponse } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() { } } });
let root: Root | undefined; let host: HTMLDivElement | undefined;
const realFetch = globalThis.fetch;
async function mount(children: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(children)); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; globalThis.fetch = realFetch; });
function button(text: string): HTMLButtonElement { const b = [...document.querySelectorAll("button")].find((b) => b.textContent === text); assert.ok(b, text); return b; }
const empty = (): CopilotStatus => ({ available: true, connected: false, pending: false, revision: 0, modelIds: [], device: null, error: null });

test("Copilot UI requires consent, displays device code, cancels, and confirms disconnect", async () => {
  let status = empty(); let listener = () => { }; const logins: boolean[] = []; let cancels = 0; let opens = 0; let disconnects = 0;
  const push = async () => { await act(async () => listener()); };
  window.lh = {
    expandWindow() { }, copilot: {
      status: async () => status,
      login: async (consent) => { logins.push(consent); status = { ...status, pending: true, revision: 1, device: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" } }; listener(); return status; },
      cancel: async () => { cancels++; status = { ...empty(), revision: 2 }; listener(); return status; },
      disconnect: async () => { disconnects++; status = { ...empty(), revision: 4 }; listener(); return status; },
      open: async () => { opens++; return status; },
      onChange: (cb) => { listener = cb; return () => { listener = () => { }; }; },
    }
  };
  await mount(<CopilotConnection />);
  await act(async () => button("Connect GitHub Copilot").click());
  assert.ok(document.body.textContent?.includes(COPILOT_NOTICE));
  assert.equal(button("Continue to GitHub").disabled, true);
  await act(async () => button("Continue to GitHub").click()); assert.equal(logins.length, 0);
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  // Linkedom lacks native checkbox activation; dispatch the actual React change event.
  await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  assert.equal(button("Continue to GitHub").disabled, false);
  await act(async () => button("Continue to GitHub").click());
  assert.deepEqual(logins, [true]); assert.ok(document.body.textContent?.includes("ABCD-1234"));
  await act(async () => button("Open GitHub").click()); assert.equal(opens, 1);
  await act(async () => button("Cancel sign-in").click()); assert.equal(cancels, 1);
  status = { ...status, connected: true, modelIds: ["gpt-5"], revision: 3 }; await push();
  await act(async () => button("Disconnect").click()); assert.equal(disconnects, 0);
  await act(async () => button("Disconnect account").click()); assert.equal(disconnects, 1);
  assert.ok(document.body.textContent?.includes("Connect GitHub Copilot"));
});

test("browser-only Copilot control is disabled and explains desktop requirement", async () => {
  await mount(<CopilotConnection />);
  assert.equal(button("Connect GitHub Copilot").disabled, true);
  assert.ok(document.body.textContent?.includes("private server connection"));
});

test("root Copilot changes invalidate the shared model picker without mounting settings", async () => {
  let listener = () => { }; let fetches = 0;
  const status = empty();
  window.lh = { expandWindow() { }, copilot: { status: async () => status, login: async () => status, cancel: async () => status, disconnect: async () => status, open: async () => status, onChange: (cb) => { listener = cb; return () => { }; } } };
  globalThis.fetch = async () => { fetches++; return Response.json({ models: [], providers: [], defaults: null, rolePins: {}, slots: {} } as unknown as ModelCatalogResponse); };
  function Reader() { useModelCatalog(); return null; }
  await mount(<SidebarProvider><Reader /></SidebarProvider>);
  const before = fetches; await act(async () => listener()); assert.equal(fetches, before + 1);
});

test("graph cost display identifies Copilot subscription without fabricated API dollars", async () => {
  const stage = { model: "github-copilot:gpt-5", steps: [{ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }] };
  const costs = graphCostSummary({ chats: [{ title: "lesson", extractions: [{ startedAt: 1, at: "2026-10-25T00:00:00Z", durationMs: 1, stages: { extractor: stage, auditor: stage } }] }], sources: [] });
  await mount(<GraphCostControl costs={costs} />);
  assert.ok(document.body.textContent?.includes("Copilot plan"));
  assert.equal(document.body.textContent?.includes("ChatGPT plan"), false);
  assert.equal(document.body.textContent?.includes("$0.00"), false);
});