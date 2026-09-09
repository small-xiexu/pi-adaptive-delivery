import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createBashTool, type CustomEntry } from "@earendil-works/pi-coding-agent";
import { createContainerOperations, resolveContainerImage, type ContainerReference } from "../../extensions/delivery-gate/src/container.ts";
import { resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";
import { createDevelopmentHost } from "../support/development-host.ts";
import { plainTheme } from "../support/delivery-ui.ts";
import type { TaskDetailsPanel } from "../../extensions/delivery-gate/src/task-details.ts";

if (process.env.PI_ADAPTIVE_CONTAINER_TESTS !== "1") throw new Error("真实容器测试须显式使用 run-tests.ts --containers；不静默跳过或放宽默认禁网");

async function host(t: TestContext, script: string, directory = "src") {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-container-")));
	const cwd = path.join(root, "repo");
	const config = path.join(root, "docker-config");
	await Promise.all([path.join(cwd, directory), path.join(cwd, "inputs"), config].map((dir) => mkdir(dir, { recursive: true })));
	execFileSync("git", ["init", "--quiet"], { cwd });
	await writeFile(path.join(cwd, "inputs/command.cjs"), script);
	await writeFile(path.join(cwd, "plan.md"), "protected plan\n");
	await writeFile(path.join(root, "outside.txt"), "not mounted\n");
	const refs: ContainerReference[] = [];
	const cli = (...args: string[]) => execFileSync("docker", ["--config", config, "--host", "unix:///var/run/docker.sock", ...args],
		{ env: { PATH: process.env.PATH, HOME: config, DOCKER_CONFIG: config }, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
	const workspace = await resolveWorkspaceIdentity(cwd);
	const image = await resolveContainerImage("node:22-alpine", cwd);
	const runner = createContainerOperations({ workspace, image, readPaths: ["inputs"], writePaths: [directory], protectedPaths: [path.join(cwd, "plan.md")],
		beforeCreate: async (ref) => { refs.push(ref); await appendFile(path.join(root, "container-references.jsonl"), JSON.stringify(ref) + "\n"); } });
	t.after(() => {
		for (const ref of refs) {
			const ids = cli("ps", "--all", "--quiet", "--no-trunc", "--filter", `label=pi-adaptive-delivery.execution=${ref.name}`);
			if (ids) { cli("rm", "--force", "--volumes", ids); assert.fail(`产品未清理本次容器，夹具已强制清理：${ref.name}`); }
		}
	});
	t.diagnostic(JSON.stringify({ root, image, dockerHost: "local Unix socket", input: "temporary fixture only" }));
	return { root, cwd, directory, cli, runner, run: (signal?: AbortSignal, timeout = 10) => createBashTool(cwd, { operations: runner.operations, exposeSessionEnvironment: false })
		.execute("container-probe", { command: "node inputs/command.cjs", timeout }, signal) };
}

test("真实容器执行产物可写，输入/台账/根目录/宿主外部文件不可写，无网络或 Docker socket", { timeout: 40_000 }, async (t) => {
	const h = await host(t, `const fs = require("node:fs");
const checks = {};
for (const target of ["inputs/command.cjs", "plan.md", "/outside.txt"]) {
  try { fs.writeFileSync(target, "forbidden"); checks[target] = "writable"; } catch (error) { checks[target] = error.code; }
}
for (const target of ["/var/run/docker.sock", "/workspace/.git", "../outside.txt"]) {
  try { fs.readFileSync(target); checks[target] = "readable"; } catch (error) { checks[target] = error.code; }
}
checks.interfaces = Object.keys(require("node:os").networkInterfaces());
checks.uid = process.getuid();
checks.status = fs.readFileSync("/proc/self/status", "utf8").split("\\n").filter(line => /^(CapEff|NoNewPrivs):/.test(line));
fs.writeFileSync("src/result.json", JSON.stringify(checks));
console.log("container command completed");`);
	await h.run();
	const checks = JSON.parse(await readFile(path.join(h.cwd, "src/result.json"), "utf8"));
	for (const target of ["inputs/command.cjs", "plan.md", "/outside.txt"]) assert.equal(checks[target], "EROFS");
	for (const target of ["/var/run/docker.sock", "/workspace/.git", "../outside.txt"]) assert.equal(checks[target], "ENOENT");
	assert.deepEqual(checks.interfaces, ["lo"]);
	assert.ok(checks.uid > 0);
	assert.match(checks.status.join("\n"), /CapEff:\s+0+\nNoNewPrivs:\s+1/);
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "protected plan\n");
	assert.equal(h.runner.lastExecution?.clean, true);
	assert.equal(h.runner.cleanupFailed, false);
});

test("Docker CSV 挂载保留逗号和引号目录，不作为命令或额外挂载解释", { timeout: 40_000 }, async (t) => {
	const directory = 'src,with"quote';
	const h = await host(t, `require("node:fs").writeFileSync(${JSON.stringify(`${directory}/result.txt`)}, "correct");`, directory);
	await h.run();
	assert.equal(await readFile(path.join(h.cwd, directory, "result.txt"), "utf8"), "correct");
});

test("普通命令失败保留真实退出码和部分产物，清理后可再次执行", { timeout: 40_000 }, async (t) => {
	const h = await host(t, 'require("node:fs").writeFileSync("src/partial.txt", "partial"); process.exit(7);');
	await assert.rejects(h.run(), /code 7/);
	assert.equal(h.runner.lastExecution?.exitCode, 7);
	assert.equal(h.runner.lastExecution?.clean, true);
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), 'require("node:fs").writeFileSync("src/partial.txt", "repaired");');
	await h.run();
	assert.equal(await readFile(path.join(h.cwd, "src/partial.txt"), "utf8"), "repaired");
});

test("真实容器 OOM 的原生错误包含 137、输出和已确认清理", { timeout: 40_000 }, async (t) => {
	const h = await host(t, `console.log("OOM_PROBE_STARTED");
console.log("memory.max=" + require("node:fs").readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim());
const held=[]; setInterval(() => held.push(Buffer.alloc(16*1024*1024,1)), 10);`);
	await assert.rejects(h.run(), (error: Error) => {
		assert.match(error.message, /OOMKilled/);
		assert.match(error.message, /退出码：137；容器清理：已确认/);
		assert.match(error.message, /OOM_PROBE_STARTED/);
		assert.match(error.message, /memory.max=1073741824/);
		return true;
	});
	assert.equal(h.runner.lastExecution?.status, "failed");
});

for (const kind of ["cancel", "timeout", "background"]) test(`真实容器 ${kind} 收尾后，脱离 stdio 的后代不能继续写入`, { timeout: 40_000 }, async (t) => {
	const worker = 'setInterval(() => require("node:fs").appendFileSync("src/ticks.txt", "tick\\n"), 30)';
	const h = await host(t, `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { detached: true, stdio: "ignore" });
child.unref();
require("node:fs").writeFileSync("src/ready.json", JSON.stringify({ pid: child.pid }));
${kind === "background" ? 'setTimeout(() => {}, 150);' : 'setInterval(() => {}, 1000);'}`);
	const controller = new AbortController();
	const run = h.run(controller.signal, kind === "timeout" ? 1 : 10);
	const outcome = kind === "background" ? run : assert.rejects(run, kind === "cancel" ? /abort/i : /timeout/);
	const deadline = Date.now() + 10_000;
	while (!await readFile(path.join(h.cwd, "src/ready.json")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
		assert.ok(Date.now() < deadline, "必须先观察到实际命令启动");
		await setTimeout(20);
	}
	if (kind === "cancel") controller.abort();
	await outcome;
	assert.equal(h.runner.lastExecution?.clean, true);
	assert.equal(h.runner.cleanupFailed, false);
	const file = path.join(h.cwd, "src/ticks.txt");
	const before = await readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
	await setTimeout(250);
	const after = await readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
	assert.equal(after, before);
});

async function developmentHost(t: TestContext, scenario: string, script: string, commands: string[] = []) {
	const h = await createDevelopmentHost(t, `container-${scenario}`);
	await mkdir(path.join(h.cwd, "inputs"));
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), script);
	await h.prepare();
	assert.equal((await h.approve("implementation", ["src"], { image: "node:22-alpine", inputs: ["inputs"] }, commands)).isError, false);
	const children = async () => {
		const entries = h.sm.getEntries().filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "delivery-development");
		return Promise.all(entries.map(async (entry) => {
			const { childSessionFile } = entry.data as { childSessionFile: string };
			return (await readFile(childSessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		}));
	};
	const config = path.join(h.root, "docker-config");
	await mkdir(config);
	const cli = (...args: string[]) => execFileSync("docker", ["--config", config, "--host", "unix:///var/run/docker.sock", ...args],
		{ env: { PATH: process.env.PATH, HOME: config, DOCKER_CONFIG: config }, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
	t.after(async () => {
		for (const rows of await children()) for (const row of rows.filter((entry: any) => entry.type === "custom" && entry.customType === "delivery-container")) {
			const ids = cli("ps", "--all", "--quiet", "--no-trunc", "--filter", `label=pi-adaptive-delivery.execution=${row.data.name}`);
			if (ids) { cli("rm", "--force", "--volumes", ids); assert.fail(`正式子工具遗留容器，夹具已清理：${row.data.name}`); }
		}
	});
	return { ...h, children };
}

test("真实 Pi 子命令运行中查看详情，Esc 关闭后继续完成，结束仍可读原始结果", { timeout: 40_000 }, async (t) => {
	const h = await developmentHost(t, "details", `require("node:fs").writeFileSync("src/ready.txt", "ready");
const phase = (name) => { for (let i = 0; i < 80; i++) console.log(name + " " + i + " " + "output ".repeat(15)); console.log(name + "_LATEST"); };
phase("DETAIL_COMMAND_RUNNING");
setTimeout(() => phase("DETAIL_MIDDLE"), 2500);
setTimeout(() => phase("DETAIL_LATER"), 5500);
setTimeout(() => console.log("DETAIL_COMMAND_FINISHED"), 10_000);`);
	let panel: TaskDetailsPanel | undefined;
	h.setCustom((async (factory: any) => {
		let done!: () => void;
		const closed = new Promise<void>((resolve) => { done = resolve; });
		const component = await factory({ terminal: { rows: 32 }, requestRender() {} }, plainTheme, {}, done);
		panel = component;
		try { await closed; } finally { component.dispose?.(); panel = undefined; }
	}) as any);
	const until = async (condition: () => Promise<boolean> | boolean) => {
		const deadline = Date.now() + 15_000;
		while (!await condition()) { assert.ok(Date.now() < deadline, "未取得详情或实际执行证据"); await setTimeout(20); }
	};
	let ended = false;
	let later = false;
	const unsubscribe = h.session.subscribe((event) => {
		if (event.type === "tool_execution_update" && event.toolName === "delivery_develop"
			&& event.partialResult.details.progress?.output.includes("DETAIL_LATER_LATEST")) later = true;
	});
	t.after(unsubscribe);
	const run = h.call("delivery_develop", { task: "创建、编辑文件并执行命令，详情不控制任务。" }).finally(() => { ended = true; });
	await until(() => readFile(path.join(h.cwd, "src/ready.txt")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }));
	const ref = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === "delivery-development") as CustomEntry<{ id: string }>;
	assert.ok(ref);
	const showing = h.session.prompt(`/delivery-tasks ${ref.data!.id}`);
	await until(() => Boolean(panel?.render(100).join("\n").includes("DETAIL_COMMAND_RUNNING_LATEST")));
	assert.equal(ended, false);
	await until(() => Boolean(panel?.render(100).join("\n").includes("DETAIL_MIDDLE_LATEST")));
	panel!.handleInput("\x1b[5~");
	const paused = panel!.render(100).join("\n");
	await until(() => later);
	await setTimeout(1100); // 等待详情至少刷新一次，确认仍保留上翻内容。
	assert.equal(panel!.render(100).join("\n"), paused);
	panel!.handleInput("\x1b[F");
	assert.ok(panel!.render(100).join("\n").includes("DETAIL_LATER_LATEST"));
	panel!.handleInput("\t");
	const activeRows = panel!.render(100);
	const activeBash = activeRows.findIndex((line) => line.includes("执行中 · bash"));
	assert.ok(activeBash >= 0);
	panel!.handleMouse({ type: "click", button: "left", x: 4, y: activeBash, screenX: 4, screenY: activeBash, width: 100, height: 30, shift: false, alt: false, ctrl: false });
	assert.ok(panel!.render(100).join("\n").includes("DETAIL_LATER_LATEST"));
	panel!.handleInput("\x1b");
	await showing;
	assert.equal(ended, false, "关闭详情不能终止在途子命令");
	const result = await run;
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(await h.readLease(), undefined);
	const finished = h.session.prompt(`/delivery-tasks ${ref.data!.id}`);
	await until(() => Boolean(panel?.render(100).join("\n").includes("已结束，待核对")));
	panel!.handleInput("\t");
	const processRows = panel!.render(100);
	const bashRow = processRows.findIndex((line) => line.includes("已返回 · bash"));
	assert.ok(bashRow >= 0);
	panel!.handleMouse({ type: "click", button: "left", x: 4, y: bashRow, screenX: 4, screenY: bashRow, width: 100, height: 30, shift: false, alt: false, ctrl: false });
	panel!.render(100);
	panel!.handleInput("\x1b[F");
	assert.ok(panel!.render(100).join("\n").includes("DETAIL_COMMAND_FINISHED"));
	panel!.handleInput("\t");
	assert.ok(panel!.render(100).join("\n").includes("开发子任务已结束"));
	panel!.handleInput("\x1b");
	await finished;
});

test("真实容器命令完成后模型断流，恢复不重复命令或委派", { timeout: 40_000 }, async (t) => {
	const h = await developmentHost(t, "stream-retry-once", `require("node:fs").appendFileSync("src/executions.txt", "once\\n"); console.log("COMMAND_BEFORE_STREAM_ERROR");`);
	const result = await h.call("delivery_develop", { task: "创建、编辑文件，执行一次命令并读回；模型断流后继续" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(await readFile(path.join(h.cwd, "src/executions.txt"), "utf8"), "once\n");
	const children = await h.children();
	assert.equal(children.length, 1);
	const rows = children[0]!;
	assert.equal(rows.filter((row: any) => row.message?.role === "assistant" && row.message.stopReason === "error").length, 1);
	const tools = rows.filter((row: any) => row.message?.role === "toolResult").map((row: any) => row.message);
	assert.deepEqual(tools.map((tool: any) => tool.toolName), ["write", "edit", "bash", "read"]);
	assert.ok(tools.every((tool: any) => !tool.isError));
	assert.equal(tools[2].details.container.exitCode, 0);
	assert.equal(tools[2].details.container.clean, true);
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 4);
});

test("开发初始读取失败后写入与真实自检成功，父沿失败结果取证并继续固定验收", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "read-before-write", `const assert = require("node:assert/strict");
assert.equal(require("node:fs").readFileSync("src/value.js", "utf8"), "export const value = 2;\\n");
console.log("READ_RECOVERY_SELF_CHECK_OK");`, ["node inputs/command.cjs"]);
	const result = await h.call("delivery_develop", { task: "先读取不存在的目标，然后创建、编辑并执行一次容器自检。" });
	assert.equal(result.isError, true, "成功自检不覆盖之前的工具失败");
	const [rows] = await h.children();
	const tools = rows.filter((row: any) => row.message?.role === "toolResult").map((row: any) => row.message);
	assert.deepEqual(tools.map((tool: any) => [tool.toolName, tool.isError]), [["read", true], ["write", false], ["edit", false], ["bash", false], ["read", false]]);
	assert.match(JSON.stringify(tools[0].content), /ENOENT/);
	assert.match(JSON.stringify(tools[3].content), /READ_RECOVERY_SELF_CHECK_OK/);
	assert.equal(tools[3].details.container.exitCode, 0);
	assert.equal(tools[3].details.container.clean, true);
	assert.equal(rows.find((row: any) => row.customType === "delivery-child-exit").data.development.clean, true);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assert.match(text, /子任务存在工具失败/);
	const childFile = text.match(/^原始子 Session：(.+)$/m)?.[1];
	assert.ok(childFile, "失败正文必须提供模型可直接读取的子记录路径");
	assert.match(text, /子收尾核验：已取得证明/);
	assert.ok(text.includes(h.sm.getSessionFile()!) && text.includes(result.toolCallId));
	assert.match(text, /父 writer.*待.*落盘/);
	const native = await h.call("read", { path: childFile });
	assert.equal(native.isError, false);
	assert.match(JSON.stringify(native.content), /READ_RECOVERY_SELF_CHECK_OK/);
	assert.equal((await h.call("delivery_validate", {})).isError, false, "原批准仍有效时由既有门禁执行固定验收");
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "开发工具失败保留；原始自检已核实，独立固定验收通过。\n" })).isError, false);
	assert.equal(h.choices.length, 4, "取证与验收不重复申请原范围批准");
	const children = (await h.audit()).filter((row) => row.child && row.phase === "start");
	assert.equal(children.length, 2, "补证不重复开发或自检，只增加独立验收子");
	for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("正式父批准/子 CLI/真实 Docker：文件开发、实际命令、持久收尾后父回写台账", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "normal", `const fs = require("node:fs");
const source = fs.readFileSync("src/value.js", "utf8");
if (!source.includes("value = 2")) process.exit(8);
fs.writeFileSync("src/value.js", source.replace("value = 2", "value = 3"));
console.log("CONTAINER_REAL_COMMAND_OK");`);
	const progress: any[] = [];
	const unsubscribe = h.session.subscribe((event) => { if (event.type === "tool_execution_update" && event.toolName === "delivery_develop") progress.push(event.partialResult.details.progress); });
	t.after(unsubscribe);
	const result = await h.call("delivery_develop", { task: "创建、编辑后执行已批准的容器自检脚本，再读回文件。" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.ok(progress.some((view) => view.action === "正在执行：bash node inputs/command.cjs" && view.output.includes("CONTAINER_REAL_COMMAND_OK")), "容器实际日志在命令结束前沿子 RPC 实时到达父卡片");
	assert.ok(progress.every((view) => view.id === result.toolCallId));
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 3;\n");
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const [rows] = await h.children();
	const ref = rows.find((row: any) => row.type === "custom" && row.customType === "delivery-container");
	assert.ok(ref);
	const tool = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolName === "bash");
	assert.equal(tool.message.isError, false);
	assert.match(JSON.stringify(tool.message.content), /CONTAINER_REAL_COMMAND_OK/);
	assert.equal(tool.message.details.container.clean, true);
	assert.equal(tool.message.details.container.exitCode, 0);
	assert.equal(tool.message.details.container.name, ref.data.name);
	assert.ok(rows.indexOf(ref) < rows.indexOf(tool));
	const events = await h.audit();
	assert.equal(events.filter((row) => row.child && row.phase === "environment-tool-call" && row.toolName === "bash").length, 1);
	assert.equal(events.filter((row) => row.child && row.phase === "environment-tool-result" && row.toolName === "bash").length, 1);
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "真实容器命令已执行，完整独立验收仍待后续。" })).isError, false);
	assert.equal(h.choices.length, 4, "节点回写不重复请求批准");
});

for (const kind of ["failure", "readonly", "hook-deny", "hook-error"]) test(`正式容器命令 ${kind} 保留失败，不误报成功或锁死已清理 writer`, { timeout: 60_000 }, async (t) => {
	const script = kind === "readonly" ? 'require("node:fs").writeFileSync("inputs/command.cjs", "forbidden");'
		: 'if (!require("node:fs").readFileSync("src/value.js", "utf8").includes("value = 3")) process.exit(7); console.log("repaired command");';
	const h = await developmentHost(t, kind, script);
	assert.equal((await h.call("delivery_develop", { task: "验证容器错误与配置检查" })).isError, true);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const [rows] = await h.children();
	const result = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolName === "bash");
	assert.equal(result?.message.isError, true);
	assert.match(JSON.stringify(result.message.content), kind === "readonly" ? /EROFS/ : kind === "hook-deny" ? /CONFIGURED_TOOL_HOOK_DENIED/ : kind === "hook-error" ? /CONFIGURED_TOOL_HOOK_ERROR/ : /code 7/);
	assert.equal(rows.some((row: any) => row.customType === "delivery-container"), !kind.startsWith("hook-"));
	if (kind === "failure") {
		assert.equal((await h.call("delivery_develop", { task: "fixture-container-repair：在原授权范围内修复源码并复验" })).isError, false);
		assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 3;\n");
		assert.equal(await readFile(path.join(h.cwd, "inputs/command.cjs"), "utf8"), script);
		assert.equal(h.choices.length, 4);
	}
});

for (const kind of ["cancel", "timeout"]) test(`正式父子容器 ${kind} 等待命令清理和持久终态后才交回 writer`, { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, kind, 'require("node:fs").writeFileSync("src/ready.txt", "ready"); setInterval(() => {}, 1000);');
	const run = h.call("delivery_develop", { task: "执行在途容器命令" });
	const deadline = Date.now() + 15_000;
	while (!await readFile(path.join(h.cwd, "src/ready.txt")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
		assert.ok(Date.now() < deadline, "必须观察到真实容器已执行");
		await setTimeout(20);
	}
	assert.equal((await h.readLease())?.owner.kind, "child");
	if (kind === "cancel") await h.session.abort();
	assert.equal((await run).isError, true);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const [rows] = await h.children();
	assert.ok(rows.some((row: any) => row.customType === "delivery-child-exit" && row.data.development.clean));
});

test("父 Bash 已被配置覆盖时不将其偷偷替换成容器实现", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "normal", 'console.log("must not execute");');
	await h.session.prompt("/fixture-replace-tool bash");
	assert.notEqual(h.session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source, "builtin");
	const result = await h.call("delivery_develop", { task: "缺少可重建 Bash 能力" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /不能重建该实现/);
	assert.ok(!(await h.audit()).some((row) => row.child));
	assert.equal(await h.readLease(), undefined);
});

test("正式固定验收运行完整原清单，绑定稳定候选和真实子命令记录", { timeout: 60_000 }, async (t) => {
	const commands = ["node inputs/command.cjs", "node inputs/second.cjs"];
	const h = await developmentHost(t, "validation-two", 'console.log("FIRST_REAL_VALIDATION");', commands);
	await mkdir(path.join(h.cwd, "src"), { recursive: true });
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await writeFile(path.join(h.cwd, "inputs/second.cjs"), 'console.log("SECOND_REAL_VALIDATION");');
	const result = await h.call("delivery_validate", {});
	assert.equal(result.isError, false, JSON.stringify(result));
	const proof = (result.details as any).validation;
	assert.equal(proof.before.digest, proof.after.digest);
	assert.deepEqual(proof.commands, commands);
	assert.deepEqual(proof.results.map((row: any) => row.status), ["passed", "passed"]);
	assert.equal(new Set(proof.results.map((row: any) => row.container)).size, 2);
	const [rows] = await h.children();
	for (const item of proof.results) {
		const call = rows.find((row: any) => row.message?.role === "assistant" && row.message.content.some((part: any) => part.type === "toolCall" && part.id === item.toolCallId));
		const outcome = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolCallId === item.toolCallId);
		assert.ok(call && outcome);
		assert.equal(outcome.message.isError, false);
		assert.equal(outcome.message.details.container.name, item.container);
		assert.equal(outcome.message.details.container.clean, true);
	}
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: `固定验收通过，候选 ${proof.after.digest}；独立审查待实施。\n` })).isError, false);
	assert.equal(h.choices.length, 4);
});

test("独立审查读取原目标、代码、真实差异与原始验收记录，父裁决后原授权返工/复验/回写", { timeout: 90_000 }, async (t) => {
	const h = await developmentHost(t, "review-normal", 'console.log("REAL_VALIDATION_FOR_REVIEW");', ["node inputs/command.cjs"]);
	await mkdir(path.join(h.cwd, "src"), { recursive: true });
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.session.prompt("/fixture-parent-history");
	await writeFile(path.join(h.cwd, "plan.md"), "用户无关内容，必须保留。\n当前节点：待验证\n");
	const validation = await h.call("delivery_validate", {});
	assert.equal(validation.isError, false, JSON.stringify(validation));
	const reviewed = await h.call("delivery_review", { task: "独立检查 value，按真实证据报告发现" });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.match(JSON.stringify(reviewed.content), /FAKE_REVIEW_MECHANISM.*P1 src\/value.js/);
	const details = reviewed.details as any;
	assert.equal(details.candidate.digest, (validation.details as any).validation.after.digest);
	const requests = (await h.audit()).filter((row) => row.pid === details.pid && row.phase === "model");
	assert.equal(requests.length, 4);
	assert.ok(requests.every((row) => !row.parentMarkerSeen));
	assert.deepEqual(requests[0].tools, ["read"]);
	assert.match(JSON.stringify(requests[0].messages), /APPROVED_DESIGN_BODY.*APPROVED_IMPLEMENTATION_BODY/s);
	assert.match(JSON.stringify(requests[2].messages), /diff --git/);
	assert.match(JSON.stringify(requests[3].messages), /delivery-container.*delivery-child-exit/s);
	assert.notEqual(details.reviewSessionFile, (validation.details as any).childSessionFile);
	assert.throws(() => process.kill(details.pid, 0), { code: "ESRCH" });
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.call("delivery_document_edit", { path: "plan.md", edits: [{ oldText: "当前节点：待验证", newText: `当前节点：进行中，父接受发现并安排修复；验收 ${details.candidate.digest}` }] })).isError, false);
	assert.equal((await h.call("delivery_develop", { task: "父裁决接受本夹具发现，将 value 修复为 2" })).isError, false);
	const next = await h.call("delivery_validate", {});
	assert.equal(next.isError, false, JSON.stringify(next));
	assert.notEqual((next.details as any).validation.after.digest, details.candidate.digest);
	const checked = await h.call("delivery_review", { task: "复核同范围修复和受影响代码" });
	assert.equal(checked.isError, false, JSON.stringify(checked));
	assert.match(JSON.stringify(checked.content), /未发现本夹具范围内问题/);
	assert.equal((checked.details as any).candidate.digest, (next.details as any).validation.after.digest);
	assert.equal((await h.call("delivery_document_edit", { path: "plan.md", edits: [{ oldText: `当前节点：进行中，父接受发现并安排修复；验收 ${details.candidate.digest}`,
		newText: `当前节点：限定机制已验证；修复后候选 ${(checked.details as any).candidate.digest}。fake provider 不证明审查质量。` }] })).isError, false);
	assert.match(await readFile(path.join(h.cwd, "plan.md"), "utf8"), /^用户无关内容，必须保留。\n当前节点：限定机制已验证/);
	assert.equal(h.choices.length, 4, "同范围返工及节点回写不重复批准");
});

test("正式固定验收取消等待真实容器退出，不消费父排队消息或形成可审查证据", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "validation-cancel", 'require("node:fs").writeFileSync("src/ready.txt", "ready"); setInterval(() => {}, 1000);', ["node inputs/command.cjs"]);
	await mkdir(path.join(h.cwd, "src"), { recursive: true });
	const before = (await h.audit()).filter((row) => !row.child && row.phase === "model").length;
	const run = h.call("delivery_validate", {});
	const deadline = Date.now() + 15_000;
	while (!await readFile(path.join(h.cwd, "src/ready.txt")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
		assert.ok(Date.now() < deadline, "必须观察到实际验收命令在途");
		await setTimeout(20);
	}
	assert.equal((await h.readLease())?.owner.kind, "child");
	await h.session.followUp("取消后不能继续验收");
	h.session.clearQueue();
	await h.session.abort();
	assert.equal((await run).isError, true);
	assert.equal(h.session.pendingMessageCount, 0);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const [rows] = await h.children();
	assert.equal(rows.find((row: any) => row.customType === "delivery-child-exit").data.development.validation.results[0].status, "cancelled");
	assert.equal((await h.audit()).filter((row) => !row.child && row.phase === "model").length, before + 1);
	assert.equal((await h.call("delivery_review", { task: "取消不是验收通过" })).isError, true);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, 1);
});

for (const kind of ["failure", "changed", "wrong", "edit", "omit", "timeout", "mask-error", "hook-deny"]) {
	test(`正式固定验收 ${kind} 不产生假通过，明确收尾后可交回 writer`, { timeout: 60_000 }, async (t) => {
		const script = kind === "changed" ? 'require("node:fs").writeFileSync("src/value.js", "changed by validation\\n");'
			: kind === "timeout" ? "setInterval(() => {}, 1000);"
			: ["failure", "mask-error"].includes(kind) ? 'if (!require("node:fs").readFileSync("src/value.js", "utf8").includes("value = 2")) process.exit(7);'
			: 'console.log("REAL_VALIDATION");';
		const commands = ["node inputs/command.cjs", ...(kind === "omit" ? ["node inputs/second.cjs"] : [])];
		const h = await developmentHost(t, `validation-${kind}`, script, commands);
		await mkdir(path.join(h.cwd, "src"), { recursive: true });
		await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
		await writeFile(path.join(h.cwd, "inputs/second.cjs"), 'console.log("must run when required");');
		const result = await h.call("delivery_validate", {});
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
		const [rows] = await h.children();
		const proof = rows.find((row: any) => row.customType === "delivery-child-exit")?.data.development.validation;
		assert.ok(proof);
		const expected = kind === "timeout" ? "timeout" : ["failure", "mask-error"].includes(kind) ? "failed"
			: ["wrong", "edit", "hook-deny"].includes(kind) ? "not-run" : "passed";
		assert.equal(proof.results[0].status, expected);
		if (kind === "omit") assert.equal(proof.results[1].status, "not-run");
		if (kind === "changed") assert.notEqual(proof.before.digest, proof.after.digest);
		if (kind === "mask-error") {
			const native = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolName === "bash");
			assert.equal(native.message.isError, false, "配置钩子确实改写了表面结果");
			assert.equal(proof.results[0].exitCode, 7, "运行事实不能跟随表面结果改成成功");
		}
		if (kind === "failure") {
			assert.equal((await h.call("delivery_develop", { task: "在原授权内把 value 修复为 2 并自检" })).isError, false);
			const checked = await h.call("delivery_validate", {});
			assert.equal(checked.isError, false, JSON.stringify(checked));
			const newer = (checked.details as any).validation;
			assert.notEqual(newer.after.digest, proof.before.digest);
			assert.equal(newer.before.digest, newer.after.digest);
			assert.equal(await readFile(path.join(h.cwd, "inputs/command.cjs"), "utf8"), script);
			assert.equal(h.choices.length, 4, "范围内修复/复验不重新批准");
		}
	});
}
