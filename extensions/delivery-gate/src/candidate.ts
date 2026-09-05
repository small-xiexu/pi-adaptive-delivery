import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import type { ApprovalRecord } from "./approvals.ts";
import { digestApprovalContent } from "./approvals.ts";
import { pathIsInside } from "./subagents.ts";
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from "./workspace.ts";

export const CANDIDATE_MANIFEST_VERSION = 3 as const;

export type CandidateFileMode = "100644" | "100755" | "120000";

export interface CandidateFileDigest {
	path: string;
	type: "file" | "symlink";
	mode: CandidateFileMode;
	size: number;
	digest: string;
}

export interface CandidateManifest {
	version: typeof CANDIDATE_MANIFEST_VERSION;
	workspace: WorkspaceIdentity;
	head: string | "UNBORN";
	indexDiffDigest: string;
	trackedDiffDigest: string;
	untracked: CandidateFileDigest[];
	submoduleDigest: string;
	approvalDigest: string;
	controlPlaneExclusions: string[];
}

export interface CandidateSnapshot {
	digest: string;
	manifest: CandidateManifest;
}

export interface CandidateOptions {
	cwd: string;
	approvals?: Partial<Record<"solution" | "plan" | "combined", ApprovalRecord>>;
	progressPaths?: readonly string[];
}

export interface ProgressArtifactSnapshot {
	path: string;
	type: "file" | "symlink";
	size: number;
	digest: string;
	dev: number;
	ino: number;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function runGit(cwd: string, args: string[], allowFailure = false): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error && !allowFailure) {
				reject(new Error(`git ${args.join(" ")} failed: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`));
				return;
			}
			resolve(Buffer.from(stdout));
		});
	});
}

function nulPaths(buffer: Buffer): string[] {
	return buffer
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right, "en"));
}

async function hashRegularFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

async function fileDigest(gitRoot: string, relativePath: string): Promise<CandidateFileDigest> {
	const absolute = path.join(gitRoot, relativePath);
	const stats = await lstat(absolute);
	if (stats.isSymbolicLink()) {
		const target = await readlink(absolute);
		return { path: relativePath, type: "symlink", mode: "120000", size: Buffer.byteLength(target), digest: sha256(target) };
	}
	if (!stats.isFile()) throw new Error(`Unsupported untracked candidate path type: ${relativePath}`);
	return {
		path: relativePath,
		type: "file",
		mode: (stats.mode & 0o111) === 0 ? "100644" : "100755",
		size: stats.size,
		digest: await hashRegularFile(absolute),
	};
}

async function canonicalProgressPaths(identity: WorkspaceIdentity, paths: readonly string[]): Promise<string[]> {
	const result: string[] = [];
	for (const raw of paths) {
		if (!raw || path.isAbsolute(raw)) throw new Error(`Progress path must be relative to Git root: ${raw}`);
		const normalized = path.normalize(raw);
		if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
			throw new Error(`Progress path escapes Git root: ${raw}`);
		}
		const absolute = path.join(identity.gitRoot, normalized);
		if (!pathIsInside(identity.gitRoot, absolute)) throw new Error(`Progress path escapes Git root: ${raw}`);
		let current = identity.gitRoot;
		const components = normalized.split(path.sep).filter(Boolean);
		for (let index = 0; index < components.length; index += 1) {
			current = path.join(current, components[index]!);
			let stats;
			try {
				stats = await lstat(current);
			} catch (error) {
				throw new Error(`Progress path must exist before candidate freeze: ${raw}; ${error instanceof Error ? error.message : String(error)}`);
			}
			if (stats.isSymbolicLink()) throw new Error(`Progress path contains a symlink component: ${raw}`);
			if (index === components.length - 1 && !stats.isFile()) {
				throw new Error(`Progress path must be a regular file: ${raw}`);
			}
		}
		result.push(normalized);
	}
	return [...new Set(result)].sort((left, right) => left.localeCompare(right, "en"));
}

function diffPathspec(exclusions: readonly string[]): string[] {
	return ["--", ".", ...exclusions.map((value) => `:(exclude,literal,top)${value}`)];
}

export async function createCandidateSnapshot(options: CandidateOptions): Promise<CandidateSnapshot> {
	const workspace = await resolveWorkspaceIdentity(options.cwd);
	const exclusions = await canonicalProgressPaths(workspace, options.progressPaths ?? []);
	const pathspec = diffPathspec(exclusions);
	const [headOutput, indexDiff, trackedDiff, untrackedOutput, submodules] = await Promise.all([
		runGit(workspace.workspacePath, ["rev-parse", "--verify", "HEAD"], true),
		runGit(workspace.workspacePath, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", ...pathspec]),
		runGit(workspace.workspacePath, ["diff", "--binary", "--no-ext-diff", "--no-textconv", ...pathspec]),
		runGit(workspace.workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
		runGit(workspace.workspacePath, ["submodule", "status", "--recursive"], true),
	]);
	const excluded = new Set(exclusions);
	const untrackedPaths = nulPaths(untrackedOutput).filter((value) => !excluded.has(value));
	const untracked = await Promise.all(untrackedPaths.map((value) => fileDigest(workspace.gitRoot, value)));
	const head = headOutput.toString("utf8").trim() || "UNBORN";
	const approvalDigest = digestApprovalContent(options.approvals ?? {});
	const manifest: CandidateManifest = {
		version: CANDIDATE_MANIFEST_VERSION,
		workspace,
		head,
		indexDiffDigest: sha256(indexDiff),
		trackedDiffDigest: sha256(trackedDiff),
		untracked,
		submoduleDigest: sha256(submodules),
		approvalDigest,
		controlPlaneExclusions: exclusions,
	};
	return { digest: digestApprovalContent(manifest), manifest };
}

export async function snapshotProgressArtifact(gitRoot: string, relativePath: string): Promise<ProgressArtifactSnapshot> {
	const root = await realpath(gitRoot);
	const paths = await canonicalProgressPaths(
		{ key: "", cwdPath: root, workspacePath: root, gitRoot: root },
		[relativePath],
	);
	const relative = paths[0]!;
	const absolute = path.join(root, relative);
	const before = await lstat(absolute);
	const digest = await fileDigest(root, relative);
	const after = await lstat(absolute);
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.mode !== after.mode ||
		before.size !== after.size
	) {
		throw new Error(`Progress artifact changed while it was being snapshotted: ${relative}`);
	}
	return { ...digest, dev: after.dev, ino: after.ino };
}
