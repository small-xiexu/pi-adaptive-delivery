import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { WorkspaceIdentity } from "./workspace.ts";

const OWNER_LABEL = "pi-adaptive-delivery.execution";
const HOST = "unix:///var/run/docker.sock";
const IMAGE_FORMAT = '{"id":{{json .Id}},"os":{{json .Os}},"volumes":{{json (index .Config "Volumes")}}}';
const STATE_FORMAT = `{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"owner":{{json (index .Config.Labels "${OWNER_LABEL}")}},"state":{{json .State}}}`;

export interface ContainerReference {
	name: string;
	image: string;
}

export interface ContainerExecution extends ContainerReference {
	id?: string;
	exitCode?: number;
	clean: boolean;
	status: "not-run" | "passed" | "failed" | "cancelled" | "timeout" | "unknown";
}

export interface ContainerScope {
	workspace: WorkspaceIdentity;
	image: string;
	readPaths: readonly string[];
	writePaths: readonly string[];
	protectedPaths: readonly string[];
	beforeCreate: (reference: ContainerReference) => Promise<void>;
}

function within(root: string, target: string) {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function dockerClient(workspace: string) {
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.resolve(directory, "docker");
		try { await access(candidate, constants.X_OK); }
		catch (error) {
			if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
			throw error;
		}
		const file = await realpath(candidate);
		if (within(workspace, file) || !(await lstat(file)).isFile()) throw new Error("Docker 客户端必须是工作区外的已安装可执行文件，不能执行项目内同名脚本");
		return file;
	}
	throw new Error("没有可用的本地 Docker 客户端");
}

function docker(config: string, executable: string) {
	const args = ["--config", config, "--host", HOST];
	const env = { PATH: process.env.PATH, HOME: config, DOCKER_CONFIG: config };
	const run = (command: string[], onData: (data: Buffer, stderr: boolean) => void, timeout: number) => {
		// 固定实际文件，但保留 Docker 调用身份，支持以 argv[0] 分派的已安装客户端。
		const child = spawn(executable, [...args, ...command], { argv0: "docker", env, stdio: ["ignore", "pipe", "pipe"] });
		return new Promise<void>((resolve, reject) => {
			let failure: unknown;
			const data = (chunk: Buffer, stderr: boolean) => {
				if (failure) return;
				try { onData(chunk, stderr); }
				catch (error) { failure = error; child.kill("SIGTERM"); }
			};
			child.stdout.on("data", (chunk: Buffer) => data(chunk, false));
			child.stderr.on("data", (chunk: Buffer) => data(chunk, true));
			const timer = setTimeout(() => { failure ??= new Error(`Docker ${command[0]} 客户端等待超时`); child.kill("SIGKILL"); }, timeout);
			child.on("error", (error) => { failure ??= error; });
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				if (failure) reject(failure);
				else if (code === 0 && !signal) resolve();
				else reject(new Error(`Docker ${command[0]} 客户端未正常结束：${code}/${signal}`));
			});
		});
	};
	return {
		async request(command: string[]) {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let bytes = 0;
			try {
				await run(command, (chunk, isError) => {
					bytes += chunk.length;
					if (bytes > 1024 * 1024) throw new Error("Docker 请求输出超过 1 MiB");
					(isError ? stderr : stdout).push(chunk);
				}, 15_000);
			} catch (error) { throw new Error(`${String(error)}\n${Buffer.concat(stderr).toString("utf8")}`.trim(), { cause: error }); }
			return Buffer.concat(stdout).toString("utf8").trim();
		},
		follow(command: string[], onData: (data: Buffer) => void, timeout: number) {
			return run(command, onData, timeout);
		},
	};
}

export async function resolveContainerImage(image: string, workspace: string): Promise<string> {
	const executable = await dockerClient(workspace);
	const config = await mkdtemp(path.join(os.tmpdir(), "adaptive-docker-config-"));
	try {
		const result = JSON.parse(await docker(config, executable).request(["image", "inspect", "--format", IMAGE_FORMAT, "--", image]));
		if (!/^sha256:[a-f0-9]{64}$/.test(result.id) || result.os !== "linux" || result.volumes && Object.keys(result.volumes).length) {
			throw new Error("隔离命令要求明确的本地 Linux 镜像，不能包含隐式 VOLUME");
		}
		return result.id;
	} finally { await rm(config, { recursive: true }); }
}

export async function containerMounts(scope: Pick<ContainerScope, "workspace" | "readPaths" | "writePaths" | "protectedPaths">, signal?: AbortSignal,
	onEntry?: (file: string, info: Stats) => Promise<void>) {
	const { workspacePath: root, cwdPath: cwd } = scope.workspace;
	if (await realpath(root) !== root || !within(root, cwd)) throw new Error("容器工作区路径已变化");
	const protectedPaths = [path.join(root, ".git"), ...scope.protectedPaths];
	const mounts = new Map<string, boolean>();
	for (const file of scope.readPaths) mounts.set(path.resolve(cwd, file), true);
	for (const file of scope.writePaths) mounts.set(path.resolve(cwd, file), false);
	async function inspect(file: string): Promise<void> {
		signal?.throwIfAborted();
		const info = await lstat(file);
		if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("容器挂载路径含链接或非独立普通文件");
		await onEntry?.(file, info);
		if (info.isDirectory()) for (const name of await readdir(file)) await inspect(path.join(file, name));
	}
	for (const file of mounts.keys()) {
		signal?.throwIfAborted();
		if (file === root || !within(root, file)) throw new Error("容器仅挂载明确的 worktree 内输入，不挂载整个工作区或外部路径");
		if (protectedPaths.some((target) => within(target, file) || within(file, target))) throw new Error("容器挂载涉及规划文档、执行记录或 Git 等受保护路径");
		for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) {
			if (!(await lstat(parent)).isDirectory()) throw new Error("容器挂载的祖先不是普通目录");
		}
	}
	for (const file of mounts.keys()) if (![...mounts.keys()].some((other) => other !== file && within(other, file))) await inspect(file);
	return [...mounts].sort(([a], [b]) => a.length - b.length).map(([source, readonly]) => ({ source,
		target: path.posix.join("/workspace", path.relative(root, source).split(path.sep).join("/")), readonly }));
}

// Docker 负责 PID namespace 和挂载隔离；本模块只管理一次命令，不管理 Agent 或后台服务。
export function createContainerOperations(scope: ContainerScope) {
	let active = false;
	let cleanupFailed = false;
	let lastExecution: ContainerExecution | undefined;
	const operations: BashOperations = { exec: async (command, cwd, { onData, signal, timeout = 300 }) => {
		if (active || cleanupFailed) throw new Error("容器命令尚未收尾或状态未知，未开始新执行");
		signal?.throwIfAborted();
		if (cwd !== scope.workspace.cwdPath || !/^sha256:[a-f0-9]{64}$/.test(scope.image)) throw new Error("容器工作目录或固定镜像身份未核实");
		if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) throw new Error("容器命令 timeout 必须大于 0 且不超过 300 秒");
		const uid = process.getuid?.();
		const gid = process.getgid?.();
		if (!uid || gid === undefined) throw new Error("容器命令要求非 root 的本地 Unix 用户");
		active = true;
		const execution = lastExecution = { name: `pi-adaptive-${randomUUID()}`, image: scope.image, clean: false, status: "not-run" } as ContainerExecution;
		let config: string | undefined;
		let attempted = false;
		let problem: unknown;
		let stopping: Promise<void> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		let stop: (() => void) | undefined;
		try {
			const mounts = await containerMounts(scope, signal);
			const executable = await dockerClient(scope.workspace.workspacePath);
			await scope.beforeCreate({ name: execution.name, image: execution.image });
			signal?.throwIfAborted();
			config = await mkdtemp(path.join(os.tmpdir(), "adaptive-docker-config-"));
			const cli = docker(config, executable);
			// --mount 使用 CSV，而不是 Shell 转义；字段整体引用可保留逗号和双引号路径。
			const mountArgs = mounts.flatMap((mount) => ["--mount", ["type=bind", `src=${mount.source}`, `target=${mount.target}`,
				"bind-recursive=disabled", ...(mount.readonly ? ["readonly"] : [])].map((field) => `"${field.replaceAll('"', '""')}"`).join(",")]);
			attempted = true;
			execution.status = "unknown";
			execution.id = await cli.request(["create", "--pull", "never", "--name", execution.name, "--label", `${OWNER_LABEL}=${execution.name}`,
				"--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${uid}:${gid}`,
				"--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
				"--init", "--pids-limit", "128", "--memory", "512m", "--memory-swap", "512m", "--cpus", "2", "--no-healthcheck", "--restart", "no",
				"--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--env", "HOME=/tmp", "--workdir",
				path.posix.join("/workspace", path.relative(scope.workspace.workspacePath, cwd).split(path.sep).join("/")),
				...mountArgs, "--entrypoint", "/bin/sh", scope.image, "-c", command]);
			if (!/^[a-f0-9]{64}$/.test(execution.id)) throw new Error("Docker 创建返回的容器 ID 无效");
			const inspect = async () => {
				const data = JSON.parse(await cli.request(["inspect", "--format", STATE_FORMAT, execution.id!]));
				if (data.id !== execution.id || data.name !== `/${execution.name}` || data.image !== scope.image || data.owner !== execution.name) throw new Error("Docker 容器身份不符");
				return data.state as { Status: string; Running: boolean; Pid: number; ExitCode: number; Dead: boolean; OOMKilled: boolean; Error: string };
			};
			try {
				const initial = await inspect();
				if (initial.Status !== "created" || initial.Running !== false || initial.Pid !== 0) throw new Error("新建容器已有不明执行");
				signal?.throwIfAborted();
				// 启动请求完成前不发停止请求，避免停止 created 容器后迟到的 start 再次开始执行。
				await cli.request(["start", execution.id]);
				stop = () => { stopping ??= cli.request(["stop", "--time", "1", execution.id!]).then(() => {}, (error) => { problem ??= error; }); };
				signal?.addEventListener("abort", stop, { once: true });
				if (signal?.aborted) stop();
				timer = setTimeout(() => { timedOut = true; stop!(); }, timeout * 1000);
				const clients = await Promise.allSettled([
					cli.follow(["wait", execution.id], () => {}, (timeout + 20) * 1000),
					cli.follow(["logs", "--follow", execution.id], onData, (timeout + 20) * 1000),
				].map((client) => client.catch((error) => { stop!(); throw error; })));
				const failures = clients.filter((client) => client.status === "rejected").map((client) => client.reason);
				if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
			} catch (error) { problem ??= error; }
			clearTimeout(timer);
			if (stop) signal?.removeEventListener("abort", stop);
			await stopping;
			const terminal = await inspect();
			if (terminal.Running !== false || terminal.Pid !== 0 || terminal.Dead !== false || !["exited", "created"].includes(terminal.Status)
				|| typeof terminal.Error !== "string" || typeof terminal.OOMKilled !== "boolean"
				|| terminal.Status === "exited" && (!Number.isInteger(terminal.ExitCode) || terminal.ExitCode < 0)) throw new Error("Docker 容器实际执行终态未知");
			execution.exitCode = terminal.Status === "exited" ? terminal.ExitCode : undefined;
			if (terminal.Error || terminal.OOMKilled) problem ??= new Error(`容器执行失败：${terminal.Error || "OOMKilled"}`);
			if (await cli.request(["rm", "--volumes", execution.id]) !== execution.id) throw new Error("Docker 未确认删除本次容器");
			execution.clean = true;
			execution.status = signal?.aborted ? "cancelled" : timedOut ? "timeout" : execution.exitCode === undefined ? "not-run"
				: problem || execution.exitCode !== 0 ? "failed" : "passed";
			if (signal?.aborted) throw signal.reason ?? new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			if (problem) throw problem;
			if (execution.exitCode === undefined) throw new Error("容器命令没有实际退出码");
			return { exitCode: execution.exitCode };
		} catch (error) {
			if (attempted && !execution.clean) cleanupFailed = true;
			throw new Error(`隔离命令未成功 [${execution.name}]：${String(error)}`, { cause: error });
		} finally {
			clearTimeout(timer);
			if (stop) signal?.removeEventListener("abort", stop);
			if (config) await rm(config, { recursive: true });
			active = false;
		}
	} };
	return { operations, get cleanupFailed() { return cleanupFailed; }, get lastExecution() { return lastExecution ? structuredClone(lastExecution) : undefined; } };
}
