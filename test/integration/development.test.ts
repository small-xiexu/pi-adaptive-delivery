import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { createDevelopmentHost as host } from "../support/development-host.ts";
import { COMPLETED_STATUS } from "../../extensions/delivery-gate/src/progress.ts";
import { getWriterStateRoot, resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";
import { EXECUTION_PATH_ENTRY } from "../../extensions/delivery-gate/src/execution-path.ts";
import { plainTheme } from "../support/delivery-ui.ts";
import type { DeliveryPanel, DesignReviewPanel } from "../../extensions/delivery-gate/src/ui.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

test("状态面板默认只显示摘要，详情和退出操作彼此独立", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	const tools = h.session.getActiveToolNames();
	const activations = h.sm.getEntries().filter((row) => row.type === "custom" && row.customType === "delivery-activation");
	h.setCustom((async (factory) => {
		let answer: unknown;
		const panel = await factory({ terminal: { rows: 40 }, requestRender() {} } as any, plainTheme, {} as any,
			(value) => { answer = value; }) as DeliveryPanel;
		assert.equal(panel.title, "交付状态");
		assert.deepEqual(panel.choices, ["结束交付"]);
		assert.doesNotMatch(panel.body, /PID|Session|lease/);
		assert.match(panel.body, /阶段：|下一步：|运行中：/);
		panel.render(100);
		panel.handleInput("\x0f");
		assert.match(panel.render(100).join("\n"), /PID|Session|lease/);
		panel.handleInput("\x1b");
		assert.equal(answer, undefined);
		return answer;
	}) as ExtensionUIContext["custom"]);
	await h.session.prompt("/delivery-status");
	assert.deepEqual(h.session.getActiveToolNames(), tools);
	assert.deepEqual(h.sm.getEntries().filter((row) => row.type === "custom" && row.customType === "delivery-activation"), activations);
	assert.ok(!(await h.audit()).some((row) => row.child));
	assert.equal(await h.readLease(), undefined);
});

test("没有方案确认时不启动开发或审查子 Agent", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	assert.equal((await h.call("delivery_develop", { task: "未批准开发", paths: ["src"], inputs: [] })).isError, true);
	assert.equal((await h.call("delivery_review", { task: "未批准审查", paths: ["src"], inputs: [] })).isError, true);
	assert.ok(!(await h.audit()).some((row) => row.child));
});

for (const name of ["delivery_develop", "delivery_review"] as const) for (const denied of [false, true]) {
	test(`${name} 承接动态网页工具选择，${denied ? "权限钩子仍拒绝执行" : "四个工具均可执行"}并核验 writer 收尾`, { timeout: 40_000 }, async (t) => {
		const h = await host(t, `dynamic-tools${denied ? "-hook-deny" : ""}`);
		await mkdir(path.join(h.cwd, "src"));
		await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
		await h.prepare();
		const result = await h.call(name, { task: "fixture-dynamic-web", paths: ["src"], inputs: [] });
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.equal((result.details as any).executionFacts.toolErrors, denied);
		const audit = await h.audit();
		const child = audit.find((row) => row.child && row.phase === "start");
		assert.ok(child);
		assert.ok(audit.some((row) => row.child && row.phase === "dynamic-tools-reset" && !row.active.includes("web_search")));
		assert.deepEqual(audit.filter((row) => row.child && row.phase === "dynamic-web-executed").map((row) => row.toolName),
			denied ? [] : ["web_search", "source_check", "fetch_content", "get_search_content"]);
		assert.ok(audit.filter((row) => row.child && row.phase === "model").every((row) =>
			["web_search", "source_check", "fetch_content", "get_search_content"].every((tool) => row.tools.includes(tool))));
		if (denied) assert.match(JSON.stringify(result.content), /CONFIGURED_TOOL_HOOK_DENIED/);
		assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
		assert.equal(await h.readLease(), undefined);
		assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 1;\n");
	});
}

test("重载后重新审阅说明旧确认不可用，暂停不恢复权限，明确确认产生新记录", { timeout: 60_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	await h.session.reload();
	await h.session.prompt("/delivery-shape");
	const denied = await h.call("delivery_develop", { task: "不能沿用旧确认开发", paths: ["src"], inputs: [] });
	assert.equal(denied.isError, true);
	assert.match(JSON.stringify(denied.content), /解除任务占用不会恢复旧确认/);
	let accept = false;
	h.setCustom((async (factory) => {
		let answer: unknown;
		const panel = await factory({ terminal: { rows: 40 }, requestRender() {} } as any, plainTheme, {} as any,
			(value) => { answer = value; }) as DesignReviewPanel;
		assert.match(panel.render(100).join("\n"), /旧实施确认已不可用，需要重新确认本次方案/);
		if (accept) { panel.handleInput("\x1b[A"); panel.handleInput("\x1b[A"); }
		panel.handleInput("\r");
		return answer;
	}) as ExtensionUIContext["custom"]);
	const paused = await h.approve("design", ["plan.md"], "沿用现有目标，核对当前代码后继续修复。\n本次假设：无");
	assert.equal((paused.details as any).paused, true);
	assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-approval").length, 1);
	assert.ok(!(await h.audit()).some((row) => row.child), "恢复说明和暂停不会启动子任务");
	accept = true;
	const approved = await h.approve("design", ["plan.md"], "沿用现有目标，核对当前代码后继续修复。\n本次假设：无");
	assert.equal((approved.details as any).approved, true);
	assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-approval").length, 2);
	assert.notEqual((approved.details as any).proposalId, (paused.details as any).proposalId);
});

test("复杂开发由独立子 Agent 完成并核实 writer 收尾", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	const result = await h.call("delivery_develop", { task: "创建 src/value.js，将 value 从 1 改为 2 并读取文件核对。", paths: ["src"], inputs: [] });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal((result.details as any).progress.status, COMPLETED_STATUS);
	assert.equal((result.details as any).progress.stage, "父结果与 writer 交接");
	assert.equal((result.details as any).executionFacts.stage, "父结果与 writer 交接");
	assert.equal((result.details as any).executionFacts.childProcessExit.code, 0);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	assert.equal(await h.readLease(), undefined);
	const child = (await h.audit()).find((row) => row.child && row.phase === "start");
	assert.ok(child);
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
	let opened = false;
	h.setCustom((async (factory, options) => {
		let answer: unknown;
		const panel = await factory({ terminal: { rows: 40 }, requestRender() {} } as any, plainTheme, {} as any,
			(value) => { answer = value; }) as any;
		if (options?.overlay) {
			opened = true;
			assert.match(panel.render(100).join("\n"), /子任务详情.*开发/);
			panel.handleInput("\x1b");
			panel.dispose?.();
		} else {
			assert.equal(panel.title, "交付状态");
			assert.deepEqual(panel.choices, ["结束交付"]);
			panel.handleInput("\x0f");
			assert.match(panel.render(100).join("\n"), /任务|原始子 Session/);
			panel.handleInput("\x1b");
		}
		return answer;
	}) as ExtensionUIContext["custom"]);
	await h.status();
	assert.equal(opened, false);
	assert.equal(await h.readLease(), undefined);
	const paths = h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === EXECUTION_PATH_ENTRY).map((row: any) => row.data);
	assert.ok(paths.some((row: any) => row.path === "delivery_develop" && row.phase === "started"));
	assert.ok(paths.some((row: any) => row.path === "delivery_develop" && row.phase === "ended" && row.status === "completed"));
});

test("父 Pi 直改节点记录 parent_direct，状态详情显示声明但不冒充完成", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	const result = await h.call("delivery_path", { node: "局部配置迁移", reason: "只改一个调用点，父上下文连续且可立即检查", independentReview: true });
	assert.equal(result.isError, false, JSON.stringify(result));
	const record = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === EXECUTION_PATH_ENTRY);
	assert.ok(record?.type === "custom");
	const data = record.data as any;
	assert.equal(data.path, "parent_direct");
	assert.equal(data.phase, "declared");
	assert.equal(data.independentReview, true);
	await h.session.prompt("/delivery-status");
	assert.match(h.notices.at(-1)!, /阶段：|下一步：/);
	await h.session.prompt("/delivery-status");
	assert.match(h.notices.at(-1)!, /parent_direct.*局部配置迁移/);
	assert.match(h.notices.at(-1)!, /父 Pi 已声明/);
	assert.match(h.notices.at(-1)!, /不代表已执行/);
});


test("审查子收到检查报告职责，同时继承普通写入工具", { timeout: 60_000 }, async (t) => {
	const h = await host(t, "review-normal");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const developed = await h.call("delivery_develop", { task: "把 src/value.js 的 value 修改为 2，并自行运行适合的项目检查。", paths: ["src"], inputs: [] });
	assert.equal(developed.isError, false, JSON.stringify(developed));
	const reviewed = await h.call("delivery_review", { task: "核对需求、源码差异，并主动运行相关测试或编译检查。", paths: ["src"], inputs: [] });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.match(JSON.stringify(reviewed.content), /独立验收和审查/);
	assert.ok((reviewed.details as any).candidate.digest);
	assert.equal((reviewed.details as any).reviewStatus, "valid");
	assert.equal((reviewed.details as any).progress.stage, "父结果与 writer 交接");
	assert.equal((reviewed.details as any).executionFacts.stage, "父结果与 writer 交接");
	assert.equal((reviewed.details as any).executionFacts.readonlySessionPersisted, true);
	const paths = h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === EXECUTION_PATH_ENTRY).map((row: any) => row.data);
	assert.ok(paths.some((row: any) => row.path === "delivery_develop"));
	assert.ok(paths.some((row: any) => row.path === "delivery_review" && row.phase === "ended" && row.status === "completed"));
	assert.equal(await h.readLease(), undefined);
	const sessions = (await h.audit()).filter((row) => row.child && row.phase === "start");
	assert.equal(sessions.length, 2);
	const reviewRequest = (await h.audit()).find((row) => row.child && row.phase === "model" && JSON.stringify(row.messages).includes("独立验收和代码审查。"));
	assert.ok(reviewRequest);
	assert.match(JSON.stringify(reviewRequest.messages), /默认不修改源码/);
	assert.match(JSON.stringify(reviewRequest.messages), /交回父 Pi/);
	// 审查子看不到父会话里的例外授权，必须显式告知规划文档属于父维护、不算越界。
	assert.match(JSON.stringify(reviewRequest.messages), /父维护的规划文档.*plan\.md/);
	assert.ok(reviewRequest.tools.includes("write") && reviewRequest.tools.includes("edit") && reviewRequest.tools.includes("bash"));
	const diffFile = (reviewed.details as any).diffFile as string;
	await access(diffFile);
	const workspace = await resolveWorkspaceIdentity(h.cwd);
	const leaseDirectory = path.join(await getWriterStateRoot(workspace), "leases");
	const blockedLease = path.join(leaseDirectory, `${workspace.key}.json`);
	await mkdir(leaseDirectory, { recursive: true });
	await writeFile(blockedLease, "broken");
	await h.status();
	assert.ok(h.notices.some((notice) => /阶段：等待恢复/.test(notice)));
	await access(path.dirname(diffFile));
	assert.ok(h.session.getActiveToolNames().includes("write"));
	await rm(blockedLease);
	await h.status("结束交付");
	await h.session.waitForIdle();
	await assert.rejects(access(path.dirname(diffFile)), { code: "ENOENT" });
});

test("审查替身违反职责执行写入时，审查结论失效并记录实际候选", { timeout: 60_000 }, async (t) => {
	const h = await host(t, "review-modifies");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	assert.equal((await h.call("delivery_develop", { task: "把 src/value.js 的 value 修改为 2。", paths: ["src"], inputs: [] })).isError, false);
	// fake provider 刻意执行写入，验证代码层没有按审查角色裁剪权限。
	const reviewed = await h.call("delivery_review", { task: "独立检查实现并报告问题，修复交给父 Pi。", paths: ["src"], inputs: [] });
	assert.equal(reviewed.isError, true, JSON.stringify(reviewed));
	assert.match(JSON.stringify(reviewed.content), /未形成有效结论.*候选发生变化/);
	assert.match(JSON.stringify(reviewed.content), /不能用于判断当前候选/);
	assert.match(JSON.stringify((reviewed.details as any).executionFacts), /readonlySessionPersisted.*true/);
	assert.equal((reviewed.details as any).executionFacts.stage, "审查候选核对");
	assert.equal((reviewed.details as any).progress.status, "异常退出");
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 3;\n");
	assert.equal(await h.readLease(), undefined);
});

test("审查子被 SIGKILL 后保留未知终态和 lease", { timeout: 60_000 }, async (t) => {
	const h = await host(t, "review-crash");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const reviewed = await h.call("delivery_review", { task: "独立检查并运行相关验证。", paths: ["src"], inputs: [] });
	assert.equal(reviewed.isError, true, JSON.stringify(reviewed));
	assert.match(JSON.stringify(reviewed.content), /失败阶段：子 Session 收尾/);
	const facts = (reviewed.details as any).executionFacts;
	assert.equal(facts.readonlySessionPersisted, false);
	assert.equal(facts.childProcessExit.signal, "SIGKILL");
	assert.equal(facts.reviewDirectory !== undefined, true);
	assert.equal((await h.readLease())?.owner.kind, "parent");
});

for (const name of ["delivery_develop", "delivery_review"] as const) {
	test(`${name} 子扩展异常在父返回和持久记录中保留原始原因，未知收尾仍保留 lease`, { timeout: 60_000 }, async (t) => {
		const h = await host(t, "child-extension-error");
		await mkdir(path.join(h.cwd, "src"));
		await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
		await h.prepare();
		const result = await h.call(name, { task: "核对扩展异常与 writer 收尾。", paths: ["src"], inputs: [] });
		assert.equal(result.isError, true, JSON.stringify(result));
		const facts = (result.details as any).executionFacts;
		const original = ["FIXTURE_CHILD_EXTENSION_ERROR", 'type="extension_error"', 'event="tool_execution_end"',
			`extensionPath=${JSON.stringify(path.join(h.packageDir, "provider.ts"))}`];
		const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		for (const value of original) {
			assert.ok(text.includes(value), text);
			assert.ok(facts.childProcessFailure.includes(value), facts.childProcessFailure);
		}
		assert.match(text, /交付任务收尾失败/);
		assert.deepEqual(facts.childProcessExit, { code: 143, signal: null });
		assert.equal(name === "delivery_review" ? facts.readonlySessionPersisted : facts.childSessionPersisted, false);
		const child = (await h.audit()).find((row) => row.child && row.phase === "start");
		assert.ok(child);
		assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
		const lease = await h.readLease();
		assert.ok(lease);
		assert.equal(lease.owner.kind, name === "delivery_review" ? "parent" : "child");

		const rows = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		const persisted = rows.find((row) => row.type === "message" && row.message?.role === "toolResult" && row.message.toolCallId === result.toolCallId);
		assert.deepEqual(persisted.message.content, result.content);
		assert.equal(persisted.message.details.executionFacts.childProcessFailure, facts.childProcessFailure);
		if (name === "delivery_review") {
			const ended = rows.find((row) => row.type === "custom" && row.customType === "delivery-delegation" && row.data.phase === "ended");
			assert.equal(ended.data.processFailure, facts.childProcessFailure);
			assert.ok(ended.data.error.includes("FIXTURE_CHILD_EXTENSION_ERROR"));
		}
		const starts = (await h.audit()).filter((row) => row.child && row.phase === "start").length;
		const retry = await h.call(name, { task: "未知收尾不得启动替代 writer。", paths: ["src"], inputs: [] });
		assert.equal(retry.isError, true);
		assert.match(JSON.stringify(retry.content), /FIXTURE_CHILD_EXTENSION_ERROR|结束状态与当前占用记录不一致|writer/);
		assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, starts);
		assert.equal((await h.readLease())?.leaseId, lease.leaseId);
	});
}

test("并发开发调用不会把在途 writer 当作残留恢复", { timeout: 90_000 }, async (t) => {
	const h = await host(t, "cancel");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const definition = h.session.extensionRunner.getAllRegisteredTools().find((tool) => tool.definition.name === "delivery_develop")?.definition;
	assert.ok(definition);
	const firstId = randomUUID();
	const firstArgs = { task: "保持开发任务在途以验证并发保护。", paths: ["src"], inputs: [] };
	h.sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: firstId, name: "delivery_develop", arguments: firstArgs }], api: "openai-completions", provider: "fixture", model: "fake", stopReason: "toolUse", timestamp: Date.now(), usage: {} } as any);
	const abort = new AbortController();
	const first = definition.execute(firstId, firstArgs as any, abort.signal, undefined, h.session.extensionRunner.createToolContext(firstId, abort.signal));
	const deadline = Date.now() + 15_000;
	while (!(await h.audit()).some((row) => row.child && row.phase === "start")) {
		assert.ok(Date.now() < deadline, "未观察到在途开发子任务");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const lease = await h.readLease();
	assert.ok(lease);
	const secondId = randomUUID();
	const secondArgs = { task: "并发开发不得清理第一项任务。", paths: ["src"], inputs: [] };
	h.sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: secondId, name: "delivery_develop", arguments: secondArgs }], api: "openai-completions", provider: "fixture", model: "fake", stopReason: "toolUse", timestamp: Date.now(), usage: {} } as any);
	await assert.rejects(definition.execute(secondId, secondArgs as any, undefined, undefined, h.session.extensionRunner.createToolContext(secondId, undefined)), /writer|未启动/);
	assert.equal((await h.readLease())?.leaseId, lease.leaseId);
	assert.equal(h.choices.includes("恢复交付"), false);
	abort.abort();
	await assert.rejects(first, /收尾失败|终态未知|aborted/i);
	assert.equal((await h.readLease())?.leaseId, lease.leaseId);
});
test("已核实的 writer fault 在继续时自动清理同一 lease 并恢复内存状态", { timeout: 90_000 }, async (t) => {
	const h = await host(t);
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	const workspace = await resolveWorkspaceIdentity(h.cwd);
	const leaseFile = path.join(await getWriterStateRoot(workspace), "leases", `${workspace.key}.json`);
	let blocked = true;
	const unlink = fs.unlink;
	t.mock.method(fs, "unlink", async (...args: Parameters<typeof unlink>) => {
		if (blocked && String(args[0]) === leaseFile) throw new Error("fixture release unlink failure");
		return unlink(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	await h.prepare();
	const first = await h.call("delivery_develop", { task: "制造已核实但未交回的 writer fault。", paths: ["src"], inputs: [] });
	assert.equal(first.isError, false, JSON.stringify(first));
	const retained = await h.readLease();
	assert.ok(retained);
	assert.ok(h.notices.some((notice) => /writer 未交回/.test(notice)));
	const retainedSource = JSON.parse(await readFile(leaseFile, "utf8"));
	for (const mutate of [
		(record: any) => { record.owner.sessionId = "replacement-session"; },
		(record: any) => { record.owner.runId = "replacement-run"; record.coordinator.runId = "replacement-run"; },
	]) {
		const tampered = structuredClone(retainedSource);
		mutate(tampered);
		await writeFile(leaseFile, `${JSON.stringify(tampered)}\n`);
		const refused = await h.call("delivery_develop", { task: "归属变化时不得自动恢复。", paths: ["src"], inputs: [] });
		assert.equal(refused.isError, true, JSON.stringify(refused));
		assert.match(JSON.stringify(refused.content), /结束状态与当前占用记录不一致|暂未清理/);
		assert.equal((await h.readLease())?.owner.sessionId, tampered.owner.sessionId);
		await writeFile(leaseFile, `${JSON.stringify(retainedSource)}\n`);
	}
	blocked = false;
	const second = await h.call("delivery_develop", { task: "继续并核对自动恢复后的 writer。", paths: ["src"], inputs: [] });
	assert.equal(second.isError, false, JSON.stringify(second));
	assert.equal(await h.readLease(), undefined);
	const unlock = h.sm.getEntries().findLast((row) => row.type === "custom" && row.customType === "delivery-unlock");
	assert.equal(unlock?.type, "custom");
	assert.equal((unlock.data as any).recovery, "automatic");
	assert.equal((unlock.data as any).reconciledRunId, first.toolCallId);
	assert.ok(h.notices.some((notice) => /已自动恢复上次交付/.test(notice)));
});
test("继续遇到未知收尾时保持占用，不启动替代审查", { timeout: 90_000 }, async (t) => {
	const h = await host(t, "review-crash");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const first = await h.call("delivery_review", { task: "独立检查并运行相关验证。", paths: ["src"], inputs: [] });
	assert.equal(first.isError, true, JSON.stringify(first));
	const originalLease = await h.readLease();
	assert.equal(originalLease?.owner.kind, "parent");
	const firstStarts = (await h.audit()).filter((row) => row.child && row.phase === "start").length;
	const second = await h.call("delivery_review", { task: "继续独立检查并运行相关验证。", paths: ["src"], inputs: [] });
	assert.equal(second.isError, true, JSON.stringify(second));
	assert.match(JSON.stringify(second.content), /结束状态与当前占用记录不一致|writer/);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, firstStarts);
	assert.equal((await h.readLease())?.leaseId, originalLease?.leaseId);
});

test("lease ID 不匹配时继续不清理旧 fault 或启动替代任务", { timeout: 90_000 }, async (t) => {
	const h = await host(t, "review-crash");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const failed = await h.call("delivery_review", { task: "制造可核对的异常审查终态。", paths: ["src"], inputs: [] });
	assert.equal(failed.isError, true, JSON.stringify(failed));
	const workspace = await resolveWorkspaceIdentity(h.cwd);
	const leaseFile = path.join(await getWriterStateRoot(workspace), "leases", `${workspace.key}.json`);
	const record = JSON.parse(await readFile(leaseFile, "utf8"));
	record.leaseId = "replacement-lease-for-test";
	await writeFile(leaseFile, `${JSON.stringify(record)}\n`);
	const starts = (await h.audit()).filter((row) => row.child && row.phase === "start").length;
	const retry = await h.call("delivery_review", { task: "不得绕过不匹配的失败状态。", paths: ["src"], inputs: [] });
	assert.equal(retry.isError, true, JSON.stringify(retry));
	assert.match(JSON.stringify(retry.content), /结束状态与当前占用记录不一致|writer 尚未完成交接/);
	assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, starts);
	assert.equal((await h.readLease())?.leaseId, "replacement-lease-for-test");
});

test("无法自动核实的残留只请求一次恢复选择", { timeout: 90_000 }, async (t) => {
	const h = await host(t, "normal");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const workspace = await resolveWorkspaceIdentity(h.cwd);
	const leases = new (await import("../../extensions/delivery-gate/src/workspace.ts")).WriterLeaseManager(await getWriterStateRoot(workspace));
	await leases.acquire(workspace, { kind: "parent", sessionId: "old-session", pid: 99999, runId: "old-run" });
	const declined = await h.call("delivery_develop", { task: "残留恢复默认等待用户选择。", paths: ["src"], inputs: [] });
	assert.equal(declined.isError, true, JSON.stringify(declined));
	assert.match(JSON.stringify(declined.content), /已保留上次交付现场/);
	assert.ok(await h.readLease());
	h.setSelect(async (title, items) => title === "恢复交付" ? "清理残留并继续" : items[0]);
	const resumed = await h.call("delivery_develop", { task: "确认后清理残留并继续。", paths: ["src"], inputs: [] });
	assert.equal(resumed.isError, false, JSON.stringify(resumed));
	assert.equal(await h.readLease(), undefined);
	assert.ok(h.notices.some((notice) => /已清理上次交付的残留占用/.test(notice)));
});

test("父回合中断审查时保留中断阶段、子 Session 引用和 lease", { timeout: 60_000 }, async (t) => {
	const h = await host(t, "review-wait");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const run = h.call("delivery_review", { task: "独立检查并等待父回合收尾。", paths: ["src"], inputs: [] });
	const deadline = Date.now() + 15_000;
	while (!(await h.audit()).some((row) => row.child && row.phase === "review-waiting")) {
		assert.ok(Date.now() < deadline, "未观察到审查子等待");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await h.session.abort();
	const reviewed = await run;
	assert.equal(reviewed.isError, true, JSON.stringify(reviewed));
	const facts = (reviewed.details as any).executionFacts;
	assert.match(JSON.stringify(reviewed.content), /失败阶段：子 Session 收尾/);
	assert.ok(facts.interruption);
	assert.equal(typeof facts.readonlySessionFile, "string");
	assert.equal(await h.readLease(), undefined, "可核实的用户取消完成正常 writer 交回");
});

test("方案确认不冻结开发路径，节点调整和返工只记录新的调用范围", { timeout: 60_000 }, async (t) => {
	const h = await host(t);
	assert.equal((await h.approve("design", [])).isError, false);
	const first = await h.call("delivery_develop", { task: "创建并读回 value", paths: ["src"], inputs: [] });
	assert.equal(first.isError, false, JSON.stringify(first));
	const second = await h.call("delivery_develop", { task: "范围内返工并读回 value", paths: ["src/value.js"], inputs: ["README.md"] });
	assert.equal(second.isError, false, JSON.stringify(second));
	const approvals = h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-approval");
	assert.equal(approvals.length, 1);
	assert.equal(h.choices.length, 1);
	const calls = h.sm.getBranch().flatMap((row) => row.type === "message" && row.message.role === "assistant" ? row.message.content.filter((part) => part.type === "toolCall" && part.name === "delivery_develop") : []);
	assert.deepEqual(calls.map((call: any) => call.arguments.paths), [["src"], ["src/value.js"]]);
	assert.ok(!(await h.audit()).some((row) => JSON.stringify(row).includes("delivery_validate")));
	assert.equal(await h.readLease(), undefined);
});

test("开发和审查调用拒绝空范围、越界路径和父维护台账", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	const rejected = async (name: string, args: Record<string, unknown>, patterns: RegExp[]) => {
		const result = await h.call(name, args);
		assert.equal(result.isError, true, JSON.stringify(result));
		const text = JSON.stringify(result.content);
		for (const pattern of patterns) assert.match(text, pattern);
		assert.equal((result.details as any).executionFacts?.stage, "调用前范围校验");
		return result;
	};
	await rejected("delivery_develop", { task: "空范围", paths: [], inputs: [] }, [/调用前范围校验/, /非空 paths/]);
	await rejected("delivery_develop", { task: "越出 worktree", paths: ["../outside"], inputs: [] }, [/调用前范围校验/, /当前 worktree/]);
	for (const args of [
		{ task: "审查台账精确命中", paths: ["plan.md"], inputs: [] },
		{ task: "审查台账目录重叠", paths: ["."], inputs: [] },
		{ task: "审查输入重叠", paths: ["src"], inputs: ["./plan.md"] },
		{ task: "审查台账相对路径", paths: ["./plan.md"], inputs: [] },
	]) {
		const result = await rejected("delivery_review", args, [/父维护规划文档/, /冲突范围：(?:paths=.*(?:plan\.md|\.)|inputs=.*plan\.md)/, /子 Session 尚未启动/]);
		assert.match(JSON.stringify(result.details), /调用前范围校验/);
	}
	assert.equal(await h.readLease(), undefined);
	assert.equal((await h.audit()).filter((row) => row.child).length, 0);
});
