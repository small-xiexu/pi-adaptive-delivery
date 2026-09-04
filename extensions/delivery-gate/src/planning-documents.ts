import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	rename,
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

export const PLANNING_DOCUMENT_EVIDENCE_VERSION = 2 as const;
export const PLANNING_DOCUMENT_REVISION_INTENT_VERSION = 1 as const;
export const SOLUTION_DOCUMENT_START = "<!-- adaptive-delivery:solution:start -->";
export const SOLUTION_DOCUMENT_END = "<!-- adaptive-delivery:solution:end -->";
export const PLAN_DOCUMENT_START = "<!-- adaptive-delivery:plan:start -->";
export const PLAN_DOCUMENT_END = "<!-- adaptive-delivery:plan:end -->";

const MAX_DOCUMENT_BYTES = 512 * 1024;

interface FileIdentity {
	dev: number;
	ino: number;
}

interface PersistedParentIdentity extends FileIdentity {
	relativePath: string;
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
	solutionFileIdentity: FileIdentity;
	solutionParentIdentities: PersistedParentIdentity[];
	solutionContentDigest: string;
	planFileIdentity: FileIdentity;
	planParentIdentities: PersistedParentIdentity[];
	approvedPlanContentDigest: string;
	planContentDigest: string;
	syncedAt: string;
}

export interface SolutionDocumentEvidence {
	version: typeof PLANNING_DOCUMENT_EVIDENCE_VERSION;
	requirementName: string;
	solutionPath: string;
	planPath: string;
	selectionSource: DocumentSelectionSource;
	solutionFileIdentity: FileIdentity;
	solutionParentIdentities: PersistedParentIdentity[];
	solutionContentDigest: string;
	syncedAt: string;
}

export interface PlanningDocumentRevisionIntent {
	version: typeof PLANNING_DOCUMENT_REVISION_INTENT_VERSION;
	kind: "solution" | "plan";
	path: string;
	previousFileIdentity: FileIdentity;
	previousParentIdentities: PersistedParentIdentity[];
	previousContentDigest: string;
	nextFileIdentity: FileIdentity;
	nextParentIdentities: PersistedParentIdentity[];
	nextContentDigest: string;
	preparedAt: string;
}

export function digestPlanningDocumentContent(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function persistedParentIdentities(target: NewDocumentTarget): PersistedParentIdentity[] {
	return target.parents.map((parent) => ({
		relativePath: path.relative(target.root, parent.path),
		dev: parent.dev,
		ino: parent.ino,
	}));
}

function assertPersistedIdentity(
	existing: { target: NewDocumentTarget; identity: FileIdentity },
	fileIdentity: FileIdentity,
	parentIdentities: readonly PersistedParentIdentity[],
	label: string,
): void {
	if (!sameIdentity(existing.identity, fileIdentity)) {
		throw new Error(`${label} file identity changed: ${existing.target.relative}`);
	}
	const currentParents = persistedParentIdentities(existing.target);
	if (
		currentParents.length !== parentIdentities.length ||
		currentParents.some((parent, index) => {
			const expected = parentIdentities[index];
			return !expected || parent.relativePath !== expected.relativePath || !sameIdentity(parent, expected);
		})
	) {
		throw new Error(`${label} parent identity changed: ${existing.target.relative}`);
	}
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

async function syncParentDirectory(absolutePath: string): Promise<void> {
	try {
		const handle = await open(path.dirname(absolutePath), constants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === "win32" && (code === "EPERM" || code === "EISDIR" || code === "EINVAL")) return;
		throw error;
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
			solutionFileIdentity: opened[0]!.identity,
			solutionParentIdentities: persistedParentIdentities(solutionTarget),
			solutionContentDigest: digestPlanningDocumentContent(input.solutionContent),
			planFileIdentity: opened[1]!.identity,
			planParentIdentities: persistedParentIdentities(planTarget),
			approvedPlanContentDigest: digestPlanningDocumentContent(input.planContent),
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

function assertPlanningEvidenceContract(
	documents: PlanningDocumentsContract,
	evidence: PlanningDocumentEvidence,
): void {
	assertSolutionEvidenceContract(documents, evidence);
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

async function overwriteExistingDocument(input: {
	gitRoot: string;
	kind: PlanningDocumentRevisionIntent["kind"];
	relativePath: string;
	expectedDigest: string;
	expectedFileIdentity: FileIdentity;
	expectedParentIdentities: readonly PersistedParentIdentity[];
	content: string;
	label: string;
	afterResolveBeforeOpen?: () => Promise<void>;
	afterTemporaryWriteBeforeCommit?: () => Promise<void>;
	afterRenameBeforeDirectorySync?: () => Promise<void>;
	onRevisionPrepared: (intent: PlanningDocumentRevisionIntent) => Promise<void>;
	beforeCommit?: () => Promise<void>;
}): Promise<{ fileIdentity: FileIdentity; parentIdentities: PersistedParentIdentity[] }> {
	const existing = await readExistingDocument(input.gitRoot, input.relativePath);
	assertPersistedIdentity(existing, input.expectedFileIdentity, input.expectedParentIdentities, input.label);
	if (digestPlanningDocumentContent(existing.content) !== input.expectedDigest) {
		throw new Error(`${input.label} content changed and will not be overwritten: ${input.relativePath}`);
	}
	await input.afterResolveBeforeOpen?.();
	const temporaryRelative = path.join(
		path.dirname(existing.target.relative),
		`.${path.basename(existing.target.relative)}.adaptive-delivery-${randomUUID()}.tmp`,
	);
	const temporaryTarget: NewDocumentTarget = {
		root: existing.target.root,
		relative: temporaryRelative,
		absolute: path.join(existing.target.root, temporaryRelative),
		parents: existing.target.parents,
	};
	const temporary = await openNewDocument(temporaryTarget);
	try {
		await writeAllAtStart(temporary.handle, input.content);
		await temporary.handle.sync();
		await assertParentIdentities(temporary.target.parents);
		await assertOpenedTargetIdentity(temporary);
		await input.afterTemporaryWriteBeforeCommit?.();
		await input.beforeCommit?.();
		await assertExpectedDocumentCurrent(input);
		const nextContentDigest = digestPlanningDocumentContent(input.content);
		await input.onRevisionPrepared({
			version: PLANNING_DOCUMENT_REVISION_INTENT_VERSION,
			kind: input.kind,
			path: input.relativePath,
			previousFileIdentity: input.expectedFileIdentity,
			previousParentIdentities: [...input.expectedParentIdentities],
			previousContentDigest: input.expectedDigest,
			nextFileIdentity: temporary.identity,
			nextParentIdentities: persistedParentIdentities(existing.target),
			nextContentDigest,
			preparedAt: new Date().toISOString(),
		});
		await input.beforeCommit?.();
		await assertExpectedDocumentCurrent(input);
		await temporary.handle.close();
		await rename(temporary.target.absolute, existing.target.absolute);
		await input.afterRenameBeforeDirectorySync?.();
		await syncParentDirectory(existing.target.absolute);
		return {
			fileIdentity: temporary.identity,
			parentIdentities: persistedParentIdentities(existing.target),
		};
	} catch (error) {
		await temporary.handle.close().catch(() => {});
		await removeOpenedDocument(temporary);
		throw error;
	}
}

async function assertExpectedDocumentCurrent(input: {
	gitRoot: string;
	relativePath: string;
	expectedDigest: string;
	expectedFileIdentity: FileIdentity;
	expectedParentIdentities: readonly PersistedParentIdentity[];
	label: string;
}): Promise<void> {
	const current = await readExistingDocument(input.gitRoot, input.relativePath);
	assertPersistedIdentity(current, input.expectedFileIdentity, input.expectedParentIdentities, input.label);
	if (digestPlanningDocumentContent(current.content) !== input.expectedDigest) {
		throw new Error(`${input.label} content changed and will not be overwritten: ${input.relativePath}`);
	}
}

export async function resolvePlanningDocumentRevision(
	gitRoot: string,
	intent: PlanningDocumentRevisionIntent,
): Promise<"previous" | "next"> {
	const current = await readExistingDocument(gitRoot, intent.path);
	const digest = digestPlanningDocumentContent(current.content);
	const matches = (
		fileIdentity: FileIdentity,
		parentIdentities: readonly PersistedParentIdentity[],
		contentDigest: string,
	) => {
		try {
			assertPersistedIdentity(current, fileIdentity, parentIdentities, "Planning document revision");
			return digest === contentDigest;
		} catch {
			return false;
		}
	};
	if (matches(intent.previousFileIdentity, intent.previousParentIdentities, intent.previousContentDigest)) {
		return "previous";
	}
	if (matches(intent.nextFileIdentity, intent.nextParentIdentities, intent.nextContentDigest)) return "next";
	throw new Error(`Planning document revision matches neither recorded state: ${intent.path}`);
}

export async function assertSolutionDocumentCurrent(
	gitRoot: string,
	evidence: SolutionDocumentEvidence,
): Promise<void> {
	const existing = await readExistingDocument(gitRoot, evidence.solutionPath);
	assertPersistedIdentity(
		existing,
		evidence.solutionFileIdentity,
		evidence.solutionParentIdentities,
		"Technical solution document",
	);
	if (digestPlanningDocumentContent(existing.content) !== evidence.solutionContentDigest) {
		throw new Error(`Technical solution document content changed: ${evidence.solutionPath}`);
	}
}

export async function assertPlanDocumentCurrent(
	gitRoot: string,
	evidence: PlanningDocumentEvidence,
): Promise<void> {
	const existing = await readExistingDocument(gitRoot, evidence.planPath);
	assertPersistedIdentity(
		existing,
		evidence.planFileIdentity,
		evidence.planParentIdentities,
		"Implementation plan document",
	);
	if (digestPlanningDocumentContent(existing.content) !== evidence.planContentDigest) {
		throw new Error(`Implementation plan document content changed: ${evidence.planPath}`);
	}
}

export async function refreshPlanDocumentEvidence(
	gitRoot: string,
	evidence: PlanningDocumentEvidence,
	expectedDigest: string,
	now: Date = new Date(),
): Promise<PlanningDocumentEvidence> {
	const existing = await readExistingDocument(gitRoot, evidence.planPath);
	assertPersistedIdentity(
		existing,
		evidence.planFileIdentity,
		evidence.planParentIdentities,
		"Implementation plan document",
	);
	if (digestPlanningDocumentContent(existing.content) !== expectedDigest) {
		throw new Error(`Implementation plan document does not match the completed progress write: ${evidence.planPath}`);
	}
	return {
		...evidence,
		planContentDigest: expectedDigest,
		syncedAt: now.toISOString(),
	};
}

export async function writeSolutionDocument(input: {
	gitRoot: string;
	documents: PlanningDocumentsContract;
	solutionContent: string;
	previous?: SolutionDocumentEvidence;
	previousPlanning?: PlanningDocumentEvidence;
	now?: Date;
	afterResolveBeforeOpen?: () => Promise<void>;
	afterTemporaryWriteBeforeCommit?: () => Promise<void>;
	afterRenameBeforeDirectorySync?: () => Promise<void>;
	onRevisionPrepared?: (intent: PlanningDocumentRevisionIntent) => Promise<void>;
}): Promise<SolutionDocumentEvidence> {
	if (!input.solutionContent.includes(input.documents.requirementName)) {
		throw new Error("Technical solution document does not contain the approved requirement name");
	}
	if (Buffer.byteLength(input.solutionContent, "utf8") > MAX_DOCUMENT_BYTES) {
		throw new Error("Technical solution document exceeds the size limit");
	}
	if (!input.previous) {
		await resolveNewTarget(input.gitRoot, input.documents.planPath);
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
				solutionFileIdentity: opened.identity,
				solutionParentIdentities: persistedParentIdentities(target),
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
	if (!input.onRevisionPrepared) throw new Error("Technical solution revision requires a durable revision intent callback");
	if (input.previousPlanning) {
		assertPlanningEvidenceContract(input.documents, input.previousPlanning);
		if (input.previous.solutionContentDigest !== input.previousPlanning.solutionContentDigest) {
			throw new Error("Technical solution evidence does not match the previous planning document evidence");
		}
		await assertPlanDocumentCurrent(input.gitRoot, input.previousPlanning);
	}
	const replaced = await overwriteExistingDocument({
		gitRoot: input.gitRoot,
		kind: "solution",
		relativePath: input.previous.solutionPath,
		expectedDigest: input.previous.solutionContentDigest,
		expectedFileIdentity: input.previous.solutionFileIdentity,
		expectedParentIdentities: input.previous.solutionParentIdentities,
		content: input.solutionContent,
		label: "Technical solution document",
		...(input.afterResolveBeforeOpen || input.previousPlanning
			? {
				afterResolveBeforeOpen: async () => {
					await input.afterResolveBeforeOpen?.();
					if (input.previousPlanning) await assertPlanDocumentCurrent(input.gitRoot, input.previousPlanning);
				},
			}
			: {}),
		...(input.afterTemporaryWriteBeforeCommit
			? { afterTemporaryWriteBeforeCommit: input.afterTemporaryWriteBeforeCommit }
			: {}),
		...(input.afterRenameBeforeDirectorySync
			? { afterRenameBeforeDirectorySync: input.afterRenameBeforeDirectorySync }
			: {}),
		onRevisionPrepared: input.onRevisionPrepared,
		...(input.previousPlanning
			? { beforeCommit: () => assertPlanDocumentCurrent(input.gitRoot, input.previousPlanning!) }
			: {}),
	});
	return {
		...input.previous,
		solutionFileIdentity: replaced.fileIdentity,
		solutionParentIdentities: replaced.parentIdentities,
		solutionContentDigest: digestPlanningDocumentContent(input.solutionContent),
		syncedAt: (input.now ?? new Date()).toISOString(),
	};
}

export async function writePlanDocument(input: {
	gitRoot: string;
	documents: PlanningDocumentsContract;
	solutionContent: string;
	planContent: string;
	solutionEvidence: SolutionDocumentEvidence;
	previous?: PlanningDocumentEvidence;
	now?: Date;
	afterResolveBeforeOpen?: () => Promise<void>;
	afterTemporaryWriteBeforeCommit?: () => Promise<void>;
	afterRenameBeforeDirectorySync?: () => Promise<void>;
	onRevisionPrepared?: (intent: PlanningDocumentRevisionIntent) => Promise<void>;
}): Promise<PlanningDocumentEvidence> {
	assertSolutionEvidenceContract(input.documents, input.solutionEvidence);
	if (digestPlanningDocumentContent(input.solutionContent) !== input.solutionEvidence.solutionContentDigest) {
		throw new Error("Approved technical solution content does not match the synchronized document evidence");
	}
	await assertSolutionDocumentCurrent(input.gitRoot, input.solutionEvidence);
	if (!input.planContent.includes(input.documents.requirementName)) {
		throw new Error("Implementation plan document does not contain the approved requirement name");
	}
	if (input.previous) {
		assertPlanningEvidenceContract(input.documents, input.previous);
		if (!input.onRevisionPrepared) throw new Error("Implementation plan revision requires a durable revision intent callback");
		const replaced = await overwriteExistingDocument({
			gitRoot: input.gitRoot,
			kind: "plan",
			relativePath: input.previous.planPath,
			expectedDigest: input.previous.planContentDigest,
			expectedFileIdentity: input.previous.planFileIdentity,
			expectedParentIdentities: input.previous.planParentIdentities,
			content: input.planContent,
			label: "Implementation plan document",
			afterResolveBeforeOpen: async () => {
				await input.afterResolveBeforeOpen?.();
				await assertSolutionDocumentCurrent(input.gitRoot, input.solutionEvidence);
			},
			beforeCommit: () => assertSolutionDocumentCurrent(input.gitRoot, input.solutionEvidence),
			...(input.afterTemporaryWriteBeforeCommit
				? { afterTemporaryWriteBeforeCommit: input.afterTemporaryWriteBeforeCommit }
				: {}),
			...(input.afterRenameBeforeDirectorySync
				? { afterRenameBeforeDirectorySync: input.afterRenameBeforeDirectorySync }
				: {}),
			onRevisionPrepared: input.onRevisionPrepared,
		});
		return {
			version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
			requirementName: input.documents.requirementName,
			solutionPath: input.solutionEvidence.solutionPath,
			planPath: input.previous.planPath,
			selectionSource: input.documents.selectionSource,
			solutionFileIdentity: input.solutionEvidence.solutionFileIdentity,
			solutionParentIdentities: input.solutionEvidence.solutionParentIdentities,
			solutionContentDigest: input.solutionEvidence.solutionContentDigest,
			planFileIdentity: replaced.fileIdentity,
			planParentIdentities: replaced.parentIdentities,
			approvedPlanContentDigest: digestPlanningDocumentContent(input.planContent),
			planContentDigest: digestPlanningDocumentContent(input.planContent),
			syncedAt: (input.now ?? new Date()).toISOString(),
		};
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
			solutionFileIdentity: input.solutionEvidence.solutionFileIdentity,
			solutionParentIdentities: input.solutionEvidence.solutionParentIdentities,
			solutionContentDigest: input.solutionEvidence.solutionContentDigest,
			planFileIdentity: opened.identity,
			planParentIdentities: persistedParentIdentities(planTarget),
			approvedPlanContentDigest: digestPlanningDocumentContent(input.planContent),
			planContentDigest: digestPlanningDocumentContent(input.planContent),
			syncedAt: (input.now ?? new Date()).toISOString(),
		};
	} catch (error) {
		await opened.handle.close().catch(() => {});
		await removeOpenedDocument(opened);
		throw error;
	}
}

export async function assertPlanningDocumentsExist(
	gitRoot: string,
	evidence: PlanningDocumentEvidence,
): Promise<void> {
	await assertSolutionDocumentCurrent(gitRoot, evidence);
	await assertPlanDocumentCurrent(gitRoot, evidence);
}

function parseFileIdentity(value: unknown): FileIdentity | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 2 ||
		typeof input.dev !== "number" ||
		!Number.isSafeInteger(input.dev) ||
		input.dev < 0 ||
		typeof input.ino !== "number" ||
		!Number.isSafeInteger(input.ino) ||
		input.ino < 0
	) return undefined;
	return { dev: input.dev, ino: input.ino };
}

function parseParentIdentities(value: unknown, relativeFile: string): PersistedParentIdentity[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parent = path.dirname(relativeFile);
	const expectedPaths: string[] = [];
	if (parent !== ".") {
		let current = "";
		for (const component of parent.split(path.sep)) {
			current = current ? path.join(current, component) : component;
			expectedPaths.push(current);
		}
	}
	if (value.length !== expectedPaths.length) return undefined;
	const result: PersistedParentIdentity[] = [];
	for (const [index, item] of value.entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const input = item as Record<string, unknown>;
		const identity = parseFileIdentity({ dev: input.dev, ino: input.ino });
		if (
			Object.keys(input).length !== 3 ||
			typeof input.relativePath !== "string" ||
			input.relativePath !== expectedPaths[index] ||
			!identity
		) return undefined;
		result.push({ relativePath: input.relativePath, ...identity });
	}
	return result;
}

export function parsePlanningDocumentRevisionIntent(value: unknown): PlanningDocumentRevisionIntent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 10 ||
		input.version !== PLANNING_DOCUMENT_REVISION_INTENT_VERSION ||
		(input.kind !== "solution" && input.kind !== "plan") ||
		typeof input.path !== "string" ||
		typeof input.previousContentDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.previousContentDigest) ||
		typeof input.nextContentDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.nextContentDigest) ||
		typeof input.preparedAt !== "string" ||
		Number.isNaN(Date.parse(input.preparedAt))
	) return undefined;
	try {
		const relativePath = validateRelativeMarkdownPath(input.path);
		const previousFileIdentity = parseFileIdentity(input.previousFileIdentity);
		const previousParentIdentities = parseParentIdentities(input.previousParentIdentities, relativePath);
		const nextFileIdentity = parseFileIdentity(input.nextFileIdentity);
		const nextParentIdentities = parseParentIdentities(input.nextParentIdentities, relativePath);
		if (!previousFileIdentity || !previousParentIdentities || !nextFileIdentity || !nextParentIdentities) {
			return undefined;
		}
		return {
			version: PLANNING_DOCUMENT_REVISION_INTENT_VERSION,
			kind: input.kind,
			path: relativePath,
			previousFileIdentity,
			previousParentIdentities,
			previousContentDigest: input.previousContentDigest,
			nextFileIdentity,
			nextParentIdentities,
			nextContentDigest: input.nextContentDigest,
			preparedAt: input.preparedAt,
		};
	} catch {
		return undefined;
	}
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
		typeof input.approvedPlanContentDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.approvedPlanContentDigest) ||
		typeof input.syncedAt !== "string" ||
		Number.isNaN(Date.parse(input.syncedAt))
	) {
		return undefined;
	}
	try {
		const solutionPath = validateRelativeMarkdownPath(input.solutionPath);
		const planPath = validateRelativeMarkdownPath(input.planPath);
		if (solutionPath === planPath) return undefined;
		const solutionFileIdentity = parseFileIdentity(input.solutionFileIdentity);
		const solutionParentIdentities = parseParentIdentities(input.solutionParentIdentities, solutionPath);
		const planFileIdentity = parseFileIdentity(input.planFileIdentity);
		const planParentIdentities = parseParentIdentities(input.planParentIdentities, planPath);
		if (!solutionFileIdentity || !solutionParentIdentities || !planFileIdentity || !planParentIdentities) return undefined;
		return {
			version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
			requirementName: input.requirementName.trim(),
			solutionPath,
			planPath,
			selectionSource: input.selectionSource as DocumentSelectionSource,
			solutionFileIdentity,
			solutionParentIdentities,
			solutionContentDigest: input.solutionContentDigest,
			planFileIdentity,
			planParentIdentities,
			approvedPlanContentDigest: input.approvedPlanContentDigest,
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
		const solutionFileIdentity = parseFileIdentity(input.solutionFileIdentity);
		const solutionParentIdentities = parseParentIdentities(input.solutionParentIdentities, solutionPath);
		if (!solutionFileIdentity || !solutionParentIdentities) return undefined;
		return {
			version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
			requirementName: input.requirementName.trim(),
			solutionPath,
			planPath,
			selectionSource: input.selectionSource as DocumentSelectionSource,
			solutionFileIdentity,
			solutionParentIdentities,
			solutionContentDigest: input.solutionContentDigest,
			syncedAt: input.syncedAt,
		};
	} catch {
		return undefined;
	}
}
