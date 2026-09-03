import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
	DOCUMENT_SELECTION_SOURCES,
	textFromContent,
	type DocumentSelectionSource,
	type PlanningDocumentsContract,
} from "./plan-contract.ts";
import { pathIsInside } from "./subagents.ts";

export const PLANNING_DOCUMENT_EVIDENCE_VERSION = 1 as const;
export const SOLUTION_DOCUMENT_START = "<!-- adaptive-delivery:solution:start -->";
export const SOLUTION_DOCUMENT_END = "<!-- adaptive-delivery:solution:end -->";
export const PLAN_DOCUMENT_START = "<!-- adaptive-delivery:plan:start -->";
export const PLAN_DOCUMENT_END = "<!-- adaptive-delivery:plan:end -->";

const MAX_DOCUMENT_BYTES = 512 * 1024;

interface FileIdentity {
	dev: number;
	ino: number;
}

interface ParentIdentity extends FileIdentity {
	path: string;
}

interface NewDocumentTarget {
	root: string;
	relative: string;
	absolute: string;
	parents: ParentIdentity[];
}

interface OpenedDocument {
	target: NewDocumentTarget;
	handle: FileHandle;
	identity: FileIdentity;
}

export interface PlanningDocumentEvidence {
	version: typeof PLANNING_DOCUMENT_EVIDENCE_VERSION;
	requirementName: string;
	solutionPath: string;
	planPath: string;
	selectionSource: DocumentSelectionSource;
	solutionContentDigest: string;
	planContentDigest: string;
	syncedAt: string;
}

export interface SolutionDocumentEvidence {
	version: typeof PLANNING_DOCUMENT_EVIDENCE_VERSION;
	requirementName: string;
	solutionPath: string;
	planPath: string;
	selectionSource: DocumentSelectionSource;
	solutionContentDigest: string;
	syncedAt: string;
}

export function digestPlanningDocumentContent(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function markerPair(kind: "solution" | "plan"): readonly [string, string] {
	return kind === "solution"
		? [SOLUTION_DOCUMENT_START, SOLUTION_DOCUMENT_END]
		: [PLAN_DOCUMENT_START, PLAN_DOCUMENT_END];
}

export function stripAdaptiveDeliveryProtocol(markdown: string): string {
	if (!markdown.includes("adaptive-delivery:") && !markdown.includes("```adaptive-delivery-")) return markdown;
	const withoutMarkers = markdown.replace(
		/^[ \t]*<!-- adaptive-delivery:(?:solution|plan):(?:start|end) -->[ \t]*(?:\n|$)/gm,
		"",
	);
	const withoutCompleteFences = withoutMarkers.replace(
		/(^|\n)[ \t]*```adaptive-delivery-(?:documents|plan)[^\n]*\n[\s\S]*?\n[ \t]*```(?=\n|$)/g,
		"$1",
	);
	const withoutStreamingFence = withoutCompleteFences.replace(
		/(^|\n)[ \t]*```adaptive-delivery-(?:documents|plan)[^\n]*\n[\s\S]*$/g,
		"$1",
	);
	return withoutStreamingFence.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

export function extractPlanningDocumentContent(content: unknown, kind: "solution" | "plan"): string | undefined {
	const text = textFromContent(content);
	const [startMarker, endMarker] = markerPair(kind);
	const start = text.indexOf(startMarker);
	const end = text.indexOf(endMarker);
	if (
		start < 0 ||
		end < 0 ||
		text.lastIndexOf(startMarker) !== start ||
		text.lastIndexOf(endMarker) !== end ||
		end <= start + startMarker.length
	) {
		return undefined;
	}
	const value = text.slice(start + startMarker.length, end).trim();
	if (!value || Buffer.byteLength(value, "utf8") > MAX_DOCUMENT_BYTES) return undefined;
	const visible = stripAdaptiveDeliveryProtocol(value).trim();
	return visible ? `${visible}\n` : undefined;
}

function validateRelativeMarkdownPath(value: string): string {
	if (!value || value.includes("\0") || /[\r\n\\]/.test(value) || path.isAbsolute(value)) {
		throw new Error("Planning document path must be a relative Markdown path");
	}
	const normalized = path.normalize(value);
	if (
		normalized !== value ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith(`..${path.sep}`) ||
		path.extname(normalized).toLowerCase() !== ".md"
	) {
		throw new Error(`Invalid planning document path: ${value}`);
	}
	return normalized;
}

async function ensureParentDirectories(root: string, relativeFile: string): Promise<ParentIdentity[]> {
	const parentRelative = path.dirname(relativeFile);
	if (parentRelative === ".") return [];
	let current = root;
	const parents: ParentIdentity[] = [];
	for (const component of parentRelative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			await mkdir(current, { mode: 0o755 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stats = await lstat(current);
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new Error(`Planning document parent is not a regular directory: ${current}`);
		}
		parents.push({ path: current, dev: stats.dev, ino: stats.ino });
	}
	return parents;
}

async function resolveExistingParentIdentities(root: string, relativeFile: string): Promise<ParentIdentity[]> {
	const parentRelative = path.dirname(relativeFile);
	if (parentRelative === ".") return [];
	let current = root;
	const parents: ParentIdentity[] = [];
	for (const component of parentRelative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		const stats = await lstat(current);
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new Error(`Planning document parent is not a regular directory: ${current}`);
		}
		parents.push({ path: current, dev: stats.dev, ino: stats.ino });
	}
	return parents;
}

async function assertParentIdentities(parents: readonly ParentIdentity[]): Promise<void> {
	for (const expected of parents) {
		const current = await lstat(expected.path);
		if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(expected, current)) {
			throw new Error(`Planning document parent identity changed: ${expected.path}`);
		}
	}
}

async function assertOpenedTargetIdentity(opened: OpenedDocument): Promise<void> {
	const current = await lstat(opened.target.absolute);
	if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(opened.identity, current)) {
		throw new Error(`Planning document target identity changed: ${opened.target.relative}`);
	}
}

async function resolveNewTarget(gitRoot: string, relativePath: string): Promise<NewDocumentTarget> {
	const root = await realpath(gitRoot);
	const relative = validateRelativeMarkdownPath(relativePath);
	const absolute = path.join(root, relative);
	if (!pathIsInside(root, absolute) || absolute === root) throw new Error(`Planning document escapes Git root: ${relative}`);
	const parents = await ensureParentDirectories(root, relative);
	try {
		await lstat(absolute);
		throw new Error(`Planning document already exists and will not be overwritten: ${relative}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { root, relative, absolute, parents };
}

async function openNewDocument(target: NewDocumentTarget): Promise<OpenedDocument> {
	const handle = await open(
		target.absolute,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o644,
	);
	let opened: OpenedDocument | undefined;
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Planning document target is not a regular file: ${target.relative}`);
		opened = { target, handle, identity: { dev: stats.dev, ino: stats.ino } };
		await assertParentIdentities(target.parents);
		await assertOpenedTargetIdentity(opened);
		return opened;
	} catch (error) {
		await handle.close();
		if (opened) await removeOpenedDocument(opened);
		throw error;
	}
}

async function writeAllAtStart(handle: FileHandle, content: string): Promise<void> {
	const data = Buffer.from(content, "utf8");
	await handle.truncate(0);
	let offset = 0;
	while (offset < data.length) {
		const result = await handle.write(data, offset, data.length - offset, offset);
		if (result.bytesWritten <= 0) throw new Error("Planning document write made no progress");
		offset += result.bytesWritten;
	}
	await handle.truncate(data.length);
}

async function removeOpenedDocument(opened: OpenedDocument): Promise<void> {
	try {
		const current = await lstat(opened.target.absolute);
		if (!current.isSymbolicLink() && sameIdentity(opened.identity, current)) {
			await unlink(opened.target.absolute);
		}
	} catch {
		// Preserve an unknown replacement rather than deleting it during cleanup.
	}
}

export async function writePlanningDocuments(input: {
	gitRoot: string;
	documents: PlanningDocumentsContract;
	solutionContent: string;
	planContent: string;
	now?: Date;
	afterResolveBeforeOpen?: () => Promise<void>;
}): Promise<PlanningDocumentEvidence> {
	if (!input.solutionContent.includes(input.documents.requirementName)) {
		throw new Error("Technical solution document does not contain the approved requirement name");
	}
	if (!input.planContent.includes(input.documents.requirementName)) {
		throw new Error("Implementation plan document does not contain the approved requirement name");
	}
	const solutionTarget = await resolveNewTarget(input.gitRoot, input.documents.solutionPath);
	const planTarget = await resolveNewTarget(input.gitRoot, input.documents.planPath);
	if (solutionTarget.absolute === planTarget.absolute) throw new Error("Planning document targets must be different files");
	await input.afterResolveBeforeOpen?.();

	const opened: OpenedDocument[] = [];
	try {
		opened.push(await openNewDocument(solutionTarget));
		opened.push(await openNewDocument(planTarget));
		await Promise.all(opened.map(assertOpenedTargetIdentity));
		await Promise.all(opened.map((item) => assertParentIdentities(item.target.parents)));
		await opened[0]!.handle.writeFile(input.solutionContent, "utf8");
		await opened[1]!.handle.writeFile(input.planContent, "utf8");
		await Promise.all(opened.map((item) => item.handle.sync()));
		await Promise.all(opened.map((item) => assertParentIdentities(item.target.parents)));
		await Promise.all(opened.map((item) => item.handle.close()));
		return {
			version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
			requirementName: input.documents.requirementName,
			solutionPath: solutionTarget.relative,
			planPath: planTarget.relative,
			selectionSource: input.documents.selectionSource,
			solutionContentDigest: digestPlanningDocumentContent(input.solutionContent),
			planContentDigest: digestPlanningDocumentContent(input.planContent),
			syncedAt: (input.now ?? new Date()).toISOString(),
		};
	} catch (error) {
		await Promise.allSettled(opened.map((item) => item.handle.close()));
		await Promise.allSettled(opened.map(removeOpenedDocument));
		throw error;
	}
}

function assertSolutionEvidenceContract(
	documents: PlanningDocumentsContract,
	evidence: SolutionDocumentEvidence,
): void {
	if (
		evidence.requirementName !== documents.requirementName ||
		evidence.solutionPath !== documents.solutionPath ||
		evidence.planPath !== documents.planPath ||
		evidence.selectionSource !== documents.selectionSource
	) {
		throw new Error("Technical solution evidence does not match the approved document contract");
	}
}

async function readExistingDocument(
	gitRoot: string,
	relativePath: string,
): Promise<{ target: NewDocumentTarget; identity: FileIdentity; content: string }> {
	const root = await realpath(gitRoot);
	const relative = validateRelativeMarkdownPath(relativePath);
	const absolute = path.join(root, relative);
	if (!pathIsInside(root, absolute) || absolute === root) throw new Error(`Planning document escapes Git root: ${relative}`);
	const parents = await resolveExistingParentIdentities(root, relative);
	const before = await lstat(absolute);
	if (before.isSymbolicLink() || !before.isFile()) {
		throw new Error(`Planning document is not a regular file: ${relative}`);
	}
	if (before.size > MAX_DOCUMENT_BYTES) throw new Error(`Planning document exceeds ${MAX_DOCUMENT_BYTES} bytes: ${relative}`);
	const target = { root, relative, absolute, parents };
	const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = { target, handle, identity: { dev: before.dev, ino: before.ino } };
		const current = await handle.stat();
		if (!current.isFile() || !sameIdentity(before, current)) {
			throw new Error(`Planning document target identity changed: ${relative}`);
		}
		await assertParentIdentities(parents);
		await assertOpenedTargetIdentity(opened);
		const content = await handle.readFile("utf8");
		await assertParentIdentities(parents);
		await assertOpenedTargetIdentity(opened);
		return { target, identity: opened.identity, content };
	} finally {
		await handle.close();
	}
}

export async function assertSolutionDocumentCurrent(
	gitRoot: string,
	evidence: SolutionDocumentEvidence,
): Promise<void> {
	const existing = await readExistingDocument(gitRoot, evidence.solutionPath);
	if (digestPlanningDocumentContent(existing.content) !== evidence.solutionContentDigest) {
		throw new Error(`Technical solution document content changed: ${evidence.solutionPath}`);
	}
}

export async function writeSolutionDocument(input: {
	gitRoot: string;
	documents: PlanningDocumentsContract;
	solutionContent: string;
	previous?: SolutionDocumentEvidence;
	now?: Date;
	afterResolveBeforeOpen?: () => Promise<void>;
}): Promise<SolutionDocumentEvidence> {
	if (!input.solutionContent.includes(input.documents.requirementName)) {
		throw new Error("Technical solution document does not contain the approved requirement name");
	}
	if (Buffer.byteLength(input.solutionContent, "utf8") > MAX_DOCUMENT_BYTES) {
		throw new Error("Technical solution document exceeds the size limit");
	}
	await resolveNewTarget(input.gitRoot, input.documents.planPath);

	if (!input.previous) {
		const target = await resolveNewTarget(input.gitRoot, input.documents.solutionPath);
		await input.afterResolveBeforeOpen?.();
		const opened = await openNewDocument(target);
		try {
			await writeAllAtStart(opened.handle, input.solutionContent);
			await opened.handle.sync();
			await assertParentIdentities(target.parents);
			await assertOpenedTargetIdentity(opened);
			await opened.handle.close();
			return {
				version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
				requirementName: input.documents.requirementName,
				solutionPath: target.relative,
				planPath: input.documents.planPath,
				selectionSource: input.documents.selectionSource,
				solutionContentDigest: digestPlanningDocumentContent(input.solutionContent),
				syncedAt: (input.now ?? new Date()).toISOString(),
			};
		} catch (error) {
			await opened.handle.close().catch(() => {});
			await removeOpenedDocument(opened);
			throw error;
		}
	}

	assertSolutionEvidenceContract(input.documents, input.previous);
	const existing = await readExistingDocument(input.gitRoot, input.previous.solutionPath);
	if (digestPlanningDocumentContent(existing.content) !== input.previous.solutionContentDigest) {
		throw new Error(`Technical solution document content changed and will not be overwritten: ${input.previous.solutionPath}`);
	}
	await input.afterResolveBeforeOpen?.();
	const handle = await open(existing.target.absolute, constants.O_RDWR | constants.O_NOFOLLOW);
	let mutated = false;
	try {
		const opened = { target: existing.target, handle, identity: existing.identity };
		const current = await handle.stat();
		if (!current.isFile() || !sameIdentity(existing.identity, current)) {
			throw new Error(`Planning document target identity changed: ${existing.target.relative}`);
		}
		await assertParentIdentities(existing.target.parents);
		await assertOpenedTargetIdentity(opened);
		const currentContent = await handle.readFile("utf8");
		if (digestPlanningDocumentContent(currentContent) !== input.previous.solutionContentDigest) {
			throw new Error(`Technical solution document content changed and will not be overwritten: ${input.previous.solutionPath}`);
		}
		await assertParentIdentities(existing.target.parents);
		await assertOpenedTargetIdentity(opened);
		mutated = true;
		await writeAllAtStart(handle, input.solutionContent);
		await handle.sync();
		await assertParentIdentities(existing.target.parents);
		await assertOpenedTargetIdentity(opened);
		return {
			...input.previous,
			solutionContentDigest: digestPlanningDocumentContent(input.solutionContent),
			syncedAt: (input.now ?? new Date()).toISOString(),
		};
	} catch (error) {
		if (mutated) {
			await writeAllAtStart(handle, existing.content).then(() => handle.sync()).catch(() => {});
		}
		throw error;
	} finally {
		await handle.close();
	}
}

export async function writePlanDocument(input: {
	gitRoot: string;
	documents: PlanningDocumentsContract;
	solutionContent: string;
	planContent: string;
	solutionEvidence: SolutionDocumentEvidence;
	now?: Date;
	afterResolveBeforeOpen?: () => Promise<void>;
}): Promise<PlanningDocumentEvidence> {
	assertSolutionEvidenceContract(input.documents, input.solutionEvidence);
	if (digestPlanningDocumentContent(input.solutionContent) !== input.solutionEvidence.solutionContentDigest) {
		throw new Error("Approved technical solution content does not match the synchronized document evidence");
	}
	await assertSolutionDocumentCurrent(input.gitRoot, input.solutionEvidence);
	if (!input.planContent.includes(input.documents.requirementName)) {
		throw new Error("Implementation plan document does not contain the approved requirement name");
	}
	const planTarget = await resolveNewTarget(input.gitRoot, input.documents.planPath);
	await input.afterResolveBeforeOpen?.();
	await assertSolutionDocumentCurrent(input.gitRoot, input.solutionEvidence);
	const opened = await openNewDocument(planTarget);
	try {
		await writeAllAtStart(opened.handle, input.planContent);
		await opened.handle.sync();
		await assertParentIdentities(planTarget.parents);
		await assertOpenedTargetIdentity(opened);
		await assertSolutionDocumentCurrent(input.gitRoot, input.solutionEvidence);
		await opened.handle.close();
		return {
			version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
			requirementName: input.documents.requirementName,
			solutionPath: input.solutionEvidence.solutionPath,
			planPath: planTarget.relative,
			selectionSource: input.documents.selectionSource,
			solutionContentDigest: input.solutionEvidence.solutionContentDigest,
			planContentDigest: digestPlanningDocumentContent(input.planContent),
			syncedAt: (input.now ?? new Date()).toISOString(),
		};
	} catch (error) {
		await opened.handle.close().catch(() => {});
		await removeOpenedDocument(opened);
		throw error;
	}
}

async function assertExistingDocument(gitRoot: string, relativePath: string): Promise<void> {
	const root = await realpath(gitRoot);
	const relative = validateRelativeMarkdownPath(relativePath);
	const absolute = path.join(root, relative);
	if (!pathIsInside(root, absolute) || absolute === root) throw new Error(`Planning document escapes Git root: ${relative}`);
	let current = root;
	const components = relative.split(path.sep).filter(Boolean);
	for (let index = 0; index < components.length; index += 1) {
		current = path.join(current, components[index]!);
		const stats = await lstat(current);
		if (stats.isSymbolicLink()) throw new Error(`Planning document contains a symlink component: ${relative}`);
		if (index < components.length - 1 && !stats.isDirectory()) {
			throw new Error(`Planning document parent is not a directory: ${relative}`);
		}
		if (index === components.length - 1 && !stats.isFile()) {
			throw new Error(`Planning document is not a regular file: ${relative}`);
		}
	}
}

export async function assertPlanningDocumentsExist(
	gitRoot: string,
	evidence: PlanningDocumentEvidence,
): Promise<void> {
	await assertExistingDocument(gitRoot, evidence.solutionPath);
	await assertExistingDocument(gitRoot, evidence.planPath);
}

export function parsePlanningDocumentEvidence(value: unknown): PlanningDocumentEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		input.version !== PLANNING_DOCUMENT_EVIDENCE_VERSION ||
		typeof input.requirementName !== "string" ||
		!input.requirementName.trim() ||
		typeof input.solutionPath !== "string" ||
		typeof input.planPath !== "string" ||
		typeof input.selectionSource !== "string" ||
		!(DOCUMENT_SELECTION_SOURCES as readonly string[]).includes(input.selectionSource) ||
		typeof input.solutionContentDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.solutionContentDigest) ||
		typeof input.planContentDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.planContentDigest) ||
		typeof input.syncedAt !== "string" ||
		Number.isNaN(Date.parse(input.syncedAt))
	) {
		return undefined;
	}
	try {
		const solutionPath = validateRelativeMarkdownPath(input.solutionPath);
		const planPath = validateRelativeMarkdownPath(input.planPath);
		if (solutionPath === planPath) return undefined;
		return {
			version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
			requirementName: input.requirementName.trim(),
			solutionPath,
			planPath,
			selectionSource: input.selectionSource as DocumentSelectionSource,
			solutionContentDigest: input.solutionContentDigest,
			planContentDigest: input.planContentDigest,
			syncedAt: input.syncedAt,
		};
	} catch {
		return undefined;
	}
}

export function parseSolutionDocumentEvidence(value: unknown): SolutionDocumentEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		input.version !== PLANNING_DOCUMENT_EVIDENCE_VERSION ||
		typeof input.requirementName !== "string" ||
		!input.requirementName.trim() ||
		typeof input.solutionPath !== "string" ||
		typeof input.planPath !== "string" ||
		typeof input.selectionSource !== "string" ||
		!(DOCUMENT_SELECTION_SOURCES as readonly string[]).includes(input.selectionSource) ||
		typeof input.solutionContentDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.solutionContentDigest) ||
		typeof input.syncedAt !== "string" ||
		Number.isNaN(Date.parse(input.syncedAt))
	) return undefined;
	try {
		const solutionPath = validateRelativeMarkdownPath(input.solutionPath);
		const planPath = validateRelativeMarkdownPath(input.planPath);
		if (solutionPath === planPath) return undefined;
		return {
			version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
			requirementName: input.requirementName.trim(),
			solutionPath,
			planPath,
			selectionSource: input.selectionSource as DocumentSelectionSource,
			solutionContentDigest: input.solutionContentDigest,
			syncedAt: input.syncedAt,
		};
	} catch {
		return undefined;
	}
}
