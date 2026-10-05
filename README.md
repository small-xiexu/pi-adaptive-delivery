# Pi Adaptive Delivery

**让 Pi 按“先确认、再修改、后检查”的方式完成开发任务。**

![Pi Adaptive Delivery 交付流程：方案确认并开始实施 → 开发 · 检查 · 审查](https://raw.githubusercontent.com/small-xiexu/pi-adaptive-delivery/main/docs/images/preview.png)

![Pi Adaptive Delivery 完整交付流程示意图](https://raw.githubusercontent.com/small-xiexu/pi-adaptive-delivery/main/docs/images/flow.png)

这是一个给 Pi 增加交付流程的扩展包。你说明需求和允许修改的范围，Pi 先整理方案并等待确认；确认后再修改代码、运行项目已有检查，并在需要时安排独立审查。

普通 Pi 使用不受影响。安装后不会自动进入交付流程，只有输入 `/delivery-shape` 才会开始。

## 你会怎么使用

整个过程可以理解为五步：

1. 输入 `/delivery-shape`，描述要解决的问题。
2. 和 Pi 讨论方案、范围和验收方式。
3. 在方案面板中选择“确认方案并开始实施”。
4. Pi 直接完成简单任务，或安排开发子 Agent 完成复杂任务，再运行检查和必要的审查。
5. 查看实际改动和检查结果；任务结束后输入 `/delivery-exit` 回到普通 Pi。

```mermaid
flowchart LR
    A[普通使用 Pi] --> B[/delivery-shape]
    B --> C[讨论方案和范围]
    C --> D[确认方案并开始实施]
    D --> E[父 Pi 直接修改或委派开发]
    E --> F[运行项目检查]
    F --> G{需要独立审查?}
    G -->|是| H[审查并处理问题]
    G -->|否| I[查看改动和结果]
    H --> I
    I --> J[/delivery-exit]
    J --> A
```

例如，你可以输入：

```text
/delivery-shape 修复空列表导致页面报错，保持正常列表行为不变
```

Pi 会先说明目标、数据行为、技术路径和验收方式。你可以提出修改意见，直到方案符合预期，再确认开始实施。

## 重要边界

**这不是安全沙箱。** 开发和审查子 Agent 会继承当前 Pi 已启用的普通工具和原有权限检查，包括：

- 读取和修改文件
- Shell 和项目命令
- 联网能力
- 其他已加载的 Pi 插件工具

审查子 Agent 也不会被 Package 自动禁用 `write` 或 `edit`。开发和审查的区别来自任务职责：开发负责实现，审查负责检查和报告问题。Package 负责方案确认、任务交接、检查证据和恢复状态，不负责限制普通工具权限，也不能保证项目后台进程全部停止。

项目本身需要的 Node、Python、Java、数据库或其他依赖，仍由项目和本机环境负责。Package 不自动安装依赖、不修改项目运行环境，也不把工具名称存在当成项目检查一定能通过。

## 安装和快速开始

当前版本是 `0.1.12`。普通使用建议选择项目级 npm 安装；如果你要修改或调试这个 Package，再使用本地源码安装。

### 方式一：安装已发布的 npm Package

在你要使用 Package 的项目中执行：

```sh
pi install npm:pi-adaptive-delivery -l
```

然后启动 Pi：

```sh
cd /path/to/your-project
pi
```

项目级安装会在项目中生成 `.pi/settings.json`，其中声明了 Package。这个文件应纳入项目版本控制；`.pi/npm/` 下由 npm 生成的 `node_modules`、`package.json` 和锁文件通常由 npm 的 `.gitignore` 排除，不要提交。

如果使用全局安装，所有项目都会加载这个 Package：

```sh
pi install npm:pi-adaptive-delivery
```

卸载项目级 Package：

```sh
pi remove npm:pi-adaptive-delivery -l
```

### 方式二：使用本地源码

适合开发、调试或试用尚未发布的修改：

```sh
git clone https://github.com/small-xiexu/pi-adaptive-delivery.git
```

然后在**你要修改的项目**的 `.pi/settings.json` 中加入本地仓库绝对路径，并保留已有配置和其他扩展包：

```json
{
  "packages": [
    "/absolute/path/to/pi-adaptive-delivery"
  ]
}
```

本地 Package 目录本身需要有 Pi 能加载的扩展资源。进入目标项目后启动 Pi：

```sh
cd /path/to/your-project
pi
```

无论使用哪种安装方式，都需要：

- 已配置可用模型的 Pi
- 一个 Git 项目
- 项目本身已有的运行依赖和检查命令

Package 不要求 Docker 或镜像。项目检查直接使用本机工具链。

### 启动和重载

如果 Pi 已经开着，安装 Package 或修改 `.pi/settings.json` 后，等当前任务收尾，再输入：

```text
/reload
```

进入交付流程：

```text
/delivery-shape
```

你也可以直接带上需求：

```text
/delivery-shape 修复登录超时后页面一直显示加载中的问题
```

## 方案确认和实施方式

Pi 会根据任务复杂度选择实施方式：

- **简单任务：** 当前 Pi 在已确认范围内直接修改和检查。
- **复杂任务：** 独立开发子 Agent 修改代码，完成后把结果交回父 Pi。
- **需要第二视角的任务：** 独立审查子 Agent 读取当前改动、运行检查并报告问题。

你通常只需要确认一次方案。确认后，Pi 可以在同一范围内调整步骤、修正失败、继续检查和安排返工。以下情况需要重新确认：

- 改变业务目标或数据行为
- 扩大源码或测试范围
- 改变对外接口
- 改变验收标准
- 引入新的重大外部风险

需要长期查阅或持续跟踪进度时，方案可以写入项目 Markdown 文档；简单任务也可以只保留在当前会话中。确认界面会显示本次是否复用现有文档、新建文档或不落盘。

落盘方案在确认前必须确实写入指定的 Markdown 文件。文件不存在、为空或不是普通文件时，Package 会拒绝确认并提示先完成文档写入。不落盘的方案会明确说明内容只保存在当前会话。

## 命令速查

### 开始和推进

| 命令 | 用途 |
|---|---|
| `/delivery-shape [需求]` | 进入交付流程并讨论需求；可以不带需求，只开启流程 |
| `/delivery-plan [补充要求]` | 让 Pi 继续整理方案、内部步骤和验收路径 |
| `/delivery-run [补充要求]` | 让 Pi 继续执行已经确认的方案 |

`/delivery-plan` 和 `/delivery-run` 是恢复和推进入口，不能代替方案确认，也不会在未确认时直接开始开发。

### 查看进度和任务

| 命令 | 用途 |
|---|---|
| `/delivery-status` | 查看当前阶段、下一步和正在运行的任务 |
| `/delivery-status details` | 查看工作区、写入交接、失败阶段、lease 和原始 Session 等诊断信息 |
| `/delivery-tasks [任务 ID]` | 查看子任务列表或打开指定任务的实时详情 |
| `/delivery-resume` | 继续当前会话中尚未确认的方案；只继续讨论，不会自动开始开发 |

`/delivery-tasks` 可以在子任务运行期间使用，不需要等任务结束或重载 Pi。

### 退出和恢复

| 命令 | 用途 |
|---|---|
| `/delivery-exit` | 正常结束交付流程，恢复进入前的工具列表和普通 Pi 使用 |
| `/delivery-unlock` | 在确认没有在途任务后，人工核对并清理崩溃或强杀留下的残留写入记录 |

正常结束时使用 `/delivery-exit`。如果它提示仍有写入记录，先执行：

```text
/delivery-status details
```

确认没有运行中的任务、排队消息或未完成交互后，再使用：

```text
/delivery-unlock
```

清理后重新查看状态并检查代码改动。`/delivery-exit` 不负责强制删除未知状态的写入记录。

如果 `/delivery-unlock` 明确报告已经复位同一父 Pi 进程中已结束的已知失败状态，并且方案确认仍然有效，可以重新发起任务；否则先退出或重载，再重新使用 `/delivery-shape` 并确认方案。

## 任务状态和检查结果

任务详情只显示 Package 能从原始记录中核实的事实：

- 当前任务是否仍在运行
- 子 Session 是否创建
- 子任务实际执行了哪些工具
- 工具是否返回错误
- 子进程是否正常退出
- 原始 Session 是否完整保存
- writer 是否已经交回
- 检查或审查是否因为改动变化而失效

“已完成”表示子任务正常结束并完成了必要的收尾，不等于业务目标一定达成。项目检查失败、命令未匹配、编辑后需要修正等过程信息会保留在任务详情中，由父 Pi 结合原始结果判断下一步。

代码发生新的修改后，之前的检查结果不能自动证明当前代码仍然通过，通常需要重新检查。审查是独立意见，不会代替用户确认，也不会自动扩大修改范围。

## 普通 Shell 和暂停操作

你仍可以在主 Pi 终端执行手动 Shell：

```text
!命令
!!命令
```

`!` 和 `!!` 沿用 Pi 原生行为。手动执行的命令不会自动获得交付批准，也不会被 Package 当成正式检查证据。

方案面板支持以下操作：

- ↑↓ 选择操作，Enter 确认
- Ctrl+O 查看完整详情
- PgUp/PgDn 翻页
- 选择“提出修改意见”后，Enter 提交意见，Shift+Enter 换行
- Esc 返回方案内容；再次 Esc 才暂停方案

子任务详情中按 Esc 只关闭详情窗口，任务仍会继续。

如果模型长时间没有内容增量，交付流程会在默认 120 秒后中断本次请求并自动继续，每个回合最多自动恢复两次。工具执行期间不计入这个停顿时间，因此长时间运行的项目命令不会被误判。这个机制只在交付流程中生效，普通 Pi 会话仍由 Pi 自己处理停顿。

## 兼容性和当前边界

当前自动化验证过的基础组合是：

- macOS
- Pi `1.0.2`
- Node `25.2.1`

其他 Pi 版本、操作系统、第三方插件组合和真实模型质量没有在本轮完整验证。升级 Pi 后，应重启已经运行的父 Pi；标准 Pi 启动子任务时会优先复用父进程当前的 CLI 入口，避免父进程 PATH 变化后混用另一份 Pi。嵌入 SDK 没有可复用入口时才按 PATH 查找工作区外的标准 CLI，此时仍需要保证宿主 SDK 和找到的 CLI 版本一致。

Package 会核对父子工具定义、工具来源、系统指令、规则和 Skills。环境无法对齐时，任务不会发送，Package 会保持失败关闭，不会静默补回被停用的工具。

本 Package 不依赖或包装 `pi-subagents`，不修改 Pi 安装目录，不提供第二套 Agent runtime，也不接管普通工具的权限系统。

## 进一步阅读

| 想了解什么 | 阅读 |
|---|---|
| 本机工具、配置和验证方式 | [技术方案：本机接入与开发验证](docs/技术方案.md#section-14) |
| 为什么需要先确认方案、怎样进入流程 | [技术方案：方案对齐与主流程](docs/技术方案.md#3-已对齐的主流程) |
| 怎样检查、审查和返工 | [技术方案：验收、审查与返工](docs/技术方案.md#section-10) |
| 中断后怎样恢复 | [技术方案：进度与中断恢复](docs/技术方案.md#section-11) |
| AI 的协作规则和推理级别 | [adaptive-delivery Skill](skills/adaptive-delivery/SKILL.md) |
| 当前进度、版本和实际验证记录 | [实施计划](docs/实施计划.md#section-13) |

实现基于 Pi 的公开 API，使用本机项目权限和工具环境，不把 Package 当作安全沙箱或项目依赖管理器。
