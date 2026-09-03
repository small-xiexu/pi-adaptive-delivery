import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { ApprovalRecord } from "./approvals.ts";
import { createCandidateSnapshot, type CandidateSnapshot } from "./candidate.ts";
import type { TinyDeliveryContract } from "./tiny-contract.ts";
import { pathIsInside } from "./subagents.ts";
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from "./workspace.ts";

export const TINY_BASELINE_VERSION = 1 as const;
export const TINY_SCOPE_EVIDENCE_VERSION = 1 as const;

export interface TinyApprovalBaseline {
	version: typeof TINY_BASELINE_VERSION;
	workspace: WorkspaceIdentity;
	head: string | "UNBORN";
	branch: string;
	candidateDigest: string;
	approvalContentDigest: string;
	capturedAt: string;
}

export interface TinyScopeEvidence {
	version: typeof TINY_SCOPE_EVIDENCE_VERSION;
	baselineDigest: string;
	candidateDigest: string;
	changedPaths: string[];
	deltaDigest: string;
	verifiedAt: string;
}

interface DeltaEntry {
	status: " M" | "??";
	path: string;
}

const PROTECTED_BASENAMES = [
	/^package\.json$/,
	/^(?:package-lock|npm-shrinkwrap|pnpm-lock|yarn\.lock|bun\.lockb?)$/,
	/^tsconfig(?:\..+)?\.json$/,
	/^(?:cargo\.toml|cargo\.lock|go\.mod|go\.sum|go\.work)$/,
	/^(?:pyproject\.toml|poetry\.lock|uv\.lock|pipfile(?:\.lock)?)$/,
	/^requirements(?:[-_.].+)?\.txt$/,
	/^(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/,
	/^(?:dockerfile|docker-compose(?:\..+)?\.ya?ml)$/,
];
const PROTECTED_SEGMENTS = new Set([
	"auth",
	"api",
	"authentication",
	"authorization",
	"billing",
	"crypto",
	"deploy",
	"deployment",
	"migrations",
	"payment",
	"payments",
	"permissions",
	"production",
	"release",
	"schema",
	"schemas",
	"secrets",
	"tenant",
	"transactions",
]);

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function runGit(cwd: string, args: string[], allowExitOne = false): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error && !(allowExitOne && (error as NodeJS.ErrnoException & { code?: number }).code === 1)) {
				reject(new Error(`git ${args.join(" ")} failed: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`));
				return;
			}
			resolve(Buffer.from(stdout));
		});
	});
}

function sameWorkspace(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
	return left.key === right.key && left.cwdPath === right.cwdPath && left.workspacePath === right.workspacePath && left.gitRoot === right.gitRoot;
}

async function currentBranch(cwd: string): Promise<string> {
	const branch = (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)).toString("utf8").trim();
	return branch || "DETACHED";
}

async function porcelain(cwd: string): Promise<Buffer> {
	return runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
}

function parseDelta(buffer: Buffer): DeltaEntry[] {
	const fields = buffer.toString("utf8").split("\0").filter(Boolean);
	const entries: DeltaEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index]!;
		if (field.length < 4 || field[2] !== " ") throw new Error("Tiny workspace status is malformed");
		const status = field.slice(0, 2);
		const relativePath = field.slice(3);
		if (status.includes("R") || status.includes("C")) index += 1;
		if (status !== " M" && status !== "??") {
			throw new Error(`Tiny does not support staged, renamed, deleted, copied, conflicted, or type-changed delta: ${status} ${relativePath}`);
		}
		entries.push({ status, path: relativePath });
	}
	return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function protectedPath(relativePath: string): boolean {
	const lower = relativePath.toLowerCase();
	const components = lower.split("/");
	const basename = components.at(-1)!;
	const tokens = lower.split(/[/_.-]+/).filter(Boolean);
	return components.some((component) => PROTECTED_SEGMENTS.has(component)) ||
		tokens.some((token) => PROTECTED_SEGMENTS.has(token)) ||
		lower.startsWith(".github/workflows/") ||
		lower.startsWith(".gitlab/") ||
		PROTECTED_BASENAMES.some((pattern) => pattern.test(basename));
}

async function assertNoSymlinkComponents(gitRoot: string, relativePath: string, allowMissingTarget: boolean): Promise<void> {
	let current = gitRoot;
	const components = relativePath.split("/");
	for (let index = 0; index < components.length; index += 1) {
		current = path.join(current, components[index]!);
		let stats;
		try {
			stats = await lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingTarget && index === components.length - 1) return;
			throw new Error(`Tiny scope path cannot be proven: ${relativePath}`);
		}
		if (stats.isSymbolicLink()) throw new Error(`Tiny scope path contains a symlink: ${relativePath}`);
		if (index < components.length - 1 && !stats.isDirectory()) throw new Error(`Tiny scope parent is not a directory: ${relativePath}`);
		if (index === components.length - 1 && !stats.isFile()) throw new Error(`Tiny scope target is not a regular file: ${relativePath}`);
	}
}

async function assertNotIgnoredOrSubmodule(gitRoot: string, relativePath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		execFile("git", ["check-ignore", "--quiet", "--", relativePath], { cwd: gitRoot }, (error) => {
			if (!error) reject(new Error(`Tiny scope cannot contain an ignored path: ${relativePath}`));
			else if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) resolve();
			else reject(error);
		});
	});
	const components = relativePath.split("/");
	for (let length = 1; length <= components.length; length += 1) {
		const prefix = components.slice(0, length).join("/");
		const stage = (await runGit(gitRoot, ["ls-files", "--stage", "--", prefix])).toString("utf8");
		if (stage.split("\n").some((line) => line.startsWith("160000 "))) {
			throw new Error(`Tiny scope cannot contain a submodule path: ${relativePath}`);
		}
	}
}

async function assertScopeTarget(gitRoot: string, relativePath: string, allowMissingTarget = true): Promise<void> {
	if (protectedPath(relativePath)) throw new Error(`Tiny scope contains a protected or toolchain path: ${relativePath}`);
	await assertNoSymlinkComponents(gitRoot, relativePath, allowMissingTarget);
	await assertNotIgnoredOrSubmodule(gitRoot, relativePath);
}

function parseWorkspace(value: unknown): WorkspaceIdentity | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (["key", "cwdPath", "workspacePath", "gitRoot"].some((key) => typeof input[key] !== "string" || !input[key])) return undefined;
	return {
		key: input.key as string,
		cwdPath: input.cwdPath as string,
		workspacePath: input.workspacePath as string,
		gitRoot: input.gitRoot as string,
	};
}

export function parseTinyApprovalBaseline(value: unknown): TinyApprovalBaseline | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const workspace = parseWorkspace(input.workspace);
	if (
		input.version !== TINY_BASELINE_VERSION ||
		!workspace ||
		typeof input.head !== "string" || !input.head ||
		typeof input.branch !== "string" || !input.branch ||
		typeof input.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.candidateDigest) ||
		typeof input.approvalContentDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.approvalContentDigest) ||
		typeof input.capturedAt !== "string" || Number.isNaN(Date.parse(input.capturedAt))
	) return undefined;
	return {
		version: TINY_BASELINE_VERSION,
		workspace,
		head: input.head,
		branch: input.branch,
		candidateDigest: input.candidateDigest,
		approvalContentDigest: input.approvalContentDigest,
		capturedAt: input.capturedAt,
	};
}

export function parseTinyScopeEvidence(value: unknown): TinyScopeEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		input.version !== TINY_SCOPE_EVIDENCE_VERSION ||
		typeof input.baselineDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.baselineDigest) ||
		typeof input.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.candidateDigest) ||
		typeof input.deltaDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.deltaDigest) ||
		!Array.isArray(input.changedPaths) || input.changedPaths.length === 0 ||
		!input.changedPaths.every((item) => typeof item === "string" && item) ||
		new Set(input.changedPaths).size !== input.changedPaths.length ||
		typeof input.verifiedAt !== "string" || Number.isNaN(Date.parse(input.verifiedAt))
	) return undefined;
	return {
		version: TINY_SCOPE_EVIDENCE_VERSION,
		baselineDigest: input.baselineDigest,
		candidateDigest: input.candidateDigest,
		changedPaths: [...input.changedPaths] as string[],
		deltaDigest: input.deltaDigest,
		verifiedAt: input.verifiedAt,
	};
}

export async function captureTinyApprovalBaseline(input: {
	cwd: string;
	contract: TinyDeliveryContract;
	approval: ApprovalRecord;
	now?: Date;
}): Promise<TinyApprovalBaseline> {
	const identity = await resolveWorkspaceIdentity(input.cwd);
	for (const relativePath of input.contract.changeScope) await assertScopeTarget(identity.gitRoot, relativePath);
	const status = await porcelain(identity.workspacePath);
	if (status.length > 0) throw new Error("Tiny requires a clean workspace baseline; existing dirty changes must use Standard delivery");
	const candidate = await createCandidateSnapshot({ cwd: input.cwd, approvals: { combined: input.approval } });
	return {
		version: TINY_BASELINE_VERSION,
		workspace: identity,
		head: candidate.manifest.head,
		branch: await currentBranch(identity.workspacePath),
		candidateDigest: candidate.digest,
		approvalContentDigest: input.approval.contentDigest,
		capturedAt: (input.now ?? new Date()).toISOString(),
	};
}

async function inspectTinyDelta(input: {
	cwd: string;
	contract: TinyDeliveryContract;
	baseline: TinyApprovalBaseline;
	approval: ApprovalRecord;
	allowEmpty: boolean;
}): Promise<{ identity: WorkspaceIdentity; entries: DeltaEntry[] }> {
	const identity = await resolveWorkspaceIdentity(input.cwd);
	if (!sameWorkspace(identity, input.baseline.workspace)) throw new Error("Tiny workspace identity changed after approval");
	if (input.approval.contentDigest !== input.baseline.approvalContentDigest) throw new Error("Tiny approval changed after baseline capture");
	const head = (await runGit(identity.workspacePath, ["rev-parse", "--verify", "HEAD"], true)).toString("utf8").trim() || "UNBORN";
	if (head !== input.baseline.head) throw new Error("Tiny HEAD changed after approval");
	if (await currentBranch(identity.workspacePath) !== input.baseline.branch) throw new Error("Tiny branch changed after approval");
	const entries = parseDelta(await porcelain(identity.workspacePath));
	if (!input.allowEmpty && entries.length === 0) throw new Error("Tiny candidate has no task delta");
	const scope = new Set(input.contract.changeScope);
	for (const entry of entries) {
		if (!scope.has(entry.path)) throw new Error(`Tiny workspace delta escaped approved scope: ${entry.path}`);
		await assertScopeTarget(identity.gitRoot, entry.path, false);
	}
	return { identity, entries };
}

export async function assertTinyAuthorizationCurrent(input: {
	cwd: string;
	contract: TinyDeliveryContract;
	baseline: TinyApprovalBaseline;
	approval: ApprovalRecord;
}): Promise<void> {
	await inspectTinyDelta({ ...input, allowEmpty: true });
}

export async function freezeTinyCandidate(input: {
	cwd: string;
	contract: TinyDeliveryContract;
	baseline: TinyApprovalBaseline;
	approval: ApprovalRecord;
	approvals: { combined: ApprovalRecord };
	now?: Date;
}): Promise<{ candidate: CandidateSnapshot; evidence: TinyScopeEvidence }> {
	const before = await inspectTinyDelta({ ...input, allowEmpty: false });
	const candidate = await createCandidateSnapshot({ cwd: input.cwd, approvals: input.approvals });
	const after = await inspectTinyDelta({ ...input, allowEmpty: false });
	const beforeDigest = sha256(JSON.stringify(before.entries));
	const afterDigest = sha256(JSON.stringify(after.entries));
	if (beforeDigest !== afterDigest) throw new Error("Tiny workspace delta changed during candidate freeze");
	return {
		candidate,
		evidence: {
			version: TINY_SCOPE_EVIDENCE_VERSION,
			baselineDigest: input.baseline.candidateDigest,
			candidateDigest: candidate.digest,
			changedPaths: after.entries.map((entry) => entry.path),
			deltaDigest: afterDigest,
			verifiedAt: (input.now ?? new Date()).toISOString(),
		},
	};
}

export async function assertTinyWritePath(input: {
	cwd: string;
	gitRoot: string;
	changeScope: readonly string[];
	toolPath: unknown;
}): Promise<string> {
	if (typeof input.toolPath !== "string" || !input.toolPath.trim() || input.toolPath.includes("\0")) {
		throw new Error("Tiny write tool path is missing or malformed");
	}
	const root = await realpath(input.gitRoot);
	const absolute = path.resolve(await realpath(input.cwd), input.toolPath);
	if (!pathIsInside(root, absolute) || absolute === root) throw new Error("Tiny write path escapes the Git root");
	const relative = path.relative(root, absolute).split(path.sep).join("/");
	if (!input.changeScope.includes(relative)) throw new Error(`Tiny write path is outside approved scope: ${relative}`);
	await assertScopeTarget(root, relative);
	return relative;
}
