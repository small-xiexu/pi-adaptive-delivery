import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDevelopmentHost as host } from "../support/development-host.ts";
import { COMPLETED_STATUS } from "../../extensions/delivery-gate/src/progress.ts";
import { getWriterStateRoot, resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";
import { EXECUTION_PATH_ENTRY } from "../../extensions/delivery-gate/src/execution-path.ts";
import { plainTheme } from "../support/delivery-ui.ts";
import type { DeliveryPanel, DesignReviewPanel } from "../../extensions/delivery-gate/src/ui.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

test("状态面板默认回车和查看详情只关闭，不结束交付或启动任务", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	const tools = h.session.getActiveToolNames();
	const activations = h.sm.getEntries().filter((row) => row.type === "custom" && row.customType === "delivery-activation");
	h.setCustom((async (factory) => {
		let answer: unknown;
		const panel = await factory({ terminal: { rows: 40 }, requestRender() {} } as any, plainTheme, {} as any,
			(value) => { answer = value; }) as DeliveryPanel;
		assert.equal(panel.title, "交付状态");
		assert.deepEqual(panel.choices, ["关闭", "查看任务", "结束交付"]);
		assert.doesNotMatch(panel.body, /PID|Session|lease/);
		panel.render(100);
		panel.handleInput("\x0f");
		panel.render(100);
		panel.handleInput("\x1b[F");
		panel.handleInput("\r");
		assert.equal(answer, "关闭");
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
			panel.render(100);
			panel.handleInput("\x1b[B");
			panel.handleInput("\r");
			assert.equal(answer, "查看任务");
		}
		return answer;
	}) as ExtensionUIContext["custom"]);
	await h.status("查看任务");
	assert.equal(opened, true);
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
	assert.match(h.notices.at(-1)!, /交付已启用，当前无在途任务/);
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
	await h.status("结束交付");
	assert.match(h.notices.at(-1)!, /展开详情.*解除占用.*结束交付/);
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
		assert.match(JSON.stringify(retry.content), /交付 writer 尚未完成交接或已关闭/);
		assert.equal((await h.audit()).filter((row) => row.child && row.phase === "start").length, starts);
		assert.equal((await h.readLease())?.leaseId, lease.leaseId);
	});
}

test("显式解锁后复位已知终态，父 Pi 可重新发起审查", { timeout: 90_000 }, async (t) => {
	const h = await host(t, "review-crash");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const first = await h.call("delivery_review", { task: "独立检查并运行相关验证。", paths: ["src"], inputs: [] });
	assert.equal(first.isError, true, JSON.stringify(first));
	const originalLease = await h.readLease();
	assert.equal(originalLease?.owner.kind, "parent");
	const firstStarts = (await h.audit()).filter((row) => row.child && row.phase === "start").length;
	let accept = false;
	h.setCustom((async (factory) => {
		let answer: unknown;
		const panel = await factory({ terminal: { rows: 40 }, requestRender() {} } as any, plainTheme, {} as any,
			(value) => { answer = value; }) as DeliveryPanel;
		if (panel.title === "交付状态") {
			panel.render(100);
			const index = panel.choices.indexOf("解除占用");
			assert.ok(index > 0);
			for (let i = 0; i < index; i++) panel.handleInput("\x1b[B");
			panel.handleInput("\r");
			return answer;
		}
		assert.equal(panel.title, "解除上次任务的占用");
		const body = panel.render(100).join("\n");
		assert.match(body, /保留现有代码改动/);
		assert.match(body, /失效的方案确认不会恢复/);
		assert.doesNotMatch(body, /PID|Session|lease|owner|请核对实施范围/);
		assert.match(body, /暂不处理/);
		panel.handleInput("\x0f");
		panel.render(100);
		panel.handleInput("\x1b[F");
		const detail = panel.render(100).join("\n");
		assert.match(detail, /PID/);
		assert.ok(detail.includes(originalLease!.leaseId));
		if (accept) panel.handleInput("\x1b[A");
		panel.handleInput("\r");
		return answer;
	}) as ExtensionUIContext["custom"]);

	await h.status("解除占用");
	assert.match(h.notices.at(-1)!, /未解除占用，现场保持原样/);
	assert.deepEqual(await h.readLease(), originalLease, "查看证据及默认回车均不清理占用");
	assert.equal(h.sm.getBranch().some((row) => row.type === "custom" && row.customType === "delivery-unlock"), false);
	accept = true;
	await h.status("解除占用");
	await h.session.waitForIdle();
	assert.match(h.notices.at(-1)!, /已复位父进程中的已知失败运行态/);
	assert.match(h.notices.at(-1)!, /方案确认仍有效/);
	assert.equal(await h.readLease(), undefined);
	const unlock = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === "delivery-unlock");
	assert.equal(unlock?.type, "custom");
	assert.equal((unlock.data as any).inMemoryState, "cleared");
	assert.equal(typeof (unlock.data as any).reconciledRunId, "string");

	const second = await h.call("delivery_review", { task: "重新独立检查并运行相关验证。", paths: ["src"], inputs: [] });
	assert.equal(second.isError, true, JSON.stringify(second));
	const secondStarts = (await h.audit()).filter((row) => row.child && row.phase === "start").length;
	assert.equal(secondStarts, firstStarts + 1, "解锁后应启动新的审查子 Session，而不是被旧 active fault 拒绝");
	assert.equal((await h.readLease())?.owner.kind, "parent", "第二次审查自身仍失败时应继续保留 lease");
});

test("lease ID 不匹配时解锁不复位 fault，仍阻止重放交付任务", { timeout: 90_000 }, async (t) => {
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

	await h.status("解除占用");
	await h.session.waitForIdle();
	assert.match(h.notices.at(-1)!, /仍保留未能安全复位的交付状态/);
	const unlock = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === "delivery-unlock");
	assert.equal(unlock?.type, "custom");
	assert.equal((unlock.data as any).inMemoryState, "retained");
	const retry = await h.call("delivery_review", { task: "不得绕过未匹配的 fault 状态。", paths: ["src"], inputs: [] });
	assert.equal(retry.isError, true, JSON.stringify(retry));
	assert.match(JSON.stringify(retry.content), /交付 writer 尚未完成交接或已关闭/);
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
