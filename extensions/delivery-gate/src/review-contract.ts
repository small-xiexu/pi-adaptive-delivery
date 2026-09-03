import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import { resolveWorkspaceIdentity } from "./workspace.ts";

export const REVIEW_CONTRACT_VERSION = 1 as const;
const MAX_REVIEW_PACKET_BYTES = 192 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;

export interface CandidateReviewPacket {
	version: typeof REVIEW_CONTRACT_VERSION;
	candidateDigest: string;
	diffDigest: string;
	changedPaths: string[];
	text: string;
}

export interface StructuredReviewResult {
	version: typeof REVIEW_CONTRACT_VERSION;
	candidateDigest: string;
	diffDigest: string;
	verdict: "BLOCK" | "OK" | "OK_WITH_NOTES";
	findings: Array<{
		severity: "P0" | "P1" | "P2";
		path: string | null;
		line: number | null;
		summary: string;
	}>;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function runGit(cwd: string, args: string[], allowFailure = false): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "buffer", maxBuffer: MAX_REVIEW_PACKET_BYTES + 1 }, (error, stdout, stderr) => {
			if (error && !allowFailure) {
				reject(new Error(`git ${args.join(" ")} failed: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`));
				return;
			}
			resolve(Buffer.from(stdout));
		});
	});
}

function nulPaths(value: Buffer): string[] {
	return value.toString("utf8").split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right, "en"));
}

function literalPathspec(exclusions: readonly string[]): string[] {
	return ["--", ".", ...exclusions.map((value) => `:(exclude,literal,top)${value}`)];
}

async function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

function ensureBounded(value: string): void {
	if (Buffer.byteLength(value, "utf8") > MAX_REVIEW_PACKET_BYTES) {
		throw new Error(`Candidate diff exceeds the ${MAX_REVIEW_PACKET_BYTES}-byte reviewer packet limit`);
	}
}

function regularFileMode(mode: number): "100644" | "100755" {
	return (mode & 0o111) === 0 ? "100644" : "100755";
}

export async function createCandidateReviewPacket(input: {
	cwd: string;
	candidateDigest: string;
	progressPaths?: readonly string[];
}): Promise<CandidateReviewPacket> {
	const workspace = await resolveWorkspaceIdentity(input.cwd);
	const pathspec = literalPathspec(input.progressPaths ?? []);
	const [staged, tracked, untrackedOutput] = await Promise.all([
		runGit(workspace.workspacePath, ["-c", "core.quotepath=false", "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--find-renames", ...pathspec]),
		runGit(workspace.workspacePath, ["-c", "core.quotepath=false", "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--find-renames", ...pathspec]),
		runGit(workspace.workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	const exclusions = new Set(input.progressPaths ?? []);
	const untrackedPaths = nulPaths(untrackedOutput).filter((value) => !exclusions.has(value));
	const untrackedSections: string[] = [];
	for (const relativePath of untrackedPaths) {
		const absolute = path.join(workspace.gitRoot, relativePath);
		const stats = await lstat(absolute);
		if (stats.isSymbolicLink()) {
			const target = await readlink(absolute);
			untrackedSections.push(
				`untracked symlink ${JSON.stringify(relativePath)} mode=120000 target=${JSON.stringify(target)} target-sha256=${sha256(target)}\n`,
			);
			continue;
		}
		if (!stats.isFile()) throw new Error(`Unsupported untracked reviewer path type: ${relativePath}`);
		const mode = regularFileMode(stats.mode);
		if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
			untrackedSections.push(`untracked large/binary file ${JSON.stringify(relativePath)} mode=${mode} size=${stats.size} sha256=${await hashFile(absolute)}; content omitted by bounded policy\n`);
			continue;
		}
		const content = await readFile(absolute);
		if (content.includes(0)) {
			untrackedSections.push(`untracked binary file ${JSON.stringify(relativePath)} mode=${mode} size=${stats.size} sha256=${sha256(content)}; content omitted by bounded policy\n`);
			continue;
		}
		const lines = content.toString("utf8").split("\n").map((line) => `+${line}`).join("\n");
		untrackedSections.push(`diff --git a/${relativePath} b/${relativePath}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${relativePath}\n@@ untracked file sha256=${sha256(content)} @@\n${lines}\n`);
	}
	const body = [
		"=== STAGED DIFF ===",
		staged.toString("utf8") || "(none)",
		"=== TRACKED WORKTREE DIFF ===",
		tracked.toString("utf8") || "(none)",
		"=== UNTRACKED FILES ===",
		untrackedSections.join("\n") || "(none)",
	].join("\n");
	ensureBounded(body);
	const diffDigest = sha256(body);
	const changedPaths = [...new Set([
		...nulPaths(await runGit(workspace.workspacePath, ["diff", "--cached", "--name-only", "-z", ...pathspec])),
		...nulPaths(await runGit(workspace.workspacePath, ["diff", "--name-only", "-z", ...pathspec])),
		...untrackedPaths,
	])].sort((left, right) => left.localeCompare(right, "en"));
	return {
		version: REVIEW_CONTRACT_VERSION,
		candidateDigest: input.candidateDigest,
		diffDigest,
		changedPaths,
		text: [
			`Candidate digest: ${input.candidateDigest}`,
			`Candidate diff digest: ${diffDigest}`,
			`Changed paths: ${changedPaths.length ? changedPaths.join(", ") : "(none)"}`,
			body,
		].join("\n"),
	};
}

export function parseStructuredReviewResult(
	content: string,
	expected: Pick<CandidateReviewPacket, "candidateDigest" | "diffDigest">,
): StructuredReviewResult | undefined {
	const matches = [...content.matchAll(/```adaptive-delivery-review\s*\n([\s\S]*?)\n```/g)];
	if (matches.length !== 1) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(matches[0]![1]!);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input).sort();
	if (keys.join(",") !== ["candidateDigest", "diffDigest", "findings", "verdict", "version"].sort().join(",")) return undefined;
	if (
		input.version !== REVIEW_CONTRACT_VERSION ||
		input.candidateDigest !== expected.candidateDigest ||
		input.diffDigest !== expected.diffDigest ||
		(input.verdict !== "BLOCK" && input.verdict !== "OK" && input.verdict !== "OK_WITH_NOTES") ||
		!Array.isArray(input.findings) || input.findings.length > 64
	) return undefined;
	const findings: StructuredReviewResult["findings"] = [];
	for (const value of input.findings) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const finding = value as Record<string, unknown>;
		if (Object.keys(finding).sort().join(",") !== ["line", "path", "severity", "summary"].sort().join(",")) return undefined;
		if (
			(finding.severity !== "P0" && finding.severity !== "P1" && finding.severity !== "P2") ||
			(finding.path !== null && (typeof finding.path !== "string" || !finding.path)) ||
			(finding.line !== null && (typeof finding.line !== "number" || !Number.isInteger(finding.line) || finding.line < 1)) ||
			typeof finding.summary !== "string" || !finding.summary.trim() || Buffer.byteLength(finding.summary, "utf8") > 4_000
		) return undefined;
		findings.push({
			severity: finding.severity,
			path: finding.path,
			line: finding.line,
			summary: finding.summary.trim(),
		});
	}
	const blocking = findings.some((finding) => finding.severity === "P0" || finding.severity === "P1");
	if ((input.verdict === "BLOCK") !== blocking) return undefined;
	return {
		version: REVIEW_CONTRACT_VERSION,
		candidateDigest: expected.candidateDigest,
		diffDigest: expected.diffDigest,
		verdict: input.verdict,
		findings,
	};
}
