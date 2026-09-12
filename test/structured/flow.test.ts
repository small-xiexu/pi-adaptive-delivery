import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDevelopmentHost } from "../support/development-host.ts";
import { writeFile as writeFixture } from "node:fs/promises";

if (!process.env.ADAPTIVE_STRUCTURED_PACKAGE) throw new Error("Structured 验证须显式 --adapter <已安装 Package>；不静默跳过");
const adapter = process.env.ADAPTIVE_STRUCTURED_PACKAGE;

async function configure(f: any) {
	const settings = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8"));
	settings.packages = [f.packageDir, ...(settings.packages ?? []), adapter];
	settings.defaultTools = ["read", "bash", "write", "edit", "grep", "find", "ls"];
	await writeFixture(path.join(f.agentDir, "settings.json"), JSON.stringify(settings));
	await writeFixture(path.join(f.agentDir, "pi-codex-conversion.json"), JSON.stringify({ executionMode: "normal", voiceFeaturesOnly: false, scope: { allProviders: "on", additionalProviders: [] }, voice: { audioSetupCompleted: true }, openai: { forceCachedWebSockets: false, cacheKeepalive: false, lunaCacheKeepaliveMinutes: 0, verbosity: "low" } }));
}

test("Structured 环境的开发和审查仍使用两个职责子 Agent", { timeout: 90_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "structured-minimal", undefined, (fixture) => configure(fixture));
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const developed = await h.call("delivery_develop", { task: "把 value 修改为 2，并用 Structured 工具读取确认。" });
	assert.equal(developed.isError, false, JSON.stringify(developed));
	const reviewed = await h.call("delivery_review", { task: "独立检查实际差异，并运行必要的测试或编译命令。" });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	assert.ok((reviewed.details as any).candidate.digest);
	assert.equal(await h.readLease(), undefined);
	const events = await h.audit();
	assert.ok(events.some((row) => row.child && row.phase === "provider-payload" && row.payload?.tools?.some((tool: any) => tool.name === "exec_command")));
	assert.ok(!events.some((row) => JSON.stringify(row).includes("delivery_validate")));
});
