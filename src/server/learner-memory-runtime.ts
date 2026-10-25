/** Production composition only. Neither the coordinator nor jobs imports this
 * module: storage, credentials and role resolution meet here without a cycle. */
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { chatGPTBackgroundAllowed, chatGPTModel, onChatGPTChange } from "../agent/chatgpt-bridge.ts";
import { copilotModelAvailable, onCopilotChange } from "../agent/copilot-bridge.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { onKeysChange, providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { createLearnerMemoryCoordinator } from "./learner-memory.ts";
import { setMemoryJobHooks } from "./jobs.ts";
import { memoryDirectory, stores } from "./stores.ts";

export async function resolveMemoryUpdaterEngine(): Promise<PiEngine> {
  const spec = resolveRoleSpec("memoryUpdater", stores.settingsStore.readSettings());
  if (!spec) throw new ModelsNotConfiguredError(["cheap"]);
  if (spec.provider === "chatgpt" || spec.provider === "github-copilot") await refreshConnectionCatalog();
  if (!providerKeyPresent(spec.provider) ||
    (spec.provider === "chatgpt" && (!chatGPTBackgroundAllowed() || !chatGPTModel(spec.id))) ||
    (spec.provider === "github-copilot" && !copilotModelAvailable(spec.id))) {
    throw new ProviderKeyMissingError(spec.provider, ["cheap"]);
  }
  return piEngineForSpec(spec, true);
}

function createRuntime() {
  const coordinator = createLearnerMemoryCoordinator({
    chatStore: stores.chatStore,
    jobStore: stores.jobStore,
    memoryStore: stores.learnerMemoryStore,
    memoryDirectory,
    resolveEngine: resolveMemoryUpdaterEngine,
    autoRun: process.env.NODE_ENV !== "test",
    onError: (error) => console.error("[memory] background update failed:", error),
  });
  // Synchronous and durable BEFORE any service can write a new transcript.
  coordinator.activate();
  return coordinator;
}

const key = Symbol.for("learnharness.learner-memory.runtime");
const globals = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createRuntime> };
export const learnerMemoryCoordinator = globals[key] ??= createRuntime();
setMemoryJobHooks(learnerMemoryCoordinator);

/** Recover in the background; configuration writes never wait for model calls. */
export function refreshLearnerMemory(): void {
  void learnerMemoryCoordinator.recover().catch((error) => console.error("[memory] recovery failed:", error));
}

const watchKey = Symbol.for("learnharness.learner-memory.watch");
const watches = globalThis as typeof globalThis & { [watchKey]?: boolean };
if (!watches[watchKey]) {
  watches[watchKey] = true;
  onKeysChange(refreshLearnerMemory);
  onChatGPTChange(refreshLearnerMemory);
  onCopilotChange(refreshLearnerMemory);
  if (process.env.NODE_ENV !== "test") refreshLearnerMemory();
}

/** A failed enqueue must not invalidate a successful transcript write. Recovery
 * closes this crash gap from durable transcripts, not an ephemeral callback. */
export function scanLearnerMemory(chatId: string): void {
  try { learnerMemoryCoordinator.scan(chatId); }
  catch (error) { console.error(`[chat ${chatId}] memory scan failed:`, error); }
}