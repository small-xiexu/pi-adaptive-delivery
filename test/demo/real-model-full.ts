#!/usr/bin/env node
// 真实模型全流程验证：真实 SDK 父会话 + 真实子 Pi CLI + 真实项目检查 + 真实 writer lease。
// 覆盖：拷问式对齐 → 两阶段落盘 → 意见轮 → 两次确认 → 开发 → 注入缺陷 → 审查报缺陷 →
//       返工（按新默认规则）→ 状态/任务弹层 → 残留 lease → 退出被拒 → /delivery-unlock → 正常退出。
// 认证由 Pi 自己从符号链接的 auth.json 读取；本脚本不读取、不复制、不打印任何凭证。
// 用法：node --import tsx test/demo/real-model-full.ts
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContextActions, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";
import { plainTheme } from "../support/delivery-ui.ts";

const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const sourceAgent = path.join(os.homedir(), ".pi", "agent");
const model = process.env.DEMO_MODEL ?? "openai/gpt-5.6-sol";
const thinking = process.env.DEMO_THINKING ?? "medium";
const deadline = Date.now() + Number(process.env.DEMO_TIMEOUT_MIN ?? 30) * 60_000;

const say = (text = "") => console.log(text);
const section = (title: string) => say(`\n\n════════ ${title} ════════`);
const brief = (value: string, limit = 600) => {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};
const textOf = (content: unknown): string => Array.isArray(content)
	? content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("")
	: typeof content === "string" ? content : "";

// 1. 隔离环境
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-full-")));
const agentDir = path.join(root, "agent");
await Promise.all([agentDir, path.join(root, "home")].map((dir) => mkdir(dir, { recursive: true })));
for (const file of ["auth.json", "models.json", "models-store.json", "AGENTS.md"]) {
	try { await symlink(path.join(sourceAgent, file), path.join(agentDir, file)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const [provider, modelId] = model.split("/");
await writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [repo], defaultProvider: provider, defaultModel: modelId,
	defaultThinkingLevel: thinking, compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }, null, 2)}\n`);

// 2. demo 项目：多模块订单结算服务，基线只有满 100 减 10
const cwd = path.join(root, "repo");
const files: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "demo-order-service", private: true, type: "module", version: "0.4.0" }, null, 2)}\n`,
	"AGENTS.md": "# demo 订单结算服务规则\n\n- 只在 `src/` 与 `test/` 下改动。\n- 金额一律以“分”为单位计算，对外返回元。\n- 检查统一执行 `node inputs/command.cjs`。\n- 不提交、不推送、不发布。\n",
	"inputs/command.cjs": 'const { spawnSync } = require("node:child_process");\nconst env = { ...process.env };\ndelete env.NODE_TEST_CONTEXT;\nconst run = spawnSync(process.execPath, ["--test"], { stdio: "inherit", env });\nprocess.exit(run.status ?? 1);\n',
	"src/money.js": '/** 金额换算：对外用元，内部一律用分。 */\nexport function toCents(yuan) {\n  return Math.round(yuan * 100);\n}\n\nexport function toYuan(cents) {\n  return cents / 100;\n}\n\nexport function sumCents(values) {\n  return values.reduce((total, value) => total + toCents(value), 0);\n}\n',
	"src/discount.js": '/** 现有活动：满 100 减 10（以分为单位计算，返回分）。 */\nexport function fullReduction(cents) {\n  return cents >= 10000 ? cents - 1000 : cents;\n}\n',
	"src/cart.js": 'import { sumCents } from "./money.js";\n\n/** 购物车小计，入参为每件商品的价格（元）。 */\nexport function subtotal(prices) {\n  return sumCents(prices);\n}\n',
	"src/checkout.js": 'import { subtotal } from "./cart.js";\nimport { fullReduction } from "./discount.js";\nimport { toYuan } from "./money.js";\n\n/** 结算：小计（分）→ 满减 → 返回元。 */\nexport function checkout(prices) {\n  const cents = fullReduction(subtotal(prices));\n  return { cents, total: toYuan(cents) };\n}\n',
	"src/index.js": 'export { toCents, toYuan, sumCents } from "./money.js";\nexport { fullReduction } from "./discount.js";\nexport { subtotal } from "./cart.js";\nexport { checkout } from "./checkout.js";\n',
	"test/money.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { toCents, toYuan, sumCents } from "../src/money.js";\n\ntest("元与分互转", () => {\n  assert.equal(toCents(19.99), 1999);\n  assert.equal(toYuan(1999), 19.99);\n});\n\ntest("按分累加避免浮点误差", () => {\n  assert.equal(sumCents([0.1, 0.2]), 30);\n});\n',
	"test/discount.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { fullReduction } from "../src/discount.js";\n\ntest("满 100 减 10", () => {\n  assert.equal(fullReduction(10000), 9000);\n  assert.equal(fullReduction(12000), 11000);\n  assert.equal(fullReduction(9999), 9999);\n});\n',
	"test/cart.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { subtotal } from "../src/cart.js";\n\ntest("购物车小计以分为单位", () => {\n  assert.equal(subtotal([19.99, 0.01]), 2000);\n});\n',
	"test/checkout.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { checkout } from "../src/checkout.js";\n\ntest("120 元走满减", () => {\n  assert.deepEqual(checkout([120]), { cents: 11000, total: 110 });\n});\n\ntest("90 元不变", () => {\n  assert.deepEqual(checkout([90]), { cents: 9000, total: 90 });\n});\n',
};
for (const [name, content] of Object.entries(files)) {
	const target = path.join(cwd, name);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, content);
}
const check = () => { const run = spawnSync(process.execPath, ["inputs/command.cjs"], { cwd, encoding: "utf8" }); return { code: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` }; };
const env = { ...process.env, HOME: path.join(root, "home"), TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
execFileSync("git", ["init", "--quiet"], { cwd });
execFileSync("git", ["add", "-A"], { cwd });
execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "订单结算服务基线"], { cwd });
section("0 · demo 项目与基线");
say(`真实模型：${model} · thinking ${thinking} · 隔离根：${root}`);
say(`基线检查：node inputs/command.cjs → 退出码 ${check().code}`);

// 3. 交互替身（记录面板原文；批准由脚本代选，不是真实用户点击）
const panels: { title: string; lines: string[] }[] = [];
const notices: string[] = [];
const confirmations: string[] = [];
let feedbackGiven = false;
let injected = false;
let injectNote = "";
let unlockConfirmed = false;
const custom = (async (factory: any, options: any) => {
	let done!: (value: unknown) => void;
	const result = new Promise<unknown>((resolve) => { done = resolve; });
	const panel = await factory({ terminal: { rows: 50 }, requestRender() {} } as never, plainTheme, {} as never, done) as
		{ title?: string; choices?: string[]; render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
	try {
		if (options?.overlay) {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			panels.push({ title: panel.title ?? "任务详情", lines: panel.render(100) });
			done(undefined);
			return await result;
		}
		const choices = panel.choices ?? [];
		panels.push({ title: panel.title ?? "", lines: panel.render(100) });
		if (panel.title === "方案审阅" && !feedbackGiven) {
			feedbackGiven = true;
			say(`\n【面板】方案审阅 → 提出修改意见`);
			panel.handleInput?.("\x1b[A");
			panel.handleInput?.("\r");
			panel.handleInput?.("\x1b[200~折扣率和门槛请抽成命名常量，别散在表达式里；技术方案里补一张边界对照表（200/249.99/250/300 元各实付多少）。\x1b[201~");
			panel.handleInput?.("\r");
			return await result;
		}
		say(`\n【面板】${panel.title} → ${choices[0]}`);
		const index = choices.indexOf(choices[0]!);
		if (index === 0) for (let i = 1; i < choices.length; i++) panel.handleInput?.("\x1b[A");
		panel.handleInput?.("\r");
		return await result;
	} finally { panel.dispose?.(); }
}) as ExtensionUIContext["custom"];
const confirmFn: ExtensionUIContext["confirm"] = async (title, message) => {
	confirmations.push(`${title}\n${brief(message, 400)}`);
	say(`\n【确认框】${title}`);
	if (title.includes("强制清理")) unlockConfirmed = true;
	return true;
};
const selectFn: ExtensionUIContext["select"] = async (_title, items) => items[0];
const inputFn: ExtensionUIContext["input"] = async () => "按推荐";

// 4. 真实 SDK 父会话（额外挂一个只在 demo 里用的注入钩子）
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [(pi: ExtensionAPI) => {
	// 只在 demo 里使用：开发子结束后向仓库注入一个单文件缺陷，确保审查能发现问题、触发返工。
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "delivery_develop" || event.isError || injected) return;
		injected = true;
		const target = path.join(cwd, "src/discount.js");
		const source = await readFile(target, "utf8");
		const match = /(DISCOUNT\w*THRESHOLD\w*\s*=\s*)(\d+)/.exec(source);
		if (!match) { injectNote = "未能定位门槛常量，未注入"; return; }
		await writeFile(target, source.slice(0, match.index) + `${match[1]}20000` + source.slice(match.index + match[0].length));
		injectNote = `已注入单文件缺陷：${match[0]} → ${match[1]}20000（九折门槛退回 200 元）`;
	}) }] });
await resourceLoader.reload();
const loadErrors = resourceLoader.getExtensions().errors;
if (loadErrors.length) throw new Error(`扩展加载失败：${JSON.stringify(loadErrors)}`);
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const target = modelRuntime.getModel(provider, modelId);
if (!target) throw new Error(`找不到模型 ${model}`);
const sm = SessionManager.create(cwd, path.join(root, "sessions"));
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: sm });
initTheme("dark");
await session.bindExtensions({ mode: "tui",
	commandContextActions: { reload: () => session.reload() } as ExtensionCommandContextActions,
	abortHandler: () => { session.clearQueue(); void session.abort(); },
	uiContext: { ...session.extensionRunner.getUIContext(), custom,
		confirm: (...args: Parameters<ExtensionUIContext["confirm"]>) => confirmFn(...args),
		select: (...args: Parameters<ExtensionUIContext["select"]>) => selectFn(...args),
		input: (...args: Parameters<ExtensionUIContext["input"]>) => inputFn(...args),
		notify: (text: string) => { notices.push(text); } } as unknown as ExtensionUIContext,
	onError: (error) => notices.push(error.error) });
await session.setModel(target);
await session.prompt("/delivery-shape");

// 5. 驱动
let printed = 0;
const printNew = () => {
	for (const row of sm.getBranch().slice(printed)) {
		if (row.type !== "message") { if ((row as { customType?: string }).customType) say(`[记录] ${(row as { customType?: string }).customType}`); continue; }
		const message = row.message as { role: string; content: any; isError?: boolean };
		if (message.role === "assistant") for (const part of message.content ?? []) {
			if (part.type === "text" && part.text?.trim()) say(`\n[模型] ${part.text.trim().slice(0, 900)}`);
			if (part.type === "toolCall") say(`[调用] ${part.name} ${brief(JSON.stringify(part.arguments), 240)}`);
		}
		if (message.role === "toolResult") say(`[结果]${message.isError ? " 失败" : ""} ${brief(textOf(message.content) || JSON.stringify(message.content), 400)}`);
	}
	printed = sm.getBranch().length;
};
const idle = async (ms = 1200) => { await session.waitForIdle(); await new Promise((resolve) => setTimeout(resolve, ms)); await session.waitForIdle(); };
const lastAssistant = () => {
	const row = sm.getBranch().findLast((entry) => entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "assistant");
	return row ? textOf((row as { message: { content: unknown } }).message.content) : "";
};
const answers = [
	"允许，本次例外：只新增 docs/调整-技术方案.md 和 docs/调整-实施计划.md 两份文档，其余改动仍然只在 src/ 与 test/ 下。",
	"按对用户最优惠取一档；恰好 250 元走九折；金额四舍五入到分。",
	"按你的推荐。",
];
const step = async (label: string, message: string, wait = 3000) => {
	if (Date.now() > deadline) throw new Error("超出时间预算");
	say(`\n\n▶ ${label}：${brief(message, 160)}`);
	await session.prompt(message);
	await idle(wait);
	printNew();
};
const drive = async (label: string, message: string, wait = 3000) => {
	await step(label, message, wait);
	for (let index = 0; index < 6 && Date.now() < deadline; index += 1) {
		const text = lastAssistant();
		if (!/？|\?/.test(text)) break;
		const answer = answers.shift() ?? "按你的推荐。";
		await step(`回答追问（第 ${index + 1} 次）`, answer, wait);
	}
};

section("1 · 真实模型完整流程");
await drive("用户需求", process.env.DEMO_TASK ?? "/delivery-shape 给订单结算加一档活动：满 250 打九折；它与现有满 100 减 10 按原始小计互斥，取对用户最优惠的一档。金额仍按分四舍五入。补测试。方案和实施计划分别写入 docs/调整-技术方案.md、docs/调整-实施计划.md。完成后安排一次独立代码审查。检查统一跑 node inputs/command.cjs。", 5000);
section("2 · 面板与审批");
say(`已记录面板：${panels.map((panel) => panel.title).join(" / ") || "（无）"}`);
say(`通知：${notices.filter((text) => !text.includes("")).slice(0, 6).map((text) => brief(text, 120)).join(" ｜ ")}`);
await idle(3000);
printNew();
section("3 · 等待开发与审查（含注入缺陷）");
for (let index = 0; index < 8 && Date.now() < deadline; index += 1) {
	await idle(4000);
	printNew();
	const branch = sm.getBranch();
	const reviewed = branch.some((row) => row.type === "message" && (row as { message?: { toolName?: string } }).message?.toolName === "delivery_review");
	const developed = branch.some((row) => row.type === "message" && (row as { message?: { toolName?: string } }).message?.toolName === "delivery_develop");
	if (developed && reviewed && injected) break;
	if (![...notices].at(-1)?.includes("")) { /* noop */ }
	const text = lastAssistant();
	if (/？|\?/.test(text)) { await step("追问", answers.shift() ?? "按你的推荐。", 4000); continue; }
	if (!developed && index >= 2) await step("推动", "/delivery-run", 4000);
	else if (developed && !reviewed && index >= 4) await step("推动审查", "/delivery-run", 4000);
}

section("4 · 结果核对");
say(`注入说明：${injectNote || "（未注入）"}`);
say(`最终检查：node inputs/command.cjs → 退出码 ${check().code}`);
for (const file of ["docs/调整-技术方案.md", "docs/调整-实施计划.md"]) {
	const info = await lstat(path.join(cwd, file)).catch(() => undefined);
	say(`落盘文档：${file} → ${info ? `${info.size} 字节` : "不存在"}`);
}
const workspace = await resolveWorkspaceIdentity(cwd);
const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
say(`残留 lease：${(await leases.read(workspace.key)) ? "有" : "无"}`);
say(`git status：\n${spawnSync("/usr/bin/git", ["status", "--short"], { cwd, encoding: "utf8" }).stdout.trim()}`);

section("5 · 状态、任务弹层、退出与人工解锁");
await step("/delivery-status", "/delivery-status", 2000);
say(`\n[通知] ${brief(notices.at(-1) ?? "", 400)}`);
await step("/delivery-status details", "/delivery-status details", 2000);
say(`\n[通知] ${brief(notices.at(-1) ?? "", 600)}`);
await step("/delivery-tasks", "/delivery-tasks", 4000);
const detail = panels.at(-1);
if (detail) say(`\n【任务弹层】${detail.title}\n${detail.lines.slice(0, 12).join("\n")}`);
// 造残留现场：真实 lease + 操作锁
const stale = await leases.acquire(workspace, { kind: "parent", sessionId: "demo-crashed", pid: process.pid, runId: "demo-stale" });
if (stale.ok) await mkdir(path.join(await getWriterStateRoot(workspace), "leases", `${workspace.key}.operation-lock`), { recursive: true });
await step("退出（应被拒）", "/delivery-exit", 2500);
say(`\n[通知] ${brief(notices.at(-1) ?? "", 300)}`);
await step("人工解锁", "/delivery-unlock", 2500);
say(`\n[确认框原文]\n${confirmations.at(-1) ?? "（未触发）"}`);
say(`[通知] ${brief(notices.at(-1) ?? "", 300)}`);
say(`解锁后残留 lease：${(await leases.read(workspace.key)) ? "仍有" : "已清理"}`);
await step("再次退出", "/delivery-exit", 5000);
say(`\n[通知] ${brief(notices.at(-1) ?? "", 300)}`);

section("6 · 证据位置");
say(`隔离根：${root}`);
say(`父会话：${sm.getSessionFile()}`);
say(`子会话目录：${path.join(agentDir, "sessions")}`);
say(`解锁二次确认：${unlockConfirmed ? "已触发" : "未触发"}`);
say(`剩余时间：${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒`);
session.dispose();
