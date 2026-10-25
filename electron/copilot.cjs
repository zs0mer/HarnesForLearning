"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const failure = (code) => Object.assign(new Error(code), { code });
function publicCopilotError(error) {
  return ({ secure_storage: "Secure OS credential storage is unavailable. GitHub Copilot requires encrypted storage.", storage: "GitHub Copilot credentials could not be read or saved securely. Reconnect in Providers.", cancelled: "GitHub Copilot sign-in cancelled.", consent: "Consent is required before GitHub Copilot sign-in.", disconnected: "GitHub Copilot is disconnected. Connect in Providers.", model: "This model is unavailable for your GitHub Copilot account. Choose an available model in Providers.", stale: "The GitHub Copilot connection changed. Retry with the current connection.", pending: "GitHub Copilot sign-in is already pending.", endpoint: "GitHub Copilot returned an untrusted authentication endpoint." })[error?.code] || "GitHub Copilot authorization failed. Check your connection and Copilot subscription, then reconnect. No API-key fallback was used.";
}
function allowedVerificationUrl(value) {
  try { const u = new URL(value); return u.origin === "https://github.com" && u.pathname === "/login/device" && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
function allowedCopilotBaseUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"].includes(u.hostname) && !u.port && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/";
  } catch { return false; }
}
function validateCopilotState(state) {
  if (!state || state.version !== 1 || !Object.hasOwn(state, "credential")) throw failure("storage");
  const c = state.credential;
  if (c !== null && (!c || c.type !== "oauth" || typeof c.access !== "string" || !c.access || typeof c.refresh !== "string" || !c.refresh || !Number.isFinite(c.expires) || c.enterpriseUrl || !Array.isArray(c.availableModelIds) || c.availableModelIds.some((id) => typeof id !== "string" || !id))) throw failure("storage");
  return { version: 1, credential: c === null ? null : { type: "oauth", access: c.access, refresh: c.refresh, expires: c.expires, availableModelIds: [...c.availableModelIds] } };
}
/** Main-process only, atomic encrypted envelope outside learning data. */
function encryptedCopilotStore(file, safeStorage) {
  function secure() { if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw failure("secure_storage"); }
  return {
    secure,
    async read() {
      secure();
      try {
        const envelope = JSON.parse(await fs.readFile(file, "utf8"));
        if (envelope.version !== 1 || typeof envelope.encrypted !== "string" || !envelope.encrypted || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.encrypted)) throw failure("storage");
        return validateCopilotState(JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, "base64"))));
      } catch (e) { if (e.code === "ENOENT") return null; throw failure("storage"); }
    },
    async write(state) {
      secure(); const value = validateCopilotState(state); const temp = `${file}.${randomUUID()}.tmp`; let handle;
      try {
        const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        handle = await fs.open(temp, "wx", 0o600); await handle.writeFile(JSON.stringify({ version: 1, encrypted })); await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temp, file);
        if (process.platform !== "win32") { const dir = await fs.open(path.dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); } }
      } catch { throw failure("storage"); }
      finally { await handle?.close().catch(() => { }); await fs.unlink(temp).catch(() => { }); }
    },
  };
}

/** One GitHub.com credential. OAuth and refresh stay behind private child IPC. */
function createCopilot({ store, loadOAuth, openExternal, onChange = () => { }, timeoutMs = 600000 }) {
  let credential = null; let initialized; let revision = 0; let error = null; let pending = null; let loginTask = Promise.resolve(); let queue = Promise.resolve();
  const serial = (fn) => { const next = queue.then(fn); queue = next.catch(() => { }); return next; };
  async function init() {
    if (!initialized) {
      const started = revision;
      initialized = store.read().then((state) => { const value = state ? validateCopilotState(state).credential : null; if (revision === started) credential = value; });
    }
    return initialized;
  }
  const snapshot = () => ({ available: true, connected: !!credential, pending: !!pending, revision, modelIds: credential?.availableModelIds ?? [], device: pending?.device ?? null, error });
  const publish = () => { onChange(snapshot()); };
  async function status() { try { await init(); } catch (e) { error = publicCopilotError(e); } return snapshot(); }
  async function checkedAuth(oauth, value) { const auth = await oauth.toAuth(value); if (!auth.apiKey || !allowedCopilotBaseUrl(auth.baseUrl)) throw failure("endpoint"); return auth; }
  async function login(consent) {
    if (consent !== true) throw failure("consent");
    if (pending) throw failure("pending");
    const started = revision;
    store.secure(); await init(); if (revision !== started) throw failure("cancelled"); if (pending) throw failure("pending"); if (credential) throw failure("disconnected");
    const attempt = { controller: new AbortController(), device: null }; pending = attempt; error = null; revision++; publish();
    const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(timeoutMs)]);
    loginTask = (async () => {
      try {
        const oauth = await loadOAuth();
        const result = await oauth.login({
          signal, prompt: async (prompt) => { if (prompt.type !== "text") throw failure("endpoint"); return ""; }, notify: (event) => {
            if (pending !== attempt || signal.aborted) return;
            if (event.type === "device_code") {
              if (!allowedVerificationUrl(event.verificationUri) || typeof event.userCode !== "string" || !/^[A-Z0-9-]{4,32}$/.test(event.userCode)) throw failure("endpoint");
              attempt.device = { userCode: event.userCode, verificationUri: event.verificationUri }; publish();
            }
          }
        });
        const validated = validateCopilotState({ version: 1, credential: result }).credential;
        await checkedAuth(oauth, validated);
        await serial(async () => {
          if (pending !== attempt || signal.aborted) return;
          await store.write({ version: 1, credential: validated });
          if (pending !== attempt || signal.aborted) { await store.write({ version: 1, credential: null }); return; }
          credential = validated; revision++;
        });
      } catch (e) { if (pending === attempt) error = signal.aborted ? publicCopilotError(failure("cancelled")) : publicCopilotError(e); }
      finally { if (pending === attempt) { pending = null; publish(); } }
    })();
    return snapshot();
  }
  async function cancel() { revision++; if (pending) { pending.controller.abort(); pending = null; error = null; } publish(); return status(); }
  async function disconnect() {
    await cancel(); revision++; credential = null; error = null; publish();
    try { await serial(async () => { await store.write({ version: 1, credential: null }); initialized = Promise.resolve(); }); }
    catch (e) { error = publicCopilotError(e); publish(); throw e; }
    return status();
  }
  async function lease(modelId, expectedRevision) {
    await init();
    return serial(async () => {
      const current = revision;
      if (expectedRevision !== current) throw failure("stale");
      if (!credential) throw failure("disconnected");
      const oauth = await loadOAuth();
      if (credential.expires - Date.now() < 300000) {
        const refreshed = await oauth.refresh(credential, AbortSignal.timeout(15000));
        const next = validateCopilotState({ version: 1, credential: refreshed }).credential;
        await checkedAuth(oauth, next);
        if (revision !== current) throw failure("stale");
        await store.write({ version: 1, credential: next });
        if (revision !== current) throw failure("stale");
        credential = next; publish();
      }
      if (!credential.availableModelIds.includes(modelId)) throw failure("model");
      const auth = await checkedAuth(oauth, credential);
      if (revision !== current || !credential) throw failure("stale");
      return { revision, auth };
    });
  }
  return { status, login, cancel, disconnect, lease, waitForLogin: () => loginTask, async open() { if (!pending?.device || !allowedVerificationUrl(pending.device.verificationUri)) throw failure("endpoint"); await openExternal(pending.device.verificationUri); return status(); } };
}
module.exports = { createCopilot, encryptedCopilotStore, validateCopilotState, allowedVerificationUrl, allowedCopilotBaseUrl, publicCopilotError };