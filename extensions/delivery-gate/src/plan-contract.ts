import path from "node:path";

export const PLAN_CONTRACT_VERSION = 2 as const;
export const DOCUMENT_TARGET_CONTRACT_VERSION = 1 as const;
export const PLAN_RISKS = ["low", "medium", "high"] as const;
export const PLAN_COMPLEXITIES = ["small", "medium", "large"] as const;
export const PLAN_UNCERTAINTIES = ["low", "medium", "high"] as const;
export const DOCUMENT_SELECTION_SOURCES = ["user", "project", "global", "package-default"] as const;

export type PlanRisk = (typeof PLAN_RISKS)[number];
export type PlanComplexity = (typeof PLAN_COMPLEXITIES)[number];
export type PlanUncertainty = (typeof PLAN_UNCERTAINTIES)[number];
export type DocumentSelectionSource = (typeof DOCUMENT_SELECTION_SOURCES)[number];

export interface PlanningDocumentsContract {
	requirementName: string;
	solutionPath: string;
	planPath: string;
	selectionSource: DocumentSelectionSource;
}

export interface ValidationCommand {
	id: string;
	command: string;
	timeoutMs: number;
	repairCommand?: string;
	repairTimeoutMs?: number;
}

export interface ProgressCheck {
	id: string;
	command: string;
	args: readonly string[];
	timeoutMs: number;
}

export interface ApprovedPlanContract {
	version: typeof PLAN_CONTRACT_VERSION;
	risk: PlanRisk;
	complexity: PlanComplexity;
	uncertainty: PlanUncertainty;
	documents: PlanningDocumentsContract;
	validation: readonly ValidationCommand[];
	progressTargets: readonly string[];
	progressChecks: readonly ProgressCheck[];
}

function oneOf<T extends readonly string[]>(value: unknown, options: T): value is T[number] {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

function projectRelativePath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f\\]/u.test(value)) return undefined;
	if (value !== value.trim()) return undefined;
	const input = value;
	if (input.length > 512 || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) return undefined;
	const normalized = path.posix.normalize(input);
	if (
		normalized !== input ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return undefined;
	}
	const components = normalized.split("/");
	if (components.some((component) => [".git", ".pi", "node_modules"].includes(component.toLowerCase()))) {
		return undefined;
	}
	return normalized;
}

function planningDocumentPath(value: unknown): string | undefined {
	const normalized = projectRelativePath(value);
	return normalized && path.extname(normalized).toLowerCase() === ".md" ? normalized : undefined;
}

export function parsePlanningDocumentsValue(value: unknown): PlanningDocumentsContract | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input).sort();
	const allowed = ["planPath", "requirementName", "selectionSource", "solutionPath"].sort();
	if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) return undefined;
	if (
		typeof input.requirementName !== "string" ||
		!input.requirementName.trim() ||
		Buffer.byteLength(input.requirementName.trim(), "utf8") > 240 ||
		/[\u0000-\u001f\u007f/\\]/u.test(input.requirementName) ||
		!oneOf(input.selectionSource, DOCUMENT_SELECTION_SOURCES)
	) {
		return undefined;
	}
	const requirementName = input.requirementName.trim();
	const solutionPath = planningDocumentPath(input.solutionPath);
	const planPath = planningDocumentPath(input.planPath);
	if (!solutionPath || !planPath || solutionPath === planPath) return undefined;
	if (!path.basename(solutionPath, ".md").includes(requirementName)) return undefined;
	if (!path.basename(planPath, ".md").includes(requirementName)) return undefined;
	return { requirementName, solutionPath, planPath, selectionSource: input.selectionSource };
}

export function parseValidationCommands(value: unknown): ValidationCommand[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > 12) return undefined;
	const seen = new Set<string>();
	const commands: ValidationCommand[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return undefined;
		const record = item as Record<string, unknown>;
		const hasRepairCommand = Object.hasOwn(record, "repairCommand");
		const hasRepairTimeout = Object.hasOwn(record, "repairTimeoutMs");
		if (
			typeof record.id !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(record.id) ||
			seen.has(record.id) ||
			typeof record.command !== "string" ||
			!record.command.trim() ||
			Buffer.byteLength(record.command, "utf8") > 4096 ||
			typeof record.timeoutMs !== "number" ||
			!Number.isInteger(record.timeoutMs) ||
			record.timeoutMs < 1000 ||
			record.timeoutMs > 3_600_000 ||
			hasRepairCommand !== hasRepairTimeout ||
			(hasRepairCommand && (
				typeof record.repairCommand !== "string" ||
				!record.repairCommand.trim() ||
				Buffer.byteLength(record.repairCommand, "utf8") > 4096 ||
				typeof record.repairTimeoutMs !== "number" ||
				!Number.isInteger(record.repairTimeoutMs) ||
				record.repairTimeoutMs < 1000 ||
				record.repairTimeoutMs > 3_600_000
			))
		) {
			return undefined;
		}
		seen.add(record.id);
		commands.push({
			id: record.id,
			command: record.command.trim(),
			timeoutMs: record.timeoutMs,
			...(hasRepairCommand
				? {
					repairCommand: (record.repairCommand as string).trim(),
					repairTimeoutMs: record.repairTimeoutMs as number,
				}
				: {}),
		});
	}
	return commands;
}

function parseProgressTargets(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 16) return undefined;
	const targets: string[] = [];
	for (const item of value) {
		const target = projectRelativePath(item);
		if (!target) return undefined;
		targets.push(target);
	}
	return [...new Set(targets)];
}

function parseProgressChecks(value: unknown): ProgressCheck[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 8) return undefined;
	const checks: ProgressCheck[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object") return undefined;
		const record = item as Record<string, unknown>;
		if (
			typeof record.id !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(record.id) ||
			seen.has(record.id) ||
			typeof record.command !== "string" ||
			!record.command.trim() ||
			pathLikeCommand(record.command) ||
			!Array.isArray(record.args) ||
			record.args.length > 32 ||
			!record.args.every((arg) => typeof arg === "string" && !arg.includes("\0") && arg.length <= 1024) ||
			typeof record.timeoutMs !== "number" ||
			!Number.isInteger(record.timeoutMs) ||
			record.timeoutMs < 1000 ||
			record.timeoutMs > 300_000
		) {
			return undefined;
		}
		seen.add(record.id);
		checks.push({ id: record.id, command: record.command.trim(), args: [...record.args], timeoutMs: record.timeoutMs });
	}
	return checks;
}

function pathLikeCommand(command: string): boolean {
	return command.includes("\0") || /[\r\n]/.test(command);
}

export function parsePlanContractValue(value: unknown): ApprovedPlanContract | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input).sort();
	const allowed = ["complexity", "documents", "progressChecks", "progressTargets", "risk", "uncertainty", "validation", "version"].sort();
	if (keys.some((key) => !allowed.includes(key))) return undefined;
	if (
		input.version !== PLAN_CONTRACT_VERSION ||
		!oneOf(input.risk, PLAN_RISKS) ||
		!oneOf(input.complexity, PLAN_COMPLEXITIES) ||
		!oneOf(input.uncertainty, PLAN_UNCERTAINTIES)
	) {
		return undefined;
	}
	const validation = parseValidationCommands(input.validation);
	const documents = parsePlanningDocumentsValue(input.documents);
	const progressTargets = parseProgressTargets(input.progressTargets);
	const progressChecks = parseProgressChecks(input.progressChecks);
	if (!validation || !documents || !progressTargets || !progressChecks || !progressTargets.includes(documents.planPath)) {
		return undefined;
	}
	if (
		validation.some((command) => command.repairCommand !== undefined) &&
		input.risk === "low" &&
		input.complexity === "small" &&
		input.uncertainty === "low"
	) return undefined;
	return {
		version: PLAN_CONTRACT_VERSION,
		risk: input.risk,
		complexity: input.complexity,
		uncertainty: input.uncertainty,
		documents,
		validation,
		progressTargets,
		progressChecks,
	};
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } =>
			Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string"),
		)
		.map((item) => item.text)
		.join("\n");
}

export function parsePlanningDocumentsFromContent(content: unknown): PlanningDocumentsContract | undefined {
	const text = textFromContent(content);
	const matches = [...text.matchAll(/```adaptive-delivery-documents\s*\n([\s\S]*?)\n```/g)];
	if (matches.length !== 1) return undefined;
	try {
		const parsed = JSON.parse(matches[0]![1]!);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const { version, ...documents } = parsed as Record<string, unknown>;
		if (version !== DOCUMENT_TARGET_CONTRACT_VERSION) return undefined;
		return parsePlanningDocumentsValue(documents);
	} catch {
		return undefined;
	}
}

export function parsePlanContractFromContent(content: unknown): ApprovedPlanContract | undefined {
	const text = textFromContent(content);
	const matches = [...text.matchAll(/```adaptive-delivery-plan\s*\n([\s\S]*?)\n```/g)];
	if (matches.length !== 1) return undefined;
	try {
		return parsePlanContractValue(JSON.parse(matches[0]![1]!));
	} catch {
		return undefined;
	}
}

export type DeliveryRoute = "single" | "standard" | "high-risk";

export function selectDeliveryRoute(contract: ApprovedPlanContract): DeliveryRoute {
	if (contract.risk === "high" || contract.uncertainty === "high") return "high-risk";
	if (contract.complexity === "small" && contract.risk === "low" && contract.uncertainty === "low") return "single";
	return "standard";
}
