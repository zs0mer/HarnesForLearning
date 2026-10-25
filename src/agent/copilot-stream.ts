import { createModels, type AssistantMessage, type StreamFunction } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { copilotAuth, copilotController, copilotModelAvailable, copilotRevision } from "./copilot-bridge.ts";

/** Keep the SDK's native Copilot APIs/headers, replacing only its auth port.
 * No environment/API-key fallback and no credential persistence in the server. */
export const copilotStream: StreamFunction = (model, context, options) => {
	const output = new AssistantMessageEventStream();
	const { controller, release } = copilotController();
	const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const revision = copilotRevision();
	void (async () => {
		let partial: AssistantMessage = { role: "assistant", api: model.api, provider: "github-copilot", model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		try {
			if (options?.apiKey || Object.keys(options?.headers ?? {}).some((k) => k.toLowerCase() === "authorization")) throw new Error("Authorization overrides are forbidden.");
			const check = () => { if (signal.aborted || revision !== copilotRevision() || !copilotModelAvailable(model.id)) throw new Error("GitHub Copilot connection changed."); };
			check();
			const auth = await copilotAuth(model.id, revision); check();
			const models = createModels();
			const provider = githubCopilotProvider();
			models.setProvider({ ...provider, auth: { apiKey: { name: "Desktop Copilot lease", resolve: async () => { check(); return { auth }; } } } });
			const delegate = options?.fetch ?? globalThis.fetch;
			// Native catalog headers identify Copilot's supported transport;
			// credentials still come exclusively from the desktop lease.
			const source = models.streamSimple({ ...model, samplingParams: undefined, baseUrl: auth.baseUrl, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, context, {
				...options, signal,
				fetch: (input, init) => {
					check(); const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
					if (url.origin !== new URL(auth.baseUrl).origin) throw new Error("Untrusted Copilot request endpoint.");
					return delegate(input, { ...init, redirect: "error" });
				},
			});
			for await (const event of source) {
				partial = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
				if (event.type === "error") throw new Error("Copilot request failed");
				output.push(event);
			}
		} catch {
			partial = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: "GitHub Copilot request failed or the connection changed. Check your Copilot subscription and reconnect in Providers. No API-key fallback was used." };
			output.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error: partial });
		} finally { release(); output.end(); }
	})();
	return output;
};