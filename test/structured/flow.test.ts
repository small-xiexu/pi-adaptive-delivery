import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createPiFixture, FixtureRpc, testEnvironment } from "../support/pi-fixture.ts";
import { createDevelopmentHost } from "../support/development-host.ts";

if (!process.env.ADAPTIVE_STRUCTURED_PACKAGE) throw new Error("Structured 验收须显式 --adapter <已安装 Package>；不静默跳过");
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

function auditResources(t: TestContext, f: Awaited<ReturnType<typeof createPiFixture>>) {
	t.after(async () => {
		const events = await jsonl(path.join(f.agentDir, "fixture-events.jsonl"));
		for (const row of events.filter((event) => event.child && event.phase === "start")) assert.throws(() => process.kill(row.pid, 0), { code: "ESRCH" });
		t.diagnostic(JSON.stringify({ root: f.root, environment: "本机 / 不额外禁网 / 临时 HOME" }));
	});
}

function assertEnhancements(events: any[]) {
	const requests = events.filter((event) => event.phase === "provider-payload");
	assert.ok(requests.some((event) => event.child) && requests.some((event) => !event.child));
	for (const request of requests) {
		assert.equal(request.payload.text.verbosity, "low");
		assert.ok(request.payload.input.some((message: any) => message.role === "developer" && JSON.stringify(message.content).includes(request.child ? "STRUCTURED_CHILD_CONTEXT_PROOF" : "STRUCTURED_PARENT_CONTEXT_PROOF")));
		assert.ok(!JSON.stringify(request.payload.input.filter((message: any) => message.role === "developer")).includes(request.child ? "STRUCTURED_PARENT_CONTEXT_PROOF" : "STRUCTURED_CHILD_CONTEXT_PROOF"));
		for (const name of ["exec_command", "write_stdin", "apply_patch"]) assert.ok(request.payload.tools.some((tool: any) => tool.name === name));
	}
	assert.ok(events.filter((event) => event.phase === "codex-developer-message").every((event) => event.accepted === true));
	assert.ok(events.filter((event) => event.child && event.phase === "model").every((event) => event.parentMarkerSeen === false));
}

test("Structured 进入交付仍保留父命令和补丁，退出保持原工具选择", { timeout: 45_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "structured-normal", undefined, (f) => configure(f), false);
	const originalSource = path.join(adapter, "dist/index.js");
	assert.equal(h.session.getAllTools().find((tool) => tool.name === "exec_command")!.sourceInfo.path, originalSource);
	assert.ok(!h.session.getAllTools().some((tool) => tool.name.startsWith("delivery_")));
	assert.equal((await h.call("exec_command", { cmd: "printf ORIGINAL_HOST > original.txt", yield_time_ms: 1000 })).isError, false);
	h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== "view_image"));
	const original = h.session.getActiveToolNames();
	await h.session.prompt("/delivery-shape");
	for (const name of ["exec_command", "apply_patch"]) {
		const args = name === "exec_command" ? { cmd: "touch forbidden.txt" } : { input: "*** Begin Patch\n*** Add File: forbidden.txt\n+blocked\n*** End Patch" };
		assert.equal((await h.call(name, args)).isError, false);
	}
	await h.session.prompt("/delivery-exit");
	assert.deepEqual(h.session.getActiveToolNames(), original);
	assert.equal((await h.call("exec_command", { cmd: "printf RESTORED >> original.txt", yield_time_ms: 1000 })).isError, false);
	assert.equal(await readFile(path.join(h.cwd, "original.txt"), "utf8"), "ORIGINAL_HOSTRESTORED");
	assert.equal(await readFile(path.join(h.cwd, "forbidden.txt"), "utf8"), "blocked\n");
	assert.equal(h.choices.length, 0);
});

for (const seven of [false, true]) test(`Structured ${seven ? "七工具" : "默认四工具"} 父子沿用插件读取、图片与上下文增强`, { timeout: 60_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "structured-readonly", undefined, (f) => configure(f, false, seven));
	auditResources(t, h);
	const result = await h.call("delivery_readonly", { task: "读取 input.txt" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.match(JSON.stringify(result.content), /fixture-read-ok/);
	const child = await jsonl((result.details as any).sessionFile);
	assert.ok(child.some((row) => row.message?.toolName === "exec_command" && row.message.isError === false));
	await writeFile(path.join(h.cwd, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
	const image = await h.call("view_image", { path: path.join(h.cwd, "pixel.png") });
	assert.equal(image.isError, false, JSON.stringify(image));
	assert.ok(image.content.some((part: any) => part.type === "image"));
	assert.equal((await h.call("exec_command", { cmd: "touch forbidden.txt" })).isError, false);
	assertEnhancements(await h.audit());
	await h.session.prompt("/fixture-replace-tool read");
	h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "read"]);
	const read = await h.call("read", { path: "input.txt" });
	assert.equal(read.isError, true, "原插件自行停用 read，交付包不补回");
	assert.match(JSON.stringify(read.content), /Tool read not found/);
	assert.equal(await readFile(path.join(h.cwd, "forbidden.txt"), "utf8"), "");
});

test("Structured 调换加载顺序仍保留父命令", { timeout: 40_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "structured-readonly", undefined, (f) => configure(f, true));
	assert.equal((await h.call("exec_command", { cmd: "touch forbidden.txt" })).isError, false);
	await access(path.join(h.cwd, "forbidden.txt"));
});

async function development(t: TestContext, scenario = "normal", withPlanning = true) {
	const h = await createDevelopmentHost(t, `structured-${scenario}`, undefined, (f) => configure(f));
	auditResources(t, h);
	await mkdir(path.join(h.cwd, "src"));
	await mkdir(path.join(h.cwd, "inputs"));
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), 'require("node:assert/strict").equal(require("node:fs").readFileSync("src/value.js","utf8"), "export const value = 2;\\n"); console.log("STRUCTURED_REAL_CHECK_OK");');
	if (withPlanning) await h.prepare();
	else assert.equal((await h.approve("design", [])).isError, false);
	assert.equal((await h.approve("implementation", ["src"], ["inputs"], ["node inputs/command.cjs"])).isError, false);
	return h;
}

for (const withPlanning of [false, true]) test(`Structured ${withPlanning ? "维护已有文档" : "不建规划文档"}的本机开发、自检、验收和独立审查`, { timeout: 90_000 }, async (t) => {
	const h = await development(t, "normal", withPlanning), before = await readdir(h.cwd);
	const progress: any[] = [];
	t.after(h.session.subscribe((event) => { if (event.type === "tool_execution_update" && event.toolName.startsWith("delivery_")) progress.push(event.partialResult.details.progress); }));
	await h.session.setModel(h.session.modelRuntime.getModel("adaptive-fixture", "fake-reasoner")!);
	h.session.setThinkingLevel("high");
	const developed = await h.call("delivery_develop", { task: "局部修改 value 为 2", agent: { thinking: "medium", reason: "局部实现" } });
	assert.equal(developed.isError, false, JSON.stringify(developed));
	const validated = await h.call("delivery_validate", { agent: { thinking: "low", reason: "执行固定命令" } });
	assert.equal(validated.isError, false, JSON.stringify(validated));
	const proof = (validated.details as any).validation;
	assert.equal(proof.before.digest, proof.after.digest);
	assert.deepEqual(proof.results.map((row: any) => [row.status, row.exitCode]), [["passed", 0]]);
	assert.equal(proof.environment.platform, process.platform);
	const reviewed = await h.call("delivery_review", { task: "核对原方案、实际差异和验收记录", agent: { thinking: "high", reason: "独立审查" } });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.equal((reviewed.details as any).candidate.digest, proof.after.digest);
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, withPlanning ? 3 : 2);
	assert.deepEqual(await readdir(h.cwd), before);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	for (const [result, thinking] of [[developed, "medium"], [validated, "low"], [reviewed, "high"]] as const) {
		const own = progress.filter((view) => view?.id === result.toolCallId);
		assert.ok(own.some((view) => view.action.startsWith("正在执行：")));
		assert.ok(!own.at(-1).status.includes("运行中"));
		const requests = (await h.audit()).filter((row) => row.pid === (result.details as any).pid && row.phase === "model");
		assert.ok(requests.length > 0 && requests.every((row) => row.modelId === "fake-reasoner" && row.reasoning === thinking));
		assert.match(JSON.stringify(requests[0].messages), /APPROVED_DESIGN_BODY.*APPROVED_IMPLEMENTATION_BODY/s);
	}
	assert.equal(h.session.model!.id, "fake-reasoner");
	assert.equal(h.session.thinkingLevel, "high");
	if (withPlanning) assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "已核对原始结果。\n" })).isError, false);
	assertEnhancements(await h.audit());
});

for (const failed of [false, true]) test(`Structured ${failed ? "命令非零退出" : "正常"}审查读取真实快照及原始记录，父能继续取证`, { timeout: 90_000 }, async (t) => {
	const h = await development(t, failed ? "evidence-fail" : "evidence");
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: h.cwd });
	git("add", "src/value.js");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "temporary baseline");
	assert.equal((await h.call("delivery_develop", { task: "修改源码" })).isError, false);
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	const review = await h.call("delivery_review", { task: "读取差异和原始验收" });
	assert.equal(review.isError, false, JSON.stringify(review));
	const reference = (await jsonl(h.sm.getSessionFile()!)).findLast((row) => row.customType === "delivery-delegation" && row.data.phase === "ended").data;
	if (failed) {
		const results = (await jsonl(reference.sessionFile)).filter((row) => row.message?.role === "toolResult").map((row) => row.message);
		assert.ok(results.some((row) => row.details?.exit_code === 1 && row.isError === false), "非零退出及错误标记保留原插件语义，不能据此说审查通过");
	}
	for (const [name, expected] of [["before", "value = 1"], ["after", "value = 2"]]) {
		const result = await h.call("exec_command", { cmd: `cat '${path.join(reference.reviewDirectory, name!, "src/value.js")}'`, yield_time_ms: 1000 });
		assert.equal(result.isError, false);
		assert.ok(JSON.stringify(result.content).includes(expected!));
	}
	const result = await h.call("exec_command", { cmd: `cat '${reference.sessionFile}'`, yield_time_ms: 1000, max_output_tokens: 30000 });
	assert.equal(result.isError, false);
	assert.match(JSON.stringify(result.content), /LONG_REVIEW_BEGIN/);
	assert.match(JSON.stringify(result.content), /LONG_REVIEW_END/);
	assert.equal(await h.readLease(), undefined);
});

for (const scenario of ["outside", "cancel", "unfinished", "crash"]) test(`Structured 本机 ${scenario} 依照实际调用和记录交回 writer`, { timeout: 60_000 }, async (t) => {
	const h = await development(t, scenario);
	const run = h.call("delivery_develop", { task: "验证失败和收尾边界" });
	if (scenario === "cancel") {
		const deadline = Date.now() + 20_000;
		while (!await access(path.join(h.cwd, "src/ready.txt")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
			assert.ok(Date.now() < deadline, "必须先观察到实际命令启动"); await setTimeout(20);
		}
		await h.session.abort();
	}
	const result = await run;
	assert.equal(result.isError, scenario === "cancel" || scenario === "crash", JSON.stringify(result));
	if (scenario === "outside") {
		const results = (await jsonl((result.details as any).childSessionFile)).filter((row) => row.message?.role === "toolResult").map((row) => row.message);
		assert.ok(results.some((row) => row.details?.exit_code !== undefined && row.details.exit_code !== 0), "原插件保留自检失败的真实退出码");
	} else if (scenario !== "unfinished") assert.match(JSON.stringify(result.content), /原始子 Session/);
	if (scenario === "crash") assert.ok(await h.readLease());
	else assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	if (scenario === "unfinished") assert.ok(!(result.details as any).validation, "原插件后台会话不被当成固定验收通过");
	if (scenario === "outside") assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "export const value = 2;\n");
	else await assert.rejects(access(path.join(h.cwd, "plan.md")), { code: "ENOENT" });
});

test("Structured 本机 PTY 跨工具调用接收输入，真实退出后结束卡片", { timeout: 60_000 }, async (t) => {
	const h = await development(t, "pty");
	const views: any[] = [];
	t.after(h.session.subscribe((event) => { if (event.type === "tool_execution_update" && event.toolName === "delivery_develop") views.push(event.partialResult.details.progress); }));
	const result = await h.call("delivery_develop", { task: "PTY 接收输入并保存批准范围内文件" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(await readFile(path.join(h.cwd, "src/typed.txt"), "utf8"), "TTY_INPUT_PROOF");
	assert.ok(views.some((view) => view.action.startsWith("正在执行：exec_command read value")));
	assert.ok(views.some((view) => view.action.startsWith("已完成：exec_command read value")));
	assert.equal(await h.readLease(), undefined);
	const rows = await jsonl((result.details as any).childSessionFile);
	assert.ok(rows.some((row) => row.message?.toolName === "exec_command" && row.message.details?.session_id));
	assert.ok(rows.some((row) => row.message?.toolName === "write_stdin" && row.message.details?.exit_code === 0));
});

for (const role of ["dev", "review"]) test(`Structured ${role} 持久终态被篡改时保留 writer`, { timeout: 60_000 }, async (t) => {
	const h = await development(t, `${role}-unclean`);
	let result = await h.call("delivery_develop", { task: "开发并核对持久终态" });
	if (role === "review") {
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.equal((await h.call("delivery_validate", {})).isError, false);
		result = await h.call("delivery_review", { task: "终态无法核实，不得交回" });
	}
	assert.equal(result.isError, true, JSON.stringify(result));
	assert.ok(await h.readLease());
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "禁止交回\n" })).isError, true);
});

test("Structured 并发只读子与卡片分别归属", { timeout: 60_000 }, async (t) => {
	const f = await createPiFixture(source, "structured-readonly-parallel");
	await f.rpc.send("get_state"); await f.rpc.stop(); await configure(f);
	await writeFile(path.join(f.cwd, "input-a.txt"), "EVIDENCE_A\n");
	await writeFile(path.join(f.cwd, "input-b.txt"), "EVIDENCE_B\n");
	const rpc = new FixtureRpc(f.cwd, { ...testEnvironment(f.root), ADAPTIVE_FIXTURE_SCENARIO: "structured-readonly-parallel" });
	t.after(() => rpc.stop()); auditResources(t, f);
	await rpc.send("prompt", { message: "/delivery-shape" });
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
		assert.ok(views.every((view) => view.id === result.toolCallId));
	}
	assert.notEqual(results[0].result.details.sessionFile, results[1].result.details.sessionFile);
	assertEnhancements(await jsonl(path.join(f.agentDir, "fixture-events.jsonl")));
});

test("Structured 父同回合 Shell 由原插件执行，不生成交付验收记录", { timeout: 40_000 }, async (t) => {
	const f = await createPiFixture(source, "structured-command-parallel");
	await f.rpc.send("get_state"); await f.rpc.stop(); await configure(f);
	const rpc = new FixtureRpc(f.cwd, { ...testEnvironment(f.root), ADAPTIVE_FIXTURE_SCENARIO: "structured-command-parallel" });
	t.after(() => rpc.stop());
	await rpc.send("prompt", { message: "/delivery-shape" });
	await rpc.send("prompt", { message: "并发命令必须拒绝" });
	await rpc.waitFor((row) => row.type === "agent_settled");
	const results = rpc.records.filter((row) => row.type === "tool_execution_end" && row.toolName === "exec_command");
	assert.equal(results.length, 2);
	assert.ok(results.every((row) => !row.isError));
	assert.ok(!(await rpc.send("get_entries")).data.entries.some((row: any) => row.customType === "delivery-execution"));
});

test("Structured 沿用原插件补丁的新增、编辑、移动和删除", { timeout: 45_000 }, async (t) => {
	const f = await createDevelopmentHost(t, "structured-normal", undefined, (f) => configure(f));
	await mkdir(path.join(f.cwd, "src"));
	await writeFile(path.join(f.cwd, "plan.md"), "protected\n");
	const patch = async (text: string) => {
		const result = await f.call("apply_patch", { input: `*** Begin Patch\n${text}*** End Patch\n` });
		assert.equal(result.isError, false, JSON.stringify(result));
	};
	await patch("*** Add File: src/a.txt\n+original\n*** Add File: src/delete.txt\n+remove me\n");
	await patch("*** Update File: src/a.txt\n*** Move to: src/moved.txt\n@@\n-original\n+literal '$(touch plan.md)'\n*** Delete File: src/delete.txt\n");
	assert.equal(await readFile(path.join(f.cwd, "src/moved.txt"), "utf8"), "literal '$(touch plan.md)'\n");
	await assert.rejects(access(path.join(f.cwd, "src/a.txt")), { code: "ENOENT" });
	await assert.rejects(access(path.join(f.cwd, "src/delete.txt")), { code: "ENOENT" });
	assert.equal(await readFile(path.join(f.cwd, "plan.md"), "utf8"), "protected\n");
});
