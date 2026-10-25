import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createCopilot, encryptedCopilotStore, validateCopilotState, allowedVerificationUrl, allowedCopilotBaseUrl } = require("../electron/copilot.cjs");
const { attachCopilotChild, copilotControl } = require("../electron/copilot-ipc.cjs");

function fixture() {
	let saved: any = null;
	let finish: (value: any) => void = () => {};
	let interaction: any;
	let refreshes = 0;
	const credential = { type: "oauth", access: "copilot-secret", refresh: "github-secret", expires: Date.now() + 3_600_000, availableModelIds: ["model-a"] };
	const service = createCopilot({
		store: { secure() {}, async read() { return saved; }, async write(value: any) { saved = structuredClone(value); } },
		loadOAuth: async () => ({
			async login(value: any) { interaction = value; return new Promise((resolve) => { finish = resolve; }); },
			async refresh(value: any) { refreshes++; return { ...value, expires: Date.now() + 3_600_000 }; },
			async toAuth(value: any) { return { apiKey: value.access, baseUrl: "https://api.individual.githubcopilot.com" }; },
		}),
		openExternal: async () => {},
	});
	return { service, credential, get saved() { return saved; }, get interaction() { return interaction; }, get refreshes() { return refreshes; }, finish: (v = credential) => finish(v) };
}

describe("Copilot desktop OAuth ownership", () => {
	it("requires explicit consent before invoking OAuth", async () => {
		const f = fixture();
		await assert.rejects(f.service.login(false));
		assert.equal(f.interaction, undefined);
	});
	it("publishes only the device challenge, stores credentials, and leases only an available model", async () => {
		const f = fixture();
		assert.equal((await f.service.login(true)).pending, true);
		await new Promise(setImmediate);
		assert.equal(await f.interaction.prompt({ type: "text" }), "");
		f.interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
		assert.equal((await f.service.status()).device.userCode, "ABCD-1234");
		f.finish(); await f.service.waitForLogin();
		const status = await f.service.status();
		assert.equal(status.connected, true);
		assert.equal(JSON.stringify(status).includes("secret"), false);
		assert.equal(f.saved.credential.refresh, "github-secret");
		assert.equal((await f.service.lease("model-a", status.revision)).auth.apiKey, "copilot-secret");
		await assert.rejects(f.service.lease("other", status.revision));
		await f.service.disconnect();
		await assert.rejects(f.service.lease("model-a", status.revision));
		assert.equal(f.saved.credential, null);
	});
	it("cancellation fences a late login completion", async () => {
		const f = fixture(); await f.service.login(true); await new Promise(setImmediate);
		await f.service.cancel(); f.finish(); await f.service.waitForLogin();
		assert.equal((await f.service.status()).connected, false);
		assert.equal(f.saved, null);
	});
	it("serializes refresh and persists before leasing", async () => {
		const f = fixture(); await f.service.login(true); await new Promise(setImmediate);
		f.finish({ ...f.credential, expires: 0 }); await f.service.waitForLogin();
		const { revision } = await f.service.status();
		await Promise.all([f.service.lease("model-a", revision), f.service.lease("model-a", revision)]);
		assert.equal(f.refreshes, 1);
		assert.ok(f.saved.credential.expires > Date.now());
	});
	it("rejects credential routing and verification URLs outside approved hosts", () => {
		assert.equal(allowedVerificationUrl("https://github.com/login/device"), true);
		for (const url of ["http://github.com/login/device", "https://github.com.evil.test/login/device", "https://github.com/login/device?token=x"]) assert.equal(allowedVerificationUrl(url), false);
		assert.equal(allowedCopilotBaseUrl("https://api.individual.githubcopilot.com"), true);
		for (const url of ["https://evil.test", "http://api.githubcopilot.com", "https://api.githubcopilot.com/evil"]) assert.equal(allowedCopilotBaseUrl(url), false);
		assert.throws(() => validateCopilotState({ version: 1, credential: { type: "oauth" } }));
	});
});

describe("Copilot secure persistence and IPC", () => {
	it("disconnect fences login still awaiting credential initialization", async () => {
		let resolve!: (value: null) => void;
		const read = new Promise<null>((done) => { resolve = done; }); let logins = 0;
		const service = createCopilot({ store: { secure() {}, read: () => read, write: async () => {} }, loadOAuth: async () => { logins++; throw new Error("must not load"); }, openExternal: async () => {} });
		const login = assert.rejects(service.login(true));
		const disconnect = service.disconnect();
		resolve(null); await Promise.all([login, disconnect]);
		assert.equal(logins, 0); assert.equal((await service.status()).connected, false);
	});
	it("requires OS encryption, roundtrips an encrypted envelope, and rejects damaged storage", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-copilot-"));
		const file = path.join(dir, "copilot.enc.json");
		const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test", encryptString: (text: string) => Buffer.from(text).map((v) => v ^ 0x55), decryptString: (value: Buffer) => value.map((v) => v ^ 0x55).toString() };
		try {
			const store = encryptedCopilotStore(file, safe);
			assert.equal(await store.read(), null);
			const value = { version: 1, credential: fixture().credential };
			await store.write(value);
			assert.deepEqual(await store.read(), value);
			assert.equal((await fs.readFile(file, "utf8")).includes("github-secret"), false);
			if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
			await fs.writeFile(file, "broken"); await assert.rejects(store.read());
			await assert.rejects(encryptedCopilotStore(file, { ...safe, getSelectedStorageBackend: () => "basic_text" }).read());
			assert.throws(() => encryptedCopilotStore(file, { ...safe, isEncryptionAvailable: () => false }).secure());
		} finally { await fs.rm(dir, { recursive: true, force: true }); }
	});
	it("renderer controls cannot request leases and require actual boolean consent", async () => {
		const f = fixture();
		assert.match((await copilotControl({ op: "lease" }, f.service)).error, /Unsupported/);
		assert.match((await copilotControl({ op: "login", consent: "true" }, f.service)).error, /Consent/);
		assert.equal(f.interaction, undefined);
	});
	it("only inherited child messages can lease and rejects unknown operations", async () => {
		const child = new EventEmitter() as EventEmitter & { connected: boolean; send: (message: unknown, cb: () => void) => void };
		const replies: any[] = []; child.connected = true; child.send = (value, cb) => { replies.push(value); cb(); };
		let leases = 0;
		const bridge = attachCopilotChild(child, { status: async () => ({ connected: true }), lease: async () => { leases++; return { auth: { apiKey: "private" } }; } });
		child.emit("message", { channel: "other", id: "ignored", op: "lease", modelId: "a", revision: 1 });
		child.emit("message", { channel: "lh:copilot", id: "1", op: "login" });
		child.emit("message", { channel: "lh:copilot", id: "2", op: "lease", modelId: "a", revision: 1 });
		await new Promise(setImmediate);
		assert.equal(leases, 1); assert.equal(replies.length, 2);
		assert.equal(replies.find((r) => r.id === "1").ok, false);
		assert.equal(replies.find((r) => r.id === "2").value.auth.apiKey, "private");
		bridge.dispose(); assert.equal(child.listenerCount("message"), 0);
	});
	it("failed refresh preserves saved credentials and redacts upstream diagnostics", async () => {
		const old = { ...fixture().credential, expires: 0 }; let saved = { version: 1, credential: old };
		const service = createCopilot({ store: { secure() {}, read: async () => saved, write: async (v: any) => { saved = v; } }, loadOAuth: async () => ({ refresh: async () => { throw new Error("secret upstream token"); } }), openExternal: async () => {} });
		const { revision } = await service.status();
		await assert.rejects(service.lease("model-a", revision));
		assert.deepEqual(saved.credential, old);
		const result = await copilotControl({ op: "open" }, service);
		assert.equal(JSON.stringify(result).includes("secret upstream"), false);
	});
});