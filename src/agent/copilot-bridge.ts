import type { CopilotStatus } from "../core/contracts/copilot.ts";

const key = Symbol.for("lh.copilot.bridge");
const unavailable = (): CopilotStatus => ({ available: false, connected: false, pending: false, revision: 0, modelIds: [], device: null, error: null });
interface Pending { op: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface State { status: CopilotStatus; sequence: number; pending: Map<string, Pending>; controllers: Set<AbortController> }
function state(): State {
  const global = globalThis as typeof globalThis & { [key]?: State };
  if (!global[key]) {
    const s: State = { status: unavailable(), sequence: 0, pending: new Map(), controllers: new Set() }; global[key] = s;
    process.on("message", (raw: unknown) => {
      const m = raw as { channel?: string; kind?: string; id?: string; op?: string; ok?: boolean; value?: unknown; status?: CopilotStatus; error?: string };
      if (m?.channel !== "lh:copilot") return;
      if (m.kind === "state" && m.status) accept(s, m.status);
      if (m.id) { const call = s.pending.get(m.id); if (!call || call.op !== m.op) return; clearTimeout(call.timer); s.pending.delete(m.id); if (m.ok) call.resolve(m.value); else call.reject(new Error(m.error || "GitHub Copilot authorization failed.")); }
    });
    process.on("disconnect", () => {
      s.status = unavailable(); for (const c of s.controllers) c.abort();
      for (const call of s.pending.values()) { clearTimeout(call.timer); call.reject(new Error("GitHub Copilot desktop connection closed.")); } s.pending.clear();
    });
  }
  return global[key];
}
function accept(s: State, value: CopilotStatus) {
  if (!Number.isSafeInteger(value.revision) || value.revision < s.status.revision || !Array.isArray(value.modelIds) || !value.modelIds.every((id) => typeof id === "string")) return;
  if (value.revision !== s.status.revision || !value.connected) for (const c of s.controllers) c.abort();
  s.status = { ...value, device: null }; // the server never needs the login challenge
}
function request<T>(op: "status" | "lease", fields: Record<string, unknown> = {}): Promise<T> {
  const s = state();
  if (!process.send || !process.connected) return Promise.reject(new Error("GitHub Copilot requires the desktop app's private server connection."));
  return new Promise((resolve, reject) => {
    const id = `${process.pid}:${++s.sequence}`;
    const timer = setTimeout(() => { s.pending.delete(id); reject(new Error("GitHub Copilot desktop connection timed out.")); }, 45000);
    s.pending.set(id, { op, resolve: (v) => resolve(v as T), reject, timer });
    process.send!({ channel: "lh:copilot", id, op, ...fields }, (e) => { if (e) { clearTimeout(timer); s.pending.delete(id); reject(new Error("GitHub Copilot desktop connection closed.")); } });
  });
}
export async function refreshCopilotConnection(): Promise<void> {
  const s = state();
  if (!process.send || !process.connected) { s.status = unavailable(); return; }
  try { accept(s, await request<CopilotStatus>("status")); } catch { s.status = unavailable(); for (const c of s.controllers) c.abort(); }
}
export function copilotConnected(): boolean { const s = state().status; return s.available && s.connected; }
export function copilotModelAvailable(id: string): boolean { return copilotConnected() && state().status.modelIds.includes(id); }
export function copilotRevision(): number { return state().status.revision; }
export function copilotController(): { controller: AbortController; release(): void } {
  const s = state(); const controller = new AbortController(); s.controllers.add(controller); return { controller, release: () => { s.controllers.delete(controller); } };
}
export async function copilotAuth(modelId: string, revision: number) {
  if (!copilotModelAvailable(modelId) || revision !== copilotRevision()) throw new Error("GitHub Copilot model or connection is unavailable.");
  const result = await request<{ revision: number; auth: { apiKey: string; baseUrl: string } }>("lease", { modelId, revision });
  if (result.revision !== revision || revision !== copilotRevision() || !copilotModelAvailable(modelId) || typeof result.auth?.apiKey !== "string" || !result.auth.apiKey) throw new Error("GitHub Copilot connection changed.");
  const url = new URL(result.auth.baseUrl);
  if (url.protocol !== "https:" || !["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Untrusted GitHub Copilot endpoint.");
  return result.auth;
}