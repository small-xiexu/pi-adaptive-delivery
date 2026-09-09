import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";
import { createPiFixture, testEnvironment } from "./pi-fixture.ts";
import { approvalUI } from "./delivery-ui.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));

// 文件开发与容器组合共用同一个 SDK 父/模拟选择、真实 CLI 子宿主。
export async function createDevelopmentHost(t: TestContext, scenario = "normal", configure?: (pi: ExtensionAPI) => void,
	configureFixture?: (fixture: Awaited<ReturnType<typeof createPiFixture>>) => Promise<void>) {
	const fixture = await createPiFixture(source, `development-${scenario}`);
	await fixture.rpc.send("get_state");
	await fixture.rpc.stop();
	await configureFixture?.(fixture);
	const originalEnv = { ...process.env };
	Object.assign(process.env, testEnvironment(fixture.root), { ADAPTIVE_FIXTURE_SCENARIO: `development-${scenario}` });
	if (scenario === "separate-git") execFileSync("git", ["init", "--quiet", "--separate-git-dir", "metadata"], { cwd: fixture.cwd });
	const settingsManager = SettingsManager.create(fixture.cwd, fixture.agentDir);
	let api!: ExtensionAPI;
	const resourceLoader = new DefaultResourceLoader({ cwd: fixture.cwd, agentDir: fixture.agentDir, settingsManager,
		extensionFactories: [(pi) => { api = pi; configure?.(pi); }] });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(fixture.agentDir, "auth.json"), modelsPath: path.join(fixture.agentDir, "models.json") });
	const sm = SessionManager.create(fixture.cwd, path.join(fixture.root, "parent-sessions"));
	const { session } = await createAgentSession({ cwd: fixture.cwd, agentDir: fixture.agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: sm });
	initTheme("dark");
	const notices: string[] = [];
	const choices: string[] = [];
	let select: ExtensionUIContext["select"] = async (title, items) => { choices.push(title); return items[0]; };
	let custom = approvalUI((...args) => select(...args));
	let confirm: ExtensionUIContext["confirm"] = async () => true;
	let input: ExtensionUIContext["input"] = async () => "fixture-answer";
	t.after(async () => {
		try { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
		finally {
			session.dispose();
			for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
			Object.assign(process.env, originalEnv);
		}
	});
	await session.bindExtensions({ mode: "tui", abortHandler: () => { session.clearQueue(); void session.abort(); },
		uiContext: { ...session.extensionRunner.getUIContext(), select: (...args: Parameters<ExtensionUIContext["select"]>) => select(...args),
		custom: (...args: Parameters<ExtensionUIContext["custom"]>) => custom(...args),
		confirm: (...args: Parameters<ExtensionUIContext["confirm"]>) => confirm(...args), input: (...args: Parameters<ExtensionUIContext["input"]>) => input(...args),
		notify: (text: string) => { notices.push(text); } } as unknown as ExtensionUIContext, onError: (error) => notices.push(error.error) });
	const model = modelRuntime.getModel("adaptive-fixture", "fake");
	assert.ok(model);
	await session.setModel(model);
	const workspace = await resolveWorkspaceIdentity(fixture.cwd);
	const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
	const call = async (name: string, args: Record<string, unknown>) => {
		const id = randomUUID();
		await session.prompt(`/fixture-next-tool ${JSON.stringify({ type: "toolCall", id, name, arguments: args })}`);
		await session.prompt("执行本轮隔离测试");
		const row = sm.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
		assert.ok(row?.type === "message" && row.message.role === "toolResult", JSON.stringify(session.messages));
		return row.message;
	};
	const approve = (stage: string, paths: string[], container?: { image: string; inputs: string[] }, validationCommands: string[] = []) => call("delivery_approval", {
		stage, body: `APPROVED_${stage.toUpperCase()}_BODY`, paths, validationCommands, ...(container ? { container } : {}),
	});
	const prepare = async () => {
		for (const [stage, paths] of [["design", ["plan.md"]], ["implementation", ["src", "plan.md"]]] as const) {
			assert.equal((await approve(stage, [...paths])).isError, false);
		}
	};
	const audit = async () => (await readFile(path.join(fixture.agentDir, "fixture-events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	t.diagnostic(JSON.stringify({ root: fixture.root, parentPid: process.pid, ui: "simulated", child: "standard-cli" }));
	return { ...fixture, session, sm, api, notices, choices, call, approve, prepare, audit, readLease: () => leases.read(workspace.key),
		setSelect: (value: typeof select) => { select = value; }, setConfirm: (value: typeof confirm) => { confirm = value; },
		setCustom: (value: typeof custom) => { custom = value; },
		setInput: (value: typeof input) => { input = value; } };
}
