import { createHash } from "node:crypto";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const APPROVAL_RECORD_VERSION = 1 as const;
export const APPROVAL_KINDS = ["solution", "plan", "combined"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface ApprovalRecord {
	version: typeof APPROVAL_RECORD_VERSION;
	kind: ApprovalKind;
	sessionId: string;
	entryId: string;
	contentDigest: string;
	branchAnchorEntryId: string;
	canonicalCwd: string;
	gitRoot?: string;
	approvedAt: string;
}

export interface ApprovalMessageEntry {
	type: "message";
	id: string;
	message: {
		role: string;
		content: unknown;
	};
}

export interface ApprovalTarget {
	sessionId: string;
	entry: ApprovalMessageEntry;
	branchAnchorEntryId: string;
	canonicalCwd: string;
	gitRoot?: string;
}

export interface ApprovalValidationContext {
	sessionId: string;
	branch: readonly unknown[];
	canonicalCwd: string;
	gitRoot?: string;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export function digestApprovalContent(content: unknown): string {
	return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function isApprovalKind(value: unknown): value is ApprovalKind {
	return typeof value === "string" && (APPROVAL_KINDS as readonly string[]).includes(value);
}

export function findLatestAssistantEntry(branch: readonly unknown[]): ApprovalMessageEntry | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Record<string, unknown>;
		if (candidate.type !== "message" || typeof candidate.id !== "string") continue;
		if (!candidate.message || typeof candidate.message !== "object") continue;
		const message = candidate.message as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		return candidate as unknown as ApprovalMessageEntry;
	}
	return undefined;
}

export function createApprovalRecord(
	kind: ApprovalKind,
	target: ApprovalTarget,
	now: Date = new Date(),
): ApprovalRecord {
	if (target.entry.message.role !== "assistant") {
		throw new Error("Approval target must be an assistant message");
	}
	if (!target.sessionId || !target.entry.id || !target.branchAnchorEntryId || !target.canonicalCwd) {
		throw new Error("Approval target identity is incomplete");
	}

	return {
		version: APPROVAL_RECORD_VERSION,
		kind,
		sessionId: target.sessionId,
		entryId: target.entry.id,
		contentDigest: digestApprovalContent(target.entry.message.content),
		branchAnchorEntryId: target.branchAnchorEntryId,
		canonicalCwd: target.canonicalCwd,
		...(target.gitRoot ? { gitRoot: target.gitRoot } : {}),
		approvedAt: now.toISOString(),
	};
}

function requiredString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseApprovalRecord(value: unknown): ApprovalRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (input.version !== APPROVAL_RECORD_VERSION || !isApprovalKind(input.kind)) return undefined;
	const sessionId = requiredString(input, "sessionId");
	const entryId = requiredString(input, "entryId");
	const contentDigest = requiredString(input, "contentDigest");
	const branchAnchorEntryId = requiredString(input, "branchAnchorEntryId");
	const canonicalCwd = requiredString(input, "canonicalCwd");
	const approvedAt = requiredString(input, "approvedAt");
	const gitRoot = input.gitRoot === undefined ? undefined : requiredString(input, "gitRoot");
	if (
		!sessionId ||
		!entryId ||
		!contentDigest ||
		!branchAnchorEntryId ||
		!canonicalCwd ||
		!approvedAt ||
		Number.isNaN(Date.parse(approvedAt)) ||
		(input.gitRoot !== undefined && !gitRoot)
	) {
		return undefined;
	}
	if (!/^[a-f0-9]{64}$/.test(contentDigest)) return undefined;

	return {
		version: APPROVAL_RECORD_VERSION,
		kind: input.kind,
		sessionId,
		entryId,
		contentDigest,
		branchAnchorEntryId,
		canonicalCwd,
		...(gitRoot ? { gitRoot } : {}),
		approvedAt,
	};
}

export function validateApprovalRecord(
	record: ApprovalRecord,
	context: ApprovalValidationContext,
): { ok: true } | { ok: false; reason: string } {
	if (record.sessionId !== context.sessionId) return { ok: false, reason: "Approval session does not match" };
	if (record.canonicalCwd !== context.canonicalCwd) return { ok: false, reason: "Approval cwd does not match" };
	if ((record.gitRoot ?? undefined) !== (context.gitRoot ?? undefined)) {
		return { ok: false, reason: "Approval Git root does not match" };
	}

	const ids = new Set<string>();
	let target: ApprovalMessageEntry | undefined;
	for (const entry of context.branch) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Record<string, unknown>;
		if (typeof candidate.id === "string") ids.add(candidate.id);
		if (candidate.id === record.entryId && candidate.type === "message") {
			const message = candidate.message;
			if (message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant") {
				target = candidate as unknown as ApprovalMessageEntry;
			}
		}
	}

	if (!ids.has(record.branchAnchorEntryId)) return { ok: false, reason: "Approval branch anchor is absent" };
	if (!target) return { ok: false, reason: "Approved assistant entry is absent" };
	if (digestApprovalContent(target.message.content) !== record.contentDigest) {
		return { ok: false, reason: "Approved assistant entry content changed" };
	}

	return { ok: true };
}

export interface PrivilegeConfirmationRequest {
	title: string;
	message: string;
}

export async function requireTuiUserConfirmation(
	ctx: Pick<ExtensionCommandContext, "mode" | "ui">,
	request: PrivilegeConfirmationRequest,
): Promise<boolean> {
	if (ctx.mode !== "tui") return false;
	return ctx.ui.confirm(request.title, request.message);
}
