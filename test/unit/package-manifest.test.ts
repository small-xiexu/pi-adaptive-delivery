import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PI_SUBAGENTS_RUNTIME_VERSION } from "../../extensions/delivery-gate/src/subagents.ts";

interface PackageManifest {
	name: string;
	private?: boolean;
	engines?: { node?: string };
	pi?: {
		extensions?: string[];
		skills?: string[];
		prompts?: string[];
	};
	dependencies?: Record<string, string>;
	bundledDependencies?: string[];
}

async function loadManifest(): Promise<PackageManifest> {
	const source = await readFile(new URL("../../package.json", import.meta.url), "utf8");
	return JSON.parse(source) as PackageManifest;
}

test("loads one bundled pi-subagents runtime with its prompts and skills", async () => {
	const manifest = await loadManifest();

	assert.equal(manifest.name, "pi-adaptive-delivery");
	assert.equal(manifest.private, true);
	assert.equal(manifest.engines?.node, ">=22.19.0");
	assert.deepEqual(manifest.pi?.extensions, [
		"./node_modules/pi-subagents/index.ts",
		"./extensions/delivery-gate/index.ts",
	]);
	assert.deepEqual(manifest.pi?.skills, ["./node_modules/pi-subagents/skills", "./skills"]);
	assert.deepEqual(manifest.pi?.prompts, ["./node_modules/pi-subagents/prompts", "./prompts"]);
	assert.equal(manifest.dependencies?.["pi-subagents"], PI_SUBAGENTS_RUNTIME_VERSION);
	assert.deepEqual(manifest.bundledDependencies, ["pi-subagents"]);

	assert.equal(JSON.stringify(manifest.pi?.extensions).includes("node_modules/pi-subagents/index.ts"), true);
	assert.equal(JSON.stringify(manifest.pi?.skills).includes("node_modules/pi-subagents/skills"), true);
	assert.equal(JSON.stringify(manifest.pi?.prompts).includes("node_modules/pi-subagents/prompts"), true);
});
