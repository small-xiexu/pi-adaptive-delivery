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
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationStatus,
	type SubagentDelegationUpdate,
} from "pi-subagents/delegation";
import {
	resolveSubagentLaunchContract,
	type SubagentLaunchContract,
} from "pi-subagents/preflight";

import type { SubagentAccess } from "./domain.ts";

const RPC_PROTOCOL_VERSION = 1 as const;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

export const READONLY_DELEGATE_ROLES = ["scout", "oracle", "reviewer"] as const;
export type ReadonlyDelegateRole = (typeof READONLY_DELEGATE_ROLES)[number];

const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const WORKER_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;
const MUTATION_TOOLS = new Set(["bash", "edit", "write", "subagent", "bg_wait"]);

function ceilingForAccess(accessMode: SubagentAccess): SubagentCapabilityCeiling {
	switch (accessMode) {
		case "readonly":
			return { allowedAgents: READONLY_DELEGATE_ROLES, allowedTools: READONLY_TOOLS, denyExtensions: true };
		case "validation":
			return { allowedAgents: ["reviewer"], allowedTools: ["read", "grep", "find", "ls"], denyExtensions: true };
		case "controlled-writer":
			return { allowedAgents: ["worker"], allowedTools: WORKER_TOOLS, denyExtensions: true };
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

async function validateManagedOutput(contract: SubagentLaunchContract, gitRoot: string, label: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!contract.roots.outputPath) return { ok: true };
	const canonicalRoot = await realpath(gitRoot);
	const canonicalOutput = await canonicalizePotentialPath(contract.roots.outputPath);
	if (pathIsInside(canonicalRoot, canonicalOutput)) {
		return { ok: false, reason: `${label} output is inside Git root: ${canonicalOutput}` };
	}
	const managedRoots = [contract.roots.artifactsDir, contract.roots.sessionRoot]
		.filter((root): root is string => typeof root === "string" && root.length > 0);
	if (managedRoots.length === 0) {
		return { ok: false, reason: `${label} output has no runtime-managed root` };
	}
	let managed = false;
	for (const root of managedRoots) {
		const canonicalManagedRoot = await canonicalizePotentialPath(root);
		if (pathIsInside(canonicalRoot, canonicalManagedRoot)) {
			return { ok: false, reason: `${label} managed root is inside Git root: ${canonicalManagedRoot}` };
		}
		if (pathIsInside(canonicalManagedRoot, canonicalOutput)) managed = true;
	}
	return managed
		? { ok: true }
		: { ok: false, reason: `${label} output is outside runtime-managed roots: ${canonicalOutput}` };
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
	return validateManagedOutput(contract, gitRoot, "Read-only delegation");
}

export async function validateWorkerContract(
	contract: SubagentLaunchContract,
	gitRoot: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (contract.agent.name !== "worker" || contract.agent.source !== "builtin") {
		return { ok: false, reason: `Resolved agent '${contract.agent.name}' is not the builtin 'worker'` };
	}
	if (contract.context !== "fresh") return { ok: false, reason: "Worker delegation must use fresh context" };
	if (contract.tools.fanoutAuthorized) return { ok: false, reason: "Worker delegation cannot authorize fanout" };
	if (!contract.tools.disableAmbientExtensions || contract.tools.capabilityAudit?.extensionsDenied !== true) {
		return { ok: false, reason: "Worker delegation must prove ambient Extensions are disabled" };
	}
	if (contract.tools.effectiveMcpTools.length > 0 || contract.tools.toolExtensionPaths.length > 0) {
		return { ok: false, reason: "Worker delegation cannot load MCP or tool Extension paths" };
	}
	if (contract.tools.effectiveAllowlist.some((tool) => !WORKER_TOOLS.includes(tool as (typeof WORKER_TOOLS)[number]))) {
		return { ok: false, reason: "Worker delegation resolved an unapproved tool" };
	}
	for (const required of ["edit", "write"] as const) {
		if (!contract.tools.effectiveAllowlist.includes(required)) {
			return { ok: false, reason: `Worker delegation is missing required tool '${required}'` };
		}
	}
	return validateManagedOutput(contract, gitRoot, "Worker delegation");
}

interface RpcReply {
	version?: unknown;
	requestId?: unknown;
	success?: unknown;
	data?: unknown;
	error?: { message?: unknown };
}

export interface WorkerDelegationResult {
	status: Exclude<SubagentDelegationStatus, "invalid_request">;
	runId: string;
	launchContractDigest: string;
	text?: string;
	error?: string;
	model?: string;
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

	private async rpcRequest(method: "ping", params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
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
		if (result.contract.modelCandidates.length === 0) {
			throw new Error(`No usable subagent model is configured for builtin '${role}'`);
		}
		const safe = await validateReadOnlyContract(result.contract, role, gitRoot);
		if (!safe.ok) throw new Error(safe.reason);
		return result.contract;
	}

	async preflightWorker(
		task: string,
		ctx: ExtensionContext,
		gitRoot: string,
	): Promise<SubagentLaunchContract> {
		if (!this.sessionId) throw new Error("Subagent boundary is not bound to a session");
		const result = await resolveSubagentLaunchContract({
			agent: "worker",
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
		if (result.contract.modelCandidates.length === 0) {
			throw new Error("No usable subagent model is configured for builtin 'worker'");
		}
		const safe = await validateWorkerContract(result.contract, gitRoot);
		if (!safe.ok) throw new Error(safe.reason);
		return result.contract;
	}

	async delegateWorker(
		task: string,
		ctx: ExtensionContext,
		expectedLaunchContractDigest: string,
		options: {
			signal?: AbortSignal;
			timeoutMs?: number;
			onRunId?: (runId: string) => void;
			onUpdate?: (update: SubagentDelegationUpdate) => void;
		} = {},
	): Promise<WorkerDelegationResult> {
		await this.ping();
		const requestId = randomUUID();
		const ownerRunId = `adaptive-delivery-${ctx.sessionManager.getSessionId()}`;
		const nodeId = `worker-${expectedLaunchContractDigest}-${requestId}`;
		const request: SubagentDelegationRequest = {
			requestId,
			ownerRunId,
			nodeId,
			agent: "worker",
			task,
			context: "fresh",
			cwd: ctx.cwd,
			thinking: "high",
			artifacts: true,
			result: { kind: "text" },
		};

		return new Promise((resolve, reject) => {
			let settled = false;
			let observedRunId: string | undefined;
			const cleanup = () => {
				clearTimeout(timer);
				unsubscribeUpdate?.();
				unsubscribeResponse?.();
				options.signal?.removeEventListener("abort", abort);
			};
			const finish = (error?: Error, value?: WorkerDelegationResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else if (value) resolve(value);
				else reject(new Error("Worker delegation finished without a terminal result"));
			};
			const abort = () => {
				this.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
				finish(new Error("Worker delegation aborted before terminal proof"));
			};
			const unsubscribeUpdate = this.pi.events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (payload) => {
				const update = payload as SubagentDelegationUpdate;
				if (update.requestId !== requestId || update.ownerRunId !== ownerRunId || update.nodeId !== nodeId) return;
				if (update.runId) {
					if (observedRunId && observedRunId !== update.runId) {
						this.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
						finish(new Error("Worker delegation run id changed during execution"));
						return;
					}
					if (!observedRunId) {
						observedRunId = update.runId;
						options.onRunId?.(update.runId);
					}
				}
				options.onUpdate?.(update);
			});
			const unsubscribeResponse = this.pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
				const response = payload as SubagentDelegationResponse;
				if (response.requestId !== requestId || response.ownerRunId !== ownerRunId || response.nodeId !== nodeId) return;
				if (response.status === "invalid_request") {
					finish(new Error(response.error ?? "Worker delegation request was rejected"));
					return;
				}
				if (!response.runId || (observedRunId && response.runId !== observedRunId)) {
					finish(new Error("Worker delegation terminal run id is missing or changed"));
					return;
				}
				if (!response.launchContractDigest || response.launchContractDigest !== expectedLaunchContractDigest) {
					finish(new Error("Worker delegation terminal launch contract digest is missing or changed"));
					return;
				}
				finish(undefined, {
					status: response.status as WorkerDelegationResult["status"],
					runId: response.runId,
					launchContractDigest: response.launchContractDigest,
					...(response.result?.kind === "text" ? { text: response.result.text } : {}),
					...(response.error ? { error: response.error } : {}),
					...(response.model ? { model: response.model } : {}),
				});
			});
			const timer = setTimeout(() => {
				this.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
				finish(new Error("Worker delegation timed out before terminal proof"));
			}, options.timeoutMs ?? 30 * 60_000);
			if (options.signal?.aborted) {
				abort();
				return;
			}
			options.signal?.addEventListener("abort", abort, { once: true });
			this.pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
		});
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
