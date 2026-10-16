import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export function createOAuthInteraction(
	ui: Pick<ExtensionUIContext, "input" | "select" | "notify">,
	openUrl: (url: string) => void,
): ProviderAuthInteraction {
	const controller = new AbortController();
	return {
		signal: controller.signal,
		notify(event) {
			if (event.type === "auth_url") {
				openUrl(event.url);
				ui.notify(
					`${event.instructions ? `${event.instructions}\n` : "Open this URL to authenticate:\n"}${event.url}`,
					"info",
				);
			} else if (event.type === "device_code") {
				openUrl(event.verificationUri);
				ui.notify(`Open ${event.verificationUri}\nCode: ${event.userCode}`, "info");
			} else {
				ui.notify(event.message, "info");
			}
		},
		async prompt(prompt) {
			const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
			signal.throwIfAborted();
			let value: string | undefined;
			if (prompt.type === "select") {
				const labels = prompt.options.map((option) => `${option.id} — ${option.label}`);
				const selected = await ui.select(prompt.message, labels, { signal });
				value = prompt.options[labels.indexOf(selected ?? "")]?.id;
			} else {
				value = await ui.input(prompt.message, prompt.placeholder, { signal });
			}
			// A callback-server result cancels only its pending dialog, not the entire login.
			signal.throwIfAborted();
			if (value === undefined) {
				const error = new Error("OAuth login cancelled");
				controller.abort(error);
				throw error;
			}
			return value;
		},
	};
}
