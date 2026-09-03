import path from "node:path";

import {
	parseValidationCommands,
	textFromContent,
	type ValidationCommand,
} from "./plan-contract.ts";

export const TINY_CONTRACT_VERSION = 1 as const;

export interface TinyEligibility {
	risk: "low";
	uncertainty: "low";
	userOutcomeClear: true;
	productOrArchitectureDecision: false;
	reversibleWorkspaceOnly: true;
	sharedContractChange: false;
	highRiskDomain: false;
	externalSideEffect: false;
	dependencyOrToolchainChange: false;
	focusedDeterministicValidation: true;
}

export interface TinyDeliveryContract {
	version: typeof TINY_CONTRACT_VERSION;
	intent: string;
	nonGoals: readonly string[];
	changeScope: readonly string[];
	validation: readonly ValidationCommand[];
	review: "none";
	eligibility: TinyEligibility;
}

const ELIGIBILITY_KEYS = [
	"dependencyOrToolchainChange",
	"externalSideEffect",
	"focusedDeterministicValidation",
	"highRiskDomain",
	"productOrArchitectureDecision",
	"reversibleWorkspaceOnly",
	"risk",
	"sharedContractChange",
	"uncertainty",
	"userOutcomeClear",
] as const;

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(input).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : undefined;
}

function stringList(value: unknown, maximum: number): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return undefined;
	const result: string[] = [];
	for (const item of value) {
		const normalized = boundedText(item, 2_000);
		if (!normalized || result.includes(normalized)) return undefined;
		result.push(normalized);
	}
	return result;
}

export function parseTinyScopePath(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value !== value.trim() ||
		value.length > 512 ||
		value.includes("\0") ||
		/[\r\n\\]/.test(value) ||
		path.posix.isAbsolute(value) ||
		/^[A-Za-z]:[\\/]/.test(value)
	) return undefined;
	const components = value.split("/");
	if (components.some((component) => !component || component === "." || component === "..")) return undefined;
	const normalized = path.posix.normalize(value);
	if (normalized !== value || normalized === "." || normalized.startsWith("../")) return undefined;
	const first = components[0]!.toLowerCase();
	if (first === ".git" || first === ".pi" || first === "node_modules") return undefined;
	return value;
}

function parseEligibility(value: unknown): TinyEligibility | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (!exactKeys(input, ELIGIBILITY_KEYS)) return undefined;
	if (
		input.risk !== "low" ||
		input.uncertainty !== "low" ||
		input.userOutcomeClear !== true ||
		input.productOrArchitectureDecision !== false ||
		input.reversibleWorkspaceOnly !== true ||
		input.sharedContractChange !== false ||
		input.highRiskDomain !== false ||
		input.externalSideEffect !== false ||
		input.dependencyOrToolchainChange !== false ||
		input.focusedDeterministicValidation !== true
	) return undefined;
	return input as unknown as TinyEligibility;
}

export function parseTinyContractValue(value: unknown): TinyDeliveryContract | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (!exactKeys(input, ["changeScope", "eligibility", "intent", "nonGoals", "review", "validation", "version"])) {
		return undefined;
	}
	const intent = boundedText(input.intent, 8_000);
	const nonGoals = stringList(input.nonGoals, 12);
	const validation = parseValidationCommands(input.validation);
	const eligibility = parseEligibility(input.eligibility);
	if (
		input.version !== TINY_CONTRACT_VERSION ||
		!intent ||
		!nonGoals ||
		!validation ||
		!eligibility ||
		input.review !== "none" ||
		!Array.isArray(input.changeScope) ||
		input.changeScope.length === 0 ||
		input.changeScope.length > 8
	) return undefined;
	const changeScope: string[] = [];
	for (const item of input.changeScope) {
		const parsed = parseTinyScopePath(item);
		if (!parsed || changeScope.includes(parsed)) return undefined;
		changeScope.push(parsed);
	}
	return {
		version: TINY_CONTRACT_VERSION,
		intent,
		nonGoals,
		changeScope,
		validation,
		review: "none",
		eligibility,
	};
}

export function parseTinyContractFromContent(content: unknown): TinyDeliveryContract | undefined {
	const text = textFromContent(content);
	const matches = [...text.matchAll(/```adaptive-delivery-tiny\s*\n([\s\S]*?)\n```/g)];
	if (matches.length !== 1) return undefined;
	try {
		return parseTinyContractValue(JSON.parse(matches[0]![1]!));
	} catch {
		return undefined;
	}
}

export function stripTinyDeliveryProtocol(markdown: string): string {
	return markdown.replace(
		/(^|\n)[ \t]*```adaptive-delivery-tiny[^\n]*\n[\s\S]*?(?:\n[ \t]*```(?=\n|$)|$)/g,
		"$1",
	).replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}
