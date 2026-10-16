import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const directory = mkdtempSync(join(tmpdir(), "pool-auth-"));
const authPath = join(directory, "auth.json");
const other = { type: "api_key", key: "synthetic-unrelated" };
writeFileSync(authPath, JSON.stringify({ other }));
const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
let refreshes = 0;
runtime.registerNativeProvider({
	id: "synthetic-account",
	name: "Synthetic account",
	getModels: () => [],
	auth: {
		oauth: {
			name: "Synthetic login",
			login: async (interaction) => ({
				type: "oauth",
				access: await interaction.prompt({ type: "text", message: "Synthetic token" }),
				refresh: "synthetic-refresh",
				expires: 1,
			}),
			refresh: async (credential) => {
				refreshes++;
				return { ...credential, access: "synthetic-refreshed", expires: Date.now() + 3_600_000 };
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		},
	},
});
await runtime.login("synthetic-account", "oauth", { prompt: async () => "synthetic-initial", notify() {} });
assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["synthetic-account"].access, "synthetic-initial");
const results = await Promise.all(Array.from({ length: 3 }, () => runtime.getAuth("synthetic-account")));
assert.equal(refreshes, 1, "concurrent requests must share the stored token refresh");
for (const result of results) assert.equal(result.auth.apiKey, "synthetic-refreshed");
assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["synthetic-account"].access, "synthetic-refreshed");
await runtime.logout("synthetic-account");
assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { other });
console.log("native credential login, serialized refresh, persistence and logout checks passed");
