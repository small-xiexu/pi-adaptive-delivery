#!/usr/bin/env node
// 决定性实验：本地 OpenAI 兼容假服务，第一个请求“只发响应头后永久沉默”，其余请求正常回复。
// 用 Pi 真实的 HTTP 路径（内置 deepseek provider 走 openai-completions），验证：
//   1) httpIdleTimeoutMs 是否真的中断停顿（预期约等于配置值）；
//   2) 中断后 Pi 是否自动重试并最终完成；
//   3) 加 -plugin 参数时，加载 pi-codex-conversion 后上述行为是否仍然成立。
// 不调用真实模型、不读取、不复制、不打印任何凭证。
// 用法：node --import tsx test/demo/idle-timeout-probe.ts [idleMs] [--plugin]
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, type ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";

const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const idleMs = Number(process.argv[2] ?? 5_000);
const withPlugin = process.argv.includes("--plugin");
const withWatch = process.env.PROBE_WATCH === "1";
const adapter = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@howaboua", "pi-codex-conversion");
let stalls = Number(process.env.PROBE_STALLS ?? 1);
const started = Date.now();
const requests: { at: number; bytes: number; stalled: boolean }[] = [];

const server = createServer((request, response) => {
	const record = { at: Date.now() - started, bytes: 0, stalled: false };
	requests.push(record);
	request.on("data", (chunk: Buffer) => { record.bytes += chunk.length; });
	request.on("end", () => {
		if (stalls > 0) {
			stalls -= 1;
			record.stalled = true;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.flushHeaders();   // 只发头，之后一个字节都不发
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		response.write(chunk({ role: "assistant", content: "收到" }, null));
		response.write(chunk({}, "stop"));
		response.write("data: [DONE]\n\n");
		response.end();
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-probe-")));
const agentDir = path.join(root, "agent");
await Promise.all([agentDir, path.join(root, "home")].map((dir) => mkdir(dir, { recursive: true })));
for (const file of ["auth.json", "models-store.json"]) {
	try { await symlink(path.join(os.homedir(), ".pi", "agent", file), path.join(agentDir, file)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
// 用户自己的 models.json 就是这么覆盖 baseUrl 的；这里把它指向本地假服务。
await writeFile(path.join(agentDir, "models.json"), `${JSON.stringify({ providers: { deepseek: { baseUrl: `http://127.0.0.1:${port}/v1` } } }, null, 2)}\n`);
execFileSync("git", ["init", "-q"], { cwd: root });   // 交付入口要求 Git 工作区
const settings: Record<string, unknown> = { packages: withPlugin ? [adapter] : withWatch ? [repo] : [], defaultProvider: "deepseek", defaultModel: "deepseek-flash",
	httpIdleTimeoutMs: idleMs, retry: { enabled: true, maxRetries: 3, baseDelayMs: 300 }, compaction: { enabled: false } };
if (withPlugin) settings.defaultTools = ["read", "bash", "write", "edit", "grep", "find", "ls"];
await writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
if (withPlugin) {
	await writeFile(path.join(agentDir, "pi-codex-conversion.json"), JSON.stringify({ executionMode: "normal", voiceFeaturesOnly: false,
		scope: { allProviders: "on", additionalProviders: [] }, voice: { audioSetupCompleted: true },
		openai: { forceCachedWebSockets: false, cacheKeepalive: false, lunaCacheKeepaliveMinutes: 0, verbosity: "low" } }));
}

const env = { ...process.env, HOME: path.join(root, "home"), TMPDIR: root, PI_CODING_AGENT_DIR: agentDir,
	PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", DEEPSEEK_API_KEY: "probe-not-a-credential" };
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);

console.log(`模式：${withPlugin ? "加载 pi-codex-conversion" : withWatch ? "交付包 + 停顿看门狗" : "原生"} · httpIdleTimeoutMs=${idleMs} · 假服务 http://127.0.0.1:${port}/v1`);
console.log(`（第一个请求只发响应头后沉默，之后正常回复"收到"）`);

const timeline: string[] = [];
const settingsManager = SettingsManager.create(root, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: [] });
await resourceLoader.reload();
const loadErrors = resourceLoader.getExtensions().errors;
if (loadErrors.length) console.log("扩展加载错误：", JSON.stringify(loadErrors));
for (const reload of [0]) void reload;
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const target = modelRuntime.getModel("deepseek", "deepseek-flash");
if (!target) throw new Error(`模型未注册；已知 provider：${[...new Set(modelRuntime.getModels().map((item) => item.provider))].slice(0, 8).join(", ")}`);
console.log(`模型 api = ${(target as { api?: string }).api}`);
const sm = SessionManager.create(root, path.join(root, "sessions"));
const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: sm });
initTheme("dark");
await session.bindExtensions({ mode: "tui", commandContextActions: { reload: () => session.reload() } as unknown as ExtensionCommandContextActions,
	abortHandler: () => { session.clearQueue(); void session.abort(); }, uiContext: { ...session.extensionRunner.getUIContext(), notify: (text: string, level?: string) => console.log(`[通知${level ? `/${level}` : ""}] ${text}`) } as never, onError: () => {} });
await session.setModel(target);
if (withWatch) await session.prompt("/delivery-shape");   // 启用交付后才会安装停顿看门狗

const began = Date.now();
await session.prompt("只回答两个字：收到。").catch((error) => console.log("prompt 抛错：", String(error).slice(0, 120)));
await session.waitForIdle();

console.log("\n════════ 结果 ════════");
console.log(`请求到达次数：${requests.length}`);
requests.forEach((record, index) => console.log(`  第 ${index + 1} 次：+${record.at}ms，body ${record.bytes} 字节，${record.stalled ? "【沉默】" : "【正常】"}`));
if (requests.length > 1) console.log(`停顿到重试的间隔：${requests[1]!.at - requests[0]!.at} ms（配置 ${idleMs} ms）`);
console.log(`会话总耗时：${Date.now() - began} ms`);
const rows = sm.getBranch().filter((row) => row.type === "message");
const errors = rows.map((row) => (row as { message?: { stopReason?: string; errorMessage?: string } }).message).filter((message) => message?.stopReason === "error");
for (const error of errors) console.log(`失败消息：${JSON.stringify(error?.errorMessage)}`);
const last = rows.findLast((row) => (row as { message?: { role?: string } }).message?.role === "assistant");
const content = last ? ((last as { message: { content?: { type: string; text?: string }[] } }).message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("") : "";
console.log(`最终助手正文：${JSON.stringify(content.slice(0, 60))}`);
console.log(`自动重试：${requests.length > 1 ? "是" : "否"}｜是否完成：${content.includes("收到") ? "是" : "否"}`);
for (const line of timeline) console.log(line);
server.close();
session.dispose();
process.exit(0);
