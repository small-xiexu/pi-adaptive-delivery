# Pi Adaptive Delivery

一个安装到 [Pi](https://pi.dev) 的开发交付 Package。它先和你对齐“最终要做成什么样”，得到明确批准后再写代码，并自动完成验证、独立审查和交付收口。

你只需要说明需求、检查方案并做必要批准，不需要自己组织多个 Agent、复制审查提示词或记住后续命令。

> 当前版本为 `0.1.0` 私有开发版。请先在受信任的测试 Git 仓库中验收，不要用于无人值守开发、生产操作或自动发布。

## 最终效果

一次正常任务会按下面的顺序完成：

```text
你用一句话提出需求
  -> Package 读取用户规则、项目 AGENTS.md、代码、测试和计划
  -> 用大白话说明最终效果、范围、非目标和验收方式
  -> 你批准技术方案
  -> Package 立即创建按需求命名的技术方案文档
  -> Package 自动生成实施计划
  -> 你批准实施计划
  -> Package 创建按需求命名的实施计划文档
  -> 单 writer 实现
  -> 运行已批准的真实验证命令
  -> fresh reviewer 检查当前 candidate
  -> 必要时批量返工并做一次 closure review
  -> 交付并报告残余风险和未执行动作
```

Package 不会自动 commit、push、创建 PR、发布 npm、部署或操作生产环境。这些动作始终需要单独授权。

## 安装

安装前先运行 `pi list`。本 Package 已内置并加载唯一的 `pi-subagents` runtime；若用户或项目设置中已经单独启用了 `npm:pi-subagents`，应先移除该独立 Package，再安装 Adaptive Delivery。两份 runtime 同时存在时，Package 会在启动 child 前明确阻止，不会继续产生子 Agent 费用。

### 推荐：只安装到一个项目

进入目标 Git 项目：

```bash
cd /path/to/your-project

pi install -l git:github.com/small-xiexu/pi-adaptive-delivery
```

本地开发 Package 时使用绝对路径：

```bash
pi install -l /absolute/path/to/pi-adaptive-delivery
```

项目级安装会创建 `.pi/settings.json`，只影响当前项目。`.pi/npm/.gitignore` 用于避免提交下载的 npm 依赖。

如果 `pi-subagents` 已作为全局 Package 启用，项目级过滤不能保证卸载 project-trust 阶段已经启动的全局 Extension。此时应先在隔离的 `PI_CODING_AGENT_DIR` 测试，或把全局独立 `pi-subagents` 迁移为全局 Adaptive Delivery，不能让两个 owner 共存。

### 安装到所有 Pi 项目

```bash
pi install git:github.com/small-xiexu/pi-adaptive-delivery
```

全局安装后，每个 Git 项目都会从只读 `IDLE` 开始；修改任务需要经过 Adaptive Delivery 批准流程。

安装或更新后重启 Pi。使用本地路径开发 Package 时，也可以在没有活动写入的安全状态执行 `/reload`。首次加载项目级资源时，按 Pi 提示确认 project trust。

## 第一次使用

在目标项目启动 Pi：

```bash
pi
```

确认 Package 已加载：

```text
/delivery-status
```

预期看到：

```text
状态：空闲 [IDLE]
```

然后用一句话提出修改需求，例如：

```text
/delivery-shape 修复订单重复扣款，并补充对应测试。
```

对于已经有计划的项目，也可以写：

```text
/delivery-shape 继续 P6.1 后端集中服务拆分，选择下一个最小且可独立验证的切片。
```

不需要在命令里重复项目规则、测试命令和安全限制。Package 应自行读取项目事实；存在真正的产品或范围歧义时，只问一个关键问题。

### 方案追问

Package 已把“方案追问”内置到 `adaptive-delivery`，不依赖额外的 `grilling` Skill。它会先查项目；只有存在会改变最终效果、范围、共享接口、数据、安全、费用或不可逆行为的选择时，才一次问你一个问题，并给出推荐答案和不同选择的实际影响。你可以只回复：

```text
按推荐
```

所有关键选择确认后，Package 会立即停止提问并生成技术方案。极小、局部、可逆、验收明确且没有用户决策分支的需求默认不追问，直接给出精简方案和计划。

需要主动把方案问透时，可以直接在需求后补一句：

```text
/delivery-shape <需求>，请开启方案追问
```

实现偏好、命名、未来扩展以及能从代码和文档查明的内容不会拿来反复询问你。

### 技术方案图表

技术方案遇到多步骤流程、跨模块调用、状态变化、模块关系、数据流或高风险信任边界时，会按需生成 Mermaid 流程图、时序图或状态图等。极小单步骤需求不会为了形式强制画图；中大型任务通常使用最有帮助的 1 至 3 张，高风险任务必须画清适用的关键路径。

复杂流程不会全部塞进一张大图。Package 会让父 Pi 按阶段拆成 2 至 3 张图，每张只说明一个主要问题，并使用简短节点文字，避免 TUI 为了显示完整画布把文字缩得过小。图片可以占用可滚动的终端高度，不要求同屏看完整张图。

你不需要执行额外命令。Package 会保留技术方案中的标准 Mermaid 源码，并在 assistant 回合结束后自动展示：

- Kitty、iTerm2、Ghostty、WezTerm、Warp：显示本地生成的高密度 PNG，使用当前终端全部可用宽度并保持原始比例；长图通过终端滚动查看。
- 不支持图片协议的终端：显示 Unicode 字符图。
- 不支持的图形或渲染失败：显示中文原因和原始源码。

当前保证六类图：流程图、时序图、状态图、类图、ER 图和 XY 图。渲染完全在本机内存中完成，不使用 `mmdc`/Chromium，不上传源码，也不写入目标 Git 工作区。原始 Mermaid 仍会写入需求技术方案 Markdown，因此 GitHub 或支持 Mermaid 的 IDE 也可以继续渲染。

## 你需要做的批准

### 标准任务

技术方案出现后，先检查 AI 对最终效果、范围和文档名称的理解。正确时执行：

```text
/delivery-approve-solution
```

Package 会在对话区显示批准摘要，立即把已批准技术方案写入项目，然后自动生成实施计划。计划正确时执行：

```text
/delivery-approve-plan
```

随后 Package 会创建实施计划文档并开始实现，不需要再输入 `/delivery-run`。

### 小型低风险任务

技术方案和实施计划会在同一回复中分别展示。确认两部分都正确后只需执行：

```text
/delivery-approve-plan
```

### 不应批准的情况

遇到以下情况先用自然语言纠正，不要执行 approve：

- AI 说的最终效果不是你想要的。
- 增加了你没有要求的功能、兼容层或重构。
- 把项目明确禁止的 Provider、生产、费用或发布操作纳入计划。
- 技术方案和实施计划使用了不同的需求名称或文档路径。
- 验收标准不能直接判断成功与失败。
- 项目已有唯一台账，但 AI 又创建了重复进度系统。

需求、范围、架构或验收需要重新讨论时使用：

```text
/delivery-revise
```

只调整实施顺序或施工计划时使用：

```text
/delivery-revise plan
```

## 需求级规划文档

Package 先服从当前用户要求、目标项目最近的 `AGENTS.md` 与文档路由、用户全局规则；Package 默认只在前面没有约定时补空白。

已有总技术方案或总计划默认只作为背景事实，不因为文件存在就继续堆入每个新需求。没有其他规则时创建：

```text
docs/<需求短名称>-技术方案.md
docs/<需求短名称>-实施计划.md
```

例如：

```text
docs/避免重复扣款-技术方案.md
docs/避免重复扣款-实施计划.md
```

需求短名称描述稳定的用户目标，不使用日期、`final-v2`、代码行号或可能变化的实现细节。

路径会在技术方案批准时冻结，实施计划不能静默改名。标准任务批准 solution 后，Extension 先以 create-only 方式创建技术方案；批准 plan 后只创建实施计划。小型合并批准仍一次创建两个 Markdown：

- 不覆盖已有同名文件。
- 拒绝绝对路径、`..`、symlink、非 Markdown 和同一目标。
- 技术方案批准后立即落盘，但不开放源码写入；两份文档都成功后才进入实现。
- 项目实施计划同时作为本任务的 progress target。

TUI 和项目文档只显示正常方案正文。内部 marker 和 JSON contract 保留在 Session 原始消息中用于批准、恢复和校验，但默认不会显示给用户。

当前版本不会合并或覆盖无法证明来源的需求文档。实施计划批准前执行 `/delivery-revise` 时，Package 保留已落盘技术方案的路径和摘要；重新批准后，只有文件仍与 Package 上次写入内容完全一致且路径无 symlink 时才原位更新。人工改过、身份漂移或摘要不符时保持只读并拒绝覆盖。实施计划已经落盘后的跨阶段重规划仍需用户明确处理旧计划或开始新任务。

## Package 自动完成什么

批准实施计划后，正常情况下无需继续输入命令：

1. 复验已批准技术方案文档并创建实施计划文档。
2. 获取当前 Git worktree 的唯一 writer lease。
3. 小型低风险任务由父 Pi 直接实现；其他任务由一个受控 foreground worker 实现，父 Pi 只编排。
4. 冻结包含 HEAD、staged、tracked、untracked、submodule 和批准记录的 candidate digest。
5. 由 Delivery Gate 通过 Pi 的公开命令 API 顺序执行批准的验证命令。
6. 使用 fresh reviewer 检查同一个 candidate。
7. 把 accepted P0/P1 转成可验证关闭义务并批量返工。
8. 复验后只做一次 closure review。
9. 在 writer-free 边界同步唯一进度台账。
10. 全部证据仍对应当前 candidate 时进入 `DELIVERED`。

P2、推测性意见和与当前修改无关的历史问题只进入最终 notes，不会无限触发 review/fix。

这些内部工具按阶段和任务路由出现，不会一次全部显示给 AI。`single` 实现阶段给父 Pi 代码修改和“提交候选”；`standard/high-risk` 只给父 Pi `delivery_delegate_worker`，父 Pi 看不到 `edit/write`，worker 成功结束后自动冻结候选。随后才切换为验证、审查、返工和完成工具。AI 不确定时会调用只读的 `delivery_runtime_status` 查看当前阶段与开发方式。

固定验证开始后不需要查询状态。`delivery_validate` 会保持当前工具调用，依次显示“正在执行哪条批准命令”和已经完成的结果；全部结束后再返回逐命令摘要。若 Pi 在终态保存前 reload 或验证工具被中断，Package 会保持只读并要求确认没有遗留命令后重试，不会把未知结果当成通过。

## 状态和下一步

| 看到的状态 | 含义 | 用户通常要做什么 |
|---|---|---|
| `空闲 [IDLE]` | 尚未开始任务 | 运行 `/delivery-shape` |
| `方案梳理中 [SHAPING]` | 正在只读理解需求 | 等待方案，必要时纠正 |
| `技术方案待确认` | 等待方向批准 | 检查后运行 `/delivery-approve-solution` |
| `实施计划编制中 [PLANNING]` | 正在生成具体步骤 | 等待计划 |
| `实施计划待确认` | 等待施工计划批准 | 检查后运行 `/delivery-approve-plan` |
| `开发中 [IMPLEMENTING]` | 已授权并正在实现 | 通常无需操作 |
| `验证中 [VALIDATING]` | 正在验证或 review | 通常无需操作 |
| `返工中 [REWORKING]` | 正在关闭 accepted P0/P1 | 通常无需操作 |
| `已阻塞 [BLOCKED]` | 有前置条件无法证明 | 运行 `/delivery-status` 查看原因 |
| `已交付 [DELIVERED]` | 当前候选已通过门禁 | 做用户验收，另行决定是否提交或发布 |
| `已取消 [CANCELLED]` | 当前流程已结束 | 新任务使用新 Session |

`/delivery-status` 会用中文显示恢复状态、写入者、候选版本、验证、审查、规划文档和进度同步。`当前有效` 表示证据仍对应当前工作区，`已过期` 表示工作区已经变化，`不可证明` 表示当前无法确认。路径、digest、运行 ID 和 `[STATE]` 会保留原始诊断值。

## 常见恢复

### 自动生成计划或自动开始实现失败

TUI 会明确显示应手工运行的命令：

```text
/delivery-plan
```

或：

```text
/delivery-run
```

手工运行不会重新批准，也不会扩大权限。

### 流程进入 BLOCKED

先查看原因：

```text
/delivery-status
```

解决显示的条件后再执行：

```text
/delivery-resume
```

resume 会重新校验批准、cwd、Git root、规划文档、lease、candidate 和 evidence；不能证明时继续保持只读。

临时 `BLOCKED` 会保留已经批准的方案、计划、两份规划文档、candidate 和已有验证证据，只释放当前 writer lease；因此解决运行时问题后通常可以直接 resume，不需要重新批准，也不会因为 create-only 文档已经存在而卡住。只有需求、范围、架构或计划确实要重做时，才使用 `/delivery-revise` 撤销相应批准。

用户在 TUI 确认 resume 且状态、lease 和策略全部恢复成功后，Package 会自动继续当前阶段：恢复到 `PLANNING` 时生成实施计划，恢复到 `IMPLEMENTING`、`REWORKING` 或 `VALIDATING` 时继续 `/delivery-run`。如果自动发送失败，恢复本身仍然有效，界面会明确提示手工运行对应命令。

### 更新后旧 Session 报 plan contract malformed

当前 plan contract 是 v2，旧 v1 Session 不能自动升级。确认没有任务仍在执行后：

```text
/delivery-force-release-lease
/delivery-cancel
/new
```

然后重新运行 `/delivery-shape`。force-release 会显示 workspace 和 owner，并要求真实 TUI 确认。

### 取消任务

```text
/delivery-cancel
```

取消不会回退已经产生的项目改动，但会关闭当前交付权限。新任务应使用新 Session。

## 命令参考

| 命令 | 作用 |
|---|---|
| `/delivery-shape <需求>` | 只读理解需求并形成技术方案 |
| `/delivery-approve-solution` | TUI 批准技术方案，成功后自动生成计划 |
| `/delivery-approve-plan` | TUI 批准计划，文档同步后自动开始实现 |
| `/delivery-status` | 查看状态、证据、阻塞原因和下一步 |
| `/delivery-revise [plan]` | 撤销批准并返回方案或计划阶段 |
| `/delivery-resume` | TUI 确认后恢复 BLOCKED 流程并自动继续当前阶段 |
| `/delivery-force-release-lease` | TUI 确认后强制释放 workspace lease |
| `/delivery-cancel` | 取消当前流程并锁定只读 |
| `/delivery-plan` | 自动续跑失败时手工生成计划 |
| `/delivery-run` | 自动续跑失败时手工开始实现 |

approve、resume 和 force-release 只接受真实 TUI 用户确认。RPC、JSON、print、Extension 注入消息和 child 请求不能独立授予权限。

## 支持与安全边界

当前自动验证基线：

- Pi `0.84.4`
- Node.js `>=22.19.0`
- bundled `pi-subagents 0.64.0`
- macOS
- 受信任的单 Git 仓库或 managed worktree

Linux 使用相同 Node/POSIX 原语，但在有 Linux CI 证据前仍标记为待验证。Windows 的 `O_NOFOLLOW`、realpath 和 lease 文件语义尚未验证。

Package 不支持：

- 非 Git 工作区
- 无人值守批准
- 多仓库原子交付
- 自动 commit、push、PR、npm publish 或部署
- 自动训练或自主修改 Package
- 操作系统级沙箱

Package 和 Extension 以当前用户权限运行。writer lease 只约束加载兼容 Package 的受控 Pi 流程，不能阻止外部编辑器、未加载 Package 的进程或恶意同进程 Extension。candidate digest 用于发现变化，不证明代码一定正确。不可信仓库或 unattended automation 仍需容器、VM 或其他操作系统级隔离。

真实 Provider、费用、生产数据、数据库迁移、发布和不可逆操作继续服从用户与项目自己的授权规则。

## Agent 与模型

Package 内部固定携带并加载 `pi-subagents 0.64.0` 作为唯一子 Agent runtime owner，并暴露同版本的 builtin Agents、Skill 和 Prompt。不要再单独安装或启用另一份 `pi-subagents`；检测到多个 owner 时，Package 会在启动 child 前失败并提示清理，不产生子 Agent 费用。

Package 使用稳定角色：

- `scout`：只读代码侦察
- `oracle`：高风险方案挑战
- `worker`：standard/high-risk 的唯一写入者；父 Pi 在这些路径只编排
- `reviewer`：fresh-context 独立审查
- Delivery Gate 验证器：只执行已批准计划中的固定命令，并记录逐命令终态

Package 不硬编码 Provider 或模型。角色模型由用户级 `subagents.agentOverrides` 或现有 profile 配置；使用 `/subagents-models` 检查实际解析结果。

为 worker 和 reviewer 配置至少一个 fallback，避免单个 Provider/模型的临时故障阻塞实现或独立审查：

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": {
        "model": "provider/implementation-model",
        "fallbackModels": ["provider/backup-implementation-model"]
      },
      "reviewer": {
        "model": "provider/strong-review-model",
        "fallbackModels": ["provider/backup-review-model"]
      }
    }
  }
}
```

普通方案梳理由父 Pi 直接使用只读工具完成，不为提速启动 scout。Package 会在实施计划批准前做只读 preflight；没有任何可用 reviewer candidate 时不会创建文档、获取 writer lease 或进入实现，因为后续 fresh review 无法完成。固定验证本身不再启动 reviewer 或依赖模型：`delivery_validate` 只执行已批准命令，并在当前工具卡显示当前命令、退出码和耗时。命令失败只表示批准验证未通过；父 Pi 必须再判断原因是候选代码、验证环境还是计划错误，不能一律修改源码。

模型临时排除由 bundled `pi-subagents` runtime 管理。其默认 TTL 可在 `~/.pi/agent/extensions/subagent/config.json` 调整，例如把单次瞬时错误的冷却设为 5 分钟：

```json
{
  "modelExclusions": {
    "defaultTtlMs": 300000
  }
}
```

短 TTL 与 fallback 配合使用：短冷却避免立即重试风暴，fallback 保证仍有模型可以继续。Package 不自动改写这份用户级配置。

内部枚举和协议保持英文，面向用户的状态、断点、下一步、证据和恢复提示使用中文。Pi 或 Provider 自身返回的底层错误可能保留原始诊断详情。

## 卸载

项目级安装先进入对应项目，再使用 `pi list` 确认精确 source，然后执行：

```bash
pi remove -l git:github.com/small-xiexu/pi-adaptive-delivery
```

本地路径安装使用 `pi list` 找到原绝对路径 source 后移除。全局安装去掉 `-l`。

卸载 Adaptive Delivery 后如需继续单独使用 `pi-subagents`，再显式安装所需的固定版本；不要在 Adaptive Delivery 仍启用时并行安装。

卸载不会自动删除 Session custom entries、已经创建的需求文档或可能保留的 writer lease。卸载前先用 `/delivery-status` 确认没有活动 writer；未知 lease 应完成恢复或由用户确认 force-release。

## 维护者参考

内部协议当前为：

- `adaptive-delivery-documents` v1：需求短名称、solution/plan 路径和选择来源
- `adaptive-delivery-plan` v2：文档身份、风险分类、验证命令和 progress target/check
- Delivery runtime state v1
- Candidate manifest v1
- Writer lease v1

plan v1 不包含规划文档身份，当前版本会失败关闭并要求重新生成、重新批准，不提供隐式迁移。

开发验证：

```bash
npm install
npm run typecheck
npm run test:all
npm pack --dry-run
npm audit --omit=dev
```

默认测试使用临时 Git 仓库、隔离 `PI_CODING_AGENT_DIR` 和本地 fake provider，不读取用户凭证或连接真实模型。

## 设计文档

- [技术方案](./docs/技术方案.md)
- [实施计划](./docs/实施计划.md)
