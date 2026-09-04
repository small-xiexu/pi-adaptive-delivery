---
description: 根据已批准技术方案编写实施计划
argument-hint: "[补充要求]"
---
使用 `adaptive-delivery` Skill，根据当前 Session 中已批准的技术方案和以下补充要求编写实施计划：

$@

标准流程中的技术方案文档已经由 `/delivery-approve-solution` 同步。先只读核对该文件与 Session 批准内容，不得重建、改写或把文件内容反向当作授权；不一致时停止并提示 `/delivery-revise`。

PLANNING 不重做 SHAPING 的源码研究。不要在项目中猜测或重新读取当前已加载的 Skill 文件；先搜索定位项目计划规则、现有测试入口和验证环境，再只读取生成有序里程碑与固定命令所需的切片。SHAPING/PLANNING 的 `read` 每次最多 500 行、同一次 agent run 累计最多 5000 行，runtime 会缩减或拒绝超额调用。已由批准方案或 runtime 证明的范围、风险和非目标直接沿用；计划契约足以执行和验收后立即输出。

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

`validation` 至少一项；`progressTargets` 必须包含 `documents.planPath`，其他 progress target 和 `progressChecks` 可以为空。所有 target 必须是 canonical project-relative 路径，不得包含 `.git`、`.pi`、`node_modules`、绝对路径、反斜杠、控制字符、`.`/`..` 或可规范化冗余段。两个文档路径必须不同、以 `.md` 结尾且 basename 包含完全相同的 `requirementName`。可见正文还必须显式写一行需求短名称，值与 `documents.requirementName` 完全相同，不要只依赖加入排版空格的标题。不要把 shell 重定向、管道或动态命令放进 `progressChecks`。

Standard/High-Risk 的 builtin worker 没有 shell。若某条验证需要 formatter 或 generator 的确定性改写，可在同一个 validation item 中同时增加 `"repairCommand": "exact approved repair command"` 和 `"repairTimeoutMs": 120000`；两项必须同时存在，且只在确有确定性修复需求时填写。Extension 会在唯一 worker 可信结束后、candidate freeze 前执行批准的修复命令。不得用它执行测试、发布、生产操作、动态命令或未获授权的范围外修改；Tiny 不支持 repair command。

验证命令必须基于当前项目的真实目录结构证明测试所需资源可见。若测试会从仓库根读取 `docs`、fixtures、schema、template 或其他非源码资源，容器或沙箱必须从同一当前 workspace 暴露这些资源，并使用正确的仓库根与工作目录；不得只挂载一个源码子目录后把镜像内同名路径误当成当前项目证据。

每条 `timeoutMs` 必须优先依据同一机器、同一容器/沙箱和同等测试范围的最近真实耗时，并留出明显余量；不得把历史更小测试集、不同环境或一次偶然快跑当作当前上限。缺少可比证据的完整回归、构建或长容器命令使用保守 timeout，仍不得超过 plan v2 的 3600000 毫秒上限。若宿主终止命令不能保证同时终止容器或其他外部子进程，批准命令自身必须提供确定性终止边界；不要假设 `pi.exec` timeout 能清理所有外部后代进程。

若本次 PLANNING 来自 `/delivery-revise plan`，runtime 已撤销旧 plan contract、candidate、validation 和 review evidence。磁盘上的既有 diff 可以保留，但不是可沿用的 runtime candidate。修订后的 worker 路由必须重新经过唯一 worker terminal proof、批准的 repair、candidate freeze 和完整固定验证；plan-v2 `single` 与 Tiny 路由必须由父 Pi 重新走各自完整的候选提交和验证流程。所有路由都不得声称保留旧 candidate/evidence；worker 路由不得跳过 worker。

输出后提示用户运行 `/delivery-approve-plan`；TUI 确认后 Extension 会复验技术方案摘要，首次只 create-only 写入实施计划；若这是 `/delivery-revise`，则只覆盖路径、身份和摘要仍与 runtime 旧 evidence 匹配的同一份 Package 文档。同步成功后才开放源码写入。本阶段禁止项目写入。
