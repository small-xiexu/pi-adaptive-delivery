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

## 先用大白话对齐最终效果

技术方案先帮助用户判断“你是否真的理解了我要什么”，再解释代码准备怎么改。面向用户的第一层使用尽量直白的语言，依次说明：

1. 父会话对当前需求的简短复述。
2. 做完后用户能够看到或操作到的最终效果。
3. 正常、失败和关键边界场景分别会发生什么。
4. 本次明确不做什么。
5. 可以直接判断完成与否的示例和验收结果。
6. 仍需用户决定的产品、范围或风险选择。

技术术语和实现细节放在第二层，并说明它们如何支撑前述效果。实施计划中的每个里程碑都必须对应已批准效果或验收项；无法对应的工作不进入当前任务。开发、测试或 review 期间若需要改变最终效果、范围、架构、非目标或验收标准，必须停止并请求 `/delivery-revise`，不能借实现细节静默偏离原计划。

## 自适应路由

- 小型、低风险、低不确定性：单强 Agent + focused validation。
- 中大型或中等风险：单 worker + runtime gate + fresh reviewer。
- 高风险或高不确定性：方案阶段增加只读 oracle，开发阶段使用多角度 reviewer。

风险优先于代码量。认证、授权、密钥、迁移、删除、费用和生产操作始终按高风险处理。

## 方案与计划

技术方案回答“为什么改、改成什么”，必须基于当前项目事实，并包含目标、非目标、验收、设计、取舍和风险。

实施计划回答“如何落地和证明完成”，必须包含有序里程碑、边界、测试、停止条件，并在结尾给出唯一 `adaptive-delivery-plan` JSON fence。该 fence 只承载批准的风险分类、验证命令和可选 progress target/check，不定义项目进度格式。

## 子 Agent 契约

每个 child task 都要独立包含：目标、cwd、批准范围、相关事实源、禁止动作、完成条件、验证、输出和停止条件。

- 审批前只能调用 `delivery_delegate_readonly`。
- writer 只能处理当前批准里程碑，不得启动子 Agent。
- reviewer 只读、fresh context，只报告有源码、测试、复现或契约证据的发现。
- oracle 只用于重大方向和取舍，不作最终决定。

## 实现、审查与收敛

```text
单 writer 实现
  -> delivery_submit_candidate
  -> delivery_validate
  -> 同一 candidate 的集中 review wave
  -> 父会话裁决
  -> accepted P0/P1 转成可验证关闭义务
  -> 原 writer 批量返工并运行确定性复验
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
