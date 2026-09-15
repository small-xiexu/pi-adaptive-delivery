import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";
import { DesignReviewPanel } from "../../extensions/delivery-gate/src/ui.ts";
import { createDevelopmentHost } from "../support/development-host.ts";
import { plainTheme } from "../support/delivery-ui.ts";

// 只用于人工观察的 demo：真实 Pi SDK/CLI + 临时 Git + fake provider，打印交互原文并断言关键不变量。
// 不进入 npm run test:all；运行方式见 docs/实施计划.md。

const section = (title: string) => console.log(`\n\n════════ ${title} ════════`);
const show = (title: string, lines: readonly string[]) => { console.log(`\n── ${title} ──`); for (const line of lines) console.log(line); };
const brief = (value: string, limit = 700) => value.length > limit ? `${value.slice(0, limit)}\n…[已截断，共 ${value.length} 字符]` : value;
const ok = (title: string, value: unknown) => console.log(`✓ ${title}：${value}`);

type Plan = { kind: "choice"; label: string } | { kind: "feedback"; text: string };

function createCaptureUI() {
	const panels: { title: string; width: number; lines: string[] }[] = [];
	const planned: Plan[] = [];
	const captures: string[] = [];
	let confirm: string | undefined;
	let answer = true;
	let fallback: (title: string, choices: string[]) => string = (_title, choices) => choices[0];
	const custom = (async (factory: any, options: any) => {
		let done!: (value: unknown) => void;
		const result = new Promise<unknown>((resolve) => { done = resolve; });
		const panel = await factory({ terminal: { rows: 32 }, requestRender() {} } as never, plainTheme, {} as never, done) as
			{ title?: string; choices?: string[]; render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
		try {
			// 任务详情是每秒刷新的 overlay：等首轮读取完成后再抓取。
			if (options?.overlay) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				panels.push({ title: panel.title ?? "任务详情", width: 100, lines: panel.render(100) });
				done(undefined);
				return await result;
			}
			panels.push({ title: panel.title ?? "", width: 100, lines: panel.render(100) });
			panels.push({ title: `${panel.title ?? ""} · 窄屏 52 列`, width: 52, lines: panel.render(52) });
			const action = planned.shift();
			const choices = panel.choices ?? [];
			if (action?.kind === "feedback") {
				// 与真实 TUI 相同：上移到“提出修改意见”，回车打开输入，粘贴正文后再回车发送。
				panel.handleInput?.("\x1b[A");
				panel.handleInput?.("\r");
				panel.handleInput?.(`\x1b[200~${action.text}\x1b[201~`);
				panel.handleInput?.("\r");
				return await result;
			}
			const label = action?.kind === "choice" ? action.label : fallback(panel.title ?? "", choices);
			const index = choices.indexOf(label);
			assert.ok(index >= 0, `面板 ${panel.title} 没有选项「${label}」，实际：${choices.join(" / ")}`);
			// 默认停在最后一项（不批准）；只有选第一项才需要上移。
			if (index === 0) for (let i = 1; i < choices.length; i++) panel.handleInput?.("\x1b[A");
			panel.handleInput?.(index === 0 ? "\r" : "\x1b");
			return await result;
		} finally { panel.dispose?.(); }
	}) as ExtensionUIContext["custom"];
	const confirmFn: ExtensionUIContext["confirm"] = async (title, message) => { confirm = `${title}\n${message}`; return answer; };
	return { custom, confirm: confirmFn, panels, planned,
		setAnswer: (value: boolean) => { answer = value; }, setFallback: (value: typeof fallback) => { fallback = value; },
		get confirmText() { return confirm; }, get inputs() { return captures; } };
}

function projectCheck(cwd: string) {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const run = spawnSync(process.execPath, ["inputs/command.cjs"], { cwd, encoding: "utf8", env });
	return { code: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

const DEMO_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { value } from "../src/value.js";

test("结算金额使用折扣后的数值", () => {
  assert.equal(value, 2);
});
`;

const DEMO_CHECK = `const { spawnSync } = require("node:child_process");
// demo 自身也跑在 node:test 里，去掉递归保护变量后才能真实执行嵌套检查。
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const run = spawnSync(process.execPath, ["--test", "test/value.test.js"], { stdio: "inherit", env });
process.exit(run.status ?? 1);
`;

test("demo：真实 demo 项目走完整交付流程并打印交互原文", { timeout: 300_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "local-demo");
	const capture = createCaptureUI();
	h.setCustom(capture.custom);
	h.setConfirm(capture.confirm);

	section("0 · demo 项目与基线");
	await mkdir(path.join(h.cwd, "src"), { recursive: true });
	await mkdir(path.join(h.cwd, "test"), { recursive: true });
	await mkdir(path.join(h.cwd, "inputs"), { recursive: true });
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await writeFile(path.join(h.cwd, "test/value.test.js"), DEMO_TEST);
	await writeFile(path.join(h.cwd, "inputs/command.cjs"), DEMO_CHECK);
	execFileSync("git", ["add", "-A"], { cwd: h.cwd });
	execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "订单结算 demo 基线"], { cwd: h.cwd });
	const baseline = projectCheck(h.cwd);
	show("基线检查（改动前应当失败）", [`$ node inputs/command.cjs → 退出码 ${baseline.code}`, brief(baseline.output, 400)]);
	assert.notEqual(baseline.code, 0, "基线应当失败，否则 demo 无法证明改动生效");

	section("1 · 进入交付：/delivery-shape");
	show("启用通知", [h.notices.at(-1)!]);
	assert.match(h.notices.at(-1)!, /交付已启用/);
	console.log(`（宿主启动时已执行 /delivery-shape；下面按 README 的“先进入再聊天描述需求”路径发送需求）`);
	await h.session.prompt("需求：订单结算的折扣值现在是 1，要改成 2，现有测试必须通过；本次只动 src/value.js。");
	await h.session.waitForIdle();
	ok("主 Pi 当前工具", (h.session as unknown as { getActiveToolNames(): string[] }).getActiveToolNames().join(", "));

	section("2 · 父 Pi 写规划文档（delivery_document_write）");
	const planBody = [
		"# 订单结算折扣调整",
		"",
		"## 目标",
		"把结算使用的折扣值从 1 改为 2，保持现有测试通过，不改接口。",
		"",
		"## 范围",
		"只修改 src/value.js；test/value.test.js 与 inputs/command.cjs 作为检查输入不改。",
		"",
		"## 本次假设：",
		"- 折扣值只被这一个模块导出，没有其他调用方依赖旧值。",
		"- 现有测试 test/value.test.js 就是要通过的检查入口。",
	].join("\n");
	const written = await h.call("delivery_document_write", { path: "plan.md", content: planBody });
	show("工具结果", [`isError：${written.isError}`, brief(String((written.content[0] as { text: string }).text), 200)]);
	assert.equal(written.isError, false);
	ok("plan.md 实际内容行数", (await readFile(path.join(h.cwd, "plan.md"), "utf8")).split("\n").length);
	ok("写完后的 lease", JSON.stringify(await h.readLease()) ?? "已交回");

	section("3 · 方案审阅：先提意见，再确认");
	capture.planned.push({ kind: "feedback", text: "假设里没写折扣值的类型约束。本次不展开校验，但请在方案里注明“暂不处理非数字输入”。" });
	const designBody = (extra: string) => ["把结算折扣值 1 → 2。", "范围：src/value.js 一处常量，不改接口与测试。", "验证：运行 node inputs/command.cjs（项目真实测试）。", "取舍：不动折扣计算逻辑，只改取值。", extra, "本次假设：只此一处使用该值；测试即检查入口。"].join("\n");
	const firstDesign = await h.call("delivery_approval", { stage: "design", body: designBody(""), documentStrategy: "reuse", technicalPlanPath: "plan.md", implementationPlanPath: "plan.md", paths: ["plan.md"] });
	show("第一轮方案确认面板（原文）", capture.panels.at(-2)!.lines);
	show("同一面板 · 窄屏 52 列（检查是否截断）", capture.panels.at(-1)!.lines);
	show("工具结果（提意见）", [brief(String((firstDesign.content[0] as { text: string }).text), 500)]);
	assert.equal(firstDesign.isError, false);
	assert.equal((firstDesign.details as { approved: boolean }).approved, false);
	ok("意见轮是否误启动开发委派", (await h.audit()).some((row) => row.child) ? "是（异常）" : "否");

	capture.planned.push({ kind: "choice", label: "确认方案并开始实施" });
	const design = await h.call("delivery_approval", { stage: "design", body: designBody("注意：非数字折扣暂不处理（待确认）。"), documentStrategy: "reuse", technicalPlanPath: "plan.md", implementationPlanPath: "plan.md", paths: ["plan.md"] });
	show("第二轮方案确认面板（原文）", capture.panels.at(-2)!.lines);
	show("工具结果（确认方案）", [brief(String((design.content[0] as { text: string }).text), 400)]);
	assert.equal(design.isError, false);
	await h.session.waitForIdle();
	await new Promise((resolve) => setTimeout(resolve, 300));
	show("确认后自动衔接产生的会话尾部", h.sm.getBranch().slice(-4).map((row) => row.type === "message" ? `${row.message.role}：${brief(JSON.stringify((row.message as { content?: unknown }).content), 160)}` : `${row.type}/${(row as { customType?: string }).customType ?? ""}`));

	section("4 · 委派开发子 Agent（真实 CLI 子进程 + 项目真实检查）");
	const develop = await h.call("delivery_develop", { task: "把 src/value.js 的 value 改为 2，运行项目已有检查确认通过。", paths: ["src"], inputs: [] });
	show("开发结果", [brief(String((develop.content[0] as { text: string }).text), 800)]);
	show("结果详情", [`status=${(develop.details as { progress?: { status: string } }).progress?.status}`, `pid=${(develop.details as { pid?: number }).pid}`, `子 Session=${(develop.details as { childSessionFile?: string }).childSessionFile}`]);
	ok("改动后的 src/value.js", JSON.stringify(await readFile(path.join(h.cwd, "src/value.js"), "utf8")));
	ok("开发结束后 lease", JSON.stringify(await h.readLease()) ?? "已交回");
	assert.equal(develop.isError, false);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");

	section("5 · 独立审查（真实 diff 制品 + 主动检查）");
	const review = await h.call("delivery_review", { task: "独立核对需求与 src/value.js 实际差异，主动运行项目检查并报告问题。", paths: ["src"], inputs: [] });
	show("审查结果", [brief(String((review.content[0] as { text: string }).text), 700)]);
	show("审查详情", [`候选=${(review.details as { candidate?: { digest: string } }).candidate?.digest}`, `差异制品=${(review.details as { diffFile?: string }).diffFile}`, `状态=${(review.details as { progress?: { status: string } }).progress?.status}`]);
	assert.equal(review.isError, false);

	section("6 · 父侧独立核对项目检查");
	const after = projectCheck(h.cwd);
	show("改动后检查", [`$ node inputs/command.cjs → 退出码 ${after.code}`, brief(after.output, 400)]);
	assert.equal(after.code, 0);

	section("8 · /delivery-status 与 /delivery-tasks");
	await h.session.prompt("/delivery-status");
	show("交付状态", [h.notices.at(-1)!]);
	await h.session.prompt("/delivery-status details");
	show("交付状态 · details", [brief(h.notices.at(-1)!, 900)]);
	await h.session.prompt("/delivery-tasks");
	const detailPanels = capture.panels.filter((panel) => panel.width === 100).slice(-1);
	show("任务详情面板（原文）", detailPanels.length ? detailPanels[0]!.lines : ["（未打开）"]);

	section("9 · 残留现场：退出被拒 → /delivery-unlock → 正常退出");
	const workspace = await resolveWorkspaceIdentity(h.cwd);
	const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
	const stale = await leases.acquire(workspace, { kind: "parent", sessionId: "demo-crashed-session", pid: process.pid, runId: "demo-stale" });
	assert.ok(stale.ok);
	await mkdir(path.join(await getWriterStateRoot(workspace), "leases", `${workspace.key}.operation-lock`), { recursive: true });
	await h.session.prompt("/delivery-exit");
	show("第一次退出（应被拒并给出线索）", [h.notices.at(-1)!]);
	assert.match(h.notices.at(-1)!, /暂不能退出交付/);
	assert.ok((h.session as unknown as { getActiveToolNames(): string[] }).getActiveToolNames().includes("delivery_approval"));

	await h.session.prompt("/delivery-unlock");
	show("强制清理确认框（原文）", [capture.confirmText ?? "（未触发确认）"]);
	show("清理结果", [h.notices.at(-1)!]);
	assert.equal(await leases.read(workspace.key), undefined);
	ok("残留操作锁是否清理", (await leases.inspectBlockage(workspace.key)).operationLock ? "仍在（异常）" : "已清理");

	await h.session.prompt("/delivery-exit");
	show("第二次退出", h.notices.slice(-2));
	const active = (h.session as unknown as { getActiveToolNames(): string[] }).getActiveToolNames();
	ok("退出后主 Pi 工具", active.join(", "));
	assert.ok(!active.some((name) => name.startsWith("delivery_")), "退出后不应残留交付命令工具");

	section("10 · 上下文与子会话开销");
	const audit = await h.audit();
	const parents = audit.filter((row) => !row.child && row.systemPrompt);
	if (parents.length) {
		const prompt = String(parents.at(-1)!.systemPrompt);
		ok("父系统提示字符数", prompt.length);
		ok("是否注入交付 Skill 路径", /skills\/adaptive-delivery\/SKILL\.md/.test(prompt) ? "是" : "否");
		ok("是否注入能力声明", /交付已启用/.test(prompt) ? "是" : "否");
		ok("是否注入模型与推理级别", /子任务固定继承父 Pi 当前模型/.test(prompt) ? "是" : "否");
	}
	ok("子会话进程数", audit.filter((row) => row.child && row.phase === "start").length);
	ok("demo 证据根", h.root);

	section("11 · 面板可见性对照：不同终端高度下“本次假设”是否在首屏");
	const frame = ["文档策略：复用现有文档", "技术方案：plan.md", "实施计划：plan.md", "",
		"把结算折扣值 1 → 2。", "范围：src/value.js 一处常量，不改接口与测试。",
		"验证：运行 node inputs/command.cjs（项目真实测试）。", "取舍：不动折扣计算逻辑，只改取值。",
		"本次假设：只此一处使用该值；测试即检查入口。"].join("\n");
	for (const rows of [24, 32, 40, 50]) {
		const panel = new DesignReviewPanel(frame, frame, { terminal: { rows }, requestRender() {} } as never, plainTheme, () => {}, "确认后准备实施步骤，暂不修改代码或运行命令。");
		const lines = panel.render(100);
		const page = lines.find((textLine) => /\d+–\d+ \/ \d+ 行/.test(textLine));
		ok(`${rows} 行终端分页`, page?.trim() ?? "单页显示全部正文");
		ok(`  ${rows} 行首屏含“本次假设”`, lines.some((textLine) => textLine.includes("本次假设")) ? "是" : "否");
	}
});
