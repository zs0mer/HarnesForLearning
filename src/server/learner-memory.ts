import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerJobAbort, unregisterJobAbort, fireJobAbort } from "../agent/subagents/aborts.ts";
import type { ChatStore, JobStore } from "../core/ports.ts";
import type { JobKind, JobRecord } from "../core/contracts.ts";
import { accumulateJobUsage, piUsageToStep } from "../core/contracts.ts";
import { CONCLUDE_ACK_TEXT } from "../core/contracts/chat.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "../core/question-core.ts";
import {
  LearnerMemoryRevisionConflictError,
  type LearnerMemorySnapshot,
  type LearnerMemoryStore,
} from "../core/learner-memory.ts";
import { isModelsRefusal, isProviderKeyRefusal } from "../core/settings.ts";
import type { PiEngine } from "../agent/models.ts";
import {
  applyLearnerMemoryPatch,
  runLearnerMemoryUpdater,
  validateLearnerMemoryPatch,
  type LearnerMemoryAgentOptions,
  type LearnerMemoryEvidence,
  type LearnerMemoryUpdateInput,
} from "../agent/subagents/learner-memory.ts";

/** The main agent wires a server tool with this name. Its persisted successful
 * result (details: {ok:true}) is the durable explicit-preference signal; no
 * ephemeral callback is the source of truth. Call args carry the preference. */
export const LEARNER_MEMORY_PREFERENCE_TOOL = "remember_learner_preference";
export const LEARNER_MEMORY_JOB_KIND = "memory" satisfies JobKind;

export interface LearnerMemoryMilestone {
  messageId: string;
  kind: "probe" | "practice" | "answer" | "preference";
  index: number;
  toolCallId: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function resultData(message: LhMessage & { role: "toolResult" }): Record<string, unknown> | undefined {
  const details = object(message.details);
  if (details) return details;
  try {
    return object(JSON.parse(message.content.filter((c) => c.type === "text").map((c) => c.text).join("")));
  } catch { return undefined; }
}

/** Poses, failed tools, dismissed answers, synthetic steers and assistant
 * prose cannot trigger an update. Completion requires its real paired call. */
export function detectLearnerMemoryMilestones(messages: readonly LhMessage[], kind?: string): LearnerMemoryMilestone[] {
  const calls = new Map<string, { name: string; dismissed: boolean }>();
  const seen = new Set<string>();
  const milestones: LearnerMemoryMilestone[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, dismissed: part.arguments?.outcome === "dismissed" });
    }
    if (message.role !== "toolResult" || message.isError || seen.has(message.toolCallId) || calls.get(message.toolCallId)?.name !== message.toolName) continue;
    const data = resultData(message);
    let milestoneKind: LearnerMemoryMilestone["kind"] | undefined;
    if (message.toolName === "probe_done" && data?.ok === true) milestoneKind = "probe";
    if (message.toolName === LEARNER_MEMORY_PREFERENCE_TOOL && data?.ok === true) milestoneKind = "preference";
    if (kind === "practice" && message.toolName === "conclude" && !calls.get(message.toolCallId)?.dismissed && data?.dismissed !== true && data?.ok !== false &&
      message.content.some((c) => c.type === "text" && c.text === CONCLUDE_ACK_TEXT)) milestoneKind = "practice";
    if (["quiz", "recall", "explain"].includes(message.toolName) && data && data.dismissed !== true &&
      ["quiz", "explain"].includes(String(data.kind)) &&
      (typeof data.answeredAt === "string" || data.dontKnow === true || Array.isArray(data.answers) || typeof data.text === "string")) milestoneKind = "answer";
    if (milestoneKind) {
      seen.add(message.toolCallId);
      milestones.push({ messageId: message.id, kind: milestoneKind, index, toolCallId: message.toolCallId });
    }
  }
  return milestones;
}

export function learnerMemoryMilestoneId(chatId: string, milestone: Pick<LearnerMemoryMilestone, "messageId" | "kind">): string {
  return `memory_${createHash("sha256").update(JSON.stringify([chatId, milestone.kind, milestone.messageId])).digest("hex")}`;
}

interface MemoryWork {
  version: 1;
  state: "queued" | "updating" | "retry" | "deferred" | "committing" | "complete" | "failed";
  milestone: LearnerMemoryMilestone;
  sourceMessageIds: string[];
  attempts: number;
  failures?: number;
  nextAttemptAt?: number;
  /** Write-ahead candidate: on restart compare against durable memory before
 * ever rerunning the model. No duplicate append/evidence after a crash. */
  prepared?: { before: LearnerMemorySnapshot; after: LearnerMemorySnapshot };
}

export interface LearnerMemoryCoordinatorDeps {
  chatStore: ChatStore;
  jobStore: JobStore;
  memoryStore: LearnerMemoryStore;
  /** The same durable directory passed to createLearnerMemoryStore. */
  memoryDirectory: string;
  resolveEngine: () => PiEngine | Promise<PiEngine>;
  runUpdater?: (input: LearnerMemoryUpdateInput, options: LearnerMemoryAgentOptions) => Promise<unknown>;
  /** Deterministic test seams. Delays are persisted, never busy-looped. */
  now?: () => number;
  retryDelaysMs?: readonly [number, number];
  autoRun?: boolean;
  onError?: (error: unknown) => void;
}

const serialKey = Symbol.for("learnharness.learner-memory.worker");
const globals = globalThis as typeof globalThis & { [serialKey]?: Promise<unknown> };
function globallySerialized<T>(work: () => Promise<T>): Promise<T> {
  const previous = globals[serialKey] ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  globals[serialKey] = result.catch(() => undefined);
  return result;
}

function workOf(job: JobRecord): MemoryWork | undefined {
  const work = object(job.result);
  return work?.version === 1 && object(work.milestone) && Array.isArray(work.sourceMessageIds) ? work as unknown as MemoryWork : undefined;
}

function sameMemory(a: LearnerMemorySnapshot, b: LearnerMemorySnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function refusal(error: unknown): boolean {
  const data = object(error);
  const code = data?.code ?? object(data?.envelope)?.code;
  const message = error instanceof Error ? error.message : String(data?.error ?? error);
  return code === "models_not_configured" || code === "provider_key_missing" ||
    data?.name === "ModelsNotConfiguredError" || data?.name === "ProviderKeyMissingError" ||
    isModelsRefusal(message) || isProviderKeyRefusal(message);
}

export function isTransientLearnerMemoryError(error: unknown): boolean {
  if (error instanceof LearnerMemoryRevisionConflictError) return true;
  const data = object(error);
  const status = Number(data?.status ?? data?.statusCode);
  const code = String(data?.code ?? object(data?.cause)?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);
  return [408, 429, 500, 502, 503, 504].includes(status) ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
    /\b(429|502|503|504)\b|rate.?limit|temporarily unavailable|timed? ?out|fetch failed/i.test(message);
}

/** Operational JobRecords only: NEVER calls the normal runner, appends a
 * steer, wakes a teacher, or creates a conversation. scan is called AFTER
 * transcript persistence; recover at startup and after credentials change. */
export function createLearnerMemoryCoordinator(deps: LearnerMemoryCoordinatorDeps) {
  const { chatStore, jobStore, memoryStore } = deps;
  const now = deps.now ?? Date.now;
  const delays = deps.retryDelaysMs ?? [1_000, 10_000];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const controllers = new Map<string, AbortController>();
  let disposed = false;
  interface Activation { version: 1; baseline: Record<string, string[]>; deleted: string[] }
  const activationFile = path.join(deps.memoryDirectory, ".learner-memory.activation.json");
  function saveActivation(value: Activation): void {
    fs.mkdirSync(deps.memoryDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${activationFile}.tmp`;
    fs.rmSync(temporary, { force: true });
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, activationFile);
    if (process.platform !== "win32") {
      const directory = fs.openSync(deps.memoryDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }
  /** Synchronous cutover: no transcript write can interleave with the snapshot
   * and durable rename in this process. Never infer activation from job presence. */
  function activate(): Activation {
    if (fs.existsSync(activationFile)) {
      const value = JSON.parse(fs.readFileSync(activationFile, "utf8")) as Activation;
      if (value.version !== 1 || !object(value.baseline) || !Array.isArray(value.deleted) ||
        !value.deleted.every((id) => typeof id === "string") ||
        !Object.values(value.baseline).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))) throw new Error("Invalid learner memory activation");
      return value;
    }
    const value: Activation = { version: 1, baseline: Object.fromEntries(chatStore.listChats().map((chat) => [chat.id, chatStore.getChat(chat.id)?.messages.map((m) => m.id) ?? []])), deleted: [] };
    saveActivation(value);
    return value;
  }

  function write(jobId: string, work: MemoryWork, patch: Partial<Pick<JobRecord, "status" | "activity" | "error">> = {}) {
    return jobStore.updateJob(jobId, { result: work, ...patch });
  }

  function background(jobId: string, due = now()) {
    if (disposed || deps.autoRun === false || timers.has(jobId)) return;
    if (due <= now()) { void run(jobId).catch((error) => deps.onError?.(error)); return; }
    const timer = setTimeout(() => {
      timers.delete(jobId);
      void run(jobId).catch((error) => deps.onError?.(error));
    }, Math.max(1, due - now()));
    timer.unref();
    timers.set(jobId, timer);
  }

  function scan(chatId: string, schedule = true): void {
    if (disposed) return;
    const activation = activate();
    if (activation.deleted.includes(chatId)) return;
    const baseline = new Set(Object.hasOwn(activation.baseline, chatId) ? activation.baseline[chatId] : []);
    const chat = chatStore.getChat(chatId);
    if (!chat) return;
    let processedIndex = -1;
    for (const milestone of detectLearnerMemoryMilestones(chat.messages, chat.kind)) {
      if (baseline.has(milestone.messageId)) { processedIndex = milestone.index; continue; }
      const identity = learnerMemoryMilestoneId(chatId, milestone);
      let job = jobStore.findJobByToolCallId(chatId, identity);
      if (job?.status === "done") { processedIndex = milestone.index; continue; }
      if (!job) job = jobStore.createJob({ kind: LEARNER_MEMORY_JOB_KIND, chatId, toolCallId: identity, activity: "memory queued" });
      if (job.kind !== LEARNER_MEMORY_JOB_KIND || job.status !== "running") continue;
      let work = workOf(job);
      if (!work) {
        work = {
          version: 1, state: "queued", milestone,
          sourceMessageIds: chat.messages.slice(processedIndex + 1, milestone.index + 1).map((m) => m.id).filter((id) => !baseline.has(id)), attempts: 0
        };
        write(job.id, work);
      }
      // Deferred credentials resume only on recover/explicit run, not every
      // transcript persistence (avoids repeated missing-credentials loops).
      if (schedule && work.state !== "deferred") background(job.id, work.nextAttemptAt);
    }
  }

  function buildInput(job: JobRecord, work: MemoryWork, memory: LearnerMemorySnapshot): LearnerMemoryUpdateInput {
    const chat = chatStore.getChat(job.chatId);
    if (!chat) throw new Error("Memory source session was deleted");
    const ids = new Set(work.sourceMessageIds);
    const evidence: LearnerMemoryEvidence[] = [];
    const context: LearnerMemoryUpdateInput["context"] = [];
    const end = chat.messages.findIndex((m) => m.id === work.milestone.messageId);
    if (end < 0) throw new Error("Memory milestone was removed");
    const callIds = new Set<string>();
    for (const message of chat.messages.slice(0, end + 1)) {
      if (ids.has(message.id) && message.role === "toolResult") callIds.add(message.toolCallId);
    }
    for (const message of chat.messages.slice(0, end + 1)) {
      const selected = ids.has(message.id);
      if (message.role === "assistant") {
        const value = message.content.filter((c) => (selected && c.type === "text") || (c.type === "toolCall" && (selected || callIds.has(c.id))));
        if (value.length) context.push({ messageId: message.id, value });
      } else if (selected && message.role === "user") {
        const value = typeof message.content === "string" ? message.content : message.content.filter((c) => c.type === "text");
        evidence.push({ messageId: message.id, kind: "learner", value });
      } else if (selected && message.role === "custom" && message.customType === "practice-thinking") {
        evidence.push({ messageId: message.id, kind: "practice-thinking", value: object(message.details)?.text ?? message.content });
      } else if (selected && message.role === "toolResult" && !message.isError) {
        const data = resultData(message);
        if (data && ["quiz", "probe", "recall", "explain", "ask_user_question"].includes(message.toolName) && data.dismissed !== true && ["quiz", "explain", "ask"].includes(String(data.kind))) {
          evidence.push({ messageId: message.id, kind: "answer", value: compactAnswerForModel(data as unknown as QuestionAnswerData) });
        }
      }
    }
    return { chatId: job.chatId, milestone: work.milestone, memory, evidence, context };
  }

  async function commitPrepared(job: JobRecord, work: MemoryWork): Promise<void> {
    const prepared = work.prepared!;
    const current = await memoryStore.read();
    if (!eligible(job)) return;
    const landed = { ...prepared.after, revision: prepared.before.revision + 1 };
    if (!sameMemory(current, landed)) {
      if (!sameMemory(current, prepared.before)) throw new LearnerMemoryRevisionConflictError(prepared.before.revision, current.revision);
      // Recheck after awaits: deleted/aborted jobs must not resurrect refs.
      if (!chatStore.getChat(job.chatId) || jobStore.getJob(job.id)?.status !== "running") return;
      if (!sameMemory(prepared.before, prepared.after)) await memoryStore.commit(prepared.after, prepared.before.revision);
    }
    if (!eligible(job)) return;
    write(job.id, { ...work, state: "complete", prepared: undefined }, { status: "done", activity: "memory updated", error: undefined });
  }

  function eligible(job: JobRecord): boolean {
    const activation = activate();
    const chat = chatStore.getChat(job.chatId);
    const baseline = new Set(Object.hasOwn(activation.baseline, job.chatId) ? activation.baseline[job.chatId] : []);
    const historical = chat && detectLearnerMemoryMilestones(chat.messages, chat.kind).some((m) =>
      baseline.has(m.messageId) && learnerMemoryMilestoneId(job.chatId, m) === job.toolCallId);
    return !disposed && !!chat && !historical && jobStore.getJob(job.id)?.status === "running" && !activation.deleted.includes(job.chatId);
  }
  function cancelJob(jobId: string): boolean {
    const job = jobStore.getJob(jobId);
    if (!job || job.kind !== LEARNER_MEMORY_JOB_KIND || job.status !== "running") return false;
    jobStore.updateJob(jobId, { status: "error", activity: "aborted", error: "Aborted by learner" });
    const timer = timers.get(jobId);
    if (timer) clearTimeout(timer);
    timers.delete(jobId);
    fireJobAbort(jobId);
    return true;
  }
  function cancelSession(chatId: string): void {
    for (const job of jobStore.listJobs(chatId)) cancelJob(job.id);
  }
  /** Owning deletion claim must remain held until this resolves. Restore only
   * a surviving chat, after any in-flight commit/cleanup. Canceled milestones
   * stay consumed even if the owning deletion already removed their jobs:
   * rollback never repeats model calls, but future milestones remain eligible.
   * Learned content/removed citations are not rolled back. */
  function restoreSession(chatId: string): Promise<void> {
    return globallySerialized(async () => {
      const activation = activate();
      const chat = chatStore.getChat(chatId);
      if (!chat || !activation.deleted.includes(chatId)) return;
      activation.baseline[chatId] = [...new Set([...(activation.baseline[chatId] ?? []), ...chat.messages.map((m) => m.id)])];
      activation.deleted = activation.deleted.filter((id) => id !== chatId);
      saveActivation(activation);
    });
  }
  /** Call before removing the session/jobs. Tombstone first, then serialized
   * cleanup: even a commit already in flight cannot restore deleted refs.
   * On any subsequent owning deletion failure/early return, await
   * cancelDeletion BEFORE releasing its session-deletion claim. */
  async function deleteSession(chatId: string): Promise<void> {
    const activation = activate();
    if (!activation.deleted.includes(chatId)) { activation.deleted.push(chatId); saveActivation(activation); }
    try {
      cancelSession(chatId);
      await globallySerialized(() => memoryStore.removeSessionReferences(chatId));
    } catch (error) {
      await restoreSession(chatId);
      throw error;
    }
  }

  async function attempt(jobId: string): Promise<void> {
    if (disposed) return;
    const job = jobStore.getJob(jobId);
    if (!job || job.kind !== LEARNER_MEMORY_JOB_KIND || job.status !== "running") return;
    if (!eligible(job)) { cancelJob(jobId); return; }
    let work = workOf(job);
    if (!work) { scan(job.chatId); work = workOf(jobStore.getJob(jobId)!); }
    if (!work) return;
    if ((work.nextAttemptAt ?? 0) > now()) { background(jobId, work.nextAttemptAt); return; }
    if (work.attempts >= 3 && !work.prepared) {
      write(jobId, { ...work, state: "failed" }, { status: "error", activity: "memory failed", error: "Memory retry limit reached" }); return;
    }
    const controller = new AbortController();
    controllers.set(jobId, controller);
    registerJobAbort(jobId, controller);
    try {
      if (work.prepared) { await commitPrepared(job, work); return; }
      const engine = await deps.resolveEngine();
      if (!eligible(job) || controller.signal.aborted) return;
      const memory = await memoryStore.read();
      if (!eligible(job) || controller.signal.aborted) return;
      const input = buildInput(job, work, memory);
      work = { ...work, state: "updating", attempts: work.attempts + 1, nextAttemptAt: undefined };
      write(jobId, work, { activity: "updating learner memory", error: undefined });
      const raw = await (deps.runUpdater ?? runLearnerMemoryUpdater)(input, {
        engine,
        signal: controller.signal,
        onUsage: (usage, model) => {
          const current = jobStore.getJob(jobId);
          if (current) jobStore.updateJob(jobId, { usage: accumulateJobUsage(current.usage, model, piUsageToStep(usage)) });
        },
      });
      const patch = validateLearnerMemoryPatch(raw, input);
      const after = applyLearnerMemoryPatch(memory, patch);
      if (!eligible(job) || controller.signal.aborted) return;
      work = { ...work, state: "committing", prepared: { before: memory, after } };
      write(jobId, work, { activity: "saving learner memory" });
      await commitPrepared(job, work);
    } catch (error) {
      if (disposed || jobStore.getJob(jobId)?.status !== "running") return;
      const message = error instanceof Error ? error.message : String(error);
      if (refusal(error)) {
        write(jobId, { ...work, state: "deferred", attempts: Math.max(0, work.attempts - (work.state === "updating" ? 1 : 0)) }, { activity: "memory deferred — configure models", error: message });
      } else if (isTransientLearnerMemoryError(error) && work.attempts < 3 && (work.failures ?? 0) < 2) {
        const failures = (work.failures ?? 0) + 1;
        const nextAttemptAt = now() + delays[(failures - 1) as 0 | 1];
        // CAS conflicts require fresh read/model reasoning; a model is
        // never allowed to overwrite an independently edited document pair.
        const prepared = error instanceof LearnerMemoryRevisionConflictError ? undefined : work.prepared;
        write(jobId, { ...work, prepared, failures, state: "retry", nextAttemptAt }, { activity: "memory retry scheduled", error: message });
        background(jobId, nextAttemptAt);
      } else {
        write(jobId, { ...work, state: "failed" }, { status: "error", activity: "memory failed", error: message });
      }
    } finally {
      controllers.delete(jobId);
      unregisterJobAbort(jobId);
    }
  }

  function run(jobId: string): Promise<void> { return globallySerialized(() => attempt(jobId)); }

  async function recover(): Promise<void> {
    activate();
    await globallySerialized(async () => {
      for (const chatId of activate().deleted) await memoryStore.removeSessionReferences(chatId);
    });
    const pending: { job: JobRecord; timestamp: number; index: number }[] = [];
    for (const chat of chatStore.listChats()) {
      // Enqueue all crash gaps WITHOUT starting workers in chat/activity
      // order. Jobs and chat summaries are both newest-first in production.
      scan(chat.id, false);
      const messages = chatStore.getChat(chat.id)?.messages ?? [];
      let timestamp = 0;
      const sourceOrder = new Map<string, { timestamp: number; index: number }>();
      for (const [index, message] of messages.entries()) {
        // Preserve transcript order even when source clocks move backwards.
        if (Number.isFinite(message.timestamp)) timestamp = Math.max(timestamp, message.timestamp);
        sourceOrder.set(message.id, { timestamp, index });
      }
      for (const job of jobStore.listJobs(chat.id)) {
        if (job.kind !== LEARNER_MEMORY_JOB_KIND || job.status !== "running") continue;
        const milestone = workOf(job)?.milestone;
        const source = milestone && sourceOrder.get(milestone.messageId);
        pending.push({ job, timestamp: source?.timestamp ?? 0, index: source?.index ?? milestone?.index ?? -1 });
      }
    }
    pending.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index || a.job.chatId.localeCompare(b.job.chatId) || a.job.id.localeCompare(b.job.id));
    for (const { job } of pending) await run(job.id);
  }

  return {
    activate: () => { activate(); }, scan, recover, run, cancelJob, cancelSession, deleteSession,
    restoreSession, cancelDeletion: restoreSession,
    notifyPreference: (chatId: string) => scan(chatId),
    /** Exposes durable background activity for existing jobs/status consumers. */
    status: (chatId: string) => jobStore.listJobs(chatId).filter((job) => job.kind === LEARNER_MEMORY_JOB_KIND),
    dispose() { disposed = true; for (const controller of controllers.values()) controller.abort(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}