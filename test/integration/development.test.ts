import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";
import { createDevelopmentHost as host } from "../support/development-host.ts";
import { FixtureRpc, testEnvironment } from "../support/pi-fixture.ts";
import { TOOL_ERROR_STATUS } from "../../extensions/delivery-gate/src/progress.ts";

test("真实子 edit 匹配不唯一后补充上下文修正，返回过程错误提示而非整项失败", { timeout: 40_000 }, async (t) => {
	const h = await host(t, "edit-recovery");
	await h.prepare();
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "first = 1\nsecond = 1\n");
	const result = await h.call("delivery_develop", { task: "修正两处值，匹配不唯一时读取文件并补足上下文" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal((result.details as any).progress.status, TOOL_ERROR_STATUS);
	assert.match(JSON.stringify(result.content), /不证明错误已修复或任务已验收/);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "first = 2\nsecond = 2\n");
	const rows = (await readFile((result.details as any).childSessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	const tools = rows.filter((row) => row.message?.role === "toolResult").map((row) => row.message);
	assert.deepEqual(tools.map((tool) => [tool.toolName, tool.isError]), [["edit", true], ["read", false], ["edit", false]]);
	assert.match(JSON.stringify(tools[0].content), /Found 2 occurrences/);
	assert.match(JSON.stringify(tools[2].content), /Successfully replaced 2 block/);
	assert.equal(rows.find((row) => row.customType === "delivery-child-exit").data.development.clean, true);
	assert.throws(() => process.kill((result.details as any).pid, 0), { code: "ESRCH" });
	assert.equal(await h.readLease(), undefined);
	assert.equal((await h.call("delivery_review", { task: "没有固定验收不能视作已验证" })).isError, true);
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "编辑结果已核对，待固定验收。" })).isError, false);
});

for (const name of ["git", "pi", "node"]) test(`未批准时状态查询和只读委派不执行项目 PATH ${name}`, { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	const bin = path.join(h.cwd, "bin");
	await mkdir(bin);
	await writeFile(path.join(bin, name), `#!/bin/sh\nprintf executed > '${h.cwd}/path-executed'\n${name === "git" ? 'exec /usr/bin/git "$@"' : "exit 0"}\n`, { mode: 0o700 });
	process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
	await h.session.prompt("/delivery-status");
	assert.ok(h.notices.some((notice) => notice.includes("当前没有运行中的子任务")), h.notices.join("\n"));
	const result = await h.call("delivery_readonly", { task: "读取 input.txt，不提供实施授权" });
	assert.equal(result.isError, name === "pi", JSON.stringify(result));
	if (name === "pi") assert.match(JSON.stringify(result), /Pi.*工作区外/);
	const children = (await h.audit()).filter((row) => row.child && row.phase === "start");
	assert.equal(children.length, name === "pi" ? 0 : 1);
	for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
	await assert.rejects(access(path.join(h.cwd, "path-executed")), { code: "ENOENT" });
	assert.equal(h.choices.length, 0);
});

test("正式开发入口：父确认后子 Pi 创建、编辑与读回，收尾后父重新取得文档 writer", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	const progress: any[] = [];
	const unsubscribe = h.session.subscribe((event) => { if (event.type === "tool_execution_update" && event.toolName === "delivery_develop") progress.push(event.partialResult.details.progress); });
	t.after(unsubscribe);
	await h.prepare();
	await h.session.prompt("/fixture-parent-history");
	await h.session.setModel(h.session.modelRuntime.getModel("adaptive-fixture", "fake-reasoner")!);
	h.session.setThinkingLevel("high");
	const result = await h.call("delivery_develop", { task: "创建 src/value.js，将 value 从 1 改为 2 并读取文件核对。",
		agent: { thinking: "medium", reason: "边界明确的局部开发" } });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.ok(progress.every((view) => view.id === result.toolCallId && view.name.startsWith("开发")));
	for (const tool of ["write", "edit", "read"]) {
		assert.ok(progress.some((view) => view.action === `正在执行：${tool} src/value.js`));
		assert.ok(progress.some((view) => view.action === `已完成：${tool} src/value.js`));
	}
	assert.match(progress.at(-1).status, /开发结束/);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const events = await h.audit();
	const child = events.find((row) => row.child && row.phase === "start");
	assert.ok(child);
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
	const requests = events.filter((row) => row.child && row.phase === "model");
	assert.equal(requests.length, 4);
	assert.ok(requests.every((row) => row.modelId === "fake-reasoner" && row.reasoning === "medium"));
	assert.deepEqual(progress.at(-1).agent, { provider: "adaptive-fixture", id: "fake-reasoner", thinking: "medium", reason: "边界明确的局部开发" });
	assert.equal(h.session.model!.id, "fake-reasoner");
	assert.equal(h.session.thinkingLevel, "high");
	assert.ok(requests.every((row) => !row.parentMarkerSeen));
	assert.match(JSON.stringify(requests[0].messages), /APPROVED_DESIGN_BODY.*APPROVED_IMPLEMENTATION_BODY/s);
	assert.ok(requests[0].tools.includes("write") && requests[0].tools.includes("edit"));
	assert.ok(!requests[0].tools.includes("delivery_develop") && !requests[0].tools.includes("delivery_approval"));
	const owned = events.filter((row) => row.phase === "development-lease");
	assert.equal(owned.length, 3);
	for (const item of owned) {
		assert.equal(item.lease.owner.pid, child.pid);
		assert.equal(item.lease.owner.kind, "child");
		assert.equal(item.lease.coordinator.pid, process.pid);
		assert.notEqual(item.lease.owner.processToken, item.lease.coordinator.processToken);
		assert.equal(item.lease.owner.runId, result.toolCallId);
	}
	assert.equal(events.filter((row) => row.child && row.phase === "environment-tool-call").length, 3);
	assert.equal(events.filter((row) => row.child && row.phase === "environment-tool-result").length, 3);
	assert.equal(events.filter((row) => row.child && row.phase === "environment-context").length, requests.length);
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "父核对后记录文件变更，命令验证尚未执行。\n" })).isError, false);
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 2, "文件节点回写不重复请求批准");
});

test("无规划文档的真实 Pi 开发、固定验收和独立审查沿用会话批准正文", { timeout: 60_000 }, async (t) => {
	const h = await host(t, "local-review-normal");
	await mkdir(path.join(h.cwd, "inputs"));
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), "console.log('fixture validation input');\n");
	const before = await readdir(h.cwd);
	assert.equal((await h.approve("design", [])).isError, false);
	assert.equal((await h.call("delivery_develop", { task: "只有方案确认不能开发" })).isError, true);
	assert.equal((await h.approve("implementation", [])).isError, true);
	assert.ok(!(await h.audit()).some((row) => row.child));
	assert.equal((await h.approve("implementation", ["src"], ["inputs"], ["node inputs/command.cjs"])).isError, false);
	const developed = await h.call("delivery_develop", { task: "局部修改 value 为 2，不需要规划文件" });
	assert.equal(developed.isError, false, JSON.stringify(developed));
	assert.equal((await h.call("delivery_review", { task: "没有固定验收不能审查" })).isError, true);
	const validated = await h.call("delivery_validate", {});
	assert.equal(validated.isError, false, JSON.stringify(validated));
	const reviewed = await h.call("delivery_review", { task: "按原方案、实际差异和验收记录核对结果" });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.equal((reviewed.details as any).candidate.digest, (validated.details as any).validation.after.digest);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	assert.deepEqual((await readdir(h.cwd)).sort(), [...before, "src"].sort(), "只增加源码目录，无规划文件或目录");
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 2);
	const requests = (await h.audit()).filter((row) => row.child && row.phase === "model");
	for (const result of [developed, validated, reviewed]) {
		const pid = (result.details as any).pid;
		assert.match(JSON.stringify(requests.find((row) => row.pid === pid)?.messages), /APPROVED_DESIGN_BODY.*APPROVED_IMPLEMENTATION_BODY/s);
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	}
	const rows = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	assert.equal(rows.filter((row) => row.customType === "delivery-approval").length, 2);
	assert.ok(!rows.some((row) => /^delivery_document_/.test(row.message?.toolName ?? "")));
});

test("正式固定验收没有批准或命令时不启动子 Pi，不把零项算通过", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	assert.equal((await h.call("delivery_validate", {})).isError, true);
	await h.prepare();
	const result = await h.call("delivery_validate", {});
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result), /未运行/);
	assert.ok(!(await h.audit()).some((row) => row.child));
	assert.equal(await h.readLease(), undefined);
});

async function reviewHost(t: TestContext, scenario = "normal", configure?: (pi: ExtensionAPI) => void) {
	const h = await host(t, `local-review-${scenario}`, configure);
	await h.prepare();
	await mkdir(path.join(h.cwd, "src"));
	await mkdir(path.join(h.cwd, "inputs"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), "console.log('fixture input');\n");
	const inputs = ["inputs"];
	const commands = ["node inputs/command.cjs"];
	assert.equal((await h.approve("implementation", ["src"], inputs, commands)).isError, false);
	return { ...h, inputs, commands };
}

test("真实 Pi 子任务跟随父模型切换，四类工具拒绝单独选模型", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	assert.ok(!h.api.getAllTools().some((tool) => tool.name === "delivery_models"));
	assert.equal((await h.call("delivery_models", {})).isError, true);
	for (const tool of ["delivery_readonly", "delivery_develop", "delivery_validate", "delivery_review"]) {
		const rejected = await h.call(tool, { ...(tool === "delivery_validate" ? {} : { task: "不能另选可用模型" }),
			agent: { model: { provider: "adaptive-fixture", id: "fake-reasoner" }, thinking: "low", reason: "不能另选模型" } });
		assert.equal(rejected.isError, true, JSON.stringify(rejected));
		assert.match(JSON.stringify(rejected), /agent\/model|additional propert/i);
	}
	assert.equal((await h.call("delivery_readonly", { task: "不能发出任务", agent: { thinking: "high", reason: "非推理模型不能用 high" } })).isError, true);
	assert.ok(!(await h.audit()).some((row) => row.child));
	const first = await h.call("delivery_readonly", { task: "使用父当前模型检查 input.txt" });
	assert.equal(first.isError, false, JSON.stringify(first));
	await h.session.setModel(h.session.modelRuntime.getModel("adaptive-fixture", "fake-reasoner")!);
	h.session.setThinkingLevel("high");
	const result = await h.call("delivery_readonly", { task: "检查 input.txt 并返回结论", agent: { thinking: "low", reason: "明确的事实查询" } });
	assert.equal(result.isError, false, JSON.stringify(result));
	const requests = (await h.audit()).filter((row) => row.child && row.phase === "model");
	for (const [run, id, thinking] of [[first, "fake", "off"], [result, "fake-reasoner", "low"]] as const) {
		const details = run.details as any;
		const own = requests.filter((row) => row.pid === details.pid);
		assert.ok(own.length > 0 && own.every((row) => row.modelId === id));
		if (thinking !== "off") assert.ok(own.every((row) => row.reasoning === thinking));
		assert.equal(details.progress.agent.thinking, thinking);
		assert.throws(() => process.kill(details.pid, 0), { code: "ESRCH" });
	}
	assert.ok(requests.every((row) => !row.tools.includes("delivery_models") && !row.tools.includes("delivery_document_write")));
	const parentRequests = (await h.audit()).filter((row) => !row.child && row.phase === "model");
	assert.match(parentRequests.at(-1).systemPrompt, /父 Pi 当前模型 adaptive-fixture\/fake-reasoner；可选推理级别：off、minimal、low、medium、high/);
	assert.doesNotMatch(parentRequests.at(-1).systemPrompt, /delivery_models/);
	const record = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === "delivery-delegation") as any;
	assert.deepEqual(record.data.agent, { provider: "adaptive-fixture", id: "fake-reasoner", thinking: "low", reason: "明确的事实查询" });
	assert.equal(h.session.model!.id, "fake-reasoner");
	assert.equal(h.session.thinkingLevel, "high");
	assert.equal(h.choices.length, 0);
});

for (const tool of ["delivery_readonly", "delivery_develop"]) test(`${tool} 拒绝实际子启动级别被配置改写，不发送任务且正常收尾`, { timeout: 40_000 }, async (t) => {
	const h = await host(t, "selection-mismatch");
	if (tool === "delivery_develop") await h.prepare();
	await h.session.setModel(h.session.modelRuntime.getModel("adaptive-fixture", "fake-reasoner")!);
	const result = await h.call(tool, { task: "不得在被改写的模型配置下执行", agent: {
		thinking: "high", reason: "检验关键边界" } });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result), /模型或继承工具未核实，未发送任务/);
	const events = (await h.audit()).filter((row) => row.child);
	assert.equal(events.filter((row) => row.phase === "start").length, 1);
	assert.ok(!events.some((row) => row.phase === "model" || row.phase === "environment-tool-call"));
	assert.throws(() => process.kill(events.find((row) => row.phase === "start").pid, 0), { code: "ESRCH" });
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	await assert.rejects(access(path.join(h.cwd, "src/value.js")), { code: "ENOENT" });
});

test("真实验收与审查子可分别选择级别，原批准与工具参数绑定保持", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t);
	await h.session.setModel(h.session.modelRuntime.getModel("adaptive-fixture", "fake-reasoner")!);
	h.session.setThinkingLevel("high");
	const validated = await h.call("delivery_validate", { agent: { thinking: "low", reason: "执行固定验收命令" } });
	assert.equal(validated.isError, false, JSON.stringify(validated));
	const reviewed = await h.call("delivery_review", { task: "对照候选与证据检查行为", agent: { thinking: "high", reason: "代码审查需检查遗漏边界" } });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.equal((validated.details as any).progress.agent.thinking, "low");
	assert.equal((reviewed.details as any).progress.agent.thinking, "high");
	const requests = (await h.audit()).filter((row) => row.child && row.phase === "model");
	assert.ok(requests.some((row) => row.modelId === "fake-reasoner" && row.reasoning === "low"));
	assert.ok(requests.some((row) => row.modelId === "fake-reasoner" && row.reasoning === "high"));
	assert.ok(requests.every((row) => row.modelId === "fake-reasoner"));
	assert.equal(h.session.model!.id, "fake-reasoner");
	assert.equal(h.session.thinkingLevel, "high");
	assert.equal(await h.readLease(), undefined);
});

test("真实子审查运行中切换父模型，子后续请求保持启动模型与级别", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t, "dialog");
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	await h.session.setModel(h.session.modelRuntime.getModel("adaptive-fixture", "fake-reasoner")!);
	h.session.setThinkingLevel("high");
	let switched = false;
	h.setConfirm(async () => {
		assert.ok((await h.audit()).some((row) => row.child && row.phase === "model" && row.modelId === "fake-reasoner"));
		await h.session.setModel(h.session.modelRuntime.getModel("adaptive-fixture", "fake")!);
		switched = true;
		return true;
	});
	const reviewed = await h.call("delivery_review", { task: "审查中切换父模型", agent: { thinking: "low", reason: "检查已确认的局部改动" } });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.equal(switched, true);
	const requests = (await h.audit()).filter((row) => row.pid === (reviewed.details as any).pid && row.phase === "model");
	assert.ok(requests.length > 1 && requests.every((row) => row.modelId === "fake-reasoner" && row.reasoning === "low"));
	assert.equal(h.session.model!.id, "fake");
	assert.equal(h.session.thinkingLevel, "off");
	assert.equal(await h.readLease(), undefined);
	assert.throws(() => process.kill((reviewed.details as any).pid, 0), { code: "ESRCH" });
});

test("候选含符号链接时不启动子 Pi 或锁住 writer，修复范围后可继续验收", { timeout: 40_000 }, async (t) => {
	const h = await host(t, "local-review-normal");
	await h.prepare();
	await mkdir(path.join(h.cwd, "inputs"));
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), "console.log('fixture input');\n");
	await symlink("inputs", path.join(h.cwd, "src"));
	assert.equal((await h.approve("implementation", ["src"], ["inputs"], ["node inputs/command.cjs"])).isError, false);
	const validation = await h.call("delivery_validate", {});
	assert.equal(validation.isError, true);
	assert.match(JSON.stringify(validation), /链接/);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.ok(!(await h.audit()).some((row) => row.child));
	const choices = h.choices.length;
	await rm(path.join(h.cwd, "src"));
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "候选缺失，尚未验收。\n" })).isError, false);
	assert.equal((await h.call("delivery_develop", { task: "创建缺失的 src 并完成修改" })).isError, false);
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal(h.choices.length, choices);
});

test("交接后任务发送前记录失败，正常退出的空子 Session 可证明未执行并交回 writer", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	const append = h.sm.appendCustomEntry.bind(h.sm);
	let injected = false;
	h.sm.appendCustomEntry = (name, data) => {
		if (name === "delivery-development" && !injected) { injected = true; throw new Error("fixture before-task record failure"); }
		return append(name, data);
	};
	const result = await h.call("delivery_develop", { task: "任务尚未发送就停止" });
	assert.equal(injected, true);
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result), /fixture before-task record failure/);
	assert.match(JSON.stringify(result.content), /子任务尚未发送，Session 文件可能尚未生成/);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const events = await h.audit();
	assert.equal(events.filter((row) => row.child && row.phase === "model").length, 0);
	const child = events.find((row) => row.child && row.phase === "start");
	assert.ok(child);
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
	await assert.rejects(access(path.join(h.cwd, "src/value.js")), { code: "ENOENT" });
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "本次任务未运行。\n" })).isError, false);
});

test("独立审查缺少本轮验收时不启动子任务，拒绝后不占住父 writer", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t);
	const result = await h.call("delivery_review", { task: "没有验收不能伪造通过" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result), /没有本轮/);
	assert.ok(!(await h.audit()).some((row) => row.child));
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
});

test("真实 Pi 独立审查在 Git replace 存在时仍收到真实修改差异", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t);
	const progress: any[] = [];
	const unsubscribe = h.session.subscribe((event) => { if (event.type === "tool_execution_update" && ["delivery_validate", "delivery_review"].includes(event.toolName)) progress.push(event.partialResult.details.progress); });
	t.after(unsubscribe);
	const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: h.cwd, encoding: "utf8" }).trim();
	git("add", "src");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "isolated review baseline");
	const old = git("rev-parse", "HEAD:src/value.js");
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 2;\n");
	const replacement = git("hash-object", "-w", "src/value.js");
	git("replace", old, replacement);
	const validation = await h.call("delivery_validate", {});
	assert.equal(validation.isError, false);
	const review = await h.call("delivery_review", { task: "检查原始 HEAD 与当前源码的差异" });
	assert.equal(review.isError, false, JSON.stringify(review));
	assert.ok(progress.filter((view) => view.id === validation.toolCallId).every((view) => view.name.startsWith("验收")));
	assert.ok(progress.filter((view) => view.id === review.toolCallId).every((view) => view.name.startsWith("审查")));
	assert.ok(progress.some((view) => view.id === validation.toolCallId && view.action === "正在执行：bash node inputs/command.cjs"));
	assert.ok(progress.some((view) => view.id === review.toolCallId && view.action === "已完成：read src/value.js"));
	assert.match(progress.findLast((view) => view.id === validation.toolCallId).status, /固定验收通过/);
	assert.match(progress.at(-1).status, /审查结束/);
	const diffFile = (review.details as any).diffFile;
	assert.match(await readFile(diffFile, "utf8"), /-export const value = 1;\n\+export const value = 2;/);
	const events = await h.audit();
	assert.ok(events.some((row) => row.child && row.phase === "model" && JSON.stringify(row.messages).includes("-export const value = 1;")));
	assert.equal(git("rev-parse", `refs/replace/${old}`), replacement);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
});

for (const kind of ["source", "input", "approval"]) test(`独立审查 ${kind} 变化使旧验收失效，重新验收后才可继续`, { timeout: 60_000 }, async (t) => {
	const h = await reviewHost(t);
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	if (kind === "approval") await h.approve("implementation", ["src"], h.inputs, h.commands);
	else await writeFile(path.join(h.cwd, kind === "source" ? "src/value.js" : "inputs/test.js"), "changed candidate\n");
	assert.equal((await h.call("delivery_review", { task: "不能沿用旧证据" })).isError, true);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, 1);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	const review = await h.call("delivery_review", { task: "新证据对应当前候选" });
	assert.equal(review.isError, false, JSON.stringify(review));
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
});

test("独立审查不回退最近一次失败之前的成功验收", { timeout: 60_000 }, async (t) => {
	const h = await reviewHost(t);
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), "process.exit(7);\n");
	assert.equal((await h.call("delivery_validate", {})).isError, true);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.call("delivery_review", { task: "拒绝回退旧成功" })).isError, true);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, 2);
});

for (const kind of ["parent", "child"]) test(`独立审查拒绝篡改后的 ${kind} 原生验收证据`, { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t);
	const validation = await h.call("delivery_validate", {});
	assert.equal(validation.isError, false);
	if (kind === "parent") {
		const row = h.sm.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === validation.toolCallId);
		assert.ok(row?.type === "message" && row.message.role === "toolResult");
		row.message.content = [{ type: "text", text: "内存与磁盘一起伪造成功" }];
		const file = h.sm.getSessionFile()!;
		const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		await writeFile(file, rows.map((entry) => JSON.stringify(entry.id === row.id ? row : entry)).join("\n") + "\n");
	} else {
		const file = (validation.details as any).childSessionFile;
		const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		rows.find((row) => row.message?.role === "toolResult").message.content = [{ type: "text", text: "伪造子证据" }];
		await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	}
	assert.equal((await h.call("delivery_review", { task: "拒绝被篡改的证据" })).isError, true);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, 1);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
});

for (const kind of ["tool-replaced", "hook-deny", "hook-error", "write"]) test(`独立审查 ${kind} 保留实际错误，核实收尾后可交回 writer`, { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t, kind);
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	const result = await h.call("delivery_review", { task: kind === "write" ? "fixture-read-then-write" : "检查实际能力失败" });
	assert.equal(result.isError, kind === "tool-replaced", JSON.stringify(result));
	if (kind === "hook-deny" || kind === "hook-error") assert.equal((result.details as any).progress.status, TOOL_ERROR_STATUS);
	const children = (await h.audit()).filter((row) => row.child && row.phase === "start");
	assert.equal(children.length, 2);
	assert.throws(() => process.kill(children[1].pid, 0), { code: "ESRCH" });
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	if (kind === "write") assert.equal(await readFile(path.join(h.cwd, "forbidden.txt"), "utf8"), "unexpected", "只读是任务要求；普通工具违规写入仍须由父审查");
	else await assert.rejects(access(path.join(h.cwd, "forbidden.txt")), { code: "ENOENT" });
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "审查失败，未完成交付。\n" })).isError, false);
});

test("独立审查在途持有父 lease，取消清空队列并等待子实际退出", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t, "wait");
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	const before = (await h.audit()).filter((row) => !row.child && row.phase === "model").length;
	const run = h.call("delivery_review", { task: "等待取消" });
	const deadline = Date.now() + 10_000;
	while (!(await h.audit()).some((row) => row.phase === "review-waiting")) {
		assert.ok(Date.now() < deadline, "必须先观察到真实审查子模型在途");
		await setTimeout(20);
	}
	assert.equal((await h.readLease())?.owner.kind, "parent");
	const workspace = await resolveWorkspaceIdentity(h.cwd);
	const other = new WriterLeaseManager(await getWriterStateRoot(workspace));
	assert.equal((await other.acquire(workspace, { kind: "parent", sessionId: "competing-review", pid: process.pid })).ok, false);
	await h.session.followUp("不得在取消后继续");
	h.session.clearQueue();
	await h.session.abort();
	assert.equal((await run).isError, true);
	assert.equal(h.session.pendingMessageCount, 0);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const events = await h.audit();
	assert.equal(events.filter((row) => !row.child && row.phase === "model").length, before + 1);
	const child = events.find((row) => row.phase === "review-waiting");
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("独立审查期间外部改动候选不能形成同候选审查证据", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t, "dialog");
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	h.setConfirm(async () => { await writeFile(path.join(h.cwd, "src/value.js"), "externally changed\n"); return true; });
	const result = await h.call("delivery_review", { task: "普通询问期间外部进程绕过 lease 改文件" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result), /审查期间候选发生变化/);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.call("delivery_review", { task: "旧验收已失效" })).isError, true);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, 2);
});

for (const boundary of ["dialog", "handoff"]) test(`独立审查在 ${boundary} 前原验收记录变化，不能交付有效审查`, { timeout: 60_000 }, async (t) => {
	let file: string;
	let changed = false;
	const tamper = async () => {
		const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		rows.find((row) => row.message?.role === "toolResult").message.content = [{ type: "text", text: "EVIDENCE_CHANGED_DURING_REVIEW" }];
		await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
		changed = true;
	};
	const h = await reviewHost(t, boundary === "dialog" ? "dialog" : "normal", (pi) => {
		if (boundary === "handoff") pi.on("tool_result", async (event) => { if (event.toolName === "delivery_review" && !changed) await tamper(); });
	});
	const validation = await h.call("delivery_validate", {});
	assert.equal(validation.isError, false);
	file = (validation.details as any).childSessionFile;
	h.setConfirm(async () => { await tamper(); return true; });
	const result = await h.call("delivery_review", { task: "核对审查期间原始验收完整性" });
	assert.equal(changed, true);
	if (boundary === "dialog") {
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result), /审查期间原验收证据/);
		assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
		assert.equal((await h.call("delivery_review", { task: "失效验收不能复用" })).isError, true);
		h.setConfirm(async () => true);
		assert.equal((await h.call("delivery_validate", {})).isError, false);
		assert.equal((await h.call("delivery_review", { task: "重新验收后可以审查" })).isError, false);
	} else {
		assert.equal((await h.readLease())?.owner.kind, "parent", h.notices.join("\n"));
		assert.ok(h.notices.some((notice) => notice.includes("未交回")));
		assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "不能把失效结果记成完成" })).isError, true);
	}
	for (const child of (await h.audit()).filter((row) => row.child && row.phase === "start")) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("独立审查崩溃保留父 lease，不能凭只读或进程退出继续写进度", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t, "crash");
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	assert.equal((await h.call("delivery_review", { task: "注入审查崩溃" })).isError, true);
	assert.equal((await h.readLease())?.owner.kind, "parent", h.notices.join("\n"));
	assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "禁止误报完成" })).isError, true);
	assert.equal((await h.call("delivery_develop", { task: "禁止未知收尾后开发" })).isError, true);
	const children = (await h.audit()).filter((row) => row.child && row.phase === "start");
	assert.equal(children.length, 2);
	assert.throws(() => process.kill(children[1].pid, 0), { code: "ESRCH" });
});

for (const name of ["delivery_validate", "delivery_review"]) test(`正式 ${name} 被同名覆盖后不能继承父协调权限`, { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.session.prompt(`/fixture-replace-tool ${name}`);
	assert.equal((await h.call(name, name === "delivery_validate" ? {} : { task: "不能调用覆盖实现" })).isError, true);
	await assert.rejects(access(path.join(h.cwd, "forbidden.txt")), { code: "ENOENT" });
	assert.ok(!(await h.audit()).some((row) => row.child));
});

for (const name of ["delivery_validate", "delivery_review"]) for (const kind of ["tamper", "persistence"]) {
	test(`P5 ${name} 父原生终态 ${kind} 不释放 writer 或伪造完成`, { timeout: 40_000 }, async (t) => {
		let file: string | undefined;
		const h = await reviewHost(t, "normal", (pi) => pi.on("tool_result", async (event, ctx) => {
			if (event.toolName !== name) return;
			if (kind === "tamper") return { content: [{ type: "text", text: "伪造完成结果" }] };
			if (!file) { file = ctx.sessionManager.getSessionFile(); await chmod(file!, 0o400); }
			return undefined;
		}));
		if (name === "delivery_review") assert.equal((await h.call("delivery_validate", {})).isError, false);
		try {
			const run = h.call(name, name === "delivery_review" ? { task: "审查写盘故障" } : {});
			if (kind === "persistence") await assert.rejects(run, { code: "EACCES" });
			else await run;
			assert.equal((await h.readLease())?.owner.kind, name === "delivery_validate" ? "child" : "parent", h.notices.join("\n"));
			if (file) await chmod(file, 0o600);
			assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "不得误报完成" })).isError, true);
			assert.equal((await h.call("delivery_review", { task: "不能沿用未交回的验收" })).isError, true);
			for (const child of (await h.audit()).filter((row) => row.child && row.phase === "start")) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
		} finally { if (file) await chmod(file, 0o600); }
	});
}

test("P5 审查子原生日志写盘失败保留未知 lease", { timeout: 40_000 }, async (t) => {
	const h = await reviewHost(t, "child-persistence");
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	try {
		assert.equal((await h.call("delivery_review", { task: "审查子记录真实 EACCES" })).isError, true);
		assert.equal((await h.readLease())?.owner.kind, "parent", h.notices.join("\n"));
		assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "禁止完成" })).isError, true);
	} finally {
		const reference = h.sm.getEntries().findLast((row) => row.type === "custom" && row.customType === "delivery-delegation");
		if (reference?.type === "custom") await chmod((reference.data as any).sessionFile, 0o600);
	}
});

for (const boundary of ["reload", "tree"]) test(`P5 正常收尾后 ${boundary} 不自动恢复权限，重新确认和验收后可继续`, { timeout: 60_000 }, async (t) => {
	const h = await reviewHost(t);
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	const calls = (await h.audit()).filter((row) => row.phase === "model").length;
	if (boundary === "reload") await h.session.reload();
	else assert.equal((await h.session.navigateTree(h.sm.getEntries()[0]!.id, { summarize: false })).cancelled, false);
	assert.equal((await h.audit()).filter((row) => row.phase === "model").length, calls, "重载或导航不自动调用模型");
	for (const name of ["delivery_validate", "delivery_review", "delivery_develop"]) assert.equal((await h.call(name, name === "delivery_validate" ? {} : { task: "旧记录不是新授权" })).isError, true);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, 1);
	assert.equal(await h.readLease(), undefined);
	await h.prepare();
	assert.equal((await h.approve("implementation", ["src"], h.inputs, h.commands)).isError, false);
	assert.equal((await h.call("delivery_review", { task: "重新批准也不能复用旧验收" })).isError, true);
	assert.equal((await h.call("delivery_validate", {})).isError, false);
	assert.equal((await h.call("delivery_review", { task: "当前事实重新核实后审查" })).isError, false);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 1;\n");
});

test("P5 崩溃现场重开及 fork 真实 CLI 不调用模型或重放写入，status 显示磁盘 lease", { timeout: 40_000 }, async (t) => {
	const h = await host(t, "crash");
	await h.prepare();
	assert.equal((await h.call("delivery_develop", { task: "写入后崩溃，保留原始现场" })).isError, true);
	const lease = await h.readLease();
	assert.equal(lease?.owner.kind, "child");
	const file = h.sm.getSessionFile()!;
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.session.dispose();
	const calls = (await h.audit()).filter((row) => row.phase === "model").length;
	const rpc = new FixtureRpc(h.cwd, { ...testEnvironment(h.root), ADAPTIVE_FIXTURE_SCENARIO: "development-normal" });
	t.after(() => rpc.stop());
	await rpc.send("get_state");
	await rpc.send("switch_session", { sessionPath: file });
	const previousSession = (await rpc.send("get_state")).data.sessionId;
	const userEntry = h.sm.getEntries().findLast((row) => row.type === "message" && row.message.role === "user")!;
	await rpc.send("fork", { entryId: userEntry.id });
	assert.notEqual((await rpc.send("get_state")).data.sessionId, previousSession);
	assert.equal((await h.audit()).filter((row) => row.phase === "model").length, calls);
	assert.equal((await h.readLease())?.leaseId, lease!.leaseId);
	const cursor = rpc.records.length;
	await rpc.send("prompt", { message: "/delivery-status details" });
	assert.ok(rpc.records.slice(cursor).some((row) => row.type === "extension_ui_request" && row.method === "notify" && row.message.includes(lease!.leaseId) && row.message.includes("不自动解锁")));
	await rpc.send("prompt", { message: `/fixture-next-tool ${JSON.stringify({ type: "toolCall", id: "reopened-write", name: "delivery_develop", arguments: { task: "禁止沿用历史授权" } })}` });
	const from = rpc.records.length;
	await rpc.send("prompt", { message: "只有用户明确要求才尝试本次工具，不能重放旧任务" });
	await rpc.waitFor((row) => row.type === "agent_settled", from);
	assert.ok(rpc.records.slice(from).some((row) => row.type === "tool_execution_end" && row.toolName === "delivery_develop" && row.isError));
	assert.equal((await h.readLease())?.leaseId, lease!.leaseId);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 1;\n");
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, 1);
});

for (const kind of ["live", "summary-only"]) test(`P5 正式压缩 ${kind} 不用摘要代替批准或原始验收`, { timeout: 40_000 }, async (t) => {
	const configure = (pi: ExtensionAPI) => pi.on("session_before_compact", (event) => ({ compaction: {
		summary: "夹具压缩摘要声称全部目标、路径和命令都已经批准并验收通过，不能作为权限或证据。",
		firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
	} }));
	const h = kind === "live" ? await reviewHost(t, "normal", configure) : await host(t, "normal", configure);
	if (kind === "live") assert.equal((await h.call("delivery_validate", {})).isError, false);
	else await h.session.prompt("读取 input.txt，不请求任何批准");
	h.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const before = (await h.audit()).filter((row) => row.phase === "model").length;
	await h.session.compact();
	assert.equal((await h.audit()).filter((row) => row.phase === "model").length, before, "测试使用公开 compaction 钩子的固定摘要，不调用总结模型");
	assert.ok(h.sm.getEntries().some((row) => row.type === "compaction" && row.summary.includes("夹具压缩摘要")));
	const result = await h.call("delivery_review", { task: "仍只核对原始批准与实际证据" });
	assert.equal(result.isError, kind === "summary-only", JSON.stringify(result));
	if (kind === "summary-only") {
		assert.equal((await h.call("delivery_develop", { task: "摘要不能提供源码权限" })).isError, true);
		assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "默认编辑 Markdown；摘要不能提供源码或命令权限" })).isError, false);
		assert.equal(h.choices.length, 0);
		assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-approval").length, 0);
		assert.ok(!(await h.audit()).some((row) => row.child));
	}
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
});

test("P5 开发 I/O 在途正常 reload 等待实际收尾，不自动续跑", { timeout: 40_000 }, async (t) => {
	const h = await host(t, "wait");
	await h.prepare();
	const before = (await h.audit()).filter((row) => !row.child && row.phase === "model").length;
	const run = h.call("delivery_develop", { task: "真实 I/O 等待期间重载" });
	const deadline = Date.now() + 10_000;
	while (!(await h.audit()).some((row) => row.phase === "development-io-pending")) {
		assert.ok(Date.now() < deadline, "必须先进入文件 I/O");
		await setTimeout(20);
	}
	let ended = false;
	const reload = h.session.reload().then(() => { ended = true; });
	try {
		await setTimeout(80);
		assert.equal(ended, false, "重载不能先于实际句柄关闭");
		assert.equal((await h.readLease())?.owner.kind, "child");
	} finally { await writeFile(path.join(h.agentDir, "development-unblock"), "unblock"); }
	await reload;
	assert.equal((await run).isError, true);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const events = await h.audit();
	assert.ok(events.some((row) => row.phase === "development-handle-closed"));
	assert.equal(events.filter((row) => !row.child && row.phase === "model").length, before + 1);
	assert.throws(() => process.kill(events.find((row) => row.child && row.phase === "start").pid, 0), { code: "ESRCH" });
	assert.equal((await h.call("delivery_develop", { task: "重载不会恢复旧授权" })).isError, true);
});

test("P5 文档 writer 在原生结果落盘前 reload 等待交接，不续跑或遗失已发生的写入", { timeout: 40_000 }, async (t) => {
	let unblock!: () => void;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const held = new Promise<void>((resolve) => { unblock = resolve; });
	const h = await host(t, "normal", (pi) => pi.on("tool_result", async (event) => {
		if (event.toolName === "delivery_document_write") { entered(); await held; }
	}));
	await h.prepare();
	const before = (await h.audit()).filter((row) => !row.child && row.phase === "model").length;
	const run = h.call("delivery_document_write", { path: "plan.md", content: "已发生的写入保留" });
	let reload: Promise<void> | undefined;
	try {
		await ready;
		assert.equal((await h.readLease())?.owner.kind, "parent");
		let ended = false;
		reload = h.session.reload().then(() => { ended = true; });
		await setTimeout(50);
		assert.equal(ended, false);
	} finally { unblock(); await held; }
	await reload;
	assert.equal((await run).isError, false, "取消不改变已经完成的文件写入事实");
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal((await h.audit()).filter((row) => !row.child && row.phase === "model").length, before + 1);
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "已发生的写入保留");
});

for (const kind of ["readonly", "development", "readonly-write"]) test(`正式 ${kind} 子交互归属正确，普通回答不扩大授权`, { timeout: 40_000 }, async (t) => {
	const h = await host(t, "dialog-normal");
	if (kind === "development") await h.prepare();
	const titles: string[] = [];
	h.setSelect(async (title, items) => { titles.push(title); return items[1]; });
	h.setConfirm(async (title) => { titles.push(title); return true; });
	h.setInput(async (title) => { titles.push(title); return "回答不提供写入授权"; });
	const before = h.sm.getEntries().filter((row) => row.type === "custom" && row.customType === "delivery-approval").length;
	const result = await h.call(kind === "development" ? "delivery_develop" : "delivery_readonly", { task: kind === "readonly-write" ? "fixture-read-then-write" : "执行一次任务并提供证据" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(titles.length, 3);
	const events = await h.audit();
	const child = events.find((row) => row.child && row.phase === "start");
	assert.ok(titles.every((title) => title.includes(`PID ${child.pid}`) && title.includes("不授予交付权限")));
	const answer = events.find((row) => row.child && row.phase === "dialog-answer");
	assert.deepEqual({ confirm: answer.confirm, select: answer.select, input: answer.input, mode: answer.mode },
		{ confirm: true, select: "second", input: "回答不提供写入授权", mode: "rpc" });
	assert.equal(h.sm.getEntries().filter((row) => row.type === "custom" && row.customType === "delivery-approval").length, before);
	assert.ok(!h.sm.getEntries().some((row) => row.type === "custom" && row.customType === "fixture-dialog-answer"));
	const reference = h.sm.getEntries().findLast((row) => row.type === "custom" && (kind === "development"
		? row.customType === "delivery-development" : row.customType === "delivery-delegation"));
	assert.ok(reference?.type === "custom");
	const data = reference.data as { childSessionFile?: string; sessionFile?: string };
	const childLog = await readFile((kind === "development" ? data.childSessionFile : data.sessionFile)!, "utf8");
	assert.match(childLog, /"customType":"fixture-dialog-answer"/);
	assert.ok(!childLog.includes('"customType":"delivery-approval"'));
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	if (kind === "readonly-write") assert.equal(await readFile(path.join(h.cwd, "forbidden.txt"), "utf8"), "unexpected");
	else await assert.rejects(access(path.join(h.cwd, "forbidden.txt")), { code: "ENOENT" });
	if (kind === "development") {
		assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
		assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "父核实交互与文件证据后记录进度。\n" })).isError, false);
	} else await assert.rejects(access(path.join(h.cwd, "src/value.js")), { code: "ENOENT" });
});

for (const tool of ["delivery_readonly", "delivery_develop"]) for (const kind of ["deny", "cancel", "timeout", "ui-error", "parent-cancel"]) {
	test(`正式 ${tool} 子交互 ${kind} 停止父续跑并等待子收尾`, { timeout: 40_000 }, async (t) => {
		const h = await host(t, `dialog-${kind}`);
		if (tool === "delivery_develop") await h.prepare();
		const before = (await h.audit()).filter((row) => !row.child && row.phase === "model").length;
		let started!: () => void;
		const waiting = new Promise<void>((resolve) => { started = resolve; });
		h.setConfirm(async () => {
			if (kind !== "deny") return true;
			await h.session.followUp("fixture-must-not-resume");
			return false;
		});
		h.setInput(async (_title, _placeholder, options) => {
			await h.session.followUp("fixture-must-not-resume");
			if (kind === "cancel") return undefined;
			if (kind === "ui-error") throw new Error("fixture parent dialog failure");
			return new Promise((resolve) => {
				options!.signal!.addEventListener("abort", () => resolve(undefined), { once: true });
				started();
			});
		});
		const run = h.call(tool, { task: "先回答普通问题再执行任务" });
		if (kind === "parent-cancel") {
			await waiting;
			h.session.clearQueue();
			await h.session.abort();
		}
		const result = await run;
		assert.equal(result.isError, true);
		assert.equal(h.session.pendingMessageCount, 0);
		assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
		await assert.rejects(access(path.join(h.cwd, "src/value.js")), { code: "ENOENT" });
		const events = await h.audit();
		assert.equal(events.filter((row) => !row.child && row.phase === "model").length, before + 1, "取消后父模型不得继续或消费排队任务");
		const child = events.find((row) => row.child && row.phase === "start");
		assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
		if (kind === "ui-error") assert.match(JSON.stringify(result), /fixture parent dialog failure/);
	});
}

test("开发在途取消等待实际 I/O 与关闭，父不能提前取得 writer", { timeout: 40_000 }, async (t) => {
	const h = await host(t, "wait");
	await h.prepare();
	const run = h.call("delivery_develop", { task: "执行受控文件变更" });
	let abort: Promise<void> | undefined;
	try {
		const deadline = Date.now() + 10_000;
		while (!(await h.audit()).some((row) => row.phase === "development-io-pending")) {
			assert.ok(Date.now() < deadline, "必须先观察到实际 I/O 等待");
			await setTimeout(20);
		}
		const lease = await h.readLease();
		assert.equal(lease?.owner.kind, "child");
		const workspace = await resolveWorkspaceIdentity(h.cwd);
		const other = new WriterLeaseManager(await getWriterStateRoot(workspace));
		assert.equal((await other.acquire(workspace, { kind: "parent", sessionId: "competing-parent", pid: process.pid })).ok, false);
		let stopped = false;
		abort = h.session.abort().then(() => { stopped = true; });
		await setTimeout(80);
		assert.equal(stopped, false, "abort 不能先于实际工具关闭返回");
		assert.equal((await h.readLease())?.leaseId, lease?.leaseId);
	} finally { await writeFile(path.join(h.agentDir, "development-unblock"), "unblock"); }
	await abort;
	assert.equal((await run).isError, true);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const events = await h.audit();
	assert.ok(events.some((row) => row.phase === "development-handle-closed"));
	const child = events.find((row) => row.child && row.phase === "start");
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("开发部分写入不回滚，正常收尾后原授权内可重新委派修复", { timeout: 40_000 }, async (t) => {
	const h = await host(t, "partial");
	await h.prepare();
	const partial = await h.call("delivery_develop", { task: "注入部分写入" });
	assert.equal(partial.isError, false);
	assert.equal((partial.details as any).progress.status, TOOL_ERROR_STATUS);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "部分写入");
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	await writeFile(path.join(h.agentDir, "development-fault-used"), "disable fixture fault");
	assert.equal((await h.call("delivery_develop", { task: "修复原范围内的部分结果" })).isError, false);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	assert.equal(h.choices.length, 2);
});

for (const failure of ["crash", "child-tamper", "child-persistence", "parent-tamper", "parent-persistence"]) {
	test(`开发 ${failure} 不交回未知 writer，交付入口不开始新写入`, { timeout: 40_000 }, async (t) => {
		let parentFile: string | undefined;
		const h = await host(t, failure, (pi) => {
			pi.on("tool_result", async (event, ctx) => {
				if (event.toolName !== "delivery_develop") return;
				if (failure === "parent-tamper") return { content: [{ type: "text", text: "替换父开发结果" }] };
				if (failure === "parent-persistence" && !parentFile) { parentFile = ctx.sessionManager.getSessionFile(); await chmod(parentFile!, 0o400); }
				return undefined;
			});
		});
		await h.prepare();
		try {
			const run = h.call("delivery_develop", { task: "验证收尾故障" });
			if (failure === "parent-persistence") await assert.rejects(run, { code: "EACCES" });
			else {
				const result = await run;
				if (failure !== "parent-tamper") {
					assert.equal(result.isError, true);
					const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					const started = h.sm.getEntries().find((row) => row.type === "custom" && row.customType === "delivery-development");
					assert.ok(started?.type === "custom");
					assert.ok(text.includes((started.data as { childSessionFile: string }).childSessionFile));
					assert.match(text, /子收尾核验：未取得证明/);
					assert.doesNotMatch(text, /子收尾核验：已取得证明/);
				}
			}
			assert.equal((await h.readLease())?.owner.kind, "child", h.notices.join("\n"));
			assert.ok(h.notices.some((notice) => notice.includes("开发 writer 未交回")));
			if (parentFile) await chmod(parentFile, 0o600);
			assert.equal((await h.call("delivery_develop", { task: "禁止再次开发" })).isError, true);
			assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "禁止更新进度" })).isError, true);
			await assert.rejects(access(path.join(h.cwd, "plan.md")), { code: "ENOENT" });
			const events = await h.audit();
			const children = events.filter((row) => row.child && row.phase === "start");
			assert.equal(children.length, 1);
			assert.throws(() => process.kill(children[0].pid, 0), { code: "ESRCH" });
		} finally {
			if (parentFile) await chmod(parentFile, 0o600);
			const record = h.sm.getEntries().find((row) => row.type === "custom" && row.customType === "delivery-development");
			if (failure === "child-persistence" && record?.type === "custom") await chmod((record.data as { childSessionFile: string }).childSessionFile, 0o600);
		}
	});
}

for (const scenario of ["hook-deny", "hook-error"]) {
	test(`开发保留配置检查 ${scenario}，拒绝后没有源码写入`, { timeout: 40_000 }, async (t) => {
		const h = await host(t, scenario);
		await h.prepare();
		const result = await h.call("delivery_develop", { task: "执行文件检查" });
		assert.equal(result.isError, false);
		assert.equal((result.details as any).progress.status, TOOL_ERROR_STATUS);
		await assert.rejects(access(path.join(h.cwd, "src/value.js")), { code: "ENOENT" });
		assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	});
}

for (const scenario of ["outside", "plan", "git", "separate-git"]) {
	test(`普通开发工具不增加 ${scenario} 路径拦截，交付文档仍核实自身范围`, { timeout: 40_000 }, async (t) => {
		const h = await host(t, scenario);
		await h.prepare();
		if (scenario === "separate-git") await h.approve("implementation", ["src", "metadata"]);
		const result = await h.call("delivery_develop", { task: "尝试夹具中的越权路径" });
		assert.equal(result.isError, false);
		assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
		const target = scenario === "outside" ? "../outside.js" : scenario === "plan" ? "plan.md" : scenario === "separate-git" ? "metadata/forbidden.js" : ".git/forbidden.js";
		assert.equal(await readFile(path.resolve(h.cwd, target), "utf8"), "export const value = 2;\n");
		if (scenario === "separate-git") {
			assert.equal((await h.call("delivery_document_write", { path: "metadata/forbidden.md", content: "父也不能误写 Git 元数据" })).isError, true);
			await assert.rejects(access(path.join(h.cwd, "metadata/forbidden.md")), { code: "ENOENT" });
		}
		assert.equal((await h.call("delivery_document_write", { path: "plan.md", content: "失败已记录，未完成开发。" })).isError, false);
	});
}

test("公开 Bash 能力取证：cwd 不限制写入路径，命令返回及事后 abort 不清理后台后代", { timeout: 30_000 }, async (t) => {
	const h = await host(t);
	const controller = new AbortController();
	const childFile = path.join(h.cwd, "probe-child.json");
	const script = `const fs = require("node:fs");
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childFile)}, JSON.stringify({ pid: child.pid }));
fs.writeFileSync("../probe-outside.txt", "isolated capability probe");
child.unref();`;
	let pid: number | undefined;
	try {
		const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
		// 直接调用公开底层，刻意不经过产品门禁；不将此能力探测当成已开放命令工具。
		const result = await createBashTool(h.cwd).execute("capability-probe", { command, timeout: 10 }, controller.signal);
		pid = JSON.parse(await readFile(childFile, "utf8")).pid;
		assert.ok(Number.isInteger(pid) && pid! > 0);
		assert.equal(await readFile(path.join(h.root, "probe-outside.txt"), "utf8"), "isolated capability probe");
		process.kill(pid!, 0);
		controller.abort();
		await setTimeout(50);
		process.kill(pid!, 0);
		t.diagnostic(JSON.stringify({ root: h.root, commandResult: result, descendantPid: pid, aliveAfterResultAndAbort: true }));
	} finally {
		pid ??= await readFile(childFile, "utf8").then((text) => JSON.parse(text).pid, (error) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (pid) {
			process.kill(pid, "SIGTERM");
			const deadline = Date.now() + 5000;
			for (;;) {
				try { process.kill(pid, 0); }
				catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); break; }
				assert.ok(Date.now() < deadline, "能力探测后代必须实际退出");
				await setTimeout(20);
			}
			t.diagnostic(JSON.stringify({ descendantPid: pid, cleanup: "fixture SIGTERM; ESRCH" }));
		}
	}
});

test("正式开发入口缺少实施确认或开发范围时不启动子模型", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	const unapproved = await h.call("delivery_develop", { task: "未授权变更" });
	assert.equal(unapproved.isError, true);
	assert.match(JSON.stringify(unapproved.content), /子 Session 引用尚未取得/);
	assert.doesNotMatch(JSON.stringify(unapproved.content), /原始子 Session：|子收尾核验：已取得证明/);
	assert.equal((await h.approve("design", [])).isError, false);
	assert.equal((await h.approve("implementation", [])).isError, true);
	assert.equal((await h.call("delivery_develop", { task: "缺少有效实施确认" })).isError, true);
	assert.ok(!(await h.audit()).some((row) => row.child));
	assert.equal(await h.readLease(), undefined);
});

test("真实子 Pi 的本机命令失败保留错误与执行引用，不把模型总结当成功", { timeout: 40_000 }, async (t) => {
	const h = await host(t, "local-missing-command");
	await h.prepare();
	const result = await h.call("delivery_develop", { task: "夹具尝试未批准的命令" });
	assert.equal(result.isError, false);
	assert.equal((result.details as any).progress.status, TOOL_ERROR_STATUS);
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	const reference = h.sm.getEntries().find((entry) => entry.type === "custom" && entry.customType === "delivery-development");
	assert.ok(reference?.type === "custom");
	const text = await readFile((reference.data as { childSessionFile: string }).childSessionFile, "utf8");
	assert.match(text, /Cannot find module/);
	assert.ok(!text.includes('"customType":"delivery-execution"'), "普通命令失败留在原生工具结果中");
});

for (const name of ["edit", "write"]) test(`父 ${name} 仅在内存被覆盖而子未加载同一实现时，不发送任务`, { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	await h.session.prompt(`/fixture-replace-tool ${name}`);
	assert.notEqual(h.session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.source, "builtin");
	const result = await h.call("delivery_develop", { task: "需要实际配置工具的文件任务" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /父子工具定义或来源未对齐/);
	assert.ok(!(await h.audit()).some((row) => row.child && row.phase === "model"));
	assert.equal(await h.readLease(), undefined);
});
