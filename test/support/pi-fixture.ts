import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export function testEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: path.join(root, "home"),
		TMPDIR: root,
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_ADAPTIVE_TEST_ROOT: root,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		NPM_CONFIG_USERCONFIG: "/dev/null",
		NPM_CONFIG_GLOBALCONFIG: "/dev/null",
		NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
	};
}

// 仅测试使用系统沙箱；不将它作为 Package 的生产权限实现。
export function sandboxProfile(root: string, sourceRoot?: string): string {
	if (process.platform !== "darwin") {
		throw new Error("正式隔离测试当前只验收 macOS；没有系统隔离时不执行测试。");
	}
	const home = JSON.stringify(os.userInfo().homedir);
	const blockedHome = sourceRoot
		? `(require-all (subpath ${home}) (require-not (subpath ${JSON.stringify(sourceRoot)})))`
		: `(subpath ${home})`;
	const sourceParents: string[] = [];
	for (let parent = sourceRoot && path.dirname(sourceRoot); parent && parent !== path.dirname(parent); parent = path.dirname(parent)) {
		sourceParents.push(`(literal ${JSON.stringify(parent)})`);
	}
	return `(version 1)
(allow default)
(deny network*)
(deny file-read* ${blockedHome})
${sourceParents.length ? `(allow file-read-metadata ${sourceParents.join(" ")})` : ""}
(deny file-write* (require-not (require-any
  (subpath ${JSON.stringify(root)}) (literal "/dev/null"))))`;
}

export interface RpcRecord {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: any;
	[key: string]: any;
}

export class FixtureRpc {
	readonly process: ChildProcessWithoutNullStreams;
	readonly records: RpcRecord[] = [];
	readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	private ended = false;
	private failure?: Error;
	private stderr = "";
	private listeners = new Set<() => void>();

	constructor(cwd: string, env: NodeJS.ProcessEnv) {
		// 继承隔离测试入口的系统策略，不在 macOS 子进程中重复 sandbox_apply。
		this.process = spawn("pi", [
			"--mode", "rpc", "--offline",
			"--session-dir", path.join(env.PI_CODING_AGENT_DIR!, "sessions"),
		], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.process.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				try {
					this.records.push(JSON.parse(line));
				} catch (error) {
					this.failure = new Error("测试 Pi 返回了无效 JSONL", { cause: error });
				}
				this.wake();
			}
		});
		this.process.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-4000);
		});
		this.process.on("error", (error) => {
			this.failure = error;
			this.wake();
		});
		this.process.stdin.on("error", (error) => {
			this.failure = error;
			this.wake();
		});
		this.closed = new Promise((resolve) => {
			this.process.once("close", (code, signal) => {
				this.ended = true;
				buffer += decoder.end();
				if (buffer.trim()) this.failure = new Error("测试 Pi 在完整 JSONL 记录结束前关闭输出");
				this.wake();
				resolve({ code, signal });
			});
		});
	}

	private wake(): void {
		for (const listener of this.listeners) listener();
	}

	waitFor(predicate: (record: RpcRecord) => boolean, from = 0, timeoutMs = 15_000): Promise<RpcRecord> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error(`等待 Pi RPC 超时：${this.stderr}`)), timeoutMs);
			const finish = (error?: Error, result?: RpcRecord) => {
				clearTimeout(timer);
				this.listeners.delete(check);
				if (error) reject(error);
				else resolve(result!);
			};
			const check = () => {
				if (this.failure) return finish(this.failure);
				const result = this.records.slice(from).find(predicate);
				if (result) return finish(undefined, result);
				if (this.ended) finish(new Error(`Pi RPC 已退出：${this.stderr}`));
			};
			this.listeners.add(check);
			check();
		});
	}

	async send(type: string, payload: Record<string, unknown> = {}): Promise<RpcRecord> {
		const id = crypto.randomUUID();
		const response = this.waitFor((record) => record.type === "response" && record.id === id);
		this.process.stdin.write(`${JSON.stringify({ ...payload, type, id })}\n`);
		const result = await response;
		if (!result.success) throw new Error(`Pi RPC ${type} 失败：${result.error}`);
		return result;
	}

	async stop(): Promise<void> {
		if (this.ended) return;
		this.process.kill("SIGTERM");
		let forced = false;
		const timer = setTimeout(() => {
			forced = true;
			this.process.kill("SIGKILL");
		}, 5000);
		try {
			await this.closed;
			if (forced) throw new Error("测试清理被迫 SIGKILL；不作为正常退出证据");
		} finally {
			clearTimeout(timer);
		}
	}
}

export async function createPiFixture(packageSource?: string, scenario?: string, activate = true): Promise<{
	root: string;
	cwd: string;
	agentDir: string;
	packageDir: string;
	productDir?: string;
	rpc: FixtureRpc;
}> {
	if (!process.env.PI_ADAPTIVE_TEST_ROOT) throw new Error("请通过 test/support/run-tests.ts 启动 Pi 集成测试。");
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-pi-")));
	const cwd = path.join(root, "repo");
	const packageDir = path.join(root, "fixture-package");
	const env = testEnvironment(root);
	if (scenario) env.ADAPTIVE_FIXTURE_SCENARIO = scenario;
	const agentDir = env.PI_CODING_AGENT_DIR!;
	await Promise.all([cwd, packageDir, env.HOME!, agentDir].map((dir) => mkdir(dir, { recursive: true })));
	execFileSync("git", ["init", "--quiet", cwd], { env, cwd: root });
	await copyFile(fileURLToPath(new URL("./fake-provider.ts", import.meta.url)), path.join(packageDir, "provider.ts"));
	if (scenario === "document-io") {
		await copyFile(fileURLToPath(new URL("./document-io-fixture.ts", import.meta.url)), path.join(packageDir, "document-io.ts"));
	}
	const writerFixture = scenario?.startsWith("writer-") === true;
	const developmentFixture = scenario?.startsWith("development-") === true;
	if (writerFixture) await copyFile(fileURLToPath(new URL("./parent-writer-fixture.ts", import.meta.url)), path.join(packageDir, "parent-writer.ts"));
	if (developmentFixture) await copyFile(fileURLToPath(new URL("./development-io-fixture.ts", import.meta.url)), path.join(packageDir, "development-io.ts"));
	await writeFile(path.join(packageDir, "package.json"), JSON.stringify({
		name: "adaptive-isolation-fixture", type: "module", pi: { extensions: ["./provider.ts", ...(scenario === "document-io" ? ["./document-io.ts"] : []), ...(writerFixture ? ["./parent-writer.ts"] : []), ...(developmentFixture ? ["./development-io.ts"] : [])] },
	}));
	await writeFile(path.join(agentDir, "auth.json"), "{}\n");
	let productDir: string | undefined;
	if (packageSource) {
		productDir = path.join(root, "product-package");
		await mkdir(productDir);
		// 仅复制本仓库交付资源，不携带 node_modules、.pi、.env 或用户配置。
		for (const file of ["package.json", "extensions", "prompts", "skills"]) {
			await cp(path.join(packageSource, file), path.join(productDir, file), { recursive: true });
		}
	}
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		packages: [packageDir, ...(productDir && !writerFixture ? [productDir] : [])], defaultProvider: "adaptive-fixture", defaultModel: "fake",
		defaultProjectTrust: scenario === "readonly-search" ? "always" : "never",
		retry: scenario?.includes("stream-retry") ? { enabled: true, maxRetries: 2, baseDelayMs: scenario.endsWith("exit") ? 1500 : 80 } : { enabled: false }, compaction: { enabled: false },
	}));
	if (scenario === "readonly-search") {
		await mkdir(path.join(cwd, ".pi"));
		await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({ defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"] }));
	}
	await writeFile(path.join(cwd, "AGENTS.md"), "# 临时规则\n仅操作测试夹具。\n");
	await writeFile(path.join(cwd, "input.txt"), "fixture-read-ok\n");
	if (scenario?.startsWith("environment-")) {
		await mkdir(path.join(agentDir, "skills", "environment-proof"), { recursive: true });
		await writeFile(path.join(agentDir, "AGENTS.md"), "# 全局测试规则\nGLOBAL_ENVIRONMENT_RULE\n");
		await writeFile(path.join(cwd, "AGENTS.md"), "# 项目测试规则\nPROJECT_ENVIRONMENT_RULE\n");
		await writeFile(path.join(agentDir, "SYSTEM.md"), "BASE_ENVIRONMENT_INSTRUCTION\n");
		await writeFile(path.join(agentDir, "skills", "environment-proof", "SKILL.md"),
			"---\nname: environment-proof\ndescription: ENVIRONMENT_SKILL_DESCRIPTION\n---\n\nENVIRONMENT_SKILL_BODY\n");
	}
	const rpc = new FixtureRpc(cwd, env);
	if (productDir && !writerFixture && activate) {
		try { await rpc.send("prompt", { message: "/delivery-shape" }); }
		catch (error) { await rpc.stop(); throw error; }
	}
	return { root, cwd, agentDir, packageDir, productDir, rpc };
}
