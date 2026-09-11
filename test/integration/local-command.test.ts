import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { ToolExecutionComponent, type CustomEntry } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type TUI } from "@earendil-works/pi-tui";
import { createDevelopmentHost } from "../support/development-host.ts";
import { approvalUI, plainTheme } from "../support/delivery-ui.ts";
import type { TaskDetailsPanel } from "../../extensions/delivery-gate/src/task-details.ts";
import { COMPLETED_STATUS } from "../../extensions/delivery-gate/src/progress.ts";

async function developmentHost(t: TestContext, scenario: string, script: string, commands: string[] = [], withPlanning = true) {
	const h = await createDevelopmentHost(t, `local-${scenario}`, undefined, undefined, false);
	// 与 Pi 启动时相同：命令数组只构造一次，shape 后不刷新补全。
	const autocomplete = new CombinedAutocompleteProvider(h.api.getCommands().map(({ name, description }) => ({ name, description })), h.cwd);
	await h.session.prompt("/delivery-shape");
	await mkdir(path.join(h.cwd, "inputs"));
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), script);
	if (withPlanning) await h.prepare();
	else assert.equal((await h.approve("design", [])).isError, false);
	assert.equal((await h.approve("implementation", ["src"], ["inputs"], commands)).isError, false);
	const children = async () => {
		const entries = h.sm.getEntries().filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "delivery-development");
		return Promise.all(entries.map(async (entry) => {
			const { childSessionFile } = entry.data as { childSessionFile: string };
			return (await readFile(childSessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		}));
	};
	t.after(async () => {
		for (const event of (await h.audit()).filter((row) => row.child && row.phase === "start")) assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
	});
	return { ...h, children, autocomplete };
}

test("真实 Pi 中固定命令修订只确认命令，相同实施提案不重复弹窗", { timeout: 40_000 }, async (t) => {
	const h = await developmentHost(t, "approval-revision", "console.log('fixture');", [], true);
	await h.prepare();
	const initial = h.sm.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "delivery-approval") as CustomEntry<{ id: string }>;
	assert.ok(initial);
	const choicesBeforeRevision = h.choices.length;
	const command = "node -e \"console.log('REVISION_OK')\"";
	const revised = await h.approve("implementation", ["src", "plan.md"], [], [command], initial.data!.id, "修正固定命令语法，验收范围保持不变。");
	assert.equal(revised.isError, false, JSON.stringify(revised));
	assert.equal(h.choices.length, choicesBeforeRevision + 1);
	const current = h.sm.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "delivery-approval") as CustomEntry<{ id: string }>;
	assert.notEqual(current.data!.id, initial.data!.id);
	const proposal = h.sm.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "delivery-approval-proposal") as CustomEntry<{ previousApprovalId?: string; validationRevisionReason?: string }>;
	assert.equal(proposal.data!.previousApprovalId, initial.data!.id);
	assert.equal(proposal.data!.validationRevisionReason, "修正固定命令语法，验收范围保持不变。");
	const duplicate = await h.approve("implementation", ["src", "plan.md"], [], [command]);
	assert.equal(duplicate.isError, false, JSON.stringify(duplicate));
	assert.equal(h.choices.length, choicesBeforeRevision + 1, "相同有效提案不应重新弹窗");
});

test("真实 Pi 中实施意见会暂停开发并返回父会话", { timeout: 40_000 }, async (t) => {
	const h = await developmentHost(t, "implementation-feedback", "console.log('fixture');", [], true);
	await h.prepare();
	h.setCustom(approvalUI(async () => undefined, () => "补充失败后的停止条件，再开始开发。"));
	const result = await h.approve("implementation", ["src", "plan.md"], [], [], undefined, "调整实施步骤");
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal((result.details as any).approved, false);
	assert.match(result.content.map((part: any) => part.text ?? "").join("\n"), /补充失败后的停止条件/);
});

test("真实检索无匹配与断言失败均保留具体原记录，正常结束后父可继续验收和独立审查", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "normal", `require("node:assert/strict").equal(require("node:fs").readFileSync("src/value.js", "utf8"), "export const value = 2;\\n");`, ["node inputs/command.cjs"]);
	for (const name of ["delivery_readonly", "delivery_develop", "delivery_review"]) {
		if (name === "delivery_review") assert.equal((await h.call("delivery_validate", {})).isError, false);
		const result = await h.call(name, { task: "fixture-process-notes：执行检索和断言取证，保留过程记录。" });
		assert.equal(result.isError, false, JSON.stringify(result));
		const details = result.details as any;
		assert.equal(details.progress.status, COMPLETED_STATUS);
		assert.doesNotMatch(details.progress.action, /工具异常|工具失败/);
		const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		assert.match(text, /rg -n 'ABSENT_FIXTURE_PATTERN' input.txt/);
		assert.match(text, /AssertionError/);
		assert.doesNotMatch(text, /搜索无匹配，已核对|错误已修复，不影响交付/);
		const file = details.sessionFile ?? details.childSessionFile ?? details.reviewSessionFile;
		const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		const failed = rows.flatMap((row, index) => row.message?.role === "toolResult" && row.message.isError ? [{ line: index + 1, message: row.message }] : []);
		assert.equal(failed.length, 2);
		for (const failure of failed) {
			assert.equal(failure.message.toolName, "bash");
			assert.match(JSON.stringify(failure.message.content), /Command exited with code 1/);
			assert.ok(text.includes(`原记录第 ${failure.line} 行`));
		}
		assert.equal(await h.readLease(), undefined);
		assert.throws(() => process.kill(details.pid, 0), { code: "ESRCH" });
	}
	assert.equal(h.choices.length, 3, "过程核对不增加批准或重复开发");
});

test("首次进入后补全可选子任务，运行中命令和卡片可看详情，Esc 不停止任务，结束后 ID 可查", { timeout: 40_000 }, async (t) => {
	const h = await developmentHost(t, "details", `require("node:fs").writeFileSync("src/ready.txt", "ready");
const phase = (name) => { for (let i = 0; i < 80; i++) console.log(name + " " + i + " " + "output ".repeat(15)); console.log(name + "_LATEST"); };
phase("DETAIL_COMMAND_RUNNING");
setTimeout(() => phase("DETAIL_MIDDLE"), 2500);
setTimeout(() => phase("DETAIL_LATER"), 5500);
setTimeout(() => console.log("DETAIL_COMMAND_FINISHED"), 10_000);`);
	const suggestions = await h.autocomplete.getSuggestions(["/delivery-"], 0, 10, { signal: new AbortController().signal });
	const taskCommand = suggestions?.items.find((item) => item.value === "delivery-tasks");
	assert.ok(taskCommand, "运行逻辑启用后必须能从启动时的补全找到任务入口");
	assert.ok(suggestions?.items.some((item) => item.value === "delivery-resume"));
	const commandLine = h.autocomplete.applyCompletion(["/delivery-"], 0, 10, taskCommand, suggestions!.prefix).lines.join("\n").trim();
	assert.equal(commandLine, "/delivery-tasks");
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
	const showing = h.session.prompt(commandLine);
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
	assert.doesNotMatch(panel!.render(100).join("\n"), /工具过程|Tab 切换/);
	panel!.handleInput("\x1b");
	await showing;
	assert.equal(ended, false, "关闭详情不能终止在途子命令");
	const tool = h.session.extensionRunner.getToolDefinition("delivery_develop");
	assert.ok(tool);
	const card = new ToolExecutionComponent(tool.name, ref.data!.id, { task: "本机命令" }, {}, tool, { terminal: { rows: 32 }, requestRender() {} } as TUI, h.cwd);
	card.updateResult({ content: [], details: {}, isError: false }, true);
	const rows = card.render(100);
	for (let y = 0; y < rows.length; y++) card.handleMouse({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: 100, height: rows.length, shift: false, alt: false, ctrl: false });
	await until(() => Boolean(panel?.render(100).join("\n").includes("DETAIL_LATER_LATEST")));
	assert.equal(ended, false, "首次按需安装的卡片应在子命令仍运行时打开");
	panel!.handleInput("\x1b");
	const result = await run;
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(await h.readLease(), undefined);
	const finished = h.session.prompt(`/delivery-tasks ${ref.data!.id}`);
	await until(() => Boolean(panel?.render(100).join("\n").includes("已完成")));
	panel!.handleInput("\x1b[F");
	assert.ok(panel!.render(100).join("\n").includes("DETAIL_COMMAND_FINISHED"));
	panel!.handleInput("\x1b");
	await finished;
});

test("真实本机命令完成后模型断流，恢复不重复命令或委派", { timeout: 40_000 }, async (t) => {
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
	assert.match(JSON.stringify(tools[2].content), /COMMAND_BEFORE_STREAM_ERROR/);
	assert.ok(!rows.some((row: any) => row.customType === "delivery-execution"));
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 3);
});

test("开发初始读取失败后写入与真实自检成功，父核对过程错误并继续固定验收", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "read-before-write", `const assert = require("node:assert/strict");
assert.equal(require("node:fs").readFileSync("src/value.js", "utf8"), "export const value = 2;\\n");
console.log("READ_RECOVERY_SELF_CHECK_OK");`, ["node inputs/command.cjs"]);
	const result = await h.call("delivery_develop", { task: "先读取不存在的目标，然后创建、编辑并执行一次本机自检。" });
	assert.equal(result.isError, false, "正常收尾返回结果，原始工具错误仍保留");
	assert.equal((result.details as any).progress.status, COMPLETED_STATUS);
	const [rows] = await h.children();
	const tools = rows.filter((row: any) => row.message?.role === "toolResult").map((row: any) => row.message);
	assert.deepEqual(tools.map((tool: any) => [tool.toolName, tool.isError]), [["read", true], ["write", false], ["edit", false], ["bash", false], ["read", false]]);
	assert.match(JSON.stringify(tools[0].content), /ENOENT/);
	assert.match(JSON.stringify(tools[3].content), /READ_RECOVERY_SELF_CHECK_OK/);
	assert.ok(!rows.some((row: any) => row.customType === "delivery-execution"), "普通自检不冒充固定验收证据");
	assert.equal(rows.find((row: any) => row.customType === "delivery-child-exit").data.development.clean, true);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assert.match(text, /过程记录.*工具异常/);
	const childFile = (result.details as any).childSessionFile;
	assert.ok(childFile && text.includes(childFile), "返回原始证据路径供父核对");
	const native = await h.call("read", { path: childFile });
	assert.equal(native.isError, false);
	assert.match(JSON.stringify(native.content), /READ_RECOVERY_SELF_CHECK_OK/);
	assert.equal((await h.call("delivery_validate", {})).isError, false, "原批准仍有效时由既有门禁执行固定验收");
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "开发工具失败保留；原始自检已核实，独立固定验收通过。\n" })).isError, false);
	assert.equal(h.choices.length, 3, "取证与验收不重复申请原范围批准");
	const children = (await h.audit()).filter((row) => row.child && row.phase === "start");
	assert.equal(children.length, 2, "补证不重复开发或自检，只增加独立验收子");
	for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("正式父批准/子 CLI/真实本机 Shell：文件开发、实际命令、持久收尾后父回写台账", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "normal", `const fs = require("node:fs");
const source = fs.readFileSync("src/value.js", "utf8");
if (!source.includes("value = 2")) process.exit(8);
fs.writeFileSync("src/value.js", source.replace("value = 2", "value = 3"));
console.log("LOCAL_REAL_COMMAND_OK");`);
	const progress: any[] = [];
	const unsubscribe = h.session.subscribe((event) => { if (event.type === "tool_execution_update" && event.toolName === "delivery_develop") progress.push(event.partialResult.details.progress); });
	t.after(unsubscribe);
	const result = await h.call("delivery_develop", { task: "创建、编辑后执行已批准的本机自检脚本，再读回文件。" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.ok(progress.some((view) => view.action === "正在执行：bash node inputs/command.cjs" && view.output.includes("LOCAL_REAL_COMMAND_OK")), "本机实际日志在命令结束前沿子 RPC 实时到达父卡片");
	assert.ok(progress.every((view) => view.id === result.toolCallId));
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 3;\n");
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const [rows] = await h.children();
	const ref = rows.find((row: any) => row.type === "custom" && row.customType === "delivery-execution");
	assert.equal(ref, undefined, "普通 Shell 保留原生结果，不生成交付执行证明");
	const tool = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolName === "bash");
	assert.equal(tool.message.isError, false);
	assert.match(JSON.stringify(tool.message.content), /LOCAL_REAL_COMMAND_OK/);
	const events = await h.audit();
	assert.equal(events.filter((row) => row.child && row.phase === "environment-tool-call" && row.toolName === "bash").length, 1);
	assert.equal(events.filter((row) => row.child && row.phase === "environment-tool-result" && row.toolName === "bash").length, 1);
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "真实本机命令已执行，完整独立验收仍待后续。" })).isError, false);
	assert.equal(h.choices.length, 3, "节点回写不重复请求批准");
});

for (const kind of ["failure", "hook-deny", "hook-error"]) test(`正式本机命令 ${kind} 保留失败，不误报成功或锁死已交回 writer`, { timeout: 60_000 }, async (t) => {
	const script = 'if (!require("node:fs").readFileSync("src/value.js", "utf8").includes("value = 3")) process.exit(7); console.log("repaired command");';
	const h = await developmentHost(t, kind, script);
	const outcome = await h.call("delivery_develop", { task: "验证本机错误与配置检查" });
	assert.equal(outcome.isError, false);
	assert.equal((outcome.details as any).progress.status, COMPLETED_STATUS);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const [rows] = await h.children();
	const result = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolName === "bash");
	assert.equal(result?.message.isError, true);
	assert.match(JSON.stringify(result.message.content), kind === "hook-deny" ? /CONFIGURED_TOOL_HOOK_DENIED/ : kind === "hook-error" ? /CONFIGURED_TOOL_HOOK_ERROR/ : /code 7/);
	assert.equal(rows.some((row: any) => row.customType === "delivery-execution"), false);
	if (kind === "failure") {
		assert.equal((await h.call("delivery_develop", { task: "fixture-local-repair：在原授权范围内修复源码并复验" })).isError, false);
		assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 3;\n");
		assert.equal(await readFile(path.join(h.cwd, "inputs/command.cjs"), "utf8"), script);
		assert.equal(h.choices.length, 3);
	}
});

for (const kind of ["cancel", "timeout"]) test(`正式父子本机 ${kind} 等待命令交回和持久终态后才交回 writer`, { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, kind, 'require("node:fs").writeFileSync("src/ready.txt", "ready"); setInterval(() => {}, 1000);');
	const run = h.call("delivery_develop", { task: "执行在途本机命令" });
	const deadline = Date.now() + 15_000;
	while (!await readFile(path.join(h.cwd, "src/ready.txt")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
		assert.ok(Date.now() < deadline, "必须观察到真实本机已执行");
		await setTimeout(20);
	}
	assert.equal((await h.readLease())?.owner.kind, "child");
	if (kind === "cancel") await h.session.abort();
	const result = await run;
	assert.equal(result.isError, kind === "cancel");
	if (kind === "timeout") assert.match(JSON.stringify(result.content), /工具异常/);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const [rows] = await h.children();
	assert.ok(rows.some((row: any) => row.customType === "delivery-child-exit" && row.data.development.clean));
});

test("父 Bash 已被配置覆盖时不将其偷偷替换成本机实现", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "normal", 'console.log("must not execute");');
	await h.session.prompt("/fixture-replace-tool bash");
	assert.notEqual(h.session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source, "builtin");
	const result = await h.call("delivery_develop", { task: "缺少可重建 Bash 能力" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /父子工具定义或来源未对齐/);
	assert.ok(!(await h.audit()).some((row) => row.child && row.phase === "model"));
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
	assert.equal(new Set(proof.results.map((row: any) => row.execution)).size, 2);
	const [rows] = await h.children();
	for (const item of proof.results) {
		const call = rows.find((row: any) => row.message?.role === "assistant" && row.message.content.some((part: any) => part.type === "toolCall" && part.id === item.toolCallId));
		const outcome = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolCallId === item.toolCallId);
		assert.ok(call && outcome);
		assert.equal(outcome.message.isError, false);
		assert.equal(outcome.message.details.execution.name, item.execution);
		assert.equal(outcome.message.details.execution.settled, true);
	}
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: `固定验收通过，候选 ${proof.after.digest}；独立审查待实施。\n` })).isError, false);
	assert.equal(h.choices.length, 3);
});

test("固定验收退出 1 仍判为失败，不能因展示优化继续审查", { timeout: 40_000 }, async (t) => {
	const h = await developmentHost(t, "normal", 'require("node:assert/strict").equal(1, 2);', ["node inputs/command.cjs"]);
	await mkdir(path.join(h.cwd, "src"), { recursive: true });
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 2;\n");
	const result = await h.call("delivery_validate", {});
	assert.equal(result.isError, true);
	assert.equal((result.details as any).progress.status, COMPLETED_STATUS);
	assert.ok((result.details as any).progress.endedAt);
	const parentResult = h.sm.getEntries().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === result.toolCallId);
	assert.equal(parentResult?.type === "message" && parentResult.message.role === "toolResult" ? parentResult.message.details.progress.status : undefined, COMPLETED_STATUS);
	const [rows] = await h.children();
	const failure = rows.find((row: any) => row.message?.role === "toolResult" && row.message.toolName === "bash");
	assert.equal(failure.message.isError, true);
	assert.match(JSON.stringify(failure.message.content), /AssertionError.*code 1/);
	assert.equal((await h.call("delivery_review", { task: "没有通过验收，不得启动审查" })).isError, true);
	assert.equal(await h.readLease(), undefined);
});

test("无规划文档的原生 Pi 完成开发、真实本机验收与独立审查", { timeout: 60_000 }, async (t) => {
	const h = await developmentHost(t, "review-normal", `const assert = require("node:assert/strict");
assert.equal(require("node:fs").readFileSync("src/value.js", "utf8"), "export const value = 2;\\n");
console.log("NO_PLANNING_FILES_CHECK_OK");`, ["node inputs/command.cjs"], false);
	const before = await readdir(h.cwd);
	const developed = await h.call("delivery_develop", { task: "局部修正 value，直接在会话交付" });
	assert.equal(developed.isError, false, JSON.stringify(developed));
	const validated = await h.call("delivery_validate", {});
	assert.equal(validated.isError, false, JSON.stringify(validated));
	const proof = (validated.details as any).validation;
	assert.equal(proof.before.digest, proof.after.digest);
	assert.deepEqual(proof.results.map((row: any) => [row.status, row.exitCode]), [["passed", 0]]);
	const reviewed = await h.call("delivery_review", { task: "对照会话中的原批准、源码差异与原验收" });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.equal((reviewed.details as any).candidate.digest, proof.after.digest);
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 2);
	assert.deepEqual((await readdir(h.cwd)).sort(), [...before, "src"].sort());
	const requests = (await h.audit()).filter((row) => row.child && row.phase === "model");
	for (const result of [developed, validated, reviewed]) {
		const pid = (result.details as any).pid;
		assert.match(JSON.stringify(requests.find((row) => row.pid === pid)?.messages), /APPROVED_DESIGN_BODY.*APPROVED_IMPLEMENTATION_BODY/s);
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	}
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
	assert.deepEqual(requests[0].tools, ["bash", "edit", "read", "write"]);
	assert.match(JSON.stringify(requests[0].messages), /APPROVED_DESIGN_BODY.*APPROVED_IMPLEMENTATION_BODY/s);
	assert.match(JSON.stringify(requests[2].messages), /diff --git/);
	assert.match(JSON.stringify(requests[3].messages), /delivery-execution.*delivery-child-exit/s);
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
	assert.equal(h.choices.length, 3, "同范围返工及节点回写不重复批准");
});

test("正式固定验收取消等待真实本机退出，不消费父排队消息或形成可审查证据", { timeout: 60_000 }, async (t) => {
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
			assert.equal(h.choices.length, 3, "范围内修复/复验不重新批准");
		}
	});
}
