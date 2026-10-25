"use strict";
const { publicCopilotError } = require("./copilot.cjs");
function attachCopilotChild(child, connection) {
	const send = (value) => { if (child.connected) child.send({ channel: "lh:copilot", ...value }, () => {}); };
	const listener = async (m) => {
		if (!m || m.channel !== "lh:copilot" || typeof m.id !== "string" || m.id.length > 100) return;
		try {
			let value;
			if (m.op === "status") value = await connection.status();
			else if (m.op === "lease" && typeof m.modelId === "string" && Number.isSafeInteger(m.revision)) value = await connection.lease(m.modelId, m.revision);
			else throw new Error("Invalid private operation");
			send({ id: m.id, op: m.op, ok: true, value });
		} catch (e) { send({ id: m.id, op: m.op, ok: false, error: publicCopilotError(e) }); }
	};
	child.on("message", listener);
	return { send, dispose: () => child.removeListener("message", listener) };
}
async function copilotControl(command, connection) {
	try {
		if (command?.op === "status") return await connection.status();
		if (command?.op === "login") return await connection.login(command.consent === true);
		if (command?.op === "cancel") return await connection.cancel();
		if (command?.op === "disconnect") return await connection.disconnect();
		if (command?.op === "open") return await connection.open();
		return { error: "Unsupported GitHub Copilot control." };
	} catch (e) { return { error: publicCopilotError(e) }; }
}
module.exports = { attachCopilotChild, copilotControl };