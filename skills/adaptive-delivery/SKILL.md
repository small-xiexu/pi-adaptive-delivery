---
name: adaptive-delivery
description: 使用技术方案、实施计划、用户授权、单 writer、真实验证和 fresh review，自适应编排 Pi 开发任务。用于 /delivery-shape、/delivery-plan、/delivery-run 或用户要求按 Adaptive Delivery 流程交付时。
---

# Adaptive Delivery

## 不变量

1. 所有修改型任务在实现前必须有技术方案和实施计划。
2. 没有用户批准的实施计划，不得写入项目。
3. 同一个 cwd/worktree 同时只有一个 writer。
4. 只有 runtime 执行的 gate 是 verified evidence。
5. review 必须绑定当前 candidate digest，并使用 fresh context。
6. commit、push、PR、发布和部署需要独立授权。
7. 技术方案和实施计划必须在源码实现前同步为目标项目中的需求级 Markdown。

## 先用大白话对齐最终效果

技术方案先帮助用户判断“你是否真的理解了我要什么”，再解释代码准备怎么改。面向用户的第一层使用尽量直白的语言，依次说明：

1. 父会话对当前需求的简短复述。
2. 做完后用户能够看到或操作到的最终效果。
3. 正常、失败和关键边界场景分别会发生什么。
4. 本次明确不做什么。
5. 可以直接判断完成与否的示例和验收结果。
6. 仍需用户决定的产品、范围或风险选择。

技术术语和实现细节放在第二层，并说明它们如何支撑前述效果。实施计划中的每个里程碑都必须对应已批准效果或验收项；无法对应的工作不进入当前任务。开发、测试或 review 期间若需要改变最终效果、范围、架构、非目标或验收标准，必须停止并请求 `/delivery-revise`，不能借实现细节静默偏离原计划。

## 规划文档路径

先读取并服从用户明确要求、目标项目最近的 `AGENTS.md` 与文档索引、用户全局规则；Package 默认只补空白。已有总技术方案或总实施计划默认是只读背景，不因为存在就自动追加。除非规则明确要求复用，否则使用同一需求短名称创建：

```text
docs/<需求短名称>-技术方案.md
docs/<需求短名称>-实施计划.md
```

需求短名称描述稳定用户目标，不使用日期、版本尾缀、代码行号或可能变化的实现方式。方案回复必须展示需求名、两条路径和 `user|project|global|package-default` 选择来源。规则冲突、远程 Issue/TODO、多个唯一台账候选或路径职责不明确时停止询问，不能静默 fallback。

solution 正文放在唯一 `<!-- adaptive-delivery:solution:start|end -->` 标记内，并包含唯一 `adaptive-delivery-documents` v1 fence；`/delivery-approve-solution` 在 TUI 中显示并冻结需求名、路径和来源。plan 正文和唯一 `adaptive-delivery-plan` v2 fence 放在唯一 `<!-- adaptive-delivery:plan:start|end -->` 标记内，plan 的 `documents` 必须与已批准 solution 契约逐字段一致，`documents.planPath` 必须同时进入 `progressTargets`。用户批准 plan 后，Extension 只 create-only 写入两份新 Markdown；目标存在或任一路径无法证明时保持只读。两份文档成功并记录摘要后才进入 `IMPLEMENTING`。Session entry 仍是批准主体，文件不能反向授予权限。

显示 plan 批准对话前，Extension 必须用 pi-subagents 公开 preflight 证明 builtin reviewer 至少有一个可用 model candidate，且只读工具、`denyExtensions`、output 和 cwd 边界成立。preflight 不启动 child 或调用 Provider。无可用 reviewer/fallback 时保持待批准和只读，先让用户修复模型配置；不得先实现再等验证资源。

这些 marker 和 JSON fence 只属于内部协议；Extension 在 TUI 显示和规划文档落盘时隐藏它们。父会话仍需输出完整协议供原始 Session 解析，但面向用户的正文不能要求用户阅读或解释内部 JSON。

正常 TUI 流程只要求用户执行批准或恢复确认：solution approval 成功后 Extension 显示可见状态并自动展开 `/delivery-plan`；plan approval、文档同步和策略提交成功后显示两条路径并自动展开 `/delivery-run`。`/delivery-resume` 经 TUI 用户确认且状态、lease、策略全部提交成功后也自动继续：`PLANNING` 展开 `/delivery-plan`，`IMPLEMENTING`、`REWORKING`、`VALIDATING` 展开 `/delivery-run`；待批准状态继续等待用户，不能自动批准。两条模板命令继续作为手工恢复入口。非 TUI、用户取消、同步或状态提交失败不得自动继续；自动发送本身失败时保留已批准或已恢复状态并明确提示手工命令。

## 自适应路由

- 小型、低风险、低不确定性：父 Pi 是唯一 writer，直接实现后 focused validation。
- 中大型或中等风险：父 Pi 只编排，单 foreground worker 是唯一实现者，再运行 runtime gate + fresh reviewer。
- 高风险或高不确定性：方案阶段增加只读 oracle，父 Pi 只编排，单 foreground worker 实现并增加多角度 reviewer。

风险优先于代码量。认证、授权、密钥、迁移、删除、费用和生产操作始终按高风险处理。

## 方案与计划

技术方案回答“为什么改、改成什么”，必须基于当前项目事实，并包含目标、非目标、验收、设计、取舍和风险。

实施计划回答“如何落地和证明完成”，必须包含有序里程碑、边界、测试、停止条件，并给出唯一 `adaptive-delivery-plan` v2 JSON fence。该 fence 只承载批准的风险分类、需求级文档路径、验证命令和 progress target/check，不定义项目进度格式。

## 子 Agent 契约

每个 child task 都要独立包含：目标、cwd、批准范围、相关事实源、禁止动作、完成条件、验证、输出和停止条件。

- 审批前只能调用 `delivery_delegate_readonly`。
- writer 只能处理当前批准里程碑，不得启动子 Agent。
- reviewer 只读、fresh context，只报告有源码、测试、复现或契约证据的发现。
- oracle 只用于重大方向和取舍，不作最终决定。

## 实现、审查与收敛

Delivery 工具按状态动态开放。任何时候不确定当前阶段时，先调用只读的 `delivery_runtime_status`：

- `IMPLEMENTING` 和授权 `REWORKING` 根据 plan route 二选一：`single` 只给父 Pi 源码写入工具与 `delivery_submit_candidate`；`standard/high-risk` 从父 Pi 移除源码写入，只给 `delivery_delegate_worker`。
- `delivery_delegate_worker` 使用 builtin fresh foreground worker。父进程在 child 运行期间保管 workspace lease，但没有写工具、没有并行下一回合，且 tool-batch barrier 拒绝 sibling write；匹配 run ID 和 `launchContractDigest` 的 terminal response 到达后才自动冻结 candidate 与释放 lease。proof 缺失时保留 lease并 BLOCKED。
- 候选提交成功、状态切到 `VALIDATING` 后，验证、审查、返工和完成工具才会在下一次模型请求中出现。
- 后续阶段工具提前不可见不是运行时故障，不得以此为由撤销批准或删除规划文档。
- 当前阶段必需工具确实缺失时可以 `delivery_invalidate(target=BLOCKED)` 暂停；该动作只释放 writer 并保留批准链、规划文档、candidate 和 evidence。恢复权限仍必须由 TUI 用户执行 `/delivery-resume`。
- 只有需求、范围、架构或计划真的失效时，才使用 `SHAPING` 或 `PLANNING` 目标撤销相应批准。
- `delivery_validate` 不启动 AI child。Extension 只通过 Pi 公开 `pi.exec` 顺序执行已批准 plan contract 中的命令，并在同一个工具调用中显示当前命令、退出码和耗时；父 Pi 只调用一次，不得定时轮询 `delivery_runtime_status`。
- validation terminal checkpoint 保存绑定 candidate 的批次 ID 和逐命令摘要。命令无法启动、工具中断或 terminal checkpoint 缺失按 infrastructure failure；真实非零退出或超时只证明批准命令未通过。父会话必须再区分候选代码、验证环境和已批准计划，只有代码问题调用 `delivery_begin_rework`，计划错误使用 `/delivery-revise`。

```text
single: 父 Pi 实现 -> delivery_submit_candidate
standard/high-risk: 唯一 worker 实现 -> terminal proof -> 自动冻结 candidate
  -> delivery_validate
  -> 同一 candidate 的集中 review wave
  -> 父会话裁决
  -> accepted P0/P1 转成可验证关闭义务
  -> 同一路由的唯一 writer 批量返工并运行确定性复验
  -> 一次 closure review
  -> delivery_finalize 或升级设计
```

第一次返工前尽量集中发现同一 candidate 上的阻断问题：中风险通常使用一个完整 reviewer，高风险可以使用不同角度的只读 reviewer 并行检查，再由父会话一次性去重和裁决。

每个 accepted P0/P1 必须记录被破坏的不变量、最小复现或源码矛盾、修复后断言、影响边界和关闭证据。返工期间依靠 regression/property test、固定 gate 或其他确定性证据关闭这些义务，不在每个局部修改后重新启动完整 review。

返工候选只做一次 closure review，检查原 accepted P0/P1 和修复直接引入的 regression。与修复无关的历史问题另开任务；P2、推测性意见和未来优化只报告，不自动返工。

同一最小复现仍失败，或同一不变量继续出现新的 P0/P1 变体，说明当前修复方式没有收敛：返回 `SHAPING` 或 `PLANNING` 重做相应机制并重新批准，不能继续堆叠补丁。次数或资源预算只防止失控执行；只有仍存在已证实、未关闭的 P0/P1 才 `BLOCKED`，全部关闭义务通过后应交付并报告残余风险。

## 进度与恢复

Extension checkpoint 是运行时恢复事实；项目自己的计划、Issue 或 TODO 是项目进度事实。二者冲突时进入 BLOCKED，不自动覆盖。

只在无活跃 writer 且 lease 状态可证明时同步项目进度。断线恢复先只读校验批准、lease、candidate 和 evidence，再从 `nextReadyAction` 继续；不得重放结果未知的写入或命令。

## 停止条件

遇到以下情况立即停止并请求用户决定：

- 新产品、范围或架构决策
- 批准条目、cwd、lease 或 candidate 无法证明
- accepted P0/P1 需要改变已批准范围、架构或验收标准
- 同一复现或不变量在返工后仍失败，需要升级设计
- 真实 Provider、费用、凭证、生产或不可逆操作
- commit、push、PR、发布或部署

## 最终交付

最终报告包含：改动文件、candidate digest、命令与结果、accepted P0/P1 的关闭证据、closure review 结果、项目进度同步状态、残余风险、用户验收状态，以及 commit/push/PR/publish/deploy 是否执行。
