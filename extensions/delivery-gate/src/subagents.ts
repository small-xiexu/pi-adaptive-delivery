import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	registerSubagentCapabilityCeiling,
	resolveCurrentSubagentCapabilityCeiling,
	type SubagentCapabilityCeiling,
	type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import {
	resolveSubagentLaunchContract,
	type SubagentLaunchContract,
} from "pi-subagents/preflight";

import type { SubagentAccess } from "./domain.ts";
import type { ApprovedPlanContract } from "./plan-contract.ts";

const RPC_PROTOCOL_VERSION = 1 as const;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

export const READONLY_DELEGATE_ROLES = ["scout", "oracle", "reviewer"] as const;
export type ReadonlyDelegateRole = (typeof READONLY_DELEGATE_ROLES)[number];

const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const MUTATION_TOOLS = new Set(["bash", "edit", "write", "subagent", "bg_wait"]);

function ceilingForAccess(accessMode: SubagentAccess): SubagentCapabilityCeiling {
	switch (accessMode) {
		case "readonly":
			return { allowedAgents: READONLY_DELEGATE_ROLES, allowedTools: READONLY_TOOLS, denyExtensions: true };
		case "validation":
			return { allowedAgents: ["reviewer"], allowedTools: ["read", "grep", "find", "ls"], denyExtensions: true };
		case "controlled-writer":
			return { allowedAgents: ["worker", ...READONLY_DELEGATE_ROLES] };
		case "none":
		default:
			return { allowedAgents: [], allowedTools: [] };
	}
}

async function canonicalizePotentialPath(input: string): Promise<string> {
	let existing = path.resolve(input);
	const missing: string[] = [];
	while (true) {
		try {
			await access(existing);
			break;
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) throw new Error(`Cannot resolve path boundary for '${input}'`);
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
	return path.join(await realpath(existing), ...missing);
}

export function pathIsInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function validateReadOnlyContract(
	contract: SubagentLaunchContract,
	role: ReadonlyDelegateRole,
	gitRoot: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (contract.agent.name !== role || contract.agent.source !== "builtin") {
		return { ok: false, reason: `Resolved agent '${contract.agent.name}' is not the builtin '${role}'` };
	}
	if (contract.context !== "fresh") return { ok: false, reason: "Read-only delegation must use fresh context" };
	if (contract.tools.fanoutAuthorized) return { ok: false, reason: "Read-only delegation cannot authorize fanout" };
	if (!contract.tools.disableAmbientExtensions) {
		return { ok: false, reason: "Read-only delegation must disable ambient Extensions" };
	}
	if (contract.tools.capabilityAudit?.extensionsDenied !== true) {
		return { ok: false, reason: "Read-only delegation Extension denial is not proven by capability audit" };
	}
	if (
		contract.tools.effectiveMcpTools.length > 0 ||
		contract.tools.toolExtensionPaths.length > 0
	) {
		return { ok: false, reason: "Read-only delegation cannot load MCP or tool Extension paths" };
	}
	const unsafe = contract.tools.effectiveAllowlist.filter((tool) => MUTATION_TOOLS.has(tool));
	if (unsafe.length > 0) return { ok: false, reason: `Read-only delegation resolved mutation tools: ${unsafe.join(", ")}` };
	if (contract.tools.effectiveAllowlist.some((tool) => !READONLY_TOOLS.includes(tool as (typeof READONLY_TOOLS)[number]))) {
		return { ok: false, reason: "Read-only delegation resolved an unapproved tool" };
	}
	if (contract.roots.outputPath) {
		const canonicalRoot = await realpath(gitRoot);
		const canonicalOutput = await canonicalizePotentialPath(contract.roots.outputPath);
		if (pathIsInside(canonicalRoot, canonicalOutput)) {
			return { ok: false, reason: `Read-only delegation output is inside Git root: ${canonicalOutput}` };
		}
		const managedRoots = [contract.roots.artifactsDir, contract.roots.sessionRoot]
			.filter((root): root is string => typeof root === "string" && root.length > 0);
		if (managedRoots.length === 0) {
			return { ok: false, reason: "Read-only delegation output has no runtime-managed root" };
		}
		let managed = false;
		for (const root of managedRoots) {
			const canonicalManagedRoot = await canonicalizePotentialPath(root);
			if (pathIsInside(canonicalRoot, canonicalManagedRoot)) {
				return { ok: false, reason: `Read-only delegation managed root is inside Git root: ${canonicalManagedRoot}` };
			}
			if (pathIsInside(canonicalManagedRoot, canonicalOutput)) managed = true;
		}
		if (!managed) {
			return { ok: false, reason: `Read-only delegation output is outside runtime-managed roots: ${canonicalOutput}` };
		}
	}
	return { ok: true };
}

interface RpcReply {
	version?: unknown;
	requestId?: unknown;
	success?: unknown;
	data?: unknown;
	error?: { message?: unknown };
}

export type ValidationRunStatus =
	| "queued"
	| "running"
	| "complete"
	| "failed"
	| "partial"
	| "paused"
	| "stopped"
	| "rejected";

const VALIDATION_RUN_STATUSES = new Set<ValidationRunStatus>([
	"queued",
	"running",
	"complete",
	"failed",
	"partial",
	"paused",
	"stopped",
	"rejected",
]);

function validationRunStatusFromSnapshot(data: Record<string, unknown>, runId: string): ValidationRunStatus {
	const snapshot = data.asyncSnapshot;
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
		throw new Error("pi-subagents status response has no async status snapshot");
	}
	const record = snapshot as Record<string, unknown>;
	if (record.kind !== "pi-subagents.async-status-snapshot" || record.version !== 1 || !Array.isArray(record.runs)) {
		throw new Error("pi-subagents async status snapshot is incompatible");
	}
	const matches = record.runs.filter(
		(value): value is Record<string, unknown> =>
			Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).id === runId),
	);
	if (matches.length !== 1) throw new Error(`pi-subagents status did not return exactly one run '${runId}'`);
	const state = matches[0]!.state;
	if (typeof state !== "string" || !VALIDATION_RUN_STATUSES.has(state as ValidationRunStatus)) {
		throw new Error(`pi-subagents run '${runId}' returned an invalid state`);
	}
	return state as ValidationRunStatus;
}

export class SubagentBoundary {
	private ceiling?: SubagentCapabilityCeilingHandle;
	private sessionId?: string;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	bindSession(sessionId: string): void {
		if (this.sessionId === sessionId && this.ceiling) return;
		this.ceiling?.dispose();
		this.sessionId = sessionId;
		this.ceiling = registerSubagentCapabilityCeiling({
			sessionId,
			source: "pi-adaptive-delivery",
			ceiling: ceilingForAccess("none"),
		});
	}

	applyAccess(accessMode: SubagentAccess): void {
		if (!this.ceiling) throw new Error("Subagent capability ceiling is not bound to a session");
		this.ceiling.update(ceilingForAccess(accessMode));
	}

	dispose(): void {
		this.ceiling?.dispose();
		this.ceiling = undefined;
		this.sessionId = undefined;
	}

	async ping(timeoutMs = 2000): Promise<Record<string, unknown>> {
		return this.rpcRequest("ping", undefined, timeoutMs);
	}

	private async rpcRequest(method: "ping" | "spawn" | "status", params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error, value?: Record<string, unknown>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe?.();
				if (error) reject(error);
				else resolve(value ?? {});
			};
			const unsubscribe = this.pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (payload) => {
				const reply = payload as RpcReply;
				if (reply.version !== RPC_PROTOCOL_VERSION || reply.requestId !== requestId) {
					finish(new Error("Invalid pi-subagents RPC ping reply"));
					return;
				}
				if (reply.success !== true || !reply.data || typeof reply.data !== "object") {
					finish(new Error(typeof reply.error?.message === "string" ? reply.error.message : "pi-subagents RPC ping failed"));
					return;
				}
				const data = reply.data as Record<string, unknown>;
				if (
					method === "ping" &&
					(data.version !== RPC_PROTOCOL_VERSION || !Array.isArray(data.methods) || !data.methods.includes("ping"))
				) {
					finish(new Error("Incompatible pi-subagents RPC owner"));
					return;
				}
				finish(undefined, data);
			});
			const timer = setTimeout(() => finish(new Error("pi-subagents RPC owner did not answer ping")), timeoutMs);
			this.pi.events.emit(RPC_REQUEST_EVENT, {
				version: RPC_PROTOCOL_VERSION,
				requestId,
				method,
				...(params === undefined ? {} : { params }),
				source: { extension: "pi-adaptive-delivery" },
			});
		});
	}

	async status(runId: string): Promise<{ state: ValidationRunStatus }> {
		await this.ping();
		const data = await this.rpcRequest("status", { id: runId }, 5000);
		return { state: validationRunStatusFromSnapshot(data, runId) };
	}

	async spawnValidation(
		contract: ApprovedPlanContract,
		candidateDigest: string,
		ctx: ExtensionContext,
	): Promise<{ runId: string; receipt: Record<string, unknown> }> {
		await this.ping();
		const task = [
			"Validate the approved candidate without modifying project/source files.",
			`Candidate digest: ${candidateDigest}`,
			"Report only the runtime verification result and residual risks.",
		].join("\n");
		const acceptance = {
			level: "verified",
			criteria: [`Validation evidence must apply to candidate ${candidateDigest}`],
			evidence: ["commands-run", "validation-output", "residual-risks"],
			verify: contract.validation,
		};
		const workflowScript = [
			"return runs.run(\"candidate-validation\", {",
			"  agent: \"reviewer\",",
			`  task: ${JSON.stringify(task)},`,
			`  acceptance: ${JSON.stringify(acceptance)}`,
			"});",
		].join("\n");
		const receipt = await this.rpcRequest(
			"spawn",
			{
				workflowScript,
				cwd: ctx.cwd,
				context: "fresh",
				async: true,
				mission: false,
			},
			5000,
		);
		const runId = findRunId(receipt);
		if (!runId) throw new Error("pi-subagents validation spawn returned no run id");
		return { runId, receipt };
	}

	async preflight(
		role: ReadonlyDelegateRole,
		task: string,
		ctx: ExtensionContext,
		gitRoot: string,
	): Promise<SubagentLaunchContract> {
		if (!this.sessionId) throw new Error("Subagent boundary is not bound to a session");
		const result = await resolveSubagentLaunchContract({
			agent: role,
			task,
			context: "fresh",
			cwd: ctx.cwd,
			parentModel: ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: undefined,
			availableModels: ctx.modelRegistry.getAvailable(),
			capabilityCeiling: resolveCurrentSubagentCapabilityCeiling(this.sessionId),
			parentSessionFile: ctx.sessionManager.getSessionFile(),
			parentLeafId: ctx.sessionManager.getLeafId(),
		});
		if (!result.ok) throw new Error(result.message);
		const safe = await validateReadOnlyContract(result.contract, role, gitRoot);
		if (!safe.ok) throw new Error(safe.reason);
		return result.contract;
	}

	async delegate(
		role: ReadonlyDelegateRole,
		task: string,
		ctx: ExtensionContext,
		expectedLaunchContractDigest: string,
		signal?: AbortSignal,
		timeoutMs = 120_000,
	): Promise<{ text: string; runId?: string; launchContractDigest?: string }> {
		await this.ping();
		const requestId = randomUUID();
		const ownerRunId = `adaptive-delivery-${ctx.sessionManager.getSessionId()}`;
		const nodeId = `readonly-${role}-${expectedLaunchContractDigest}-${requestId}`;
		const request: SubagentDelegationRequest = {
			requestId,
			ownerRunId,
			nodeId,
			agent: role,
			task,
			context: "fresh",
			cwd: ctx.cwd,
			thinking: role === "scout" ? "low" : "high",
			artifacts: true,
			result: { kind: "text" },
		};

		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				unsubscribe?.();
				signal?.removeEventListener("abort", abort);
			};
			const finish = (error?: Error, value?: { text: string; runId?: string; launchContractDigest?: string }) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve(value ?? { text: "" });
			};
			const abort = () => {
				this.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
				finish(new Error("Read-only delegation aborted"));
			};
			const unsubscribe = this.pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
				const response = payload as SubagentDelegationResponse;
				if (response.requestId !== requestId || response.ownerRunId !== ownerRunId || response.nodeId !== nodeId) return;
				if (response.status !== "completed" || response.result?.kind !== "text") {
					finish(new Error(response.error ?? `Read-only delegation failed: ${response.status}`));
					return;
				}
				if (!response.launchContractDigest || response.launchContractDigest !== expectedLaunchContractDigest) {
					finish(new Error("Read-only delegation terminal launch contract digest is missing or changed"));
					return;
				}
				finish(undefined, {
					text: response.result.text,
					...(response.runId ? { runId: response.runId } : {}),
					...(response.launchContractDigest ? { launchContractDigest: response.launchContractDigest } : {}),
				});
			});
			const timer = setTimeout(() => {
				this.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
				finish(new Error("Read-only delegation timed out"));
			}, timeoutMs);
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			this.pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
		});
	}
}

function findRunId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["runId", "asyncId", "id"]) {
		if (typeof record[key] === "string" && record[key]) return record[key];
	}
	for (const key of ["details", "async", "result"]) {
		const nested = findRunId(record[key]);
		if (nested) return nested;
	}
	return undefined;
}
