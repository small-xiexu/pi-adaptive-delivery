export const PLAN_CONTRACT_VERSION = 1 as const;
export const PLAN_RISKS = ["low", "medium", "high"] as const;
export const PLAN_COMPLEXITIES = ["small", "medium", "large"] as const;
export const PLAN_UNCERTAINTIES = ["low", "medium", "high"] as const;

export type PlanRisk = (typeof PLAN_RISKS)[number];
export type PlanComplexity = (typeof PLAN_COMPLEXITIES)[number];
export type PlanUncertainty = (typeof PLAN_UNCERTAINTIES)[number];

export interface ValidationCommand {
	id: string;
	command: string;
	timeoutMs: number;
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
	validation: readonly ValidationCommand[];
	progressTargets: readonly string[];
	progressChecks: readonly ProgressCheck[];
}

function oneOf<T extends readonly string[]>(value: unknown, options: T): value is T[number] {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

function parseValidation(value: unknown): ValidationCommand[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > 12) return undefined;
	const seen = new Set<string>();
	const commands: ValidationCommand[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return undefined;
		const record = item as Record<string, unknown>;
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
			record.timeoutMs > 3_600_000
		) {
			return undefined;
		}
		seen.add(record.id);
		commands.push({ id: record.id, command: record.command.trim(), timeoutMs: record.timeoutMs });
	}
	return commands;
}

function parseProgressTargets(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 16) return undefined;
	const targets: string[] = [];
	for (const item of value) {
		if (
			typeof item !== "string" ||
			!item.trim() ||
			item.length > 512 ||
			item.includes("\0")
		) {
			return undefined;
		}
		targets.push(item.trim());
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
	const allowed = ["complexity", "progressChecks", "progressTargets", "risk", "uncertainty", "validation", "version"].sort();
	if (keys.some((key) => !allowed.includes(key))) return undefined;
	if (
		input.version !== PLAN_CONTRACT_VERSION ||
		!oneOf(input.risk, PLAN_RISKS) ||
		!oneOf(input.complexity, PLAN_COMPLEXITIES) ||
		!oneOf(input.uncertainty, PLAN_UNCERTAINTIES)
	) {
		return undefined;
	}
	const validation = parseValidation(input.validation);
	const progressTargets = parseProgressTargets(input.progressTargets);
	const progressChecks = parseProgressChecks(input.progressChecks);
	if (!validation || !progressTargets || !progressChecks) return undefined;
	return {
		version: PLAN_CONTRACT_VERSION,
		risk: input.risk,
		complexity: input.complexity,
		uncertainty: input.uncertainty,
		validation,
		progressTargets,
		progressChecks,
	};
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } =>
			Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string"),
		)
		.map((item) => item.text)
		.join("\n");
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
