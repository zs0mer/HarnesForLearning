import fs from "node:fs";
import path from "node:path";
import {
  LearnerMemoryRevisionConflictError,
  parseLearnerMemory,
  renderLearnerMemory,
  validateLearnerMemoryRevision,
  validateLearnerMemorySnapshot,
  type LearnerMemorySnapshot,
  type LearnerMemoryStore,
} from "../core/learner-memory.ts";

// Shared across factory instances and module reloads. Only fixed names reach the filesystem;
// topic IDs, session IDs and message IDs are always data, never path components.
const queueKey = Symbol.for("learnharness.learner-memory.queues");
const globals = globalThis as typeof globalThis & { [queueKey]?: Map<string, Promise<unknown>> };
const queues = globals[queueKey] ??= new Map<string, Promise<unknown>>();
const journal = ".learner-memory.transaction.json";
const guide = "teaching-guide.md";
const overview = "knowledge-overview.md";

function syncDirectory(root: string): void {
  // Match the encrypted store: file fsync is mandatory on every platform;
  // opening/fsyncing directories is supported on Unix, not Windows.
  if (process.platform === "win32") return;
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readFile(root: string, name: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe learner memory file");
    fs.fchmodSync(fd, 0o600);
    const bytes = fs.readFileSync(fd);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally { fs.closeSync(fd); }
}

function atomicWrite(root: string, name: string, content: string): void {
  const temporary = path.join(root, `${name}.tmp`);
  // Unlink (never follow) abandoned temporary files from a previous crash.
  fs.rmSync(temporary, { force: true });
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, path.join(root, name));
  syncDirectory(root);
}

/** A durable journal is the commit point. Recovery always rolls the complete pair forward.
 * Readers through this port never see a torn pair; unrelated direct filesystem readers
 * must not assume two separate filesystem renames are a single atomic operation.
 * Serialization is process-wide, not an interprocess lock.
 */
export function createLearnerMemoryStore(root: string): LearnerMemoryStore {
  if (typeof root !== "string" || !root || root.includes("\0")) throw new Error("Invalid learner memory root");
  const requestedRoot = path.resolve(root);

  function serialized<T>(operation: (directory: string) => T): Promise<T> {
    try {
      fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      const directory = fs.realpathSync(requestedRoot);
      fs.chmodSync(directory, 0o700);
      const previous = queues.get(directory) ?? Promise.resolve();
      const result = previous.catch(() => undefined).then(() => operation(directory));
      queues.set(directory, result);
      void result.finally(() => {
        if (queues.get(directory) === result) queues.delete(directory);
      }).catch(() => undefined);
      return result;
    } catch (error) { return Promise.reject(error); }
  }

  function finish(directory: string, snapshot: LearnerMemorySnapshot): void {
    const documents = renderLearnerMemory(snapshot);
    atomicWrite(directory, guide, documents.teachingGuide);
    atomicWrite(directory, overview, documents.knowledgeOverview);
    fs.unlinkSync(path.join(directory, journal));
    syncDirectory(directory);
  }

  function persist(directory: string, snapshot: LearnerMemorySnapshot): void {
    atomicWrite(directory, journal, JSON.stringify({ version: 1, snapshot }));
    finish(directory, snapshot);
  }

  function load(directory: string): LearnerMemorySnapshot {
    const pending = readFile(directory, journal);
    if (pending !== undefined) {
      const transaction: unknown = JSON.parse(pending);
      if (!transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
        Object.keys(transaction).sort().join(",") !== "snapshot,version" ||
        (transaction as { version: unknown }).version !== 1) {
        throw new Error("Invalid learner memory transaction");
      }
      finish(directory, validateLearnerMemorySnapshot((transaction as { snapshot: unknown }).snapshot));
    }
    const teachingGuide = readFile(directory, guide);
    const knowledgeOverview = readFile(directory, overview);
    if (teachingGuide === undefined && knowledgeOverview === undefined) {
      const empty = { teachingGuide: "", topics: [], revision: 0 };
      persist(directory, empty);
      return empty;
    }
    if (teachingGuide === undefined || knowledgeOverview === undefined) throw new Error("Incomplete learner memory document pair");
    return parseLearnerMemory(teachingGuide, knowledgeOverview);
  }

  return {
    read: () => serialized(load),
    async commit(value, expectedRevision) {
      // Copy before queuing so a caller cannot mutate a pending write.
      const snapshot = validateLearnerMemorySnapshot(value);
      validateLearnerMemoryRevision(expectedRevision);
      if (snapshot.revision !== expectedRevision) throw new LearnerMemoryRevisionConflictError(expectedRevision, snapshot.revision);
      return serialized((directory) => {
        const current = load(directory);
        if (current.revision !== expectedRevision) throw new LearnerMemoryRevisionConflictError(expectedRevision, current.revision);
        const next = validateLearnerMemorySnapshot({ ...snapshot, revision: current.revision + 1 });
        persist(directory, next);
        return next;
      });
    },
    async removeSessionReferences(chatId) {
      if (typeof chatId !== "string" || !chatId.trim() || /[\uD800-\uDFFF]/u.test(chatId)) throw new Error("Invalid chat id");
      return serialized((directory) => {
        const current = load(directory);
        let changed = false;
        const topics = current.topics.map((topic) => {
          const evidence = topic.evidence.filter((reference) => reference.chatId !== chatId);
          if (evidence.length !== topic.evidence.length) changed = true;
          return { ...topic, evidence };
        });
        if (changed) persist(directory, validateLearnerMemorySnapshot({ ...current, topics, revision: current.revision + 1 }));
      });
    },
  };
}