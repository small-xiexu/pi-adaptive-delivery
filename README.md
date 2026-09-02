# Pi Adaptive Delivery

面向 [Pi](https://pi.dev) 的自适应、审批门禁式开发交付编排 Package。

它把一个长期父 Pi 会话作为中央架构师，复用 `pi-subagents` 完成只读侦察、单 writer 实现、真实验证和 fresh review。所有受支持的修改型任务在写入前都必须有技术方案、实施计划和用户授权；流程重量根据复杂度、风险和不确定性调整。

> 当前版本为 `0.1.0` 私有开发版。请先在受信任的测试 Git 仓库中验收，不要用于无人值守开发、生产操作或自动发布。

## 能力

- 固定技术方案和实施计划门禁
- 小型低风险任务的一次合并批准
- 中大型任务的 worker + runtime gate + fresh reviewer
- 高风险任务的只读 oracle 与多角度审查
- 中文状态、中文角色和稳定英文内部标识
- 不可变 Session approval record
- 审批前固定 native read-only delegation
- canonical cwd/worktree writer lease
- candidate digest 与 stale evidence 失效
- writer-free progress-sync
- Session/tree/reload/断线恢复
- TUI-only approve/resume/force-release

## 支持边界

初始版本支持：

- Pi `0.84.4` 或兼容版本
- Node.js `>=22.19.0`
- `pi-subagents 0.62.0` 或经验证兼容版本
- 交互式 Pi TUI
- 受信任的单 Git 仓库
- 本地 cwd 或 managed worktree
- 已自动验证的平台：macOS

初始版本不支持：

- 非 Git 工作区
- 无人值守批准
- RPC/JSON/print 模式授予写权限
- 多仓库原子交付
- 自动 commit、push、PR、npm publish 或部署
- 自动训练、微调或自主修改 Package
- 操作系统级沙箱
- Windows（`O_NOFOLLOW`、realpath 和 lease 文件语义尚未验证）

Linux 使用相同的 Node/POSIX 原语，预计兼容，但在加入 Linux CI 证据前仍视为待验证平台。

## 安装

`pi-subagents` 必须作为独立 Pi Package 安装并启用：

```bash
pi install npm:pi-subagents
pi install git:github.com/small-xiexu/pi-adaptive-delivery
```

私有仓库可使用 SSH：

```bash
pi install git:git@github.com:small-xiexu/pi-adaptive-delivery.git
```

本地开发安装：

```bash
pi install /absolute/path/to/pi-adaptive-delivery
```

安装或更新后重启 Pi。首次在包含项目级 Pi 资源的仓库中使用时，按 Pi 提示确认 project trust。

## 快速开始

### 标准任务

```text
/delivery-shape <需求>
```

父会话只读检查项目并输出技术方案。确认后执行：

```text
/delivery-approve-solution
/delivery-plan
/delivery-approve-plan
/delivery-run
```

### 小型低风险任务

`/delivery-shape` 会在同一回复中分别输出精简技术方案和实施计划。确认后执行：

```text
/delivery-approve-plan
/delivery-run
```

### 阻塞恢复

```text
/delivery-status
/delivery-resume
```

无法证明批准、lease、candidate 或 process state 时，流程保持只读并显示`已阻塞 [BLOCKED]`。解决恢复条件后，`/delivery-resume` 会再次校验全部权限前置条件。

## 用户命令

| 命令 | 作用 |
|---|---|
| `/delivery-status` | 显示状态、阻塞原因、断点和下一步 |
| `/delivery-approve-solution` | TUI 用户确认当前技术方案 |
| `/delivery-approve-plan` | TUI 用户确认当前实施计划或合并方案 |
| `/delivery-revise [plan]` | 撤销批准并返回方案或计划阶段 |
| `/delivery-resume` | TUI 用户确认后从 BLOCKED 恢复 |
| `/delivery-force-release-lease` | TUI 用户确认后强制释放当前 workspace lease |
| `/delivery-cancel` | 取消流程并锁定只读 |

approve、resume 和 force-release 必须在真实 TUI 中弹出用户确认。RPC、JSON、print、Extension 注入消息和 child 请求不能独立放宽权限。

## 模型可调用工具

| 工具 | 状态与作用 |
|---|---|
| `delivery_begin` | IDLE -> SHAPING，只收紧流程 |
| `delivery_delegate_readonly` | 审批前固定只读委派 |
| `delivery_invalidate` | 只能撤销批准或进入 BLOCKED |
| `delivery_submit_candidate` | 冻结候选并释放 parent lease |
| `delivery_validate` | 启动批准命令的 runtime verification |
| `delivery_review_candidate` | fresh reviewer 前后复算 candidate |
| `delivery_progress_sync` | writer-free 边界更新 exact progress target |

调用者不能向固定委派或验证入口传入任意 output、gate、worktree、管理动作或宿主命令。

## 状态

| 中文显示 | 内部状态 |
|---|---|
| 空闲 | `IDLE` |
| 方案梳理中 | `SHAPING` |
| 技术方案待确认 | `SOLUTION_PENDING_APPROVAL` |
| 实施计划编制中 | `PLANNING` |
| 实施计划待确认 | `PLAN_PENDING_APPROVAL` |
| 方案与计划待合并确认 | `COMBINED_PENDING_APPROVAL` |
| 开发中 | `IMPLEMENTING` |
| 验证中 | `VALIDATING` |
| 返工中 | `REWORKING` |
| 已阻塞 | `BLOCKED` |
| 已交付 | `DELIVERED` |
| 已取消 | `CANCELLED` |

持久化、RPC 和状态判断只使用英文枚举；中文是展示层。

## 角色

| 中文角色 | 内部标识 | 职责 |
|---|---|---|
| 中央架构师 | 父 Pi 会话 | 产品与技术架构、编排和最终裁决 |
| 代码侦察员 | `scout` | 代码、数据流、测试和风险侦察 |
| 资料研究员 | `researcher` | 预留角色；v0.1 strict pre-approval 不启用 |
| 架构顾问 | `oracle` | 高风险方向挑战 |
| 开发执行者 | `worker` | 当前里程碑唯一写入者 |
| 独立审查员 | `reviewer` | fresh-context diff 审查 |
| 验证执行器 | acceptance runtime | 执行批准命令并保存证据 |
| 变更监视器 | Watchdog | 补充范围与改动审查 |

## 模型配置

Package 不硬编码 Provider 或模型。可以在 `~/.pi/agent/settings.json` 中配置角色：

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": {
        "model": "openai/gpt-5.6-luna",
        "thinking": "low"
      },
      "worker": {
        "model": "openai/gpt-5.6-luna",
        "thinking": "max"
      },
      "reviewer": {
        "model": "openai/gpt-5.5",
        "thinking": "high"
      },
      "oracle": {
        "model": "openai/gpt-5.6-sol",
        "thinking": "high"
      }
    }
  }
}
```

模型名称只是当前环境示例。请根据自己的 Provider、额度和模型目录调整，并使用 `/subagents-models` 检查实际映射。

## 实施计划契约

`/delivery-plan` 会在人类可读计划后附加一个严格 JSON fence：

````markdown
```adaptive-delivery-plan
{
  "version": 1,
  "risk": "medium",
  "complexity": "medium",
  "uncertainty": "low",
  "validation": [
    { "id": "typecheck", "command": "npm run typecheck", "timeoutMs": 120000 }
  ],
  "progressTargets": ["docs/实施计划.md"],
  "progressChecks": [
    { "id": "diff-check", "command": "git", "args": ["diff", "--check"], "timeoutMs": 30000 }
  ]
}
```
````

该 block 只绑定风险分类、验证命令和可选 progress target/check，不定义项目的进度格式。

## 安全与恢复

- Package/Extension 以当前用户权限运行，不是沙箱。
- writer lease 只约束加载本 Package 的受控 Pi 流程，不能阻止外部编辑器或其他进程。
- candidate digest 用于检测外部变化，不证明代码正确。
- 未知 process-terminal proof 不会按超时自动释放 lease。
- force-release 可能遗留未知 writer，必须人工确认风险。
- progress-sync 使用 exact target、realpath、逐级 symlink 检查、`O_NOFOLLOW`、target/parent dev+ino 复验和固定 argv checks。
- Session checkpoint 与项目计划/Issue/TODO 不做原子双写；冲突时进入 BLOCKED。
- 不可信仓库、代码或 unattended automation 应放在容器、VM 或等价系统隔离中。

## 卸载

```bash
pi remove git:github.com/small-xiexu/pi-adaptive-delivery
```

卸载 Package 不自动删除 Session custom entries、OS temp 测试目录或可能保留的 writer lease。卸载前先用 `/delivery-status` 确认没有活动 writer；未知 lease 应先完成恢复或由用户确认 force-release。

## 开发验证

```bash
npm install
npm run typecheck
npm run test:all
npm pack --dry-run
npm audit --omit=dev
```

默认测试使用临时 Git 仓库、隔离 `PI_CODING_AGENT_DIR` 和本地 fake provider，不连接真实模型。

## 设计文档

- [技术方案](./docs/技术方案.md)
- [实施计划](./docs/实施计划.md)
