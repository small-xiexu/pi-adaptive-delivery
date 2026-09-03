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
	type SubagentDelegationTerminalResponse,
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

export const PI_SUBAGENTS_RUNTIME_VERSION = "0.64.0";

export const READONLY_DELEGATE_ROLES = ["oracle"] as const;
export type ReadonlyDelegateRole = (typeof READONLY_DELEGATE_ROLES)[number];
type SafeReadOnlyRole = ReadonlyDelegateRole | "reviewer";

const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const WORKER_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;
const MUTATION_TOOLS = new Set(["bash", "edit", "write", "subagent", "bg_wait"]);

function ceilingForAccess(accessMode: SubagentAccess): SubagentCapabilityCeiling {
	switch (accessMode) {
		case "readonly":
			return { allowedAgents: ["oracle", "reviewer"], allowedTools: READONLY_TOOLS, denyExtensions: true };
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
	role: SafeReadOnlyRole,
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
	preflightLaunchContractDigest: string;
	text?: string;
	error?: string;
	model?: string;
}

function terminalContractError(
	response: SubagentDelegationTerminalResponse,
	contract: SubagentLaunchContract,
	expectedAgent: SafeReadOnlyRole | "worker",
): string | undefined {
	if (!response.launchContractDigest || !/^[a-f0-9]{64}$/.test(response.launchContractDigest)) {
		return "Delegation terminal runtime launch contract digest is missing or malformed";
	}
	if (response.agent !== expectedAgent) {
		return `Delegation terminal agent is missing or changed: ${String(response.agent)}`;
	}
	if (!response.model || !contract.modelCandidates.includes(response.model)) {
		return `Delegation terminal model is missing or outside the preflight candidates: ${String(response.model)}`;
	}
	if (contract.thinking && response.thinking !== contract.thinking) {
		return `Delegation terminal thinking level is missing or changed: ${String(response.thinking)}`;
	}
	return undefined;
}

function publicSecurityProjection(contract: SubagentLaunchContract): string {
	return JSON.stringify({
		agent: {
			name: contract.agent.name,
			source: contract.agent.source,
			filePath: contract.agent.filePath,
			definitionDigest: contract.agent.definitionDigest,
		},
		context: contract.context,
		thinking: contract.thinking,
		systemPromptMode: contract.systemPromptMode,
		inheritProjectContext: contract.inheritProjectContext,
		inheritGlobalContext: contract.inheritGlobalContext,
		inheritSkills: contract.inheritSkills,
		skills: contract.skills,
		tools: {
			effectiveAllowlist: contract.tools.effectiveAllowlist,
			effectiveMcpTools: contract.tools.effectiveMcpTools,
			extensionArgs: contract.tools.extensionArgs,
			disableAmbientExtensions: contract.tools.disableAmbientExtensions,
			fanoutAuthorized: contract.tools.fanoutAuthorized,
			capabilityCeiling: contract.tools.capabilityCeiling,
			extensionsDenied: contract.tools.capabilityAudit?.extensionsDenied,
		},
		roots: {
			cwd: contract.roots.cwd,
			outputPath: contract.roots.outputPath,
		},
		protocol: contract.protocol,
	});
}

export function validatePublicPreflightStability(
	initial: SubagentLaunchContract,
	current: SubagentLaunchContract,
): { ok: true } | { ok: false; reason: string } {
	if (publicSecurityProjection(initial) !== publicSecurityProjection(current)) {
		return { ok: false, reason: "Public preflight security projection changed during execution" };
	}
	if (current.modelCandidates.some((candidate) => !initial.modelCandidates.includes(candidate))) {
		return { ok: false, reason: "Public preflight introduced a model candidate after execution started" };
	}
	return { ok: true };
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
			let replyCount = 0;
			let acceptedData: Record<string, unknown> | undefined;
			let settleTimer: NodeJS.Timeout | undefined;
			const finish = (error?: Error, value?: Record<string, unknown>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (settleTimer) clearTimeout(settleTimer);
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
				replyCount += 1;
				if (replyCount > 1) {
					finish(new Error("检测到多个 pi-subagents runtime owner；请只保留 Adaptive Delivery bundled runtime"));
					return;
				}
				acceptedData = data;
				settleTimer = setTimeout(() => finish(undefined, acceptedData), 50);
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
		role: SafeReadOnlyRole,
		task: string,
		ctx: ExtensionContext,
		gitRoot: string,
		runId?: string,
	): Promise<SubagentLaunchContract> {
		if (!this.sessionId) throw new Error("Subagent boundary is not bound to a session");
		await this.ping();
		const result = await resolveSubagentLaunchContract({
			agent: role,
			task,
			context: "fresh",
			cwd: ctx.cwd,
			thinking: "high",
			artifacts: true,
			...(runId ? { runId } : {}),
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
		await this.ping();
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
		preflightContract: SubagentLaunchContract,
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
		const nodeId = `worker-${preflightContract.launchContractDigest}-${requestId}`;
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
				const contractError = terminalContractError(response, preflightContract, "worker");
				if (contractError) {
					finish(new Error(contractError));
					return;
				}
				finish(undefined, {
					status: response.status as WorkerDelegationResult["status"],
					runId: response.runId,
					launchContractDigest: response.launchContractDigest!,
					preflightLaunchContractDigest: preflightContract.launchContractDigest,
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
		role: SafeReadOnlyRole,
		task: string,
		ctx: ExtensionContext,
		preflightContract: SubagentLaunchContract,
		gitRoot: string,
		signal?: AbortSignal,
		timeoutMs = 120_000,
	): Promise<{ text: string; runId: string; launchContractDigest: string; preflightLaunchContractDigest: string }> {
		await this.ping();
		const requestId = randomUUID();
		const ownerRunId = `adaptive-delivery-${ctx.sessionManager.getSessionId()}`;
		const nodeId = `readonly-${role}-${preflightContract.launchContractDigest}-${requestId}`;
		const request: SubagentDelegationRequest = {
			requestId,
			ownerRunId,
			nodeId,
			agent: role,
			task,
			context: "fresh",
			cwd: ctx.cwd,
			thinking: "high",
			artifacts: true,
			result: { kind: "text" },
		};

		return new Promise((resolve, reject) => {
			let settled = false;
			let terminalReceived = false;
			const cleanup = () => {
				clearTimeout(timer);
				unsubscribe?.();
				signal?.removeEventListener("abort", abort);
			};
			const finish = (error?: Error, value?: { text: string; runId: string; launchContractDigest: string; preflightLaunchContractDigest: string }) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else if (value) resolve(value);
				else reject(new Error("Read-only delegation finished without a terminal result"));
			};
			const abort = () => {
				this.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
				finish(new Error("Read-only delegation aborted"));
			};
			const unsubscribe = this.pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
				const response = payload as SubagentDelegationResponse;
				if (response.requestId !== requestId || response.ownerRunId !== ownerRunId || response.nodeId !== nodeId) return;
				if (terminalReceived) {
					finish(new Error("Read-only delegation returned duplicate terminal responses"));
					return;
				}
				terminalReceived = true;
				if (response.status !== "completed" || response.result?.kind !== "text") {
					finish(new Error(response.error ?? `Read-only delegation failed: ${response.status}`));
					return;
				}
				if (!response.runId) {
					finish(new Error("Read-only delegation terminal run id is missing"));
					return;
				}
				const contractError = terminalContractError(response, preflightContract, role);
				if (contractError) {
					finish(new Error(contractError));
					return;
				}
				const terminalText = response.result.text;
				const terminalRunId = response.runId;
				const runtimeDigest = response.launchContractDigest!;
				void this.preflight(role, task, ctx, gitRoot, terminalRunId).then(
					(terminalContract) => {
						const stable = validatePublicPreflightStability(preflightContract, terminalContract);
						if (!stable.ok) {
							finish(new Error(stable.reason));
							return;
						}
						finish(undefined, {
							text: terminalText,
							runId: terminalRunId,
							launchContractDigest: runtimeDigest,
							preflightLaunchContractDigest: preflightContract.launchContractDigest,
						});
					},
					(error) => finish(new Error(
						`Read-only delegation terminal contract cannot be proven: ${error instanceof Error ? error.message : String(error)}`,
					)),
				);
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
