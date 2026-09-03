---
description: 根据已批准技术方案编写实施计划
argument-hint: "[补充要求]"
---
使用 `adaptive-delivery` Skill，根据当前 Session 中已批准的技术方案和以下补充要求编写实施计划：

$@

标准流程中的技术方案文档已经由 `/delivery-approve-solution` 同步。先只读核对该文件与 Session 批准内容，不得重建、改写或把文件内容反向当作授权；不一致时停止并提示 `/delivery-revise`。

实施计划必须服从项目自己的计划/Issue/TODO 规则，不创建第二套进度系统。已有总计划默认只作入口；用户和项目规则允许需求级台账时，使用已批准 `adaptive-delivery-documents` 契约中的同一需求短名称、路径和选择来源。路径或唯一台账需要改变时先 `/delivery-revise`，不能在计划阶段静默改名。

完整实施计划及其 JSON 契约必须放在以下唯一标记之间：

```text
<!-- adaptive-delivery:plan:start -->
...实施计划 Markdown 和下方 JSON 契约...
<!-- adaptive-delivery:plan:end -->
```

标记内必须包含且只包含一个如下 fenced JSON 契约：

```adaptive-delivery-plan
{
  "version": 2,
  "risk": "low | medium | high",
  "complexity": "small | medium | large",
  "uncertainty": "low | medium | high",
  "documents": {
    "requirementName": "用户目标导向的需求短名称",
    "solutionPath": "docs/<需求短名称>-技术方案.md",
    "planPath": "docs/<需求短名称>-实施计划.md",
    "selectionSource": "user | project | global | package-default"
  },
  "validation": [
    { "id": "stable-id", "command": "exact approved command", "timeoutMs": 120000 }
  ],
  "progressTargets": ["与 documents.planPath 完全相同的 project-relative path"],
  "progressChecks": [
    { "id": "stable-id", "command": "executable without shell", "args": ["arg1"], "timeoutMs": 30000 }
  ]
}
```

`validation` 至少一项；`progressTargets` 必须包含 `documents.planPath`，其他 progress target 和 `progressChecks` 可以为空。两个文档路径必须不同、以 `.md` 结尾且 basename 包含完全相同的 `requirementName`。不要把 shell 重定向、管道或动态命令放进 `progressChecks`。输出后提示用户运行 `/delivery-approve-plan`；TUI 确认后 Extension 会复验技术方案摘要并只 create-only 写入实施计划，成功后才开放源码写入。本阶段禁止项目写入。
