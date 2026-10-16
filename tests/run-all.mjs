// Runs every check in this directory as its own node process; exits non-zero
// if any file fails. Wired as `npm test`.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs")
	.sort();

let failed = 0;
for (const file of files) {
	const result = spawnSync(process.execPath, [path.join(dir, file)], { encoding: "utf8" });
	if (result.status === 0) {
		console.log(`PASS ${file}`);
	} else {
		failed += 1;
		console.error(`FAIL ${file}`);
		if (result.stdout) console.error(result.stdout);
		if (result.stderr) console.error(result.stderr);
	}
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed === 0 ? 0 : 1);
