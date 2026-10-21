import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface ChildExtensionRegistry {
	registerRequiredChildExtensions(input: { sessionId: string; extensions: { id: string; path: string }[] }): {
		dispose(): void;
	};
}

/** Optional integration: native children must register their own virtual model callbacks. */
export async function childExtensionRegistry(): Promise<ChildExtensionRegistry | undefined> {
	let path: string;
	try {
		path = createRequire(import.meta.url).resolve("pi-subagents/required-child-extensions");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return undefined;
		throw error;
	}
	return import(pathToFileURL(path).href);
}
