import type { DocumentSelectionSource } from "./plan-contract.ts";

export type EvidenceValidity = "current" | "stale" | "unproven";
export type ValidationStatus = "pending" | "passed" | "failed";
export type ReviewVerdict = "BLOCK" | "OK" | "OK_WITH_NOTES";
export type WorkerStatus = "starting" | "running" | "completed" | "failed";
export type ValidationVerifyStatus = "passed" | "failed" | "timed-out" | "allowed-failure" | "cancelled" | "error";

const EXACT_RUNTIME_TEXT: Readonly<Record<string, string>> = {
	"Adaptive Delivery shaping started": "已开始梳理技术方案",
	"Inspect project facts and draft the technical solution": "检查项目事实并形成技术方案",
	"Technical solution approved": "技术方案已批准",
	"Generate the implementation plan": "生成实施计划",
	"Enter implementation using the approved requirement documents": "使用已批准的需求文档开始实现",
		"Run fixed validation and fresh review": "执行固定验证和独立审查",
		"Wait for validation result, then review the same candidate": "等待验证结果，然后审查同一候选版本",
		"Wait in the current validation tool call for terminal command results": "在当前验证工具中等待固定命令终态",
		"Run fresh review for the same candidate": "审查同一候选版本",
		"Classify the failed command as a candidate, environment, or approved-plan problem": "判断失败来自候选代码、验证环境还是已批准计划",
		"Restore validation infrastructure, then retry the same candidate": "恢复本机验证能力后重试同一候选版本",
		"Confirm no validation command is still running, then retry the same candidate": "确认没有遗留验证命令后重试同一候选版本",
		"Retry fixed validation to create recoverable command evidence": "重新执行固定验证并生成可恢复的逐命令证据",
	"Classify findings and either rework or finalize delivery": "裁决审查发现，并决定返工或完成交付",
	"Apply only accepted findings, then submit a new candidate": "只修复已接受的问题，然后提交新候选版本",
	"User TUI acceptance and separately authorized publication actions": "等待用户 TUI 验收；提交和发布仍需单独授权",
	"Complete project progress update and restore the base policy": "完成项目进度更新并恢复基础权限策略",
	"Continue candidate validation": "继续验证当前候选版本",
	"Resolve the blocking condition": "解决当前阻塞条件",
	"Restore the frozen candidate and resume, or revise the plan for intentional drift": "恢复已冻结候选后继续，或为需要保留的漂移修订实施计划",
	"Delivery plan contract is malformed": "交付计划契约格式无效",
	"Delivery state entry is not an object": "交付状态记录不是有效对象",
	"Delivery state snapshot is missing": "交付状态快照缺失",
	"Blocked delivery state has an invalid resume state": "已阻塞状态包含无效的恢复状态",
	"Delivery checkpoint is malformed": "交付断点格式无效",
	"Delivery checkpoint changedFiles is malformed": "交付断点的变更文件列表格式无效",
	"Delivery state updatedAt is invalid": "交付状态更新时间无效",
	"Delivery approvals are malformed": "交付批准记录格式无效",
	"Delivery writer lease reference is malformed": "写入租约引用格式无效",
	"Delivery planning document proposal is malformed": "规划文档提案格式无效",
	"Delivery planning document evidence is malformed": "规划文档同步证据格式无效",
	"Delivery candidate digest is malformed": "候选版本摘要格式无效",
	"Delivery validation status is malformed": "验证状态格式无效",
	"Delivery validation failure kind is malformed": "验证失败类型格式无效",
	"Delivery validation failure kind requires failed validation status": "验证失败类型与验证状态不一致",
	"Delivery review evidence is malformed": "审查证据格式无效",
	"Delivery rework approval is malformed": "返工批准记录格式无效",
	"Delivery final evidence is malformed": "最终交付证据格式无效",
	"Delivery worker status is malformed": "开发执行者状态格式无效",
	"Delivery worker status requires a run id": "开发执行者状态缺少运行 ID",
	"Delivery worker launch contract digest is malformed": "开发执行者启动契约摘要格式无效",
	"Writer lease cannot be proven for the current process": "无法证明当前进程持有写入租约",
	"Validation completed without an active parent context": "验证完成时父会话上下文不可用",
	"Candidate changed after evidence was requested": "请求验证证据后候选版本发生变化",
	"Planning document contract is missing": "缺少规划文档契约",
	"A valid solution approval is required before planning": "编写实施计划前需要有效的技术方案批准",
	"Implementation requires solution+plan approvals or one combined approval": "实现阶段需要技术方案与实施计划批准，或一次有效的合并批准",
	"Approved plan contract is missing": "缺少已批准的实施计划契约",
	"Approved plan entry is absent": "当前分支缺少已批准的实施计划消息",
	"Approved plan entry no longer contains a valid plan contract": "已批准的实施计划消息不再包含有效契约",
	"Runtime plan contract does not match the approved assistant entry": "运行时实施计划契约与已批准消息不一致",
	"Planning document paths do not match the approved solution entry": "规划文档路径与已批准技术方案不一致",
	"Approved planning documents have not been synchronized": "已批准的规划文档尚未完成同步",
	"Planning document evidence does not match the approved entries": "规划文档同步证据与已批准内容不一致",
	"Candidate digest is required for validation or rework": "验证或返工前需要有效的候选版本摘要",
	"Writer lease was force-released by the user": "用户已强制释放写入租约",
	"writer authorization or lease is not proven": "无法证明写入授权或租约",
	"progress-sync preconditions are not proven": "无法证明进度同步前置条件",
	"Resolve the blocking condition, then ask the TUI user to run /delivery-resume": "解决阻塞条件后，由 TUI 用户执行 /delivery-resume",
};

const PREFIX_RUNTIME_TEXT: ReadonlyArray<readonly [string, string]> = [
	["Technical solution synchronized: ", "技术方案已同步："],
	["Planning documents synchronized for ", "规划文档已同步："],
	["Candidate frozen: ", "候选版本已冻结："],
	["Validation launched for ", "已启动候选验证："],
	["Validation started for ", "已开始候选验证："],
	["Validation passed for ", "候选验证已通过："],
	["Approved validation failed for ", "批准的固定验证未通过："],
	["Validation infrastructure failed for ", "本机验证执行失败："],
	["Fresh review completed for ", "独立审查已完成："],
	["Rework approved: ", "返工已批准："],
	["Delivery finalized for ", "交付已完成："],
	["progress-sync started for ", "已开始同步项目进度："],
	["Project progress synchronized: ", "项目进度已同步："],
	["Failed to persist delivery checkpoint: ", "保存交付断点失败："],
	["Failed to validate delivery approvals: ", "校验交付批准失败："],
	["Pending validation status cannot be proven: ", "无法证明待处理验证的状态："],
	["Validation was interrupted before its terminal checkpoint", "验证在保存终态前被中断"],
	["Passed validation state has no recoverable command evidence", "旧验证状态缺少可恢复的逐命令证据"],
	["Candidate changed after validation completed", "验证完成后候选版本发生变化"],
	["Validation run failed: ", "验证运行失败："],
	["Validation infrastructure failure must be retried before code rework", "验证基础设施失败必须先重试，不能直接返工代码"],
	["No usable subagent model is configured for builtin ", "内置子 Agent 没有可用模型："],
	["Cannot commit state transition because read-only policy failed: ", "只读策略应用失败，无法提交状态转换："],
	["Failed to apply delivery policy", "应用交付权限策略失败"],
	["Failed to capture the original Pi tool baseline: ", "无法读取 Pi 原始工具基线："],
	["Required tools are unavailable in the original Pi tool baseline: ", "Pi 原始工具配置缺少当前阶段必需工具："],
	["Pi did not activate required tools: ", "Pi 未能启用当前阶段必需工具："],
	["Controlled worker preflight failed: ", "唯一 worker 预检失败："],
	["Controlled worker terminal proof is unavailable: ", "无法证明唯一 worker 已终止："],
	["Controlled worker failed: ", "唯一 worker 执行失败："],
	["Candidate snapshot failed after controlled worker: ", "唯一 worker 结束后冻结候选失败："],
	["Authorization bundle is invalid: ", "授权信息无效："],
	["Planning documents cannot be proven: ", "无法证明规划文档："],
	["Planning document synchronization failed: ", "规划文档同步失败："],
	["Cannot revise while writer lease ownership is unproven", "无法证明写入租约归属，不能修改方案"],
	["Cannot cancel while writer lease ownership is unproven", "无法证明写入租约归属，不能取消流程"],
	["Cannot submit candidate while writer lease ownership is unproven", "无法证明写入租约归属，不能提交候选版本"],
	["Progress sync failed: ", "项目进度同步失败："],
	["Cannot invalidate because read-only policy failed: ", "只读策略应用失败，无法撤销授权："],
	["Cannot invalidate while writer lease ownership is unproven", "无法证明写入租约归属，不能撤销授权"],
	["Illegal delivery transition: ", "不允许的交付状态转换："],
	["Unsupported delivery state version: ", "不支持的交付状态版本："],
	["Unknown delivery state: ", "未知交付状态："],
	["Invalid delivery resume state: ", "无效的交付恢复状态："],
	["Approval session does not match", "批准记录与当前 Session 不匹配"],
	["Approval cwd does not match", "批准记录与当前工作目录不匹配"],
	["Approval Git root does not match", "批准记录与当前 Git 根目录不匹配"],
	["Approval branch anchor is absent", "当前分支缺少批准锚点"],
	["Approved assistant entry is absent", "当前分支缺少已批准的 assistant 消息"],
	["Approved assistant entry content changed", "已批准的 assistant 消息内容发生变化"],
];

export function formatEvidenceValidity(value: EvidenceValidity): string {
	return value === "current" ? "当前有效" : value === "stale" ? "已过期" : "不可证明";
}

export function formatValidationStatus(value: ValidationStatus): string {
	return value === "pending" ? "进行中" : value === "passed" ? "已通过" : "失败";
}

export function formatValidationVerifyStatus(value: ValidationVerifyStatus): string {
	switch (value) {
		case "passed":
			return "通过";
		case "failed":
			return "失败";
		case "timed-out":
			return "超时";
		case "allowed-failure":
			return "允许失败";
		case "cancelled":
			return "已取消";
		case "error":
			return "未能执行";
	}
}

export function formatReviewVerdict(value: ReviewVerdict): string {
	return value === "BLOCK" ? "阻塞" : value === "OK" ? "通过" : "通过（有说明）";
}

export function formatWorkerStatus(value: WorkerStatus): string {
	return value === "starting"
		? "启动中"
		: value === "running"
			? "执行中"
			: value === "completed"
				? "已完成"
				: "失败";
}

export function formatWriterKind(value: "parent" | "child"): string {
	return value === "parent" ? "父会话" : "子 Agent";
}

export function formatDocumentSelectionSource(value: DocumentSelectionSource): string {
	switch (value) {
		case "user":
			return "用户指定";
		case "project":
			return "项目规则";
		case "global":
			return "用户全局规则";
		case "package-default":
			return "Package 默认";
	}
}

export function formatRuntimeText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const exact = EXACT_RUNTIME_TEXT[value];
	if (exact) return exact;
	for (const [prefix, replacement] of PREFIX_RUNTIME_TEXT) {
		if (value.startsWith(prefix)) return `${replacement}${value.slice(prefix.length)}`;
	}
	if (/\p{Script=Han}/u.test(value)) return value;
	return `运行时异常（诊断详情：${value}）`;
}
