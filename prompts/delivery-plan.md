---
description: 根据已批准技术方案编写实施计划
argument-hint: "[补充要求]"
---
使用 `adaptive-delivery` Skill，根据当前 Session 中已批准的技术方案和以下补充要求编写实施计划：

$@

实施计划必须服从项目自己的计划/Issue/TODO 规则，不创建第二套进度系统。回复末尾必须包含且只包含一个如下 fenced JSON 契约：

```adaptive-delivery-plan
{
  "version": 1,
  "risk": "low | medium | high",
  "complexity": "small | medium | large",
  "uncertainty": "low | medium | high",
  "validation": [
    { "id": "stable-id", "command": "exact approved command", "timeoutMs": 120000 }
  ],
  "progressTargets": ["project-relative progress file when defined"],
  "progressChecks": [
    { "id": "stable-id", "command": "executable without shell", "args": ["arg1"], "timeoutMs": 30000 }
  ]
}
```

`validation` 至少一项；`progressTargets` 和 `progressChecks` 可以为空。不要把 shell 重定向、管道或动态命令放进 `progressChecks`。输出后提示用户运行 `/delivery-approve-plan`。本阶段禁止项目写入。
