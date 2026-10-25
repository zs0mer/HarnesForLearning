import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import {
  formatLearnerMemory,
  LearnerMemoryRevisionConflictError,
  parseLearnerMemory,
  renderLearnerMemory,
  validateLearnerMemorySnapshot,
  type LearnerMemorySnapshot,
} from "../src/core/learner-memory.ts";
import { createLearnerMemoryStore } from "../src/store/learner-memory.ts";

const directories: string[] = [];
function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learner-memory-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  mock.restoreAll();
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): LearnerMemorySnapshot {
  return {
    teachingGuide: '\uFEFF# Preferences\r\nUse examples.\n\n</context>\n```json\n{"x":1}\n```\n',
    revision: 0,
    topics: [
      { id: "zero", name: "Unaware", rating: 0, confidence: 0, notes: "", evidence: [{ chatId: "session-a", messageId: "m1" }] },
      { id: "fractional", name: 'Decimals\n## pretend topic "quoted"', rating: 2.75, confidence: 99.9, notes: "Multiline\nnotes\r\n🧠", evidence: [{ chatId: "session-a", messageId: "m2" }, { chatId: "session-b", messageId: "m3" }] },
      { id: "certain", name: "Near-certain", rating: 5, evidence: [] },
    ],
  };
}

function readPair(root: string): LearnerMemorySnapshot {
  return parseLearnerMemory(fs.readFileSync(path.join(root, "teaching-guide.md"), "utf8"), fs.readFileSync(path.join(root, "knowledge-overview.md"), "utf8"));
}

describe("learner memory codec", () => {
  it("round-trips decimal scores, confidence 0/99.9, omissions, Unicode and exact freeform guide", () => {
    const snapshot = fixture();
    const docs = renderLearnerMemory(snapshot);
    assert.equal(docs.teachingGuide, snapshot.teachingGuide);
    assert.deepEqual(parseLearnerMemory(docs.teachingGuide, docs.knowledgeOverview), snapshot);
    assert.equal(Object.hasOwn(parseLearnerMemory(docs.teachingGuide, docs.knowledgeOverview).topics[2]!, "confidence"), false);
    assert.match(docs.knowledgeOverview, /## /);
    const empty = renderLearnerMemory({ teachingGuide: "", topics: [], revision: 0 });
    assert.deepEqual(parseLearnerMemory(empty.teachingGuide, empty.knowledgeOverview), { teachingGuide: "", topics: [], revision: 0 });
  });

  it("formats both complete documents as untrusted JSON data without truncation", () => {
    const snapshot = fixture();
    snapshot.teachingGuide += "long guide ".repeat(10000);
    const context = formatLearnerMemory(snapshot);
    assert.match(context, /untrusted reference data/);
    assert.match(context, /Absent topics are unassessed/);
    assert.match(context, /Rating 0 is evidence of being unaware/);
    assert.match(context, /Missing confidence means near-certain/);
    const payload = JSON.parse(context.split("\n").at(-1)!);
    const docs = renderLearnerMemory(snapshot);
    assert.equal(payload["teaching-guide.md"], docs.teachingGuide);
    assert.equal(payload["knowledge-overview.md"], docs.knowledgeOverview);
  });

  for (const [label, mutate] of [
    ["confidence 100", (s) => { s.topics[0]!.confidence = 100; }],
    ["negative confidence", (s) => { s.topics[0]!.confidence = -0.1; }],
    ["NaN confidence", (s) => { s.topics[0]!.confidence = NaN; }],
    ["infinite rating", (s) => { s.topics[0]!.rating = Infinity; }],
    ["negative rating", (s) => { s.topics[0]!.rating = -0.1; }],
    ["rating above five", (s) => { s.topics[0]!.rating = 5.01; }],
    ["duplicate IDs", (s) => { s.topics[1]!.id = s.topics[0]!.id; }],
    ["empty name", (s) => { s.topics[0]!.name = " "; }],
    ["empty message ID", (s) => { s.topics[0]!.evidence[0]!.messageId = ""; }],
    ["negative revision", (s) => { s.revision = -1; }],
    ["fractional revision", (s) => { s.revision = 1.5; }],
    ["unsafe revision", (s) => { s.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ["invalid Unicode", (s) => { s.teachingGuide = "\ud800"; }],
  ] satisfies [string, (s: LearnerMemorySnapshot) => void][]) {
    it(`rejects ${label}`, () => {
      const snapshot = fixture();
      mutate(snapshot);
      assert.throws(() => validateLearnerMemorySnapshot(snapshot));
    });
  }

  it("rejects unknown/missing/wrong-typed fields and explicit undefined optionals", () => {
    for (const value of [null, [], {}, { ...fixture(), unknown: true }, { ...fixture(), teachingGuide: 4 }, { ...fixture(), topics: {} }]) {
      assert.throws(() => validateLearnerMemorySnapshot(value));
    }
    const snapshot = fixture();
    snapshot.topics[0]!.confidence = undefined;
    assert.throws(() => validateLearnerMemorySnapshot(snapshot));
  });

  it("rejects torn document pairs and malformed or unsupported overviews", () => {
    const docs = renderLearnerMemory(fixture());
    assert.throws(() => parseLearnerMemory("different guide", docs.knowledgeOverview), /mismatched/);
    for (const overview of ["", "# Junk", docs.knowledgeOverview.replace('"version":1', '"version":2'), docs.knowledgeOverview.replace("- Rating: 0", "- Rating: 6"), docs.knowledgeOverview.replace("- Confidence: 0", "- Confidence: 100"), docs.knowledgeOverview + "unexpected text"]) {
      assert.throws(() => parseLearnerMemory(docs.teachingGuide, overview));
    }
  });
});

describe("learner memory filesystem store", () => {
  for (const platform of ["linux", "win32"] as const) {
    it(`syncs files on ${platform}, directories only on Unix`, async () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform });
      try {
        const original = fs.fsyncSync;
        let files = 0; let directories = 0;
        mock.method(fs, "fsyncSync", (fd: number) => {
          if (fs.fstatSync(fd).isDirectory()) {
            directories++;
            assert.notEqual(platform, "win32", "Windows must never sync a directory");
          } else files++;
          return original(fd);
        });
        const store = createLearnerMemoryStore(scratch());
        await store.commit(fixture(), 0);
        assert.ok(files >= 6, "seed and commit journals/documents must sync");
        assert.equal(directories > 0, platform !== "win32");
      } finally { Object.defineProperty(process, "platform", descriptor); }
    });
  }

  it("seeds exactly two readable final Markdown files, privately, including nested directories", async () => {
    const root = path.join(scratch(), "nested", "data");
    const store = createLearnerMemoryStore(root);
    assert.deepEqual(await store.read(), { teachingGuide: "", topics: [], revision: 0 });
    assert.deepEqual(fs.readdirSync(root).sort(), ["knowledge-overview.md", "teaching-guide.md"]);
    for (const directory of [root, path.dirname(root)]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const file of fs.readdirSync(root)) assert.equal(fs.statSync(path.join(root, file)).mode & 0o777, 0o600);
    assert.deepEqual(readPair(root), await store.read());
  });

  it("persists and reopens a full snapshot, increments revision, and detaches values", async () => {
    const root = scratch();
    const store = createLearnerMemoryStore(root);
    const snapshot = fixture();
    const pending = store.commit(snapshot, 0);
    snapshot.teachingGuide = "mutated after enqueue";
    const saved = await pending;
    assert.deepEqual(saved, { ...fixture(), revision: 1 });
    saved.topics.length = 0;
    assert.deepEqual(await createLearnerMemoryStore(root).read(), { ...fixture(), revision: 1 });
    assert.deepEqual(readPair(root), { ...fixture(), revision: 1 });
    for (const name of fs.readdirSync(root)) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);
  });

  it("serializes independent stores and alias roots: only one concurrent CAS wins, without data loss", async () => {
    const root = scratch();
    const first = createLearnerMemoryStore(root);
    const second = createLearnerMemoryStore(path.join(root, "."));
    const a = fixture();
    const b = { ...fixture(), teachingGuide: "second writer" };
    const results = await Promise.allSettled([first.commit(a, 0), second.commit(b, 0)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result) => result.status === "rejected");
    assert.ok(failure?.status === "rejected" && failure.reason instanceof LearnerMemoryRevisionConflictError);
    assert.equal(failure.reason.actualRevision, 1);
    assert.deepEqual(await second.read(), { ...a, revision: 1 });
    const latest = await second.read();
    latest.teachingGuide += "\nmerged update";
    assert.equal((await second.commit(latest, 1)).revision, 2);
    assert.deepEqual((await first.read()).topics, a.topics);
  });

  it("serializes readers after queued writes and continues after a failed CAS", async () => {
    const store = createLearnerMemoryStore(scratch());
    const write = store.commit(fixture(), 0);
    const read = store.read();
    assert.deepEqual(await read, await write);
    await assert.rejects(store.commit(fixture(), 0), LearnerMemoryRevisionConflictError);
    const latest = await store.read();
    assert.equal((await store.commit(latest, 1)).revision, 2);
    await assert.rejects(store.commit({ ...latest, revision: 99 }, 2), LearnerMemoryRevisionConflictError);
  });

  for (const interruptedTarget of ["teaching-guide.md", "knowledge-overview.md"]) {
    it(`recovers an interrupted commit before replacing ${interruptedTarget}, before returning any read`, async () => {
      const root = scratch();
      const store = createLearnerMemoryStore(root);
      await store.read();
      const original = fs.renameSync;
      const replacement = mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
        if (destination === path.join(root, interruptedTarget)) throw new Error("simulated crash");
        return original(source, destination);
      });
      await assert.rejects(store.commit(fixture(), 0), /simulated crash/);
      replacement.mock.restore();
      const pending = path.join(root, ".learner-memory.transaction.json");
      assert.equal(fs.statSync(pending).mode & 0o777, 0o600);
      assert.deepEqual(await createLearnerMemoryStore(root).read(), { ...fixture(), revision: 1 });
      assert.deepEqual(readPair(root), { ...fixture(), revision: 1 });
      assert.equal(fs.existsSync(pending), false);
      assert.deepEqual(fs.readdirSync(root).sort(), ["knowledge-overview.md", "teaching-guide.md"]);
    });
  }

  it("replays an already-installed pair if interrupted before journal removal", async () => {
    const root = scratch();
    const store = createLearnerMemoryStore(root);
    await store.read();
    const original = fs.unlinkSync;
    const replacement = mock.method(fs, "unlinkSync", (name: fs.PathLike) => {
      if (name === path.join(root, ".learner-memory.transaction.json")) throw new Error("simulated crash");
      return original(name);
    });
    await assert.rejects(store.commit(fixture(), 0), /simulated crash/);
    replacement.mock.restore();
    assert.deepEqual(readPair(root), { ...fixture(), revision: 1 });
    assert.deepEqual(await store.read(), { ...fixture(), revision: 1 });
    assert.equal(fs.existsSync(path.join(root, ".learner-memory.transaction.json")), false);
  });

  it("does not publish an undurable transaction temporary file", async () => {
    const root = scratch();
    const store = createLearnerMemoryStore(root);
    await store.read();
    fs.writeFileSync(path.join(root, ".learner-memory.transaction.json.tmp"), "partial JSON");
    assert.equal((await store.read()).revision, 0);
    await store.commit(fixture(), 0);
    assert.deepEqual(fs.readdirSync(root).sort(), ["knowledge-overview.md", "teaching-guide.md"]);
  });

  it("rejects corrupt or partial memory rather than erasing it, including on commit", async () => {
    for (const broken of ["teaching-guide.md", "knowledge-overview.md", ".learner-memory.transaction.json"]) {
      const root = scratch();
      const store = createLearnerMemoryStore(root);
      await store.commit(fixture(), 0);
      fs.writeFileSync(path.join(root, broken), "broken");
      const before = fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]);
      await assert.rejects(store.read());
      await assert.rejects(store.commit(fixture(), 0));
      assert.deepEqual(fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]), before);
    }
    const root = scratch();
    fs.writeFileSync(path.join(root, "teaching-guide.md"), "valuable guide");
    await assert.rejects(createLearnerMemoryStore(root).read(), /Incomplete/);
    assert.equal(fs.readFileSync(path.join(root, "teaching-guide.md"), "utf8"), "valuable guide");
  });

  it("rejects malformed transaction schema and invalid UTF-8", async () => {
    for (const transaction of [{ version: 2, snapshot: fixture() }, { version: 1, snapshot: fixture(), extra: 1 }, { version: 1, snapshot: {} }]) {
      const root = scratch();
      fs.writeFileSync(path.join(root, ".learner-memory.transaction.json"), JSON.stringify(transaction));
      await assert.rejects(createLearnerMemoryStore(root).read());
      assert.equal(fs.existsSync(path.join(root, "teaching-guide.md")), false);
    }
    const root = scratch();
    await createLearnerMemoryStore(root).commit(fixture(), 0);
    fs.writeFileSync(path.join(root, "teaching-guide.md"), Buffer.from([0xff]));
    await assert.rejects(createLearnerMemoryStore(root).read());
  });

  it("removes only a session's evidence, preserving ratings, guide, notes and other evidence", async () => {
    const root = scratch();
    const store = createLearnerMemoryStore(root);
    const saved = await store.commit(fixture(), 0);
    await store.removeSessionReferences("session-a");
    const expected = { ...saved, revision: 2, topics: saved.topics.map((topic) => ({ ...topic, evidence: topic.evidence.filter((e) => e.chatId !== "session-a") })) };
    assert.deepEqual(await store.read(), expected);
    assert.deepEqual(readPair(root), expected);
    await store.removeSessionReferences("session-a");
    assert.deepEqual(await store.read(), expected);
    await assert.rejects(store.commit(saved, 1), LearnerMemoryRevisionConflictError);
  });

  it("serializes deletion against a competing model write and preserves all other content", async () => {
    const root = scratch();
    const first = createLearnerMemoryStore(root);
    const second = createLearnerMemoryStore(root);
    const saved = await first.commit(fixture(), 0);
    const deletion = first.removeSessionReferences("session-a");
    const stale = second.commit(saved, 1);
    await deletion;
    await assert.rejects(stale, LearnerMemoryRevisionConflictError);
    assert.ok((await first.read()).topics.every((topic) => topic.evidence.every((e) => e.chatId !== "session-a")));
  });

  it("never interprets topic/session/message IDs as paths and refuses symlink/hardlink files", async () => {
    const root = scratch();
    const store = createLearnerMemoryStore(root);
    const snapshot = fixture();
    snapshot.topics[0]!.id = "../../outside";
    snapshot.topics[0]!.evidence = [{ chatId: "../../session", messageId: "/absolute/message" }];
    await store.commit(snapshot, 0);
    assert.deepEqual((await store.read()).topics, snapshot.topics);
    await store.removeSessionReferences("../../session");
    assert.deepEqual(fs.readdirSync(root).sort(), ["knowledge-overview.md", "teaching-guide.md"]);
    const external = path.join(scratch(), "private");
    fs.writeFileSync(external, "must not touch", { mode: 0o640 });
    fs.unlinkSync(path.join(root, "teaching-guide.md"));
    fs.symlinkSync(external, path.join(root, "teaching-guide.md"));
    await assert.rejects(store.read());
    assert.equal(fs.readFileSync(external, "utf8"), "must not touch");
    assert.equal(fs.statSync(external).mode & 0o777, 0o640);
    fs.unlinkSync(path.join(root, "teaching-guide.md"));
    fs.linkSync(external, path.join(root, "teaching-guide.md"));
    await assert.rejects(store.read(), /Unsafe/);
    assert.equal(fs.statSync(external).mode & 0o777, 0o640);
  });

  it("validates writes before touching storage", async () => {
    const root = path.join(scratch(), "not-created");
    const store = createLearnerMemoryStore(root);
    await assert.rejects(store.commit({ ...fixture(), revision: -1 }, 0));
    await assert.rejects(store.commit(fixture(), -1));
    await assert.rejects(store.removeSessionReferences(""));
    assert.equal(fs.existsSync(root), false);
  });
});