import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDevelopmentHost } from "../support/development-host.ts";

test("父与分析/开发子实际继承联网和插件工具，原插件检查继续拒绝，停用工具不被补回", { timeout: 45_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "inherited", undefined, async (f) => {
		await mkdir(path.join(f.agentDir, "extensions"));
		await writeFile(path.join(f.agentDir, "extensions", "inherited.ts"), `import { Type } from "typebox";
export default function(pi) {
  for (const name of ["web_search", "fetch_content", "plugin_echo", "disabled_probe"]) pi.registerTool({
    name, label: name, description: "离线工具替身，不请求网络", parameters: Type.Object({ query: Type.Optional(Type.String()), url: Type.Optional(Type.String()) }),
    execute: async (_id, args, _signal, _update, ctx) => {
      pi.appendEntry("inherited-tool-executed", { name, args, child: Boolean(process.env.PI_ADAPTIVE_DELIVERY_CHILD) });
      return { content: [{ type: "text", text: "ORIGINAL_" + name + ":" + JSON.stringify(args) }], details: {} };
    }
  });
  pi.on("session_start", () => pi.setActiveTools(pi.getActiveTools().filter(name => name !== "disabled_probe")));
  pi.on("tool_call", event => event.toolName === "web_search" && event.input.query === "blocked" ? { block: true, reason: "ORIGINAL_PLUGIN_DENIED" } : undefined);
}`);
	}, false);
	const original = h.session.getActiveToolNames();
	assert.ok(original.includes("web_search") && original.includes("fetch_content") && original.includes("bash"));
	assert.ok(!original.includes("disabled_probe"));
	assert.equal((await h.call("web_search", { query: "before" })).isError, false);
	await h.session.prompt("/delivery-shape");
	assert.deepEqual(h.session.getActiveToolNames().filter((name) => !name.startsWith("delivery_")), original);
	for (const name of ["web_search", "fetch_content", "plugin_echo"]) assert.equal((await h.call(name, {})).isError, false);
	const blocked = await h.call("web_search", { query: "blocked" });
	assert.equal(blocked.isError, true);
	assert.match(JSON.stringify(blocked.content), /ORIGINAL_PLUGIN_DENIED/);
	assert.equal((await h.call("write", { path: "original.txt", content: "原工具\n" })).isError, false);
	assert.equal((await h.call("bash", { command: "printf ORIGINAL_SHELL" })).isError, false);
	assert.equal((await h.call("delivery_develop", { task: "尚未取得交付批准" })).isError, true, "交付入口本身仍要求两次确认");
	const analysis = await h.call("delivery_readonly", { task: "fixture-inherited-tools：核对联网工具与原插件检查" });
	await h.prepare();
	const development = await h.call("delivery_develop", { task: "fixture-inherited-tools：开发阶段也可查资料" });
	for (const result of [analysis, development]) {
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.equal((result.details as any).progress.status, "已结束，有工具错误待核对");
		const file = (result.details as any).sessionFile ?? (result.details as any).childSessionFile;
		const entries = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		const tools = entries.filter((row) => row.message?.role === "toolResult").map((row) => row.message);
		assert.deepEqual(tools.map((tool) => [tool.toolName, tool.isError]), [["web_search", false], ["fetch_content", false], ["plugin_echo", false], ["web_search", true]]);
		assert.match(JSON.stringify(tools.at(-1).content), /ORIGINAL_PLUGIN_DENIED/);
		assert.equal(entries.filter((row) => row.customType === "inherited-tool-executed").length, 3, "被原插件拒绝的工具不能实际执行");
		const ready = entries.find((row) => row.customType === "delivery-child-ready");
		assert.deepEqual(ready.data.environment.tools.map((tool: any) => tool.name).sort(), [...original].sort());
		assert.throws(() => process.kill((result.details as any).pid, 0), { code: "ESRCH" });
	}
	assert.equal(await h.readLease(), undefined);
	await h.session.prompt("/delivery-exit");
	assert.deepEqual(h.session.getActiveToolNames(), original);
});
