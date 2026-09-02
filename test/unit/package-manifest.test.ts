import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("declares only this package's Pi resources", async () => {
	const manifest = await loadManifest();

	assert.equal(manifest.name, "pi-adaptive-delivery");
	assert.equal(manifest.private, true);
	assert.equal(manifest.engines?.node, ">=22.19.0");
	assert.deepEqual(manifest.pi?.extensions, ["./extensions/delivery-gate/index.ts"]);
	assert.deepEqual(manifest.pi?.skills, ["./skills"]);
	assert.deepEqual(manifest.pi?.prompts, ["./prompts"]);
	assert.equal(manifest.dependencies?.["pi-subagents"], "0.62.0");
	assert.deepEqual(manifest.bundledDependencies, ["pi-subagents"]);

	const exposedResources = JSON.stringify(manifest.pi);
	assert.equal(exposedResources.includes("node_modules/pi-subagents"), false);
});
