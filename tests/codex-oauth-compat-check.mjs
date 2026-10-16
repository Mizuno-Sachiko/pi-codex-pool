import assert from "node:assert/strict";
import { createOAuthInteraction } from "../src/oauth-compat.mts";

const notifications = [];
const urls = [];
const ui = {
	notify: (message) => notifications.push(message),
	input: async () => "synthetic-code",
	select: async (_title, choices) => choices[1],
};
const interaction = createOAuthInteraction(ui, (url) => urls.push(url));
interaction.notify({ type: "auth_url", url: "https://example.test", instructions: "Sign in" });
interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://example.test/device" });
interaction.notify({ type: "progress", message: "Waiting" });
interaction.notify({ type: "info", message: "Ready" });
assert.deepEqual(urls, ["https://example.test", "https://example.test/device"]);
assert.deepEqual(notifications, [
	"Sign in\nhttps://example.test",
	"Open https://example.test/device\nCode: ABCD-EFGH",
	"Waiting",
	"Ready",
]);
assert.equal(
	await interaction.prompt({
		type: "select",
		message: "Choose",
		options: [
			{ id: "browser", label: "Same label" },
			{ id: "device — code", label: "Same label" },
		],
	}),
	"device — code",
);
for (const type of ["text", "secret", "manual_code"])
	assert.equal(await interaction.prompt({ type, message: "Code" }), "synthetic-code");

// Native dialogs receive the prompt's cancellation, so a completed callback closes the dialog.
for (const type of ["manual_code", "select"]) {
	const abort = new AbortController();
	let dialogClosed = false;
	const pendingDialog = (_title, _choices, { signal }) =>
		new Promise((resolve) => {
			signal.addEventListener(
				"abort",
				() => {
					dialogClosed = true;
					resolve(undefined);
				},
				{ once: true },
			);
		});
	const flow = createOAuthInteraction({ ...ui, input: pendingDialog, select: pendingDialog }, () => {});
	const pending = flow.prompt({ type, message: "Code", options: [], signal: abort.signal });
	const reason = new Error("Callback completed");
	abort.abort(reason);
	await assert.rejects(pending, (error) => error === reason);
	assert.equal(dialogClosed, true);
	assert.equal(flow.signal.aborted, false, "a completed prompt must not cancel the login");
}

const abort = new AbortController();
abort.abort(new Error("Already completed"));
let opened = false;
await assert.rejects(
	createOAuthInteraction(
		{
			...ui,
			input: async () => {
				opened = true;
			},
		},
		() => {},
	).prompt({ type: "manual_code", message: "Code", signal: abort.signal }),
	/Already completed/,
);
assert.equal(opened, false);
for (const type of ["text", "select"]) {
	const cancelled = createOAuthInteraction(
		{ ...ui, input: async () => undefined, select: async () => undefined },
		() => {},
	);
	await assert.rejects(cancelled.prompt({ type, message: "Choose", options: [] }), /OAuth login cancelled/);
	assert.equal(cancelled.signal.aborted, true);
}
console.log("native OAuth events, option identity, dialog cancellation and callback recovery checks passed");
