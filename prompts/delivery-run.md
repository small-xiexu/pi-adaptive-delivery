---
description: 按已批准计划持续编排到开发交付
argument-hint: "[当前交付补充要求]"
---
使用 `adaptive-delivery` Skill，按当前 Session 中已批准的实施计划和以下补充要求持续编排：

$@

只在状态为 `IMPLEMENTING` 或授权 `REWORKING` 且 writer lease 有效时修改项目。严格保持一个 writer：

1. 按批准范围实现当前最小里程碑。
2. 使用 `delivery_submit_candidate` 冻结候选并释放 writer lease。
3. 使用 `delivery_validate` 启动批准命令的 runtime verification。
4. 使用 `delivery_review_candidate` 进行 fresh-context 独立审查。
5. 父会话一次性裁决有证据的 P0/P1，把 accepted findings 转成可验证关闭义务并交给原 writer 批量返工。
6. 返工候选通过确定性复验后只做一次 closure review；同一复现或不变量再次失败时返回方案或计划阶段升级设计，不继续堆叠补丁。
7. 在 writer-free 边界按项目规则使用 `delivery_progress_sync` 同步项目进度。
8. 未授权决策、未知进程、stale candidate 或门禁失败立即进入 BLOCKED。

不得自动 commit、push、创建 PR、npm publish 或部署。最终报告必须列出验证证据、残余风险和所有未执行发布动作。
