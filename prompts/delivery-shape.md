---
description: 只读澄清需求并形成自适应技术方案
argument-hint: "<需求>"
---
使用 `adaptive-delivery` Skill 处理以下需求：

$@

首先调用 `delivery_begin` 保存目标并进入只读方案梳理状态。随后读取当前项目的 `AGENTS.md`、事实源、代码、配置和测试，显式判断复杂度、风险和不确定性。

形成方案前按 `adaptive-delivery` Skill 判断是否需要“方案追问”。用户明确要求“grill me”“把方案问透”“逐项对齐”，或存在无法从项目事实确认且会改变最终效果、范围、共享接口、数据、安全、费用或不可逆行为的决定时，每次只问一个问题，并同时给出推荐答案、理由和不同选择的用户可见影响；等待用户回答后再继续，不得在同一回复列出多个问题或提前输出可批准方案。用户可以只回答“按推荐”。

极小、局部、可逆、验收明确、不涉及共享契约/数据/权限/费用且没有用户决策分支的需求默认零追问，直接生成精简技术方案与实施计划。极小需求只有一个高影响歧义时，只问该问题，回答后立即成案；不要追问实现偏好、命名、纯代码细节、未来扩展或能从项目查明的事项。

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
