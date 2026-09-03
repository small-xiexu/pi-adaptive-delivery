---
description: 只读澄清需求并形成自适应技术方案
argument-hint: "<需求>"
---
使用 `adaptive-delivery` Skill 处理以下需求：

$@

首先调用 `delivery_begin` 保存目标并进入只读方案梳理状态。随后读取当前项目的 `AGENTS.md`、事实源、代码、配置和测试，显式判断复杂度、风险和不确定性。

普通项目取证由父 Pi 直接使用 `read`、`grep`、`find` 和 `ls` 完成，不为加速而并行启动 scout。只有高风险技术取舍确实需要独立挑战时才调用一次固定只读 `oracle`；只读委派出现 runtime owner、preflight 或终态证明错误时不得重试同一任务，继续使用父 Pi 只读工具或明确报告阻塞。

形成方案前按 `adaptive-delivery` Skill 判断是否需要“方案追问”。用户明确要求“grill me”“把方案问透”“逐项对齐”，或存在无法从项目事实确认且会改变最终效果、范围、共享接口、数据、安全、费用或不可逆行为的决定时，每次只问一个问题，并同时给出推荐答案、理由和不同选择的用户可见影响；等待用户回答后再继续，不得在同一回复列出多个问题或提前输出可批准方案。用户可以只回答“按推荐”。

极小、局部、可逆、验收明确、不涉及共享契约/数据/权限/费用且没有用户决策分支的需求默认零追问，直接生成精简技术方案与实施计划。极小需求只有一个高影响歧义时，只问该问题，回答后立即成案；不要追问实现偏好、命名、纯代码细节、未来扩展或能从项目查明的事项。

图表只在确实帮助理解时生成：极小单步骤需求不强制；中大型任务涉及多步骤流程、跨组件调用、状态变化、模块关系或数据流时，在技术方案正文中加入最有帮助的 1 至 3 张图；高风险任务必须用适用图表画清关键路径、状态变化或信任边界。每张图只回答一个主要问题，复杂流程按“方案与批准”“实现与验证”“阻塞与恢复”等阶段拆图，不把完整生命周期压进一张画布；流程/状态图通常不超过约 10 个主要节点，时序图通常不超过 6 个参与者和 12 条主要消息。节点和连线只写便于扫读的短语，完整解释放在正文；按结构选择横向或纵向布局，避免又高又宽。仅使用标准 Mermaid 的 `flowchart`/`graph`、`sequenceDiagram`、`stateDiagram-v2`、`classDiagram`、`erDiagram` 或 `xychart-beta`，不使用初始化指令。每张图必须有标题或相邻的大白话说明，不能替代文字验收和失败边界。

Mermaid fence 必须位于 solution 标记正文内，确保原始源码进入批准消息和需求技术方案文档。Delivery Gate 会自动在 TUI 中渲染图片或字符回退；不要调用 Bash、外部服务或额外工具生成图片。

提示用户：标准任务执行 `/delivery-approve-solution` 并在 TUI 确认后，Extension 会立即 create-only 写入技术方案文档，再自动生成实施计划；此时仍不开放源码写入。实施计划批准前若需要调整，使用 `/delivery-revise`，重新批准后只在方案文件仍与上次同步摘要一致时更新同一文件。

先按“用户明确要求 -> 项目规则与文档路由 -> 用户全局规则 -> Package 默认”选择需求短名称和规划文档路径。已有总技术方案或总计划默认只作为背景事实，不因存在就追加；没有明确规则时使用 `docs/<需求短名称>-技术方案.md` 与 `docs/<需求短名称>-实施计划.md`。规则冲突或唯一台账不明确时先询问用户。

技术方案正文必须完整放在以下唯一标记之间，并在正文中写明需求短名称、两条目标路径和选择依据：

```text
<!-- adaptive-delivery:solution:start -->
...技术方案 Markdown...
<!-- adaptive-delivery:solution:end -->
```

solution 标记内必须包含且只包含一个路径契约，供 `/delivery-approve-solution` 在 TUI 中展示并冻结：

```adaptive-delivery-documents
{
  "version": 1,
  "requirementName": "用户目标导向的需求短名称",
  "solutionPath": "docs/<需求短名称>-技术方案.md",
  "planPath": "docs/<需求短名称>-实施计划.md",
  "selectionSource": "user | project | global | package-default"
}
```

- 小型低风险任务：在同一回复中分别给出标记完整的技术方案与实施计划；全篇只有一个 `adaptive-delivery-documents` 契约，实施计划使用 `delivery-plan` 相同的 plan 标记和唯一 `adaptive-delivery-plan` v2 契约，且两处 documents 字段完全一致；提示用户运行 `/delivery-approve-plan`。
- 其他任务：只给出技术方案，不生成实施计划；提示用户运行 `/delivery-approve-solution`。
- 高风险任务：先使用固定只读委派入口咨询架构顾问，再由父会话综合。

所有追问答案必须进入最终技术方案；高影响歧义全部关闭后立即停止追问。方案追问负责产品和范围对齐，架构顾问负责高风险技术挑战，不能互相替代。

不得修改项目文件，不得调用原始 `subagent`、任意 Bash、gate 或 acceptance。
