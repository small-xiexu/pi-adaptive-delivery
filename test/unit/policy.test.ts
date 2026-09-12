import assert from "node:assert/strict";
import test from "node:test";
import { inheritedTools, installPolicy } from "../../extensions/delivery-gate/src/policy.ts";

function host() {
	const handlers = new Map<string, Function>();
	let active = ["read", "write", "bash", "web_search", "fetch_content", "plugin_tool", "delivery_develop"];
	const tools = active.concat("ls").map((name) => ({ name, sourceInfo: { source: "extension", path: name.startsWith("delivery_") ? "/owned/index.ts" : "/original/index.ts" } }));
	const pi: any = { getAllTools: () => tools, getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active = names; }, on: (name: string, handler: Function) => handlers.set(name, handler) };
	installPolicy(pi, "/owned/index.ts");
	return { pi, tools, handlers };
}

test("父子继承当前已启用的原工具，不补回停用工具或复制父协调入口", () => {
	const { pi } = host();
	const original = pi.getActiveTools();
	assert.deepEqual(inheritedTools(pi, "/owned/index.ts").map((tool) => tool.name), ["read", "write", "bash", "web_search", "fetch_content", "plugin_tool"]);
	assert.deepEqual(pi.getActiveTools(), original);
	pi.setActiveTools(["web_search"]);
	assert.deepEqual(inheritedTools(pi, "/owned/index.ts").map((tool) => tool.name), ["web_search"]);
});

test("不注册启动裁剪或 user_bash 拦截，所有普通工具交回 Pi 和原插件", () => {
	const { handlers, tools } = host();
	assert.equal(handlers.has("session_start"), false);
	assert.equal(handlers.has("user_bash"), false);
	for (const toolName of ["read", "edit", "write", "bash", "web_search", "fetch_content", "plugin_tool", "exec_command", "apply_patch", "unknown"]) {
		assert.equal(handlers.get("tool_call")!({ toolName }), undefined);
	}
	tools[0]!.sourceInfo.path = "/replacement/index.ts";
	assert.equal(handlers.get("tool_call")!({ toolName: "read" }), undefined, "原工具的替换规则也由 Pi 管理");
});

test("交付元数据读取失败只拒绝交付入口，不阻断普通工具", () => {
	const { pi, handlers } = host();
	pi.getAllTools = () => { throw new Error("fixture metadata failure"); };
	assert.equal(handlers.get("tool_call")!({ toolName: "web_search" }), undefined);
	assert.equal(handlers.get("tool_call")!({ toolName: "delivery_document_write" }).block, true);
});

for (const name of ["delivery_git_status", "delivery_readonly", "delivery_approval", "delivery_document_edit", "delivery_document_write", "delivery_develop", "delivery_review"]) test(`自有 ${name} 仍核实入口来源`, () => {
	const { tools, handlers } = host();
	const own = tools.find((tool) => tool.name === name) ?? { name, sourceInfo: { source: "extension", path: "/owned/index.ts" } };
	if (!tools.includes(own)) tools.push(own);
	assert.equal(handlers.get("tool_call")!({ toolName: name }), undefined);
	own.sourceInfo.path = "/foreign/index.ts";
	assert.equal(handlers.get("tool_call")!({ toolName: name }).block, true);
});
