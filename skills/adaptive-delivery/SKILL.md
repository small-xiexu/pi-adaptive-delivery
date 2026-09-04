---
name: adaptive-delivery
description: 使用风险分级 Delivery Contract、用户授权、单 writer、真实验证和按需 fresh review，自适应编排 Pi 修改任务。仅用于 /delivery-shape、/delivery-plan、/delivery-run；不用于纯问答、只读梳理、诊断或代码评审。
---

# Adaptive Delivery

## 适用入口

只有用户明确输入 `/delivery-shape` 才能调用 `delivery_begin` 并从 `IDLE` 启动修改交付；runtime 在其他状态不暴露该工具。纯问答、只读梳理、状态盘点、诊断和代码评审保持 `IDLE`。自然语言只读请求后续转为修改时，先提示用户使用 `/delivery-shape <需求>`，不能在原只读回合自行启动流程。

## 不变量

1. 任何源码写入前都必须有职责完整、可解析并绑定当前 Session/workspace 的 Delivery Contract。
2. 没有可验证的 TUI 用户修改授权，不得写入项目；Tiny 的授权来自 approved Tiny contract，其他路径来自 approved plan。
3. 同一个 cwd/worktree 同时只有一个 writer。
4. 只有 runtime 执行的 gate 是 verified evidence。
5. validation 必须绑定当前 candidate digest；要求 review 的路径还必须绑定 runtime 生成的 actual diff digest 并使用 fresh context。
6. commit、push、PR、发布和部署需要独立授权。
7. 只有达到 persistent planning threshold 的 Standard/High-Risk 才创建需求级技术方案和实施计划；Tiny 只保存 Session/runtime contract。
8. 风险优先于代码量；Agent 不能自行扩大已批准 scope，无法证明时必须降权。

## 先用大白话对齐最终效果

技术方案先帮助用户判断“你是否真的理解了我要什么”，再解释代码准备怎么改。面向用户的第一层使用尽量直白的语言，依次说明：

1. 父会话对当前需求的简短复述。
2. 做完后用户能够看到或操作到的最终效果。
3. 正常、失败和关键边界场景分别会发生什么。
4. 本次明确不做什么。
5. 可以直接判断完成与否的示例和验收结果。
6. 仍需用户决定的产品、范围或风险选择。

技术术语和实现细节放在第二层，并说明它们如何支撑前述效果。实施计划中的每个里程碑都必须对应已批准效果或验收项；无法对应的工作不进入当前任务。开发、测试或 review 期间若需要改变最终效果、范围、架构、非目标或验收标准，必须停止并请求 `/delivery-revise`，不能借实现细节静默偏离原计划。

## 方案追问

方案追问是本 Skill 内置行为，不依赖外部 `grilling` Skill。它只在技术方案批准前用于关闭必须由用户决定的高影响歧义。

先读取项目代码、文档、配置、测试和规则。能够从项目事实确认的内容直接查证，不把检索工作转给用户。以下任一条件成立时启用方案追问：

- 用户明确说“grill me”“把方案问透”“逐项对齐”或同义要求。
- 存在无法从项目事实确认，并会改变最终效果、范围、共享接口、数据、安全、费用或不可逆行为的决定。

每轮只问一个问题并等待回答，不同时列出问题清单。问题使用大白话并固定包含：

1. 需要用户决定什么。
2. 推荐答案。
3. 推荐理由。
4. 不同选择会改变什么用户可见结果。

面向用户输出时，推荐部分固定使用两行纯文本：第一行只写“推荐答案：”，第二行写具体推荐。不要给“推荐答案”标签添加 Markdown 加粗，也不要生成 `**推荐：**正文` 这类结束标记后直接连接中文的写法。

用户回答“按推荐”时，只表示接受当前问题的推荐答案。把每个答案写入最终技术方案的业务规则、边界或验收标准；不要依赖聊天摘要代替方案正文，也不要重复询问已经确认的决定。

极小需求默认零追问。只有同时满足以下条件才生成 Tiny contract：最终效果和非目标明确；不存在产品或架构决定；批准前能列出不超过八个 exact project-relative regular-file path；修改局部、仅限当前 Git workspace 且可逆；workspace baseline clean；不涉及共享/public API、schema、持久化格式、协议或共享配置契约；不涉及 auth、authorization、permission、tenant、secret、crypto、privacy、billing、payment、migration、删除、不可逆写、事务、并发一致性、生产、部署、发布或外部写；不改变 dependency、lockfile、package manager、compiler、toolchain 或 build architecture；至少有一条 runtime 可执行的本地确定性 focused validation。任一条件不能证明时升级 Standard/High-Risk，不能用代码行数覆盖风险。

Tiny 回复只需用大白话说明“将修改什么、明确不修改什么、成功效果和验证”，并包含唯一严格 `adaptive-delivery-tiny` v1 fence；不创建 solution/plan marker、planning documents 或 progress target。提示用户执行 `/delivery-approve-plan` 做一次 TUI 合并批准。批准后若 scope 扩大，立即调用 `delivery_invalidate(target=SHAPING)`：停止写入、释放 lease、保留 partial diff、清除旧 Tiny 授权和证据，再按 Standard/High-Risk 重新方案并批准。

极小需求若仍有一个高影响歧义，只问该问题，回答后立即成案。实现偏好、命名、纯代码细节、未来扩展和能从仓库查明的事项不得触发或延长追问。所有高影响歧义关闭后立即停止并输出完整方案。

方案追问面向用户确认产品和范围；oracle 面向高风险技术取舍。两者不能互相替代。方案批准后发现新决策必须 `/delivery-revise`，不能继续追问后静默改变方向。

普通 SHAPING/PLANNING 取证由父 Pi 直接使用 `read`、`grep`、`find`、`ls`。公开只读委派只提供高风险 `oracle`，不向模型暴露 scout 或 reviewer；reviewer 仅由 plan 预检和 validation 后的固定审查入口使用。runtime owner、preflight 或终态证明失败后不得重试同一委派，父 Pi 应继续只读取证或明确报告阻塞，避免重复费用。

取证先搜索定位，再读取必要切片；不默认整篇读取大型文件，也不在项目目录猜测或重读当前已加载的 Skill。SHAPING/PLANNING 的父 Pi `read` 每次最多 500 行、同一次 agent run 累计最多 5000 行，runtime 会缩减或拒绝超额调用。SHAPING 在用户效果、边界、风险、验收和高影响歧义均有事实支撑后立即成案。PLANNING 沿用批准方案，不重新穷举源码和测试，只补齐项目计划规则、里程碑、固定验证命令和停止条件所需证据。

## 技术方案图表

图表用于减少理解成本，不作为装饰，也不能替代文字规则、失败表现和验收标准：

- Tiny 和极小单步骤需求不强制画图。
- 中大型任务存在多步骤流程、跨组件调用、状态变化、模块关系或数据流时，选择最有帮助的 1 至 3 张图。
- 高风险任务必须使用适用图表画清关键路径、状态变化或信任边界。
- 只使用六类受支持 Mermaid：`flowchart`/`graph`、`sequenceDiagram`、`stateDiagram-v2`、`classDiagram`、`erDiagram`、`xychart-beta`。
- 不使用 Mermaid 初始化指令、外部图片、HTML 或链接；每张图保持有界，并配标题或相邻的大白话说明。
- 每张图只回答一个主要问题。复杂流程按阶段或职责拆成 2 至 3 张图，不把完整生命周期和全部异常分支压进一张画布；流程/状态图通常不超过约 10 个主要节点，时序图通常不超过 6 个参与者和 12 条主要消息。节点和连线只写短语，完整解释放正文；按结构选择横向或纵向布局，避免又高又宽。

Mermaid fence 必须保留在 solution 正文中，成为原始批准消息和落盘技术方案的一部分。Delivery Gate 自动从 assistant 原始消息生成 TUI-only 图表：支持图片协议时显示本地 PNG，否则显示 Unicode 字符图。父 Pi 不调用 shell、外部服务或额外渲染工具，也不把图表展示 entry 当作批准或 candidate 事实。

## Persistent 规划文档路径

本节只适用于 Standard/High-Risk。Planning contract 与 project documentation 是不同事实：所有修改都有 Session/runtime Delivery Contract，但 Tiny 不产生项目级规划 Markdown。

先读取并服从用户明确要求、目标项目最近的 `AGENTS.md` 与文档索引、用户全局规则；Package 默认只补空白。已有总技术方案或总实施计划默认是只读背景，不因为存在就自动追加。除非规则明确要求复用，否则使用同一需求短名称创建：

```text
docs/<需求短名称>-技术方案.md
docs/<需求短名称>-实施计划.md
```

需求短名称描述稳定用户目标，不使用日期、版本尾缀、代码行号或可能变化的实现方式。方案回复必须展示需求名、两条路径和 `user|project|global|package-default` 选择来源。规则冲突、远程 Issue/TODO、多个唯一台账候选或路径职责不明确时停止询问，不能静默 fallback。

solution 正文放在唯一 `<!-- adaptive-delivery:solution:start|end -->` 标记内，并包含唯一 `adaptive-delivery-documents` v1 fence；`/delivery-approve-solution` 在 TUI 中显示并冻结需求名、路径和来源，首次确认后立即 create-only 写入技术方案，但仍保持只读。plan 正文和唯一 `adaptive-delivery-plan` v2 fence 放在唯一 `<!-- adaptive-delivery:plan:start|end -->` 标记内，plan 的 `documents` 必须与已批准 solution 契约逐字段一致，`documents.planPath` 必须同时进入 `progressTargets`。用户批准 plan 后，Extension 复验技术方案摘要并在首次批准时只 create-only 写入实施计划；两份文档成功并记录摘要后才进入 `IMPLEMENTING`。已同步两份文档后执行 `/delivery-revise` 时保留原 evidence，重新批准只允许更新路径、文件身份和现场摘要仍匹配的同一份 Package 文档；人工改动或 symlink 漂移必须拒绝覆盖。Session entry 仍是批准主体，文件不能反向授予权限。

两份可见正文都要显式写出契约中的需求短名称；标题可以为可读性加入空白。Extension 对正文身份只把 Unicode NFC 后的空白视为等价，任何非空白字符或字序不同仍拒绝写入；结构化契约、批准摘要、路径和文件 identity 不做宽松匹配。

显示 Standard/High-Risk plan 批准对话前，Extension 必须用 pi-subagents 公开 preflight 证明 builtin reviewer 至少有一个可用 model candidate，且只读工具、`denyExtensions`、output 和 cwd 边界成立。preflight 不启动 child 或调用 Provider。无可用 reviewer/fallback 时保持待批准和只读，先让用户修复模型配置；不得先实现再等验证资源。Tiny 不 preflight reviewer。

这些 marker 和 JSON fence 只属于内部协议；Extension 在 TUI 显示和规划文档落盘时隐藏它们。父会话仍需输出完整协议供原始 Session 解析，但面向用户的正文不能要求用户阅读或解释内部 JSON。

正常 TUI 流程只要求用户执行批准或恢复确认：solution approval 成功后 Extension 显示可见状态并自动展开 `/delivery-plan`；plan approval、文档同步和策略提交成功后显示两条路径并自动展开 `/delivery-run`。`/delivery-resume` 经 TUI 用户确认且状态、lease、策略全部提交成功后也自动继续：`PLANNING` 展开 `/delivery-plan`，`IMPLEMENTING`、`REWORKING`、`VALIDATING` 展开 `/delivery-run`；待批准状态继续等待用户，不能自动批准。两条模板命令继续作为手工恢复入口。非 TUI、用户取消、同步或状态提交失败不得自动继续；自动发送本身失败时保留已批准或已恢复状态并明确提示手工命令。

## 自适应路由

- `TINY`：严格低风险、exact scope、clean baseline；一次 TUI approval；无项目规划文档、worker、reviewer 和 progress sync；父 Pi 是唯一 writer；保留 lease、scope enforcement、candidate freeze 和 focused runtime validation。
- `STANDARD`：persistent solution/plan、批准链、受控实现、runtime validation 和 actual-diff-bound fresh reviewer。为兼容 plan v2，既有 `small/low/low -> single` 内部路由仍可由父 Pi 实现，其余使用唯一 foreground worker。
- `HIGH_RISK`：方案阶段增加只读 oracle、两阶段显式批准、persistent docs、唯一 worker、严格 validation 和更强 fresh review。

风险优先于代码量。认证、授权、权限、租户隔离、密钥、隐私、密码学、迁移、删除、事务/并发正确性、费用、支付、生产、部署、发布和不可逆外部写始终按高风险处理。共享契约或 dependency/toolchain 变化至少 Standard。

## 方案与计划

技术方案回答“为什么改、改成什么”，必须基于当前项目事实，并包含目标、非目标、验收、设计、取舍和风险。

实施计划回答“如何落地和证明完成”，必须包含有序里程碑、边界、测试、停止条件，并给出唯一 `adaptive-delivery-plan` v2 JSON fence。该 fence 只承载批准的风险分类、需求级文档路径、验证命令和 progress target/check，不定义项目进度格式。

计划修订不会保留 runtime candidate、validation 或 review evidence。磁盘 diff 可以作为现场继续存在，但 worker 路由必须重新取得唯一 worker terminal proof、执行批准 repair、冻结 candidate 并完整验证；plan-v2 `single` 与 Tiny 路由必须由父 Pi 重新走各自完整的候选提交和验证流程。所有路由都不能把旧 evidence 写成可沿用事实。验证命令必须按项目真实根目录和工作目录暴露测试依赖的 docs、fixtures、schema、template 等仓库资源；只挂载源码子目录不能证明仓库级测试有效。

## 子 Agent 契约

每个 child task 都要独立包含：目标、cwd、批准范围、相关事实源、禁止动作、完成条件、验证、输出和停止条件。

- 审批前只能调用 `delivery_delegate_readonly`。
- writer 只能处理当前批准里程碑，不得启动子 Agent。
- reviewer 只读、fresh context，只报告有 runtime 提供的 actual candidate diff、源码、测试、复现或契约证据的发现；结果必须回绑 candidate/diff digest。
- oracle 只用于重大方向和取舍，不作最终决定。

## 实现、审查与收敛

Delivery 工具按状态动态开放。任何时候不确定当前阶段时，先调用只读的 `delivery_runtime_status`：

- `IMPLEMENTING` 和授权 `REWORKING` 根据 plan route 二选一：`single` 只给父 Pi 源码写入工具与 `delivery_submit_candidate`；`standard/high-risk` 从父 Pi 移除源码写入，只给 `delivery_delegate_worker`。
- `delivery_delegate_worker` 使用 builtin fresh foreground worker。父进程在 child 运行期间保管 workspace lease，但没有写工具、没有并行下一回合，且 tool-batch barrier 拒绝 sibling write；匹配 run ID 和 `launchContractDigest` 的 terminal response 到达后才自动冻结 candidate 与释放 lease。proof 缺失时保留 lease并 BLOCKED。
- builtin worker 不获得 shell、ambient Extension 或 MCP。确需 formatter/generator 确定性改写时，plan v2 的对应 validation item 必须同时声明用户批准的 `repairCommand` 和 `repairTimeoutMs`；Delivery Gate 只在可信 worker terminal 后、candidate freeze 前、同一 lease 内执行。Tiny 不支持 repair command，调用者不能临时传入命令，失败时不得冻结 candidate。
- 候选提交成功、状态切到 `VALIDATING` 后，验证、审查、返工和完成工具才会在下一次模型请求中出现。
- 后续阶段工具提前不可见不是运行时故障，不得以此为由撤销批准或删除规划文档。
- 当前阶段必需工具确实缺失时可以 `delivery_invalidate(target=BLOCKED)` 暂停；该动作只释放 writer 并保留批准链、规划文档、candidate 和 evidence。恢复权限仍必须由 TUI 用户执行 `/delivery-resume`。
- 只有需求、范围、架构或计划真的失效时，才使用 `SHAPING` 或 `PLANNING` 目标撤销相应批准。
- `delivery_validate` 不启动 AI child。Extension 只通过 Pi 公开 `pi.exec` 顺序执行已批准 Delivery Contract 中的命令，并在同一个工具调用中显示当前命令、退出码和耗时；TUI validation 窗口隐藏默认高频 spinner并使用低频进度更新。父 Pi 只调用一次，不得定时轮询 `delivery_runtime_status`。计划中的 timeout 优先使用同环境、同范围最近耗时并留足余量；缺少证据的长全量或容器命令使用保守值。宿主 timeout 不能保证终止外部后代进程时，批准命令自身必须提供可终止边界，不能假设 `pi.exec` 会清理全部外部进程。
- validation terminal checkpoint 保存绑定 candidate 的批次 ID 和逐命令摘要。命令无法启动、工具中断或 terminal checkpoint 缺失按 infrastructure failure；真实非零退出或超时只证明批准命令未通过。父会话必须再区分候选代码、验证环境和已批准计划。只有代码问题才调用 `delivery_begin_rework({ reason: "包含全部已接受问题、证据、修复断言和边界的单个字符串" })`；不要传入 `acceptedFindings` 或其他未定义字段。计划错误使用 `/delivery-revise`。

```text
tiny: 父 Pi exact-scope 实现 -> delivery_submit_candidate -> delivery_validate -> delivery_finalize
plan-v2 single: 父 Pi 实现 -> delivery_submit_candidate
standard/high-risk: 唯一 worker 实现 -> terminal proof -> 自动冻结 candidate
  -> delivery_validate
  -> 同一 candidate 的集中 review wave
  -> 父会话裁决
  -> accepted P0/P1 转成可验证关闭义务
  -> 同一路由的唯一 writer 批量返工并运行确定性复验
  -> 一次 closure review
  -> delivery_finalize 或升级设计
```

第一次返工前尽量集中发现同一 candidate 上的阻断问题：中风险通常使用一个完整 reviewer，高风险可以使用不同角度的只读 reviewer 并行检查，再由父会话一次性去重和裁决。

每个 accepted P0/P1 必须记录被破坏的不变量、最小复现或源码矛盾、修复后断言、影响边界和关闭证据。返工期间依靠 regression/property test、固定 gate 或其他确定性证据关闭这些义务，不在每个局部修改后重新启动完整 review。

返工候选只做一次 closure review，检查原 accepted P0/P1 和修复直接引入的 regression。与修复无关的历史问题另开任务；P2、推测性意见和未来优化只报告，不自动返工。

同一最小复现仍失败，或同一不变量继续出现新的 P0/P1 变体，说明当前修复方式没有收敛：返回 `SHAPING` 或 `PLANNING` 重做相应机制并重新批准，不能继续堆叠补丁。次数或资源预算只防止失控执行；只有仍存在已证实、未关闭的 P0/P1 才 `BLOCKED`，全部关闭义务通过后应交付并报告残余风险。

## 进度与恢复

Extension checkpoint 是运行时恢复事实；项目自己的计划、Issue 或 TODO 是项目进度事实。身份、路径、写后现场或检查冲突时进入 BLOCKED，不自动覆盖。仅当 exact 文本前置条件在写前冲突且策略恢复与 lease 释放均可证明时，保持原状态并允许重读后重试；这不表示项目进度已经一致。

只在无活跃 writer 且 lease 状态可证明时同步项目进度。target 必须是批准的 canonical project-relative 非保留路径；每次同步前读取目标的当前 exact 区块，不复用较早调用前的 `oldText`，`oldText/newText` 均须非空且当前入口不支持删除；exact `newText` 已唯一存在时可作为幂等成功。断线恢复先只读校验批准、未知 worker、lease、candidate 和 evidence，再从 `nextReadyAction` 继续；不得重放结果未知的写入或命令。

## 停止条件

遇到以下情况立即停止并请求用户决定：

- 新产品、范围或架构决策
- 批准条目、cwd、lease 或 candidate 无法证明
- accepted P0/P1 需要改变已批准范围、架构或验收标准
- 同一复现或不变量在返工后仍失败，需要升级设计
- 真实 Provider、费用、凭证、生产或不可逆操作
- commit、push、PR、发布或部署

## 最终交付

最终报告包含：交付等级、改动文件、candidate digest、命令与结果、适用时 accepted P0/P1 的关闭证据和 closure review、适用时项目进度同步状态、残余风险、用户验收状态，以及 commit/push/PR/publish/deploy 是否执行。
