import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_TOKEN_KEY = Symbol.for("pi-adaptive-delivery.process-owner-token.v1");

export const WRITER_LEASE_VERSION = 1 as const;

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
	missionId?: string;
	runId?: string;
}

export interface WriterLeaseRecord {
	version: typeof WRITER_LEASE_VERSION;
	leaseId: string;
	workspace: WorkspaceIdentity;
	owner: WriterLeaseOwner;
	phase: "provisional" | "bound";
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

export type ReleaseWriterLeaseProof =
	| { kind: "parent-owner"; processToken: string }
	| { kind: "process-terminal"; runId: string; observed: true };

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
		({ stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: cwdPath }));
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
	if (input.missionId !== undefined && (typeof input.missionId !== "string" || !input.missionId)) return undefined;
	if (input.runId !== undefined && (typeof input.runId !== "string" || !input.runId)) return undefined;
	return {
		kind: input.kind,
		sessionId: input.sessionId,
		pid: input.pid,
		processToken: input.processToken,
		...(typeof input.missionId === "string" ? { missionId: input.missionId } : {}),
		...(typeof input.runId === "string" ? { runId: input.runId } : {}),
	};
}

export function parseWriterLeaseRecord(value: unknown): WriterLeaseRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (input.version !== WRITER_LEASE_VERSION || typeof input.leaseId !== "string" || !input.leaseId) return undefined;
	if (input.phase !== "provisional" && input.phase !== "bound") return undefined;
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
		phase: input.phase,
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
		try {
			return await operation();
		} finally {
			try {
				const owner = await readFile(path.join(lockPath, "owner"), "utf8");
				if (owner === token) await rm(lockPath, { recursive: true, force: true });
			} catch {
				// An unknown lock owner must not be removed by this operation.
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

	async acquire(
		workspace: WorkspaceIdentity,
		owner: Omit<WriterLeaseOwner, "processToken">,
		now: Date = new Date(),
	): Promise<AcquireWriterLeaseResult> {
		return this.withOperationLock(workspace.key, async () => {
		const record: WriterLeaseRecord = {
			version: WRITER_LEASE_VERSION,
			leaseId: randomUUID(),
			workspace,
			owner: { ...owner, processToken: this.token },
			phase: owner.runId ? "bound" : "provisional",
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

	async bind(
		reference: WriterLeaseReference,
		binding: { missionId?: string; runId: string; pid?: number },
		now: Date = new Date(),
	): Promise<WriterLeaseRecord> {
		return this.withOperationLock(reference.workspaceKey, async () => {
		const current = await this.assertOwned(reference);
		const next: WriterLeaseRecord = {
			...current,
			owner: {
				...current.owner,
				kind: "child",
				pid: binding.pid ?? current.owner.pid,
				...(binding.missionId ? { missionId: binding.missionId } : {}),
				runId: binding.runId,
			},
			phase: "bound",
			updatedAt: now.toISOString(),
		};
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

	async release(reference: WriterLeaseReference, proof: ReleaseWriterLeaseProof): Promise<void> {
		await this.withOperationLock(reference.workspaceKey, async () => {
		const current = await this.assertOwned(reference);
		if (current.owner.kind === "parent") {
			if (proof.kind !== "parent-owner" || proof.processToken !== this.token) {
				throw new Error("Parent writer lease requires the current process owner proof");
			}
		} else {
			if (
				proof.kind !== "process-terminal" ||
				proof.observed !== true ||
				!current.owner.runId ||
				proof.runId !== current.owner.runId
			) {
				throw new Error("Child writer lease requires matching observed process-terminal proof");
			}
		}
		await unlink(this.leasePath(reference.workspaceKey));
		});
	}

	async forceRelease(workspaceKey: string, expectedLeaseId: string): Promise<WriterLeaseRecord | undefined> {
			return this.withOperationLock(workspaceKey, async () => {
				const current = await this.read(workspaceKey);
				if (!current) return undefined;
				if (current.leaseId !== expectedLeaseId) throw new Error("Writer lease owner changed after confirmation");
				await unlink(this.leasePath(workspaceKey));
				return current;
			});
		}
}
