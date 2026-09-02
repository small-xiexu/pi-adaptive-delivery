---
description: 只读澄清需求并形成自适应技术方案
argument-hint: "<需求>"
---
使用 `adaptive-delivery` Skill 处理以下需求：

$@

首先调用 `delivery_begin` 保存目标并进入只读方案梳理状态。随后读取当前项目的 `AGENTS.md`、事实源、代码、配置和测试，显式判断复杂度、风险和不确定性。

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

不得修改项目文件，不得调用原始 `subagent`、任意 Bash、gate 或 acceptance。
