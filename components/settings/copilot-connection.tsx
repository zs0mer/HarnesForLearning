"use client";

import { useEffect, useRef, useState } from "react";
import type { CopilotStatus } from "@/src/core";
import { Button } from "@/components/ui/button";

export const COPILOT_NOTICE = "LearnHarness uses the model SDK’s bundled GitHub OAuth client to connect your GitHub.com account. Signing in may enable eligible model policies on your Copilot account. Your encrypted credentials stay on this device. This connection permits both interactive lessons and background work, including research, extraction, and compaction. Relevant conversation context, learning material, and tool results are sent to GitHub Copilot and its model services. Copilot subscription limits and premium-request charges may apply; LearnHarness does not calculate those charges.";
const empty: CopilotStatus = { available: false, connected: false, pending: false, revision: 0, modelIds: [], device: null, error: null };
function isStatus(value: unknown): value is CopilotStatus {
	if (!value || typeof value !== "object") return false;
	const s = value as CopilotStatus;
	return typeof s.available === "boolean" && typeof s.connected === "boolean" && typeof s.pending === "boolean" && Number.isSafeInteger(s.revision) && Array.isArray(s.modelIds) && s.modelIds.every((id) => typeof id === "string") && (s.error === null || typeof s.error === "string") && (s.device === null || (typeof s.device?.userCode === "string" && s.device.verificationUri === "https://github.com/login/device"));
}

/** Self-contained subscription row; Electron owns OAuth beyond this component's lifetime. */
export function CopilotConnection({ setup = false }: { setup?: boolean }) {
	const [status, setStatus] = useState(empty);
	const [confirm, setConfirm] = useState(false);
	const [consent, setConsent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [disconnecting, setDisconnecting] = useState(false);
	const sequence = useRef(0);
	const mounted = useRef(false);
	const receive = (value: unknown) => {
		if (isStatus(value)) setStatus(value);
		else setError("The GitHub Copilot connection could not be changed. Try again.");
	};
	useEffect(() => {
		mounted.current = true;
		const bridge = window.lh?.copilot;
		const refresh = async () => {
			const request = ++sequence.current;
			try { const value = await bridge?.status(); if (mounted.current && request === sequence.current && value) receive(value); }
			catch { if (mounted.current && request === sequence.current) setError("The GitHub Copilot desktop connection is unavailable."); }
		};
		void refresh(); const off = bridge?.onChange(() => void refresh());
		return () => { mounted.current = false; sequence.current++; off?.(); };
	}, []);
	async function control(action: "login" | "cancel" | "disconnect" | "open") {
		const bridge = window.lh?.copilot;
		if (!bridge || busy) return;
		setBusy(true); setError(null); const request = ++sequence.current;
		try {
			const value: unknown = action === "login" ? await bridge.login(consent) : await bridge[action]();
			if (!mounted.current) return;
			if (request === sequence.current) receive(value);
			else { const latest = ++sequence.current; const current = await bridge.status(); if (mounted.current && latest === sequence.current) receive(current); }
			if (value && typeof value === "object" && "error" in value && typeof value.error === "string") setError(value.error);
			if (action === "login") setConfirm(false);
			if (action === "disconnect") setDisconnecting(false);
		} catch { if (mounted.current) setError("The GitHub Copilot connection could not be changed. Try again."); }
		finally { if (mounted.current) setBusy(false); }
	}
	return <div data-testid="copilot-connection" className="space-y-3 py-2 text-xs">
		<div className="flex items-center justify-between gap-3">
			<div><span className="font-ui text-foreground">GitHub Copilot</span><span className="ml-2 text-muted-foreground">{status.connected ? "Connected" : status.pending ? "Awaiting authorization" : "Subscription"}</span></div>
			{status.connected ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDisconnecting(true)}>Disconnect</Button> : !status.pending && <Button variant="outline" size="sm" disabled={!status.available || busy} onClick={() => { setConfirm(true); setConsent(false); }}>Connect GitHub Copilot</Button>}
		</div>
		{!status.available && <p className="text-muted-foreground">Available in the desktop app with its private server connection.</p>}
		{confirm && <div className="space-y-3 rounded-sm border border-border p-3" data-testid="copilot-consent">
			<p className="leading-relaxed text-muted-foreground">{COPILOT_NOTICE}</p>
			<label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I agree to connect and authorize interactive and background use.</span></label>
			<div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button><Button size="sm" disabled={!consent || busy} onClick={() => void control("login")}>Continue to GitHub</Button></div>
		</div>}
		{status.pending && <div className="space-y-2 rounded-sm border border-border p-3" aria-live="polite">
			{status.device ? <><p>Enter this code at github.com/login/device:</p><code className="block select-all text-base tracking-widest">{status.device.userCode}</code><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void control("open")}>Open GitHub</Button><Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(status.device!.userCode).then(() => { if (mounted.current) setCopied(true); }).catch(() => setError("Could not copy the code. Select and copy it manually.")); }}>{copied ? "Copied" : "Copy code"}</Button></div></> : <p>Preparing GitHub sign-in…</p>}
			<Button variant="ghost" size="sm" disabled={busy} onClick={() => void control("cancel")}>Cancel sign-in</Button>
		</div>}
		{disconnecting && <div className="space-y-2 rounded-sm border border-border p-3"><p>Disconnect GitHub Copilot? This removes its credentials from this device, not GitHub’s authorization. Revoke access in GitHub settings if needed.</p><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setDisconnecting(false)}>Cancel</Button><Button variant="destructive" size="sm" disabled={busy} onClick={() => void control("disconnect")}>Disconnect account</Button></div></div>}
		{status.connected && !setup && <p className="text-muted-foreground">{status.modelIds.length} account models reported. Interactive and background use authorized. Subscription limits apply.</p>}
		{(error || status.error) && <p role="alert" className="text-red-400">{error || status.error}</p>}
	</div>;
}