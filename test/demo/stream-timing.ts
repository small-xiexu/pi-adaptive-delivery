#!/usr/bin/env node
// 测量真实模型的流式时间特征：首字节延迟（TTFB）与相邻内容增量的最大间隔。
// 用途：为 httpIdleTimeoutMs 选一个不会误杀正常请求的阈值。
// 认证由 Pi 自己从符号链接的 auth.json 读取；本脚本不读取、不复制、不打印任何凭证。
// 用法：DEMO_MODEL=openai/gpt-5.6-sol node --import tsx test/demo/stream-timing.ts
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContextActions, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const sourceAgent = path.join(os.homedir(), ".pi", "agent");
const model = process.env.DEMO_MODEL ?? "openai/gpt-5.6-sol";
const realSettings = JSON.parse(await readFile(path.join(sourceAgent, "settings.json"), "utf8"));
const [provider, modelId] = model.split("/");

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-timing-")));
const agentDir = path.join(root, "agent");
await Promise.all([agentDir, path.join(root, "home")].map((dir) => mkdir(dir, { recursive: true })));
for (const file of ["auth.json", "models.json", "models-store.json"]) {
	try { await symlink(path.join(sourceAgent, file), path.join(agentDir, file)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
await writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [repo], defaultProvider: provider, defaultModel: modelId,
	httpIdleTimeoutMs: 0, retry: { enabled: false }, compaction: { enabled: false } }, null, 2)}\n`);

const env = { ...process.env, HOME: path.join(root, "home"), TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);

const samples: { label: string; ttfb: number; maxGap: number; deltas: number; total: number; firstDelta: string; kinds: Record<string, number> }[] = [];
let current: { label: string; start: number; first?: number; last?: number; maxGap: number; deltas: number; kinds: Record<string, number>; firstDelta: string } | undefined;

const settingsManager = SettingsManager.create(root, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: [(pi: ExtensionAPI) => {
	pi.on("message_start", (event) => {
		const message = event.message as { role?: string };
		if (message.role !== "assistant" || !current) return;
		current.start = Date.now();
		current.last = undefined;
		current.first = undefined;
	});
	pi.on("message_update", (event) => {
		if (!current) return;
		const update = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
		const kind = update?.type ?? "unknown";
		const now = Date.now();
		current.deltas += 1;
		current.kinds[kind] = (current.kinds[kind] ?? 0) + 1;
		if (current.first === undefined) { current.first = now; current.firstDelta = kind; }
		if (current.last !== undefined) current.maxGap = Math.max(current.maxGap, now - current.last);
		current.last = now;
	});
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string };
		if (message.role !== "assistant" || !current || current.first === undefined) return;
		samples.push({ label: current.label, ttfb: current.first - current.start, maxGap: current.maxGap,
			deltas: current.deltas, total: Date.now() - current.start, firstDelta: current.firstDelta, kinds: { ...current.kinds } });
	});
}] });
await resourceLoader.reload();
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const target = modelRuntime.getModel(provider, modelId);
if (!target) throw new Error(`找不到模型 ${model}`);
const sm = SessionManager.create(root, path.join(root, "sessions"));
const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: sm });
initTheme("dark");
await session.bindExtensions({ mode: "tui", commandContextActions: { reload: () => session.reload() } as unknown as ExtensionCommandContextActions,
	abortHandler: () => { session.clearQueue(); void session.abort(); },
	uiContext: { ...session.extensionRunner.getUIContext(), custom: (async () => undefined) as unknown as ExtensionUIContext["custom"],
		notify: () => {} } as unknown as ExtensionUIContext, onError: () => {} });
await session.setModel(target);

const prompts: { label: string; thinking?: string; text: string }[] = [
	{ label: "短回答", text: "只回答两个字：收到。" },
	{ label: "中等解释", text: "用不超过 200 字解释什么是幂等，并举一个例子。" },
	{ label: "较长清单", text: "列出 12 条常见的 Node.js 性能问题，每条一句话，不要解释背景。" },
	{ label: "推理稍重", thinking: "high", text: "比较“先写测试”与“先写实现”在修复缺陷时的取舍，150 字以内。" },
	{ label: "长输出", thinking: "high", text: "写一份约 800 字的 Node.js 代码审查清单，分条目展开说明。" },
	{ label: "强推理长输出", thinking: "high", text: "设计一个支持幂等重试的支付回调处理方案，说明状态机、去重键、并发冲突与失败恢复，约 500 字。" },
];
for (const item of prompts) {
	current = { label: item.label, start: 0, maxGap: 0, deltas: 0, kinds: {}, firstDelta: "" };
	console.log(`\n▶ ${item.label}（thinking ${item.thinking ?? "继承"}）`);
	await session.prompt(item.text);
	await session.waitForIdle();
}
current = undefined;

console.log("\n════════ 结果 ════════");
console.log("模型：", model);
console.log("样本 | 首字节(ms) | 最大增量间隔(ms) | 增量数 | 总时长(ms) | 首个增量类型");
let maxTtfb = 0, maxGap = 0;
for (const sample of samples) {
	maxTtfb = Math.max(maxTtfb, sample.ttfb);
	maxGap = Math.max(maxGap, sample.maxGap);
	console.log(`${sample.label} | ${sample.ttfb} | ${sample.maxGap} | ${sample.deltas} | ${sample.total} | ${sample.firstDelta}`);
	console.log(`  增量类型分布：${JSON.stringify(sample.kinds)}`);
}
console.log(`\n最大首字节延迟：${maxTtfb} ms；最大增量间隔：${maxGap} ms`);
console.log(`建议 httpIdleTimeoutMs 不低于：${Math.max(60_000, Math.ceil((maxGap * 3) / 10_000) * 10_000)} ms（取观测最大间隔的 3 倍并向上取整到 10 秒，且不低于 60 秒）`);
session.dispose();
