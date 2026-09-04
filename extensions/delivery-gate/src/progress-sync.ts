import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { ProgressCheck } from "./plan-contract.ts";
import { pathIsInside } from "./subagents.ts";

export interface ProgressSyncInput {
	gitRoot: string;
	approvedTargets: readonly string[];
	target: string;
	oldText: string;
	newText: string;
	checks: readonly ProgressCheck[];
	signal?: AbortSignal;
	runCheck: (check: ProgressCheck, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;
	onWrite?: (evidence: ProgressWriteEvidence) => Promise<void>;
	beforeOpen?: () => Promise<void>;
	afterRecheckBeforeOpen?: () => Promise<void>;
}

export interface ProgressWriteEvidence {
	target: string;
	digest: string;
}

export interface ProgressSyncResult {
	target: string;
	digest: string;
	checks: Array<{ id: string; code: number }>;
}

export class ProgressSyncConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProgressSyncConflictError";
	}
}

interface FileIdentity {
	dev: number;
	ino: number;
}

interface PathIdentity extends FileIdentity {
	path: string;
}

async function inspectPathComponents(root: string, absolute: string): Promise<{ target: FileIdentity; parents: PathIdentity[] }> {
	const relative = path.relative(root, absolute);
	if (!pathIsInside(root, absolute) || !relative) throw new Error("Progress target must be a file inside Git root");
	let current = root;
	const components = relative.split(path.sep);
	const parents: PathIdentity[] = [];
	let target: FileIdentity | undefined;
	for (let index = 0; index < components.length; index += 1) {
		const component = components[index]!;
		current = path.join(current, component);
		const stats = await lstat(current);
		if (stats.isSymbolicLink()) throw new Error(`Progress target contains a symlink component: ${component}`);
		const identity = { dev: stats.dev, ino: stats.ino };
		if (index === components.length - 1) target = identity;
		else parents.push({ path: current, ...identity });
	}
	if (!target) throw new Error("Progress target identity is unavailable");
	return { target, parents };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function assertParentIdentities(parents: readonly PathIdentity[]): Promise<void> {
	for (const expected of parents) {
		const current = await lstat(expected.path);
		if (current.isSymbolicLink() || !sameIdentity(expected, current)) {
			throw new Error(`Progress target parent identity changed: ${expected.path}`);
		}
	}
}

export async function resolveProgressTarget(
	gitRoot: string,
	approvedTargets: readonly string[],
	target: string,
): Promise<{
	root: string;
	relative: string;
	absolute: string;
	identity: { target: FileIdentity; parents: PathIdentity[] };
}> {
	const root = await realpath(gitRoot);
	if (!target || path.isAbsolute(target) || target.includes("\0")) throw new Error("Progress target must be a relative path");
	const relative = path.normalize(target);
	if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Progress target escapes Git root");
	const approved = new Set(approvedTargets.map((value) => path.normalize(value)));
	if (!approved.has(relative)) throw new Error("Progress target is not approved by the plan contract");
	const absolute = path.join(root, relative);
	const identity = await inspectPathComponents(root, absolute);
	const canonical = await realpath(absolute);
	if (!pathIsInside(root, canonical)) throw new Error("Progress target escapes Git root");
	const stats = await lstat(canonical);
	if (!stats.isFile()) throw new Error("Progress target must be a regular file");
	return { root, relative, absolute: canonical, identity };
}

export async function syncProjectProgress(input: ProgressSyncInput): Promise<ProgressSyncResult> {
	if (input.signal?.aborted) throw new Error("Progress sync was cancelled before it started");
	const target = await resolveProgressTarget(input.gitRoot, input.approvedTargets, input.target);
	if (!input.oldText) throw new Error("Progress sync oldText must be non-empty");
	if (!input.newText) throw new Error("Progress sync newText must be non-empty");
	return withFileMutationQueue(target.absolute, async () => {
		await inspectPathComponents(target.root, target.absolute);
		await input.beforeOpen?.();
		const rechecked = await resolveProgressTarget(target.root, input.approvedTargets, target.relative);
		if (rechecked.absolute !== target.absolute) throw new Error("Progress target changed during validation");
		if (!sameIdentity(rechecked.identity.target, target.identity.target)) {
			throw new Error("Progress target identity changed during validation");
		}
		await input.afterRecheckBeforeOpen?.();
		const handle = await open(target.absolute, constants.O_RDWR | constants.O_NOFOLLOW);
		let next: string;
		try {
			const opened = await handle.stat();
			if (!sameIdentity(target.identity.target, opened)) {
				throw new Error("Opened progress target identity does not match the approved file");
			}
			await assertParentIdentities(target.identity.parents);
			const current = await handle.readFile("utf8");
			const first = current.indexOf(input.oldText);
			if (first < 0) {
				const applied = input.newText ? current.indexOf(input.newText) : -1;
				if (applied < 0) throw new ProgressSyncConflictError("Progress sync oldText was not found");
				if (current.indexOf(input.newText, applied + 1) >= 0) {
					throw new ProgressSyncConflictError("Progress sync oldText was not found and newText is not unique");
				}
				next = current;
			} else {
				if (current.indexOf(input.oldText, first + 1) >= 0) {
					throw new ProgressSyncConflictError("Progress sync oldText is not unique");
				}
				next = `${current.slice(0, first)}${input.newText}${current.slice(first + input.oldText.length)}`;
				const bytes = Buffer.from(next, "utf8");
				await handle.truncate(0);
				await handle.write(bytes, 0, bytes.length, 0);
				await handle.sync();
			}
		} finally {
			await handle.close();
		}
		const finalTarget = await resolveProgressTarget(target.root, input.approvedTargets, target.relative);
		if (finalTarget.absolute !== target.absolute) throw new Error("Progress target changed after write");
		if (!sameIdentity(finalTarget.identity.target, target.identity.target)) {
			throw new Error("Progress target identity changed after write");
		}
		const writeEvidence = {
			target: target.relative,
			digest: createHash("sha256").update(next!).digest("hex"),
		};
		await input.onWrite?.(writeEvidence);
		if (input.signal?.aborted) throw new Error("Progress sync was cancelled after the write");
		const checkResults: Array<{ id: string; code: number }> = [];
		for (const check of input.checks) {
			if (input.signal?.aborted) throw new Error(`Progress check '${check.id}' was cancelled before it started`);
			const result = await input.runCheck(check, input.signal);
			checkResults.push({ id: check.id, code: result.code });
			if (input.signal?.aborted) throw new Error(`Progress check '${check.id}' was cancelled`);
			if (result.killed) throw new Error(`Progress check '${check.id}' timed out`);
			if (result.code !== 0) {
				throw new Error(`Progress check '${check.id}' failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
			}
		}
		return {
			...writeEvidence,
			checks: checkResults,
		};
	});
}
