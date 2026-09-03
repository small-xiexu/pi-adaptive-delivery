---
description: 按已批准计划持续编排到开发交付
argument-hint: "[当前交付补充要求]"
---
使用 `adaptive-delivery` Skill，按当前 Session 中已批准的实施计划和以下补充要求持续编排：

$@

只在状态为 `IMPLEMENTING` 或授权 `REWORKING` 且 writer lease 有效时修改项目。严格保持一个 writer，并以 `delivery_runtime_status` 返回的 `implementationWriter` 为准：

工具按阶段开放，不会一次全部出现。先使用 `delivery_runtime_status` 核对当前状态和当前可用工具：

- `implementationWriter=parent`：适用于 Tiny 或兼容的 plan-v2 `single` 路径。Tiny 只能修改 contract 的 exact `changeScope`；父 Pi 完成后调用 `delivery_submit_candidate`。
- `implementationWriter=worker`：适用于 `standard/high-risk`。父 Pi 不得修改源码，只调用 `delivery_delegate_worker`；唯一 foreground worker terminal 成功后，Extension 自动冻结 candidate、释放 lease 并进入 `VALIDATING`。
- candidate 成功冻结后，从下一次模型请求开始开放 `delivery_validate`、`delivery_review_candidate`、`delivery_begin_rework` 和 `delivery_finalize`。
- 未来阶段工具当前不可见是正常行为，不能仅因此调用 `delivery_invalidate`。只有当前阶段必需工具确实缺失或其他前置条件无法证明时，才暂时进入 `BLOCKED`；该阻塞保留批准、规划文档和已有证据，等待 TUI 用户恢复。

1. `parent` 路径按批准范围直接实现；`worker` 路径把完整批准上下文交给唯一 worker，父 Pi 只监督和裁决。
2. `parent` 路径使用 `delivery_submit_candidate`；`worker` 路径由 `delivery_delegate_worker` 在 terminal proof 后自动提交候选。
3. 在 `VALIDATING` 只调用一次 `delivery_validate`。Extension 在当前工具卡中顺序执行并显示已批准命令；不要调用 `delivery_runtime_status` 定时轮询，也不要另启验证子 Agent。
4. Tiny 固定验证全部通过后直接 `delivery_finalize`，不调用 reviewer 或 progress sync。Standard/High-Risk 使用 `delivery_review_candidate` 进行 fresh-context 独立审查；reviewer 必须审查 runtime 提供并绑定当前 candidate 的 actual diff。命令失败时先区分候选代码、验证环境和已批准计划：只有代码问题进入返工，计划错误使用 `/delivery-revise`。
5. 父会话一次性裁决有证据的 P0/P1，把 accepted findings 转成可验证关闭义务并交给原 writer 批量返工。
6. 返工候选通过确定性复验后只做一次 closure review；同一复现或不变量再次失败时返回方案或计划阶段升级设计，不继续堆叠补丁。
7. Standard/High-Risk 在 writer-free 边界按项目规则使用 `delivery_progress_sync` 同步项目进度；Tiny 不注册 progress target。
8. Tiny 发现 scope expansion 时立即 `delivery_invalidate(target=SHAPING)`，停止写入、保留 partial diff 并升级 Standard/High-Risk；不得自行扩展 scope。未授权决策、未知进程、stale candidate 或门禁失败才进入 BLOCKED，并记录可复验的具体原因。

不得自动 commit、push、创建 PR、npm publish 或部署。最终报告必须列出验证证据、残余风险和所有未执行发布动作。
