#!/usr/bin/env node
// 真实模型 demo：真实 SDK 父会话 + 真实子 Pi CLI + 真实项目检查。
// 认证由 Pi 自己从符号链接的 auth.json 读取；本脚本不读取、不复制、不打印任何凭证。
// 用法：node --import tsx test/demo/real-model.ts
// 可用环境变量：DEMO_MODEL / DEMO_THINKING / DEMO_MAX_TURNS / DEMO_FEEDBACK / DEMO_TIMEOUT_MIN
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContextActions, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";
import { DesignReviewPanel } from "../../extensions/delivery-gate/src/ui.ts";
import { plainTheme } from "../support/delivery-ui.ts";

const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const home = os.homedir();
const sourceAgent = path.join(home, ".pi", "agent");
const maxTurns = Number(process.env.DEMO_MAX_TURNS ?? 10);
const deadline = Date.now() + Number(process.env.DEMO_TIMEOUT_MIN ?? 20) * 60_000;
const feedbackText = process.env.DEMO_FEEDBACK ?? "假设里没写折扣值的类型约束。本次不展开校验，但请在方案里注明“暂不处理非数字输入”。";
const smokeOnly = Boolean(process.env.DEMO_SMOKE_ONLY);
const scenario = process.env.DEMO_SCENARIO ?? "simple";

const say = (text = "") => console.log(text);
const section = (title: string) => say(`\n\n════════ ${title} ════════`);
const brief = (value: string, limit = 800) => value.replace(/\s+/g, " ").trim().length > limit ? `${value.replace(/\s+/g, " ").trim().slice(0, limit)}…[截断]` : value.replace(/\s+/g, " ").trim();
const textOf = (content: unknown): string => Array.isArray(content)
	? content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("")
	: typeof content === "string" ? content : "";
const remaining = () => `剩余 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒`;

// 1. 隔离环境：临时 HOME/TMPDIR/agent dir；只符号链接认证、模型目录与全局规则。
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-real-")));
const agentDir = path.join(root, "agent");
await Promise.all([agentDir, path.join(root, "home"), path.join(root, "sessions")].map((dir) => mkdir(dir, { recursive: true })));
const linked: string[] = [];
for (const file of ["auth.json", "models.json", "models-store.json", "AGENTS.md"]) {
	try {
		await symlink(path.join(sourceAgent, file), path.join(agentDir, file));
		linked.push(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
const realSettings = JSON.parse(await readFile(path.join(sourceAgent, "settings.json"), "utf8"));
const provider = process.env.DEMO_MODEL?.split("/")[0] ?? realSettings.defaultProvider;
const modelId = process.env.DEMO_MODEL?.split("/")[1] ?? realSettings.defaultModel;
const thinking = process.env.DEMO_THINKING ?? "medium";
await writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify({
	packages: [repo], defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: thinking,
	compaction: { enabled: true }, httpIdleTimeoutMs: 60_000, retry: { enabled: true, maxRetries: 2 },
}, null, 2)}\n`);

const keep = ["PATH", "LANG", "LC_ALL", "TERM", "SHELL", "USER", "LOGNAME", "TZ"];
const env: NodeJS.ProcessEnv = {};
for (const key of keep) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { HOME: path.join(root, "home"), TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);

say(`真实模型 demo：${provider}/${modelId} · thinking ${thinking}`);
say(`隔离根目录：${root}`);
say(`符号链接（不复制内容）：${linked.join(", ") || "无"}`);
say(`等价命令：DEMO_MODEL=${provider}/${modelId} node --import tsx test/demo/real-model.ts`);

// 2. demo 项目：真实订单结算小项目，基线检查必须失败。
const cwd = path.join(root, "repo");
await Promise.all([path.join(cwd, "src"), path.join(cwd, "test"), path.join(cwd, "inputs")].map((dir) => mkdir(dir, { recursive: true })));
await writeFile(path.join(cwd, "src/value.js"), "export const value = 1;\n");
await writeFile(path.join(cwd, "test/value.test.js"), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../src/value.js";\n\ntest("结算金额使用折扣后的数值", () => {\n  assert.equal(value, 2);\n});\n`);
if (scenario === "feature") {
	await writeFile(path.join(cwd, "src/discount.js"), "export function discount(total) {\n  return total;\n}\n");
	await writeFile(path.join(cwd, "test/discount.test.js"), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { discount } from "../src/discount.js";\n\ntest("满 100 减 10", () => {\n  assert.equal(discount(120), 110);\n});\n\ntest("不足 100 不变", () => {\n  assert.equal(discount(50), 50);\n});\n`);
}
await writeFile(path.join(cwd, "inputs/command.cjs"), `const { spawnSync } = require("node:child_process");\nconst env = { ...process.env };\ndelete env.NODE_TEST_CONTEXT;\nconst run = spawnSync(process.execPath, ["--test"], { stdio: "inherit", env });\nprocess.exit(run.status ?? 1);\n`);
await writeFile(path.join(cwd, "AGENTS.md"), "# demo 项目规则\n\n只修改 src 目录；检查统一使用 node inputs/command.cjs。\n");
execFileSync("git", ["init", "--quiet"], { cwd });
execFileSync("git", ["add", "-A"], { cwd });
execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "订单结算 demo 基线"], { cwd });
const check = () => { const run = spawnSync(process.execPath, ["inputs/command.cjs"], { cwd, encoding: "utf8" }); return { code: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` } };
const baseline = check();
section("0 · 基线");
say(`$ node inputs/command.cjs → 退出码 ${baseline.code}`);
if (baseline.code === 0) throw new Error("基线检查应当失败");

// 3. 交互替身：真实组件渲染 + 键盘操作，记录面板原文；批准由脚本代选，不是真实用户点击。
const panels: { title: string; lines: string[] }[] = [];
const dialogs: string[] = [];
let designFeedbackGiven = false;
const custom = (async (factory: any, options: any) => {
	let done!: (value: unknown) => void;
	const result = new Promise<unknown>((resolve) => { done = resolve; });
	const panel = await factory({ terminal: { rows: 40 }, requestRender() {} } as never, plainTheme, {} as never, done) as
		{ title?: string; choices?: string[]; render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
	try {
		if (options?.overlay) {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			panels.push({ title: panel.title ?? "任务详情", lines: panel.render(100) });
			done(undefined);
			return await result;
		}
		const choices = panel.choices ?? [];
		panels.push({ title: panel.title ?? "", lines: panel.render(100) });
		const wantsFeedback = panel.title === "方案审阅" && !designFeedbackGiven;
		if (wantsFeedback) {
			designFeedbackGiven = true;
			say("\n【交互替身】面板：方案审阅 → 选择「提出修改意见」");
			panel.handleInput?.("\x1b[A");
			panel.handleInput?.("\r");
			panel.handleInput?.(`\x1b[200~${feedbackText}\x1b[201~`);
			panel.handleInput?.("\r");
		} else {
			const label = choices[0]!;
			say(`\n【交互替身】面板：${panel.title} → 选择「${label}」`);
			const index = choices.indexOf(label);
			// 面板默认停在最后一项（不批准）；选第一项需要上移 (choices.length - 1) 次。
			if (index === 0) for (let i = 1; i < choices.length; i++) panel.handleInput?.("\x1b[A");
			panel.handleInput?.(index === 0 ? "\r" : "\x1b");
		}
		return await result;
	} finally { panel.dispose?.(); }
}) as ExtensionUIContext["custom"];
const confirmFn: ExtensionUIContext["confirm"] = async (title, message) => { dialogs.push(`confirm：${title}｜${brief(message, 200)}`); say(`\n【交互替身】confirm：${title}`); return true; };
const selectFn: ExtensionUIContext["select"] = async (title, items) => { dialogs.push(`select：${title}｜${items[0]}`); return items[0]; };
const inputFn: ExtensionUIContext["input"] = async (title) => { dialogs.push(`input：${title}`); return "按推荐"; };

// 4. 真实 SDK 父会话
const settingsManager = SettingsManager.create(cwd, agentDir);
let api!: ExtensionAPI;
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [(pi) => { api = pi; }] });
await resourceLoader.reload();
const errors = resourceLoader.getExtensions().errors;
if (errors.length) throw new Error(`扩展加载失败：${JSON.stringify(errors)}`);
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`找不到模型 ${provider}/${modelId}；已加载 provider：${[...new Set(modelRuntime.getModels().map((item) => item.provider))].join(", ")}`);
const sm = SessionManager.create(cwd, path.join(root, "sessions"));
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: sm });
initTheme("dark");
const notices: string[] = [];
await session.bindExtensions({ mode: "tui",
	commandContextActions: { reload: () => session.reload() } as ExtensionCommandContextActions,
	abortHandler: () => { session.clearQueue(); void session.abort(); },
	uiContext: { ...session.extensionRunner.getUIContext(), custom: (factory: any, options: any) => custom(factory, options),
		confirm: (...args: Parameters<ExtensionUIContext["confirm"]>) => confirmFn(...args),
		select: (...args: Parameters<ExtensionUIContext["select"]>) => selectFn(...args),
		input: (...args: Parameters<ExtensionUIContext["input"]>) => inputFn(...args),
		notify: (text: string) => { notices.push(text); } } as unknown as ExtensionUIContext,
	onError: (error) => notices.push(error.error) });
await session.setModel(model);
await session.prompt("/delivery-shape");
say(`\n交付已启用（首条通知：${notices.at(-1)}）`);

// 5. 真实模型连通性冒烟
section("1 · 真实模型连通性");
await session.prompt("只回答两个字：收到。不要调用任何工具。");
const lastAssistant = sm.getBranch().findLast((row) => row.type === "message" && (row as { message?: { role?: string } }).message?.role === "assistant") as
	{ message: { content: unknown } } | undefined;
const smoke = textOf(lastAssistant?.message.content);
say(`模型回复：${brief(smoke, 160)}`);
if (!/收到/.test(smoke)) throw new Error("真实模型未按预期回复，停止后续流程");
if (smokeOnly) { say("\n仅冒烟：跳过完整流程。"); session.dispose(); process.exit(0); }

// 6. 驱动流程：每个回合后打印新增记录，必要时用 /delivery-plan、/delivery-run 推动。
let printed = 0;
const printNew = () => {
	for (const row of sm.getBranch().slice(printed)) {
		if (row.type === "message") {
			const message = row.message as { role: string; content: any; toolCallId?: string; isError?: boolean };
			if (message.role === "assistant") for (const part of message.content ?? []) {
				if (part.type === "text" && part.text?.trim()) say(`\n[模型] ${part.text.trim()}`);
				if (part.type === "toolCall") say(`\n[调用] ${part.name} ${brief(JSON.stringify(part.arguments), 400)}`);
			}
			if (message.role === "toolResult") say(`[结果]${message.isError ? " 失败" : ""} ${brief(textOf(message.content) || JSON.stringify(message.content), 300)}`);
			if (message.role === "user" && typeof message.content === "string") say(`\n[用户] ${brief(message.content, 200)}`);
		} else say(`[记录] ${(row as { customType?: string }).customType ?? (row as { type: string }).type}`);
	}
	printed = sm.getBranch().length;
};
const idle = async (ms = 1500) => { await session.waitForIdle(); await new Promise((resolve) => setTimeout(resolve, ms)); await session.waitForIdle(); };
const turn = async (message: string) => { if (Date.now() > deadline) throw new Error("超出时间预算"); say(`\n\n▶ 用户输入：${brief(message, 200)}`); await session.prompt(message); await idle(); printNew(); };

const workspace = await resolveWorkspaceIdentity(cwd);
const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
const approvals = () => sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-approval").length;
const delegations = () => sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-development").length;

section("2 · 真实模型完整流程");
const requirement = scenario === "feature"
	? "/delivery-shape 需求：订单结算要支持满减，满 100 减 10、不足 100 不变。实现放在 src/ 下并补充对应单元测试；完成后请安排一次独立代码审查。检查统一跑 node inputs/command.cjs。"
	: "/delivery-shape 需求：订单结算的折扣值现在是 1，要改成 2，现有测试（node inputs/command.cjs）必须通过；本次只动 src/value.js。";
await turn(requirement);
for (let index = 0; index < maxTurns; index++) {
	if (Date.now() > deadline) { say(`\n⚠ 超出时间预算，停止驱动（${remaining()}）`); break; }
	const dirty = spawnSync("/usr/bin/git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8" }).stdout.trim().length > 0;
	const settled = approvals() >= 2 && (delegations() > 0 || dirty);
	if (settled && !(await leases.read(workspace.key))) { say("\n①两次确认完成、改动就位且 writer 已交回，停止驱动。"); break; }
	const before = sm.getBranch().length;
	await turn(index % 3 === 1 ? "/delivery-run" : "/delivery-plan");
	if (sm.getBranch().length === before) { say("（模型没有继续推进，停止驱动）"); break; }
}

// 7. 结果核对：真实模型留下的现场 + 父侧独立检查
section("3 · 结果");
const finalFile = await readFile(path.join(cwd, "src/value.js"), "utf8").catch(() => "（文件已不存在）");
say(`src/value.js：${JSON.stringify(finalFile)}`);
const after = check();
say(`$ node inputs/command.cjs → 退出码 ${after.code}`);
const gitStatus = spawnSync("/usr/bin/git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8" }).stdout.trim();
say(`git status：\n${gitStatus || "（干净）"}`);
say(`二次确认记录：${approvals()} · 委派记录：${delegations()} · 残留 lease：${(await leases.read(workspace.key)) ? "有" : "无"}`);
say(`子会话：${sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-delegation").length} 条委派记录`);
say(`交互替身代答：${dialogs.length ? [...new Set(dialogs)].join("；") : "无"}`);
for (const panel of panels) { section(`面板原文：${panel.title}`); for (const line of panel.lines) say(line); }
for (const notice of [...new Set(notices)]) say(`\n[通知] ${brief(notice, 400)}`);

section("4 · 证据位置");
say(`隔离根目录：${root}`);
say(`父会话：${sm.getSessionFile()}`);
say(`demo 项目：${cwd}`);
say(`子会话目录：${path.join(agentDir, "sessions")}`);
say(`\n完成：${remaining()}`);
session.dispose();
