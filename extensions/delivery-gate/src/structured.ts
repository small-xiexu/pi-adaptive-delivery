import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const STRUCTURED_TOOLS = ["exec_command", "write_stdin", "apply_patch", "view_image"];

export async function structuredPackage(tools: ToolInfo[]): Promise<{ root: string; version: string; tools: ToolInfo[] } | undefined> {
	const command = tools.find((tool) => tool.name === "exec_command");
	if (!command?.sourceInfo.path) return undefined;
	const entry = await realpath(command.sourceInfo.path);
	const root = path.dirname(path.dirname(entry));
	let metadata: { name?: string; version?: string };
	try { metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (metadata.name !== "@howaboua/pi-codex-conversion" || entry !== path.join(root, "dist", "index.js")) return undefined;
	return { root, version: metadata.version ?? "unknown", tools: tools.filter((tool) => STRUCTURED_TOOLS.includes(tool.name)) };
}
