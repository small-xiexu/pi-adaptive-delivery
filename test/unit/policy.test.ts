import assert from "node:assert/strict";
import test from "node:test";
import { allowedReadTools, installPolicy } from "../../extensions/delivery-gate/src/policy.ts";

function host(coordinatorPath?: string, developerPath?: string) {
	const handlers = new Map<string, Function>();
	let active = ["read", "write", "bash"];
	const tools: { name: string; sourceInfo: { source: string; path?: string } }[] = ["read", "write", "bash", "ls"].map((name) => ({ name, sourceInfo: { source: "builtin" } }));
	const pi: any = { getAllTools: () => tools, getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; }, on: (name: string, handler: Function) => handlers.set(name, handler) };
	installPolicy(pi, coordinatorPath, developerPath);
	return { pi, tools, handlers };
}

test("只保留当前已启用的原生只读工具，不扩大用户工具选择", () => {
	const { pi, handlers } = host();
	assert.deepEqual(allowedReadTools(pi), ["read"]);
	handlers.get("session_start")!();
	assert.deepEqual(pi.getActiveTools(), ["read"]);
});

test("实际调用边界拒绝重新激活的写工具与未知工具", () => {
	const { handlers } = host();
	for (const toolName of ["write", "bash", "unknown"]) assert.equal(handlers.get("tool_call")!({ toolName }).block, true);
	assert.equal(handlers.get("tool_call")!({ toolName: "read" }), undefined);
	assert.equal(handlers.get("user_bash")!().result.exitCode, 1);
});

test("同名工具实现被覆盖后不能继承原生只读权限", () => {
	const { tools, handlers } = host();
	tools[0]!.sourceInfo.source = "extension";
	assert.equal(handlers.get("tool_call")!({ toolName: "read" }).block, true);
});

test("权限核对异常时显式拒绝，不把异常交给扩展调度器后继续执行", () => {
	const { pi, handlers } = host();
	pi.getAllTools = () => { throw new Error("fixture metadata failure"); };
	for (const toolName of ["read", "delivery_document_edit", "delivery_document_write"]) {
		assert.equal(handlers.get("tool_call")!({ toolName }).block, true);
	}
});

for (const name of ["delivery_git_status", "delivery_readonly", "delivery_approval", "delivery_document_edit", "delivery_document_write", "delivery_develop", "delivery_validate", "delivery_review"]) test(`只有父角色的自有 ${name} 可以调用，同名覆盖立即失权`, () => {
	const { pi, tools, handlers } = host("/owned/index.ts");
	const tool = { name, sourceInfo: { source: "extension", path: "/owned/index.ts" } };
	tools.push(tool);
	pi.setActiveTools(["read", tool.name]);
	handlers.get("session_start")!();
	assert.deepEqual(pi.getActiveTools(), ["read", tool.name]);
	assert.equal(handlers.get("tool_call")!({ toolName: tool.name }), undefined);
	tool.sourceInfo.path = "/foreign/index.ts";
	assert.equal(handlers.get("tool_call")!({ toolName: tool.name }).block, true);
	const child = host();
	child.tools.push({ ...tool, sourceInfo: { source: "extension", path: "/owned/index.ts" } });
	assert.equal(child.handlers.get("tool_call")!({ toolName: tool.name }).block, true);
});

for (const name of ["edit", "write", "bash"]) test(`开发子角色仅允许自有 ${name} 进入执行，覆盖与宿主 Shell 仍拒绝`, () => {
	const { pi, tools, handlers } = host(undefined, "/owned/index.ts");
	const own = { name, sourceInfo: { source: "extension", path: "/owned/index.ts" } };
	const existing = tools.findIndex((tool) => tool.name === name);
	if (existing >= 0) tools[existing] = own;
	else tools.push(own);
	pi.setActiveTools(["read", ...new Set([name, "bash"])]);
	handlers.get("session_start")!();
	assert.deepEqual(pi.getActiveTools(), ["read", name]);
	assert.equal(handlers.get("tool_call")!({ toolName: name }), undefined);
	if (name !== "bash") assert.equal(handlers.get("tool_call")!({ toolName: "bash" }).block, true);
	assert.equal(handlers.get("user_bash")!().result.exitCode, 1);
	own.sourceInfo.path = "/foreign/index.ts";
	assert.equal(handlers.get("tool_call")!({ toolName: name }).block, true);
});
