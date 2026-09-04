---
description: 只读澄清需求并形成自适应技术方案
argument-hint: "<需求>"
---
使用 `adaptive-delivery` Skill 处理以下需求：

$@

本模板由用户明确输入 `/delivery-shape` 触发，也是 `delivery_begin` 的唯一授权来源。首先调用 `delivery_begin` 保存目标并进入只读方案梳理状态。随后读取当前项目的 `AGENTS.md`、事实源、代码、配置和测试，显式判断复杂度、风险和不确定性。

普通项目取证由父 Pi 直接使用 `read`、`grep`、`find` 和 `ls` 完成，公开只读委派不提供 scout。只有高风险技术取舍确实需要独立挑战时才调用一次固定只读 `oracle`；只读委派出现 runtime owner、preflight 或终态证明错误时不得重试同一任务，继续使用父 Pi 只读工具或明确报告阻塞。

取证必须及时收敛：先用 `grep`、`find`、`ls` 定位事实，再用 `read` 读取必要切片；不要默认整篇读取大型源码、测试或文档，不要在项目中猜测或重新读取当前已加载的 Skill 文件。SHAPING/PLANNING 的 `read` 每次最多 500 行、同一次 agent run 累计最多 5000 行，runtime 会缩减或拒绝超额调用；应把预算留给决定效果、边界和验证的关键切片。只读取足以证明用户效果、边界、风险、验证方式和未决问题的内容；这些事实已经闭合时立即成案，不为穷举调用点、测试样例或实现细节继续扩读。

形成方案前按 `adaptive-delivery` Skill 判断是否需要“方案追问”。用户明确要求“grill me”“把方案问透”“逐项对齐”，或存在无法从项目事实确认且会改变最终效果、范围、共享接口、数据、安全、费用或不可逆行为的决定时，每次只问一个问题，并同时给出推荐答案、理由和不同选择的用户可见影响；等待用户回答后再继续，不得在同一回复列出多个问题或提前输出可批准方案。用户可以只回答“按推荐”。

推荐部分固定使用两行纯文本：第一行只写“推荐答案：”，第二行写具体推荐；不要给该标签添加 Markdown 加粗，也不要让 Markdown 结束标记直接连接中文正文。

极小需求默认零追问，但只有在读取项目后能证明严格 Tiny policy 时才能走 Tiny：用户效果、非目标和验证明确；不存在产品/架构决定；exact project-relative change scope 可提前列出；workspace 可证明 clean；修改局部、可逆且只在当前 Git workspace；不涉及共享/public API、schema、持久化格式、协议、共享配置、auth/authorization/permission、tenant、secret、crypto、privacy、billing/payment/cost、migration/delete、事务/并发一致性、生产/部署/发布或不可逆外部写；不改变 dependency、lockfile、package manager、compiler、toolchain 或 build architecture；至少有一条本地、确定性、focused runtime validation。风险优先于代码量，任一条件不能证明就升级 Standard/High-Risk。

图表只在确实帮助理解时生成：极小单步骤需求不强制；中大型任务涉及多步骤流程、跨组件调用、状态变化、模块关系或数据流时，在技术方案正文中加入最有帮助的 1 至 3 张图；高风险任务必须用适用图表画清关键路径、状态变化或信任边界。每张图只回答一个主要问题，复杂流程按“方案与批准”“实现与验证”“阻塞与恢复”等阶段拆图，不把完整生命周期压进一张画布；流程/状态图通常不超过约 10 个主要节点，时序图通常不超过 6 个参与者和 12 条主要消息。节点和连线只写便于扫读的短语，完整解释放在正文；按结构选择横向或纵向布局，避免又高又宽。仅使用标准 Mermaid 的 `flowchart`/`graph`、`sequenceDiagram`、`stateDiagram-v2`、`classDiagram`、`erDiagram` 或 `xychart-beta`，不使用初始化指令。每张图必须有标题或相邻的大白话说明，不能替代文字验收和失败边界。

Mermaid fence 必须位于 solution 标记正文内，确保原始源码进入批准消息和需求技术方案文档。Delivery Gate 会自动在 TUI 中渲染图片或字符回退；不要调用 Bash、外部服务或额外工具生成图片。

Tiny 只输出简短的“将修改、不会修改、成功效果、验证”，并包含且只包含一个下列 contract；不要输出 solution/plan marker、`adaptive-delivery-documents`、`adaptive-delivery-plan` 或规划文档路径：

```adaptive-delivery-tiny
{
  "version": 1,
  "intent": "明确的单一用户效果",
  "nonGoals": ["明确不改变的行为或边界"],
  "changeScope": ["exact/project-relative/path.ts"],
  "validation": [
    { "id": "stable-id", "command": "exact focused command", "timeoutMs": 120000 }
  ],
  "review": "none",
  "eligibility": {
    "risk": "low",
    "uncertainty": "low",
    "userOutcomeClear": true,
    "productOrArchitectureDecision": false,
    "reversibleWorkspaceOnly": true,
    "sharedContractChange": false,
    "highRiskDomain": false,
    "externalSideEffect": false,
    "dependencyOrToolchainChange": false,
    "focusedDeterministicValidation": true
  }
}
```

Tiny 提示用户执行 `/delivery-approve-plan` 做一次 TUI 批准。Extension 在批准时捕获 baseline 并固定 exact scope，不创建项目规划文档，也不 preflight reviewer。

Standard/High-Risk 首次执行 `/delivery-approve-solution` 并在 TUI 确认后，Extension 会立即 create-only 写入技术方案文档，再自动生成实施计划；此时仍不开放源码写入。需要调整已批准方案或计划时使用 `/delivery-revise`；重新批准只更新路径、文件身份和现场摘要仍与 runtime 旧 evidence 匹配的同一份 Package 文档，任何外部改动都拒绝覆盖。

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

- Tiny：只输出上述 Tiny 摘要和 `adaptive-delivery-tiny` v1；提示用户运行 `/delivery-approve-plan`。
- Standard/High-Risk：只给出技术方案，不生成实施计划；提示用户运行 `/delivery-approve-solution`。
- 高风险任务：先使用固定只读委派入口咨询架构顾问，再由父会话综合。

所有追问答案必须进入最终技术方案；高影响歧义全部关闭后立即停止追问。方案追问负责产品和范围对齐，架构顾问负责高风险技术挑战，不能互相替代。

不得修改项目文件，不得调用原始 `subagent`、任意 Bash、gate 或 acceptance。
