---
description: 只读澄清需求并形成自适应技术方案
argument-hint: "<需求>"
---
使用 `adaptive-delivery` Skill 处理以下需求：

$@

首先调用 `delivery_begin` 保存目标并进入只读方案梳理状态。随后读取当前项目的 `AGENTS.md`、事实源、代码、配置和测试，显式判断复杂度、风险和不确定性。

- 小型低风险任务：在同一回复中分别给出精简技术方案与实施计划，并附唯一 `adaptive-delivery-plan` 契约；提示用户运行 `/delivery-approve-plan`。
- 其他任务：只给出技术方案，不生成实施计划；提示用户运行 `/delivery-approve-solution`。
- 高风险任务：先使用固定只读委派入口咨询架构顾问，再由父会话综合。

不得修改项目文件，不得调用原始 `subagent`、任意 Bash、gate 或 acceptance。
