import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_TOKEN_KEY = Symbol.for("pi-adaptive-delivery.process-owner-token.v1");
const gitEnvironment = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" };

export const WRITER_LEASE_VERSION = 2 as const;
export const GIT_STATUS_TOOL = "delivery_git_status";

export interface WorkspaceIdentity {
	key: string;
	cwdPath: string;
	workspacePath: string;
	gitRoot: string;
}

export interface WriterLeaseOwner {
	kind: "parent" | "child";
	sessionId: string;
	pid: number;
	processToken: string;
	runId?: string;
}

export interface WriterLeaseRecord {
	version: typeof WRITER_LEASE_VERSION;
	leaseId: string;
	workspace: WorkspaceIdentity;
	owner: WriterLeaseOwner;
	coordinator?: WriterLeaseOwner;
	createdAt: string;
	updatedAt: string;
}

export interface WriterLeaseReference {
	version: typeof WRITER_LEASE_VERSION;
	leaseId: string;
	workspaceKey: string;
}

export type AcquireWriterLeaseResult =
	| { ok: true; record: WriterLeaseRecord; reference: WriterLeaseReference }
	| { ok: false; reason: string; existing?: WriterLeaseRecord };

function processOwnerToken(): string {
	const store = globalThis as typeof globalThis & { [PROCESS_TOKEN_KEY]?: string };
	if (!store[PROCESS_TOKEN_KEY]) store[PROCESS_TOKEN_KEY] = randomUUID();
	return store[PROCESS_TOKEN_KEY];
}

function stableWorkspaceKey(workspacePath: string, gitRoot: string): string {
	return createHash("sha256").update(JSON.stringify({ gitRoot, workspacePath })).digest("hex");
}

export async function resolveWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
	const cwdPath = await realpath(cwd);
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("/usr/bin/git", ["rev-parse", "--show-toplevel"], { cwd: cwdPath, env: gitEnvironment, timeout: 15_000 }));
	} catch (error) {
		throw new Error(`Writer lease requires a Git repository: ${error instanceof Error ? error.message : String(error)}`);
	}
	const gitRoot = await realpath(stdout.trim());
	return {
		key: stableWorkspaceKey(gitRoot, gitRoot),
		cwdPath,
		workspacePath: gitRoot,
		gitRoot,
	};
}

export async function getWriterStateRoot(workspace: WorkspaceIdentity): Promise<string> {
	const { stdout } = await execFileAsync("/usr/bin/git", ["rev-parse", "--absolute-git-dir"], { cwd: workspace.workspacePath, env: gitEnvironment, timeout: 15_000 });
	return path.join(await realpath(stdout.trim()), "pi-adaptive-delivery");
}

export async function readGitStatus(cwd: string, signal?: AbortSignal) {
	const workspace = await resolveWorkspaceIdentity(cwd);
	// Git status 比较内容时也会运行 clean/process；在同次固定查询中禁用已配置过滤器。
	let filters = "";
	try {
		({ stdout: filters } = await execFileAsync("/usr/bin/git", ["config", "--includes", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], {
			cwd: workspace.workspacePath, env: gitEnvironment, signal, timeout: 15_000, maxBuffer: 50 * 1024,
		}));
	} catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
	const overrides = [...new Set(filters.split("\0").filter(Boolean))].flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
	const { stdout } = await execFileAsync("/usr/bin/git", ["--no-optional-locks", "--no-replace-objects", "--no-pager",
		"-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.excludesFile=/dev/null",
		...overrides, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"], {
		cwd: workspace.workspacePath, signal, timeout: 15_000, maxBuffer: 50 * 1024,
		env: gitEnvironment, encoding: "buffer",
	});
	const text = stdout.toString("utf8");
	if (!Buffer.from(text).equals(stdout)) throw new Error("Git 状态路径无法无损表示为 UTF-8，未返回不完整清单");
	const rows = text.split("\0").filter(Boolean);
	let head: string | null | undefined;
	let branch: string | null | undefined;
	const changes: { status: string; path: string; originalPath?: string; submodule?: string }[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (row.startsWith("# branch.oid ")) head = row.slice(13) === "(initial)" ? null : row.slice(13);
		else if (row.startsWith("# branch.head ")) branch = row.slice(14) === "(detached)" ? null : row.slice(14);
		else if (row.startsWith("# ")) continue;
		else if (row.startsWith("? ")) changes.push({ status: "??", path: row.slice(2) });
		else {
			const fields = row.split(" ");
			const prefix = fields[0] === "1" ? 8 : fields[0] === "2" ? 9 : fields[0] === "u" ? 10 : 0;
			if (!prefix || fields.length <= prefix) throw new Error("Git 状态记录无法解析，未返回不完整清单");
			const originalPath = fields[0] === "2" ? rows[++i] : undefined;
			if (fields[0] === "2" && !originalPath) throw new Error("Git 重命名原路径缺失");
			changes.push({ status: fields[1]!, path: fields.slice(prefix).join(" "), submodule: fields[2], ...(originalPath ? { originalPath } : {}) });
		}
	}
	if (head === undefined || branch === undefined) throw new Error("Git 分支或 HEAD 未取得，未猜测工作区状态");
	return { workspace: workspace.workspacePath, head, branch, changes, submodules: "仅报告提交指针变化；子模块内部改动需在其工作区另查" };
}

function referenceFor(record: WriterLeaseRecord): WriterLeaseReference {
	return {
		version: WRITER_LEASE_VERSION,
		leaseId: record.leaseId,
		workspaceKey: record.workspace.key,
	};
}

function parseOwner(value: unknown): WriterLeaseOwner | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (
		(input.kind !== "parent" && input.kind !== "child") ||
		typeof input.sessionId !== "string" ||
		!input.sessionId ||
		typeof input.pid !== "number" ||
		!Number.isInteger(input.pid) ||
		input.pid <= 0 ||
		typeof input.processToken !== "string" ||
		!input.processToken
	) {
		return undefined;
	}
	if (input.runId !== undefined && (typeof input.runId !== "string" || !input.runId)) return undefined;
	return {
		kind: input.kind,
		sessionId: input.sessionId,
		pid: input.pid,
		processToken: input.processToken,
		...(typeof input.runId === "string" ? { runId: input.runId } : {}),
	};
}

export function parseWriterLeaseRecord(value: unknown): WriterLeaseRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (input.version !== WRITER_LEASE_VERSION || typeof input.leaseId !== "string" || !input.leaseId) return undefined;
	if (!input.workspace || typeof input.workspace !== "object") return undefined;
	const workspace = input.workspace as Record<string, unknown>;
		if (
			typeof workspace.key !== "string" ||
			!/^[a-f0-9]{64}$/.test(workspace.key) ||
			typeof workspace.cwdPath !== "string" ||
			!path.isAbsolute(workspace.cwdPath) ||
			typeof workspace.workspacePath !== "string" ||
		!path.isAbsolute(workspace.workspacePath) ||
		typeof workspace.gitRoot !== "string" ||
		!path.isAbsolute(workspace.gitRoot)
	) {
		return undefined;
	}
	const owner = parseOwner(input.owner);
	if (!owner || typeof input.createdAt !== "string" || typeof input.updatedAt !== "string") return undefined;
	const coordinator = input.coordinator === undefined ? undefined : parseOwner(input.coordinator);
	if (owner.kind === "child" ? !coordinator || !validTransfer(coordinator, owner) : input.coordinator !== undefined) return undefined;
	if (Number.isNaN(Date.parse(input.createdAt)) || Number.isNaN(Date.parse(input.updatedAt))) return undefined;
	return {
		version: WRITER_LEASE_VERSION,
		leaseId: input.leaseId,
		workspace: {
			key: workspace.key,
			cwdPath: workspace.cwdPath,
			workspacePath: workspace.workspacePath,
			gitRoot: workspace.gitRoot,
		},
		owner,
		...(coordinator ? { coordinator } : {}),
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
	};
}

export function parseWriterLeaseReference(value: unknown): WriterLeaseReference | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (
		input.version !== WRITER_LEASE_VERSION ||
		typeof input.leaseId !== "string" ||
		!input.leaseId ||
		typeof input.workspaceKey !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.workspaceKey)
	) {
		return undefined;
	}
	return { version: WRITER_LEASE_VERSION, leaseId: input.leaseId, workspaceKey: input.workspaceKey };
}

function validTransfer(parent: WriterLeaseOwner, child: WriterLeaseOwner): boolean {
	return parent.kind === "parent" && child.kind === "child" && Boolean(parent.runId) && parent.runId === child.runId
		&& parent.sessionId !== child.sessionId && parent.pid !== child.pid && parent.processToken !== child.processToken;
}

export class WriterLeaseManager {
	private readonly leasesDir: string;
	private readonly token: string;

	constructor(stateRoot: string) {
		this.leasesDir = path.join(stateRoot, "leases");
		this.token = processOwnerToken();
	}

	get processToken(): string {
		return this.token;
	}

	private leasePath(workspaceKey: string): string {
		return path.join(this.leasesDir, `${workspaceKey}.json`);
	}

	private operationLockPath(workspaceKey: string): string {
		return path.join(this.leasesDir, `${workspaceKey}.operation-lock`);
	}

	private async withOperationLock<T>(
		workspaceKey: string,
		operation: () => Promise<T>,
	): Promise<T> {
		await mkdir(this.leasesDir, { recursive: true, mode: 0o700 });
		const lockPath = this.operationLockPath(workspaceKey);
		const token = randomUUID();
		let acquired = false;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				await mkdir(lockPath, { mode: 0o700 });
				await open(path.join(lockPath, "owner"), "wx", 0o600).then(async (handle) => {
					try {
						await handle.writeFile(token, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
				});
				acquired = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		if (!acquired) throw new Error("Writer lease operation lock is held or stale");
		let failure: { cause: unknown } | undefined;
		try {
			return await operation();
		} catch (cause) {
			failure = { cause };
			throw cause;
		} finally {
			try {
				const owner = await readFile(path.join(lockPath, "owner"), "utf8");
				if (owner !== token) throw new Error("Writer lease operation lock owner changed; lock retained");
				await rm(lockPath, { recursive: true });
			} catch (error) {
				if (failure) throw new AggregateError([failure.cause, error], "Writer lease operation and lock cleanup both failed");
				throw error;
			}
		}
	}

	async read(workspaceKey: string): Promise<WriterLeaseRecord | undefined> {
		try {
			const source = await readFile(this.leasePath(workspaceKey), "utf8");
			const parsed = parseWriterLeaseRecord(JSON.parse(source));
			if (!parsed) throw new Error("Writer lease record is malformed");
			if (
				parsed.workspace.key !== workspaceKey ||
				stableWorkspaceKey(parsed.workspace.workspacePath, parsed.workspace.gitRoot) !== workspaceKey
			) {
				throw new Error("Writer lease workspace identity is inconsistent");
			}
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async assertIdle(workspaceKey: string): Promise<void> {
		if (await this.read(workspaceKey)) throw new Error("现场有未交回的 writer；核实原执行前保持受控，不自动解锁。");
		try { await lstat(this.operationLockPath(workspaceKey)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		throw new Error("writer 操作锁仍在，收尾尚未核实；不自动解锁。");
	}

	async acquire(
		workspace: WorkspaceIdentity,
		owner: Omit<WriterLeaseOwner, "processToken" | "kind"> & { kind: "parent" },
		now: Date = new Date(),
	): Promise<AcquireWriterLeaseResult> {
		return this.withOperationLock(workspace.key, async () => {
		const record: WriterLeaseRecord = {
			version: WRITER_LEASE_VERSION,
			leaseId: randomUUID(),
			workspace,
			owner: { ...owner, processToken: this.token },
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
		};
		const target = this.leasePath(workspace.key);
		try {
			const handle = await open(target, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			return { ok: true, record, reference: referenceFor(record) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const existing = await this.read(workspace.key);
				return { ok: false, reason: "Writer lease is already held", ...(existing ? { existing } : {}) };
			} catch (readError) {
				return {
					ok: false,
					reason: `Writer lease exists but cannot be verified: ${readError instanceof Error ? readError.message : String(readError)}`,
				};
			}
		}
		});
	}

	async handoff(reference: WriterLeaseReference, parent: WriterLeaseOwner, child: WriterLeaseOwner,
		verifyReady: () => Promise<void>, signal: AbortSignal): Promise<WriterLeaseRecord> {
		const expected = structuredClone(parent);
		const destination = parseOwner(structuredClone(child));
		if (!destination || !validTransfer(expected, destination)) throw new Error("父子 writer 的独立进程、Session 或执行绑定无效");
		return this.withOperationLock(reference.workspaceKey, async () => {
			const current = await this.assertOwned(reference);
			if (current.owner.kind !== "parent" || !isDeepStrictEqual(current.owner, expected)) throw new Error("父 writer 归属已变化，未交接");
			await verifyReady();
			signal.throwIfAborted();
			const next: WriterLeaseRecord = { ...current, owner: destination, coordinator: expected, updatedAt: new Date().toISOString() };
			await this.atomicReplace(reference.workspaceKey, next);
			return next;
		});
	}

	async isCurrentOwner(reference: WriterLeaseReference): Promise<boolean> {
		try {
			await this.assertOwned(reference);
			return true;
		} catch {
			return false;
		}
	}

	private async assertOwned(reference: WriterLeaseReference): Promise<WriterLeaseRecord> {
		const current = await this.read(reference.workspaceKey);
		if (!current || current.leaseId !== reference.leaseId) throw new Error("Writer lease identity does not match");
		if (current.owner.processToken !== this.token) throw new Error("Writer lease belongs to a different process owner");
		return current;
	}

	private async atomicReplace(workspaceKey: string, record: WriterLeaseRecord): Promise<void> {
		await mkdir(this.leasesDir, { recursive: true, mode: 0o700 });
		const temporary = path.join(this.leasesDir, `.${workspaceKey}.${randomUUID()}.tmp`);
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, this.leasePath(workspaceKey));
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	// 在同一 lease 操作锁内核对原 owner 和原生终态；等待锁期间取得的旧证明不能用于释放。
	async releaseParent(reference: WriterLeaseReference, owner: WriterLeaseOwner,
		verifyTerminal: () => Promise<void>, signal: AbortSignal): Promise<void> {
		await this.withOperationLock(reference.workspaceKey, async () => {
			const current = await this.assertOwned(reference);
			if (current.owner.kind !== "parent" || !isDeepStrictEqual(current.owner, owner)) {
				throw new Error("父 writer 的会话或执行归属已变化，未释放 lease");
			}
			await verifyTerminal();
			signal.throwIfAborted();
			await unlink(this.leasePath(reference.workspaceKey));
		});
	}

	async releaseChild(reference: WriterLeaseReference, owner: WriterLeaseOwner, coordinator: WriterLeaseOwner,
		verifyTerminal: () => Promise<void>, signal: AbortSignal): Promise<void> {
		await this.withOperationLock(reference.workspaceKey, async () => {
			const current = await this.read(reference.workspaceKey);
			if (!current || current.leaseId !== reference.leaseId || current.owner.kind !== "child"
				|| current.coordinator?.processToken !== this.token || !isDeepStrictEqual(current.coordinator, coordinator)
				|| !isDeepStrictEqual(current.owner, owner)) {
				throw new Error("子 writer 或父协调归属已变化，未释放 lease");
			}
			await verifyTerminal();
			signal.throwIfAborted();
			await unlink(this.leasePath(reference.workspaceKey));
		});
	}
}
