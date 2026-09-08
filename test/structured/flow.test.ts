import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createPiFixture, FixtureRpc, testEnvironment } from "../support/pi-fixture.ts";
import { createDevelopmentHost } from "../support/development-host.ts";
import { createStructuredCommands } from "../../extensions/delivery-gate/src/structured.ts";
import { resolveContainerImage } from "../../extensions/delivery-gate/src/container.ts";
import { resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";

if (process.env.PI_ADAPTIVE_CONTAINER_TESTS !== "1" || !process.env.ADAPTIVE_STRUCTURED_PACKAGE) throw new Error("Structured 验收必须显式 --containers --adapter <已安装 Package>；不静默跳过");
const adapter = process.env.ADAPTIVE_STRUCTURED_PACKAGE;
const source = fileURLToPath(new URL("../../", import.meta.url));
const jsonl = async (file: string) => (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
async function configure(f: Awaited<ReturnType<typeof createPiFixture>>, wrongOrder = false, seven = true) {
	const settings = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8"));
	settings.packages = [f.packageDir, ...(wrongOrder ? [adapter, f.productDir] : [f.productDir, adapter])];
	settings.defaultTools = ["read", "bash", "write", "edit", ...(seven ? ["grep", "find", "ls"] : [])];
	await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify(settings));
	await writeFile(path.join(f.agentDir, "pi-codex-conversion.json"), JSON.stringify({ executionMode: "normal", voiceFeaturesOnly: false,
		scope: { allProviders: "on", additionalProviders: [] }, voice: { audioSetupCompleted: true },
		openai: { forceCachedWebSockets: false, cacheKeepalive: false, lunaCacheKeepaliveMinutes: 0, verbosity: "low" } }));
}

// 仅检查本场景原生记录里的 PID 和容器 label，不操作用户其他资源。
async function auditResources(t: TestContext, f: Awaited<ReturnType<typeof createPiFixture>>) {
	const config = path.join(f.root, "docker-audit");
	await mkdir(config);
	t.after(async () => {
		const names = new Set<string>();
		const visit = async (directory: string) => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const file = path.join(directory, entry.name);
				if (entry.isDirectory()) await visit(file);
				else if (entry.name.endsWith(".jsonl")) for (const row of await jsonl(file)) if (row.customType === "delivery-container") {
					assert.match(row.data.name, /^pi-adaptive-[a-f0-9-]+$/, "审计必须使用容器身份，不能混用工具名");
					names.add(row.data.name);
				}
			}
		};
		await visit(path.join(f.agentDir, "sessions"));
		const parent = path.join(f.root, "parent-sessions");
		try { await access(parent); await visit(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		for (const name of names) {
			const ids = execFileSync("docker", ["--config", config, "--host", "unix:///var/run/docker.sock", "ps", "-aq", "--filter", `label=pi-adaptive-delivery.execution=${name}`],
				{ env: { PATH: process.env.PATH, HOME: config }, encoding: "utf8", timeout: 15_000 }).trim();
			assert.equal(ids, "", `本次容器没有清理：${name}`);
		}
		const events = await jsonl(path.join(f.agentDir, "fixture-events.jsonl"));
		for (const row of events.filter((event) => event.child && event.phase === "start")) assert.throws(() => process.kill(row.pid, 0), { code: "ESRCH" });
		t.diagnostic(JSON.stringify({ root: f.root, containers: names.size }));
	});
}

function assertEnhancements(events: any[]) {
	const requests = events.filter((event) => event.phase === "provider-payload");
	assert.ok(requests.some((event) => event.child) && requests.some((event) => !event.child));
	for (const request of requests) {
		assert.equal(request.payload.text.verbosity, "low");
		assert.ok(request.payload.input.some((message: any) => message.role === "developer" && JSON.stringify(message.content).includes(request.child ? "STRUCTURED_CHILD_CONTEXT_PROOF" : "STRUCTURED_PARENT_CONTEXT_PROOF")));
		assert.ok(!JSON.stringify(request.payload.input.filter((message: any) => message.role === "developer")).includes(request.child ? "STRUCTURED_PARENT_CONTEXT_PROOF" : "STRUCTURED_CHILD_CONTEXT_PROOF"));
		for (const name of ["exec_command", "write_stdin", "apply_patch", "view_image"]) assert.ok(request.payload.tools.some((tool: any) => tool.name === name));
	}
	assert.ok(events.filter((event) => event.phase === "codex-developer-message").every((event) => event.accepted === true));
	assert.ok(events.filter((event) => event.child && event.phase === "model").every((event) => event.parentMarkerSeen === false));
}

for (const seven of [false, true]) test(`真实 Structured ${seven ? "显式七工具" : "Pi 默认四工具"} 父子只读、请求与上下文增强保留`, { timeout: 60_000 }, async (t) => {
	const f = await createPiFixture(source, "structured-readonly");
	await f.rpc.send("get_state");
	await f.rpc.stop();
	await configure(f, false, seven);
	const rpc = new FixtureRpc(f.cwd, { ...testEnvironment(f.root), ADAPTIVE_FIXTURE_SCENARIO: "structured-readonly" });
	t.after(() => rpc.stop());
	await auditResources(t, f);
	await rpc.send("get_state");
	await rpc.send("prompt", { message: "/fixture-isolation" });
	await rpc.send("prompt", { message: "fixture-delegate" });
	await rpc.waitFor((row) => row.type === "agent_settled", 0, 45_000);
	const result = rpc.records.find((row) => row.type === "tool_execution_end" && row.toolName === "delivery_readonly")!;
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.match(JSON.stringify(result.result.content), /fixture-read-ok/);
	const child = await jsonl(result.result.details.sessionFile);
	assert.ok(child.some((row) => row.message?.toolName === "exec_command" && row.message.isError === false));
	assert.equal(child.find((row) => row.customType === "delivery-child-exit").data.structured.clean, true);
	assertEnhancements(await jsonl(path.join(f.agentDir, "fixture-events.jsonl")));
	const invoke = async (id: string, args: unknown, name = "exec_command") => {
		await rpc.send("prompt", { message: `/fixture-next-tool ${JSON.stringify({ type: "toolCall", id, name, arguments: args })}` });
		const cursor = rpc.records.length;
		await rpc.send("prompt", { message: "只读 Shell 探针" });
		await rpc.waitFor((row) => row.type === "agent_settled", cursor);
		return rpc.records.slice(cursor).find((row) => row.type === "tool_execution_end" && row.toolCallId === id)!;
	};
	const approval = await invoke("rpc-approval", { stage: "documents", body: "模型不能批准", paths: ["plan.md"], validationCommands: [] }, "delivery_approval");
	assert.equal(approval.isError, true);
	assert.match(JSON.stringify(approval.result.content), /真实 TUI/);
	await writeFile(path.join(f.cwd, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
	const image = await invoke("image", { path: path.join(f.cwd, "pixel.png") }, "view_image");
	assert.equal(image.isError, false, JSON.stringify(image));
	assert.ok(image.result.content.some((part: any) => part.type === "image" && part.mimeType === "image/png"));
	const denied = await invoke("readonly-write", { cmd: "printf forbidden > forbidden.txt", yield_time_ms: 30_000 });
	assert.notEqual(denied.result.details.exit_code, 0);
	await assert.rejects(access(path.join(f.cwd, "forbidden.txt")), { code: "ENOENT" });
	const unfinished = await invoke("unfinished-parent", { cmd: "sleep 120", yield_time_ms: 250 });
	assert.ok(unfinished.result.details.session_id);
	const last = rpc.records.findLast((row) => row.type === "agent_settled");
	assert.ok(last);
	// agent_settled 的通知可早于扩展收尾，下一条调用由真实工具边界等待或拒绝。
	await rpc.send("new_session");
	const again = await invoke("new-session-read", { cmd: "cat input.txt", yield_time_ms: 30_000 });
	assert.equal(again.isError, false, JSON.stringify(again));
	assert.equal(again.result.details.exit_code, 0);
	assert.match(JSON.stringify(again.result.content), /fixture-read-ok/);
	await rpc.send("prompt", { message: "/fixture-replace-tool exec_command" });
	assert.equal((await invoke("replacement", { cmd: "touch forbidden.txt" })).isError, true);
	await assert.rejects(access(path.join(f.cwd, "forbidden.txt")), { code: "ENOENT" });
});

test("Structured 加载顺序未接管时明确拒绝，不执行原插件宿主 Shell", { timeout: 40_000 }, async (t) => {
	const f = await createPiFixture(source, "structured-readonly");
	await f.rpc.send("get_state"); await f.rpc.stop(); await configure(f, true);
	const rpc = new FixtureRpc(f.cwd, { ...testEnvironment(f.root), ADAPTIVE_FIXTURE_SCENARIO: "structured-readonly" });
	t.after(() => rpc.stop());
	await rpc.send("get_state"); await rpc.send("prompt", { message: "fixture-delegate" });
	await rpc.waitFor((row) => row.type === "agent_settled");
	assert.match(JSON.stringify(rpc.records.find((row) => row.type === "tool_execution_end" && row.toolName === "delivery_readonly")), /之前加载/);
	await rpc.send("prompt", { message: `/fixture-next-tool ${JSON.stringify({ type: "toolCall", id: "unsafe", name: "exec_command", arguments: { cmd: "touch forbidden.txt" } })}` });
	const cursor = rpc.records.length;
	await rpc.send("prompt", { message: "拒绝未接管的实现" });
	await rpc.waitFor((row) => row.type === "agent_settled", cursor);
	assert.equal(rpc.records.find((row) => row.type === "tool_execution_end" && row.toolCallId === "unsafe")?.isError, true);
	await assert.rejects(access(path.join(f.cwd, "forbidden.txt")), { code: "ENOENT" });
});

async function development(t: TestContext, scenario = "normal") {
	const h = await createDevelopmentHost(t, `structured-${scenario}`, undefined, (fixture) => configure(fixture));
	await auditResources(t, h);
	await mkdir(path.join(h.cwd, "src"));
	await mkdir(path.join(h.cwd, "inputs"));
	await writeFile(path.join(h.cwd, "inputs/check.py"), 'from pathlib import Path\nassert Path("src/value.js").read_text() == "export const value = 2;\\n"\nprint("STRUCTURED_REAL_CHECK_OK")\n');
	await h.prepare();
	assert.equal((await h.approve("implementation", ["src"], { image: "python:3.12-slim", inputs: ["inputs"] }, ["python inputs/check.py"])).isError, false);
	return h;
}

test("真实 Structured 完成独立批准、补丁开发、自检、固定验收、审查和父文档交接", { timeout: 90_000 }, async (t) => {
	const h = await development(t);
	await h.session.prompt("/fixture-parent-history");
	const progress: any[] = [];
	t.after(h.session.subscribe((event) => { if (event.type === "tool_execution_update" && event.toolName.startsWith("delivery_")) progress.push(event.partialResult.details.progress); }));
	const develop = await h.call("delivery_develop", { task: "使用 apply_patch 创建 src/value.js，再执行自检并读回" });
	assert.equal(develop.isError, false, JSON.stringify(develop));
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const validation = await h.call("delivery_validate", {});
	assert.equal(validation.isError, false, JSON.stringify(validation));
	assert.equal((validation.details as any).validation.results[0].exitCode, 0);
	const review = await h.call("delivery_review", { task: "对照当前代码、实际差异和原始验收记录独立审查" });
	assert.equal(review.isError, false, JSON.stringify(review));
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "实际开发、自检、固定验收与审查已核对。\n" })).isError, false);
	assert.equal(h.choices.length, 4);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	for (const result of [develop, validation, review]) {
		const own = progress.filter((view) => view?.id === result.toolCallId);
		assert.ok(own.length > 2);
		assert.ok(own.some((view) => view.action.startsWith("正在执行：")));
		assert.ok(!own.at(-1).status.includes("运行中"));
	}
	assertEnhancements(await h.audit());
});

for (const scenario of ["outside", "cancel", "unfinished", "crash"]) test(`真实 Structured ${scenario} 保留失败和原始证据，按实际终态决定交接`, { timeout: 60_000 }, async (t) => {
	const h = await development(t, scenario);
	const run = h.call("delivery_develop", { task: "验证执行失败和收尾边界" });
	if (scenario === "cancel") {
		const deadline = Date.now() + 20_000;
		while (!await access(path.join(h.cwd, "src/ready.txt")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
			assert.ok(Date.now() < deadline, "必须先观察到实际命令启动"); await setTimeout(20);
		}
		await h.session.abort();
	}
	const result = await run;
	assert.equal(result.isError, true, JSON.stringify(result));
	assert.match(JSON.stringify(result.content), /原始子 Session/);
	if (scenario === "crash") assert.ok(await h.readLease(), "未知子记录不能自动释放 writer");
	else assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	if (scenario === "unfinished") assert.match(JSON.stringify(result.content), /未通过原生工具交回/);
	await assert.rejects(access(path.join(h.cwd, "plan.md")), { code: "ENOENT" });
});

test("真实 Structured 子 Pi 跨原生调用写入 PTY，命令卡片直到实际退出才完成", { timeout: 60_000 }, async (t) => {
	const h = await development(t, "pty");
	const views: any[] = [];
	t.after(h.session.subscribe((event) => { if (event.type === "tool_execution_update" && event.toolName === "delivery_develop") views.push(event.partialResult.details.progress); }));
	const result = await h.call("delivery_develop", { task: "通过真实 PTY 接收输入并保存批准范围内文件" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(await readFile(path.join(h.cwd, "src/typed.txt"), "utf8"), "TTY_INPUT_PROOF");
	assert.ok(views.some((view) => view.action.startsWith("正在执行：exec_command read value")));
	assert.ok(views.some((view) => view.action.startsWith("已完成：exec_command read value")));
	assert.equal(await h.readLease(), undefined);
	const rows = await jsonl((result.details as any).childSessionFile);
	assert.ok(rows.some((row) => row.message?.toolName === "exec_command" && row.message.details?.session_id));
	assert.ok(rows.some((row) => row.message?.toolName === "write_stdin" && row.message.details?.exit_code === 0));
});

for (const role of ["dev", "review"]) test(`真实 Structured ${role} 持久清理证明失败时保留 writer`, { timeout: 60_000 }, async (t) => {
	const h = await development(t, `${role}-unclean`);
	let result = await h.call("delivery_develop", { task: "实际开发后核对持久清理证明" });
	if (role === "review") {
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.equal((await h.call("delivery_validate", {})).isError, false);
		result = await h.call("delivery_review", { task: "审查子缺少可信容器清理证明，不得交回 writer" });
	}
	assert.equal(result.isError, true, JSON.stringify(result));
	assert.ok(await h.readLease(), h.notices.join("\n"));
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "禁止交回\n" })).isError, true);
	await assert.rejects(access(path.join(h.cwd, "plan.md")), { code: "ENOENT" });
});

test("真实 Structured 并发只读子分别读取不同文件，卡片与增强不串会话", { timeout: 60_000 }, async (t) => {
	const f = await createPiFixture(source, "structured-readonly-parallel");
	await f.rpc.send("get_state"); await f.rpc.stop(); await configure(f);
	await writeFile(path.join(f.cwd, "input-a.txt"), "EVIDENCE_A\n");
	await writeFile(path.join(f.cwd, "input-b.txt"), "EVIDENCE_B\n");
	const rpc = new FixtureRpc(f.cwd, { ...testEnvironment(f.root), ADAPTIVE_FIXTURE_SCENARIO: "structured-readonly-parallel" });
	t.after(() => rpc.stop()); await auditResources(t, f);
	await rpc.send("prompt", { message: "fixture-delegate" });
	await rpc.waitFor((row) => row.type === "agent_settled", 0, 45_000);
	const results = rpc.records.filter((row) => row.type === "tool_execution_end" && row.toolName === "delivery_readonly");
	assert.equal(results.length, 2);
	for (const suffix of ["a", "b"]) {
		const result = results.find((row) => row.toolCallId === `parallel-${suffix}`)!;
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.match(JSON.stringify(result.result.content), new RegExp(`EVIDENCE_${suffix.toUpperCase()}`));
		const views = rpc.records.filter((row) => row.type === "tool_execution_update" && row.toolCallId === result.toolCallId).map((row) => row.partialResult.details.progress);
		assert.ok(views.some((view) => view.action.includes(`exec_command cat input-${suffix}.txt`)));
		assert.ok(views.every((view) => view.id === result.toolCallId && !view.action.includes(`input-${suffix === "a" ? "b" : "a"}.txt`)));
	}
	assert.notEqual(results[0].result.details.sessionFile, results[1].result.details.sessionFile);
	assertEnhancements(await jsonl(path.join(f.agentDir, "fixture-events.jsonl")));
});

test("真实 Structured 同回合并发 Shell 只创建一个可跟踪命令，回合结束实际停止", { timeout: 40_000 }, async (t) => {
	const f = await createPiFixture(source, "structured-command-parallel");
	await f.rpc.send("get_state"); await f.rpc.stop(); await configure(f);
	const rpc = new FixtureRpc(f.cwd, { ...testEnvironment(f.root), ADAPTIVE_FIXTURE_SCENARIO: "structured-command-parallel" });
	t.after(() => rpc.stop()); await auditResources(t, f);
	await rpc.send("prompt", { message: "并发只读命令" });
	await rpc.waitFor((row) => row.type === "agent_settled");
	const results = rpc.records.filter((row) => row.type === "tool_execution_end" && row.toolName === "exec_command");
	assert.equal(results.length, 2);
	assert.equal(results.filter((row) => row.isError).length, 1);
	assert.ok(results.find((row) => !row.isError)?.result.details.session_id);
	const entries = (await rpc.send("get_entries")).data.entries;
	const containers = entries.filter((row: any) => row.customType === "delivery-container");
	assert.equal(new Set(containers.map((row: any) => row.data.name)).size, 1);
	assert.ok(containers.some((row: any) => row.data.phase === "ended" && row.data.clean === true && row.data.status === "cancelled"));
});

test("真实原插件补丁 helper 支持新增、编辑、移动和删除，越界失败保留真实文件", { timeout: 45_000 }, async (t) => {
	const f = await createPiFixture(source);
	await f.rpc.send("get_state"); await f.rpc.stop();
	await mkdir(path.join(f.cwd, "src"));
	await writeFile(path.join(f.cwd, "plan.md"), "protected\n");
	const workspace = await resolveWorkspaceIdentity(f.cwd);
	const names: string[] = [];
	const config = path.join(f.root, "docker-audit"); await mkdir(config);
	const runner = createStructuredCommands({ workspace, image: await resolveContainerImage("python:3.12-slim", f.cwd), readPaths: [], writePaths: ["src"],
		protectedPaths: [path.join(f.cwd, "plan.md")], hostPaths: true }, async (ref) => { names.push(ref.name); });
	t.after(async () => {
		await runner.finish();
		for (const name of names) assert.equal(execFileSync("docker", ["--config", config, "--host", "unix:///var/run/docker.sock", "ps", "-aq", "--filter", `label=pi-adaptive-delivery.execution=${name}`],
			{ env: { PATH: process.env.PATH, HOME: config }, encoding: "utf8", timeout: 15_000 }).trim(), "");
	});
	const helper = path.join(adapter, `src/tools/apply-patch/bin/linux-${process.arch}/apply_patch`);
	const patch = (text: string) => runner.patch(crypto.randomUUID(), `*** Begin Patch\n${text}*** End Patch\n`, helper);
	await patch("*** Add File: src/a.txt\n+original\n*** Add File: src/delete.txt\n+remove me\n");
	await patch("*** Update File: src/a.txt\n*** Move to: src/moved.txt\n@@\n-original\n+literal '$(touch plan.md)'\n*** Delete File: src/delete.txt\n");
	assert.equal(await readFile(path.join(f.cwd, "src/moved.txt"), "utf8"), "literal '$(touch plan.md)'\n");
	await assert.rejects(access(path.join(f.cwd, "src/a.txt")), { code: "ENOENT" });
	await assert.rejects(access(path.join(f.cwd, "src/delete.txt")), { code: "ENOENT" });
	await assert.rejects(patch("*** Add File: src/partial.txt\n+possibly applied\n*** Add File: plan.md\n+forbidden\n"), /补丁失败，可能已部分修改/);
	assert.equal(await readFile(path.join(f.cwd, "plan.md"), "utf8"), "protected\n");
	assert.equal(runner.lastExecution?.clean, true);
	t.diagnostic(JSON.stringify({ root: f.root, containers: names }));
});
