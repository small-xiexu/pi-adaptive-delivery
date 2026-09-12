import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest 只声明自有资源，不依赖或捆绑旧后端", async () => {
	const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	assert.deepEqual(manifest.pi, { extensions: ["./extensions/delivery-gate/index.ts"],
		image: "https://raw.githubusercontent.com/small-xiexu/pi-adaptive-delivery/main/docs/images/preview.png", skills: ["./skills"], prompts: ["./prompts"] });
	assert.match(manifest.pi.image, /^https:\/\/raw\.githubusercontent\.com\/small-xiexu\/pi-adaptive-delivery\//);
	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.bundledDependencies, undefined);
	const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
	assert.ok(!Object.keys(lock.packages).some((name) => name.endsWith("/pi-subagents")));
	assert.equal(lock.packages[""].bundleDependencies, undefined);
});
