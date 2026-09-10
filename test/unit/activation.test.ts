import assert from "node:assert/strict";
import test from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { installActivation } from "../../extensions/delivery-gate/src/activation.ts";

function host(entries: any[] = []) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const messages: any[] = [];
	let tools = ["read", "bash", "plugin"];
	let starts = 0, reloads = 0;
	let idle = true, queued = false, blocked = false;
	const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		getActiveTools: () => [...tools], getAllTools: () => ["read", "bash", "plugin"].map((name) => ({ name })), setActiveTools: (names: string[]) => { tools = names; },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendUserMessage: (...args: any[]) => messages.push(args), sendMessage: (...args: any[]) => messages.push(args) };
	const ctx: any = { sessionManager: { getEntries: () => entries }, isIdle: () => idle, hasPendingMessages: () => queued,
		ui: { notify: (text: string) => notices.push(text) }, reload: async () => { reloads++; } };
	installActivation(pi, (current) => { assert.equal(current, ctx); starts++; return { initialize: async () => { tools = ["read"]; }, assertCanExit: async () => { if (blocked) throw new Error("未知 writer"); } }; });
	const autocomplete = new CombinedAutocompleteProvider([...commands].map(([name, command]) => ({ name, description: command.description })), "/tmp");
	return { pi, ctx, entries, notices, messages, handlers, command: (name: string, args = "") => commands.get(name).handler(args, ctx),
		completions: async () => (await autocomplete.getSuggestions(["/delivery-"], 0, 10, { signal: new AbortController().signal }))?.items.map((item) => item.value),
		starts: () => starts, reloads: () => reloads, setBusy: (value: boolean) => { idle = !value; }, setQueued: (value: boolean) => { queued = value; }, setBlocked: () => { blocked = true; } };
}

test("普通启动和状态查询不安装运行逻辑、不改工具、不发送模型消息", async () => {
	const h = host();
	await h.handlers.get("session_start")!({}, h.ctx);
	await h.command("delivery-status");
	await h.command("delivery-tasks");
	await h.command("delivery-resume");
	await h.command("delivery-exit");
	assert.equal(h.starts(), 0);
	assert.deepEqual(h.pi.getActiveTools(), ["read", "bash", "plugin"]);
	assert.deepEqual(h.entries, []);
	assert.deepEqual(h.messages, []);
});

test("启动时建立的补全已包含任务与恢复入口，首次 shape 后仍可发现，无须重建", async () => {
	const h = host();
	const before = await h.completions();
	assert.ok(before?.includes("delivery-tasks"));
	assert.ok(before?.includes("delivery-resume"));
	await h.command("delivery-shape");
	assert.deepEqual(await h.completions(), before);
});

test("仅 shape 安装一次运行逻辑，需求按字面发送、不展开命令或批准", async () => {
	const h = host();
	await h.command("delivery-shape", "/delivery-exit literal");
	await h.command("delivery-shape");
	assert.equal(h.starts(), 1);
	assert.equal(h.entries.length, 1);
	assert.equal(h.messages[0][1].expandPromptTemplates, false);
	assert.match(h.messages[0][0], /\/delivery-exit literal/);
	assert.deepEqual(h.entries[0].data, { enabled: true, tools: ["read", "bash", "plugin"] });
});

for (const busy of ["running", "queued", "writer"]) test(`退出拒绝 ${busy}，不写停用记录、不重载或解锁`, async () => {
	const h = host();
	await h.command("delivery-shape");
	if (busy === "running") h.setBusy(true);
	if (busy === "queued") h.setQueued(true);
	if (busy === "writer") h.setBlocked();
	await h.command("delivery-exit");
	assert.equal(h.reloads(), 0);
	assert.equal(h.entries.length, 1);
	assert.deepEqual(h.pi.getActiveTools(), ["read"]);
});

test("退出经重载恢复原工具集合，只消费一次恢复记录", async () => {
	const h = host();
	await h.command("delivery-shape");
	await h.command("delivery-exit");
	assert.equal(h.reloads(), 1);
	const resumed = host(h.entries);
	await resumed.handlers.get("session_start")!({}, resumed.ctx);
	resumed.pi.setActiveTools(["read", "plugin"]);
	await resumed.handlers.get("resources_discover")!();
	assert.equal(resumed.starts(), 0);
	assert.deepEqual(resumed.pi.getActiveTools(), ["read", "bash", "plugin"]);
	assert.deepEqual(resumed.entries.at(-1).data, { enabled: false });
	resumed.pi.setActiveTools(["read"]);
	await resumed.handlers.get("session_start")!({}, resumed.ctx);
	await resumed.handlers.get("resources_discover")!();
	assert.deepEqual(resumed.pi.getActiveTools(), ["read"]);
});

test("重载说明确认失效与退出恢复入口，提示不重新启用被停用工具", async () => {
	const h = host([{ type: "custom", customType: "delivery-activation", data: { enabled: true, tools: ["read", "bash", "plugin"] } }]);
	await h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	assert.match(h.notices.at(-1)!, /确认.*重新/);
	assert.match(h.notices.at(-1)!, /保留.*工具.*\/delivery-exit/);
	assert.deepEqual(h.pi.getActiveTools(), ["read"]);
	assert.equal(h.messages.length, 0);
	assert.equal(h.entries.length, 1);
});
