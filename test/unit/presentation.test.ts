import assert from "node:assert/strict";
import test from "node:test";

import {
	formatDocumentSelectionSource,
	formatEvidenceValidity,
	formatReviewVerdict,
	formatRuntimeText,
	formatValidationStatus,
	formatValidationVerifyStatus,
	formatWriterKind,
	formatWorkerStatus,
} from "../../extensions/delivery-gate/src/presentation.ts";

test("formats stable internal evidence values as Chinese user text", () => {
	assert.equal(formatEvidenceValidity("current"), "当前有效");
	assert.equal(formatEvidenceValidity("stale"), "已过期");
	assert.equal(formatEvidenceValidity("unproven"), "不可证明");
	assert.equal(formatValidationStatus("pending"), "进行中");
	assert.equal(formatValidationStatus("passed"), "已通过");
	assert.equal(formatValidationStatus("failed"), "失败");
	assert.equal(formatValidationVerifyStatus("passed"), "通过");
	assert.equal(formatValidationVerifyStatus("timed-out"), "超时");
	assert.equal(formatValidationVerifyStatus("cancelled"), "已取消");
	assert.equal(formatValidationVerifyStatus("error"), "未能执行");
	assert.equal(formatReviewVerdict("BLOCK"), "阻塞");
	assert.equal(formatReviewVerdict("OK"), "通过");
	assert.equal(formatReviewVerdict("OK_WITH_NOTES"), "通过（有说明）");
	assert.equal(formatWriterKind("parent"), "父会话");
	assert.equal(formatWriterKind("child"), "子 Agent");
	assert.equal(formatWorkerStatus("starting"), "启动中");
	assert.equal(formatWorkerStatus("running"), "执行中");
	assert.equal(formatWorkerStatus("completed"), "已完成");
	assert.equal(formatWorkerStatus("failed"), "失败");
	assert.equal(formatDocumentSelectionSource("project"), "项目规则");
	assert.equal(formatDocumentSelectionSource("package-default"), "Package 默认");
});

test("translates old and dynamic runtime checkpoint text without mutating identifiers", () => {
	assert.equal(formatRuntimeText("Adaptive Delivery shaping started"), "已开始梳理技术方案");
	assert.equal(
		formatRuntimeText("Inspect project facts and draft the technical solution"),
		"检查项目事实并形成技术方案",
	);
	assert.equal(formatRuntimeText("Technical solution approved"), "技术方案已批准");
	assert.equal(formatRuntimeText("Generate the implementation plan"), "生成实施计划");
	assert.equal(formatRuntimeText("Candidate frozen: abc123"), "候选版本已冻结：abc123");
	assert.equal(formatRuntimeText("Validation launched for run-1"), "已启动候选验证：run-1");
	assert.equal(formatRuntimeText("Delivery plan contract is malformed"), "交付计划契约格式无效");
	assert.equal(formatRuntimeText("Delivery validation failure kind is malformed"), "验证失败类型格式无效");
	assert.equal(
		formatRuntimeText("Resolve the blocking condition, then ask the TUI user to run /delivery-resume"),
		"解决阻塞条件后，由 TUI 用户执行 /delivery-resume",
	);
	assert.equal(
		formatRuntimeText("Required tools are unavailable in the original Pi tool baseline: edit, write"),
		"Pi 原始工具配置缺少当前阶段必需工具：edit, write",
	);
	assert.equal(formatRuntimeText("用户主动暂停"), "用户主动暂停");
	assert.equal(formatRuntimeText("unknown internal failure"), "运行时异常（诊断详情：unknown internal failure）");
});
