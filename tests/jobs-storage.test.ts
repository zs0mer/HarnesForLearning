import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, mock, test } from "node:test";

// Dynamic import after the data seam: never touch production jobs.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-durability-"));
const previousData = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = root;
const { jobStore } = await import("../src/store/jobs.ts");
const { subscribe } = await import("../src/core/events.ts");
const { createLearnerMemoryCoordinator } = await import("../src/server/learner-memory.ts");
const { createLearnerMemoryStore } = await import("../src/store/learner-memory.ts");
import type { ChatStore } from "../src/core/ports.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";

afterEach(() => { mock.restoreAll(); });
after(() => {
  if (previousData === undefined) delete process.env.LH_DATA_DIR;
  else process.env.LH_DATA_DIR = previousData;
  fs.rmSync(root, { recursive: true, force: true });
});

for (const platform of ["linux", "win32"] as const) {
  test(`atomic job writes sync before rename/events on ${platform}`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform });
    const order: string[] = [];
    const originalSync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    mock.method(fs, "fsyncSync", (fd: number) => {
      order.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
      return originalSync(fd);
    });
    mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
      assert.equal(order.at(-1), "file");
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(source, "utf8")));
      order.push("rename");
      return originalRename(source, destination);
    });
    const unsubscribe = subscribe((event) => { if (event.type === "jobs-changed") order.push("event"); });
    try {
      const job = jobStore.createJob({ kind: "memory", chatId: `chat-${platform}`, toolCallId: "m" });
      assert.deepEqual(order, platform === "win32" ? ["file", "rename", "event"] : ["file", "rename", "directory", "event"]);
      order.length = 0;
      jobStore.updateJob(job.id, { result: { prepared: "candidate" } });
      assert.deepEqual(order, platform === "win32" ? ["file", "rename", "event"] : ["file", "rename", "directory", "event"]);
      assert.deepEqual(jobStore.getJob(job.id)?.result, { prepared: "candidate" });
      assert.equal(fs.readdirSync(path.join(root, "jobs")).some((name) => name.endsWith(".tmp")), false);
      // Activation has the same platform contract, independently of jobs.
      order.length = 0;
      const memoryDirectory = path.join(root, `activation-${platform}`);
      const coordinator = createLearnerMemoryCoordinator({
        chatStore: { listChats: () => [] } as unknown as ChatStore,
        jobStore, memoryDirectory, memoryStore: createLearnerMemoryStore(memoryDirectory),
        resolveEngine: () => ({} as PiEngine), autoRun: false,
      });
      try { coordinator.activate(); } finally { coordinator.dispose(); }
      assert.deepEqual(order, platform === "win32" ? ["file", "rename"] : ["file", "rename", "directory"]);
    } finally { unsubscribe(); Object.defineProperty(process, "platform", descriptor); }
  });
}

for (const stage of ["fsyncSync", "renameSync"] as const) {
  test(`failed job ${stage} preserves previous prepared record and emits nothing`, () => {
    const job = jobStore.createJob({ kind: "memory", chatId: `failure-${stage}`, toolCallId: "m" });
    jobStore.updateJob(job.id, { result: { prepared: "durable" } });
    const before = fs.readFileSync(path.join(root, "jobs", `${job.id}.json`), "utf8");
    let events = 0;
    const unsubscribe = subscribe((event) => { if (event.type === "jobs-changed") events++; });
    mock.method(fs, stage, () => { throw new Error("filesystem crash"); });
    try {
      assert.throws(() => jobStore.updateJob(job.id, { result: { prepared: "replacement" } }), /filesystem crash/);
      assert.equal(fs.readFileSync(path.join(root, "jobs", `${job.id}.json`), "utf8"), before);
      assert.equal(events, 0);
      assert.equal(fs.readdirSync(path.join(root, "jobs")).some((name) => name.endsWith(".tmp")), false);
    } finally { unsubscribe(); }
  });
}

test("real durable prepared job survives memory crash and restart without a duplicate model call", async () => {
  const memoryDirectory = path.join(root, "memory");
  const memoryStore = createLearnerMemoryStore(memoryDirectory);
  const messages = [
    { id: "learner", role: "user", content: "I prefer diagrams", timestamp: 0 },
    { id: "call", role: "assistant", content: [{ type: "toolCall", id: "probe", name: "probe_done", arguments: {} }], timestamp: 1 },
    { id: "result", role: "toolResult", toolCallId: "probe", toolName: "probe_done", content: [], details: { ok: true }, timestamp: 2 },
  ] as LhMessage[];
  const chat = { id: "crash", messages, kind: "teach" };
  const chatStore = { listChats: () => [chat], getChat: () => chat } as unknown as ChatStore;
  const deps = { chatStore, jobStore, memoryStore, memoryDirectory, resolveEngine: () => ({} as PiEngine), autoRun: false };
  let calls = 0;
  let worker = createLearnerMemoryCoordinator({
    ...deps, chatStore: { ...chatStore, listChats: () => [] }, runUpdater: async () => {
      calls++; return { teachingGuide: [{ before: "", after: "Use diagrams" }], topics: [] };
    }
  });
  worker.activate();
  worker.dispose();
  worker = createLearnerMemoryCoordinator({
    ...deps, runUpdater: async () => {
      calls++; return { teachingGuide: [{ before: "", after: "Use diagrams" }], topics: [] };
    }
  });
  await memoryStore.read();
  worker.scan(chat.id);
  const job = worker.status(chat.id)[0]!;
  const originalRename = fs.renameSync;
  const replacement = mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (destination === path.join(memoryDirectory, "teaching-guide.md")) throw Object.assign(new Error("disk unavailable"), { code: "ETIMEDOUT" });
    return originalRename(source, destination);
  });
  await worker.run(job.id);
  replacement.mock.restore();
  worker.dispose();
  assert.ok((jobStore.getJob(job.id)!.result as { prepared?: unknown }).prepared);
  // Recovery deadline is persisted; simulate restarting after it expires.
  worker = createLearnerMemoryCoordinator({ ...deps, now: () => Date.now() + 60_000, runUpdater: async () => { throw new Error("duplicate model call"); } });
  try {
    await worker.recover();
    assert.equal(calls, 1);
    assert.equal(jobStore.getJob(job.id)!.status, "done");
    assert.equal((await memoryStore.read()).teachingGuide, "Use diagrams");
    assert.equal((await memoryStore.read()).revision, 1);
  } finally { worker.dispose(); }
});