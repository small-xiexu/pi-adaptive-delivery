import { createBashTool, createEditTool, createReadToolDefinition, createWriteTool, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Type } from "typebox";
import { allowedReadTools, installPolicy, CAPABILITY_NOTICE } from "./src/policy.ts";
import { GIT_STATUS_TOOL, readGitStatus, getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "./src/workspace.ts";
import { CHILD_ENV, CHILD_READY, CHILD_EXIT, CHILD_STOP, DELEGATE_TOOL, DELEGATION_ENTRY, delegateReadOnly, snapshotReadOnlyEnvironment } from "./src/subagents.ts";
import { installApprovals } from "./src/approvals.ts";
import { createParentDocumentWriter, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL, nativeEntries } from "./src/parent-writer.ts";
import { CHILD_ARM, DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL, createChildDevelopment, createDevelopmentDelegator } from "./src/development.ts";
import { createTaskProgress, taskRenderers } from "./src/progress.ts";
import { createStructuredCommands, structuredPackage, STRUCTURED_TOOLS, STRUCTURED_READ_IMAGE, type ExecInput, type StdinInput } from "./src/structured.ts";
import { resolveContainerImage } from "./src/container.ts";
import { installTaskDetails } from "./src/task-details.ts";
import { installStreamRetry } from "./src/stream-retry.ts";
import { agentSelection, installModelCatalog, selectChildAgent } from "./src/agent-selection.ts";

export default function adaptiveDelivery(pi: ExtensionAPI): void {
	const entryPath = fileURLToPath(import.meta.url);
	installStreamRetry(pi);
	// 子进程启动前确定角色；该内部标记只去除协调权限，不提供批准能力。
	const child = Boolean(process.env[CHILD_ENV]);
	const childDevelopment = process.env[CHILD_ENV] === "development" ? createChildDevelopment(pi) : undefined;
	let promptOptions: BuildSystemPromptOptions | undefined;
	let structured: Awaited<ReturnType<typeof structuredPackage>>;
	let readonlyCommands: ReturnType<typeof createStructuredCommands> | undefined;
	let readonlyStarting = false;
	let structuredClose: { clean: boolean; incomplete: boolean } | undefined;
	const readonlyResources: string[] = [];
	const readPaths = (ctx: ExtensionContext) => {
		if (!promptOptions) throw new Error("本回合资源环境尚未核实");
		const options = promptOptions;
		const resources = [...(options.contextFiles ?? []).map((file) => file.path), ...(options.skills ?? []).map((skill) => skill.baseDir)];
		// 子只接收父明确给定的证据；自身 Session 仍在追加，收尾后由父按委派引用读取。
		if (!child && ctx.sessionManager.getSessionFile()) resources.push(ctx.sessionManager.getSessionFile()!);
		if (child) resources.push(...JSON.parse(process.env.PI_ADAPTIVE_DELIVERY_READ_PATHS ?? "[]"));
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && [DELEGATION_ENTRY, "delivery-development"].includes(entry.customType)) {
				const data = entry.data as { sessionFile?: string; childSessionFile?: string; reviewDirectory?: string };
				if (data.sessionFile) resources.push(data.sessionFile);
				if (data.childSessionFile) resources.push(data.childSessionFile);
				if (data.reviewDirectory) resources.push(data.reviewDirectory);
			}
		}
		return [...new Set(resources)];
	};
	const structuredAllowed = (name: string) => Boolean(structured && STRUCTURED_TOOLS.includes(name)
		&& pi.getAllTools().some((tool) => tool.name === name && tool.sourceInfo.path === entryPath));
	pi.on("session_start", async (_event, ctx) => {
		await readonlyCommands?.finish();
		readonlyCommands = undefined;
		structuredClose = undefined;
		if (!pi.getActiveTools().includes("exec_command")) { structured = undefined; return; }
		// 同一 Extension 实例切换 Session 后，公开工具来源已经是本扩展；保留已核实的原定义。
		if (!structuredAllowed("exec_command")) structured = await structuredPackage(pi.getAllTools());
		if (!structured) return;
		for (const tool of structured.tools) pi.registerTool({
			name: tool.name, label: tool.name, parameters: tool.parameters as any,
			description: `${tool.description}\n交付隔离：exec_command/write_stdin 只在本地禁网 Docker 中运行，最长 300 秒、至多一个未交回命令；max_output_tokens 须大于 0 且不超过 12500，默认 4000；yield_time_ms 为 0–30000，返回 session_id 后用 write_stdin 取回最终退出。使用容器内 /bin/sh 与镜像已有程序，workdir 和文件使用本 worktree 原绝对路径，不继承宿主 Shell、PATH 或凭据。父/只读子镜像 node:22-alpine 提供 Node 和 BusyBox，不能假定有 rg、Python 或 GNU find。工作树、明确审查目录（before/after/diff.patch）及原始 Session 均只读；长 JSONL 可用 Node fs 按换行逐条 JSON.parse，按角色和记录位置选取 content 中的 text 或工具结果，分段输出原文，不输出 thinking；grep 单行可能截断，不能据此判定原文不可读。开发须原实施确认中的容器授权，apply_patch 仅修改原可写挂载，镜像须支持 glibc helper。父文档仍使用 delivery_document_edit/write。`,
			execute: async (id, args: any, signal, update, context) => {
				if (!structuredAllowed(tool.name)) throw new Error("Structured 工具来源已变化，未执行");
				if (tool.name === "view_image") {
					if (!context.model?.input.includes("image")) throw new Error("当前模型不支持图片；未调用额外 Provider");
					const result = await createReadToolDefinition(context.cwd).execute(id, { path: args.path }, signal, update, context);
					if (!result.content.some((part) => part.type === "image")) throw new Error(`view_image 未取得可用图片：${result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")}`);
					return result;
				}
				if (childDevelopment) return childDevelopment.executeStructured(tool.name, id, args, path.join(structured!.root, `src/tools/apply-patch/bin/linux-${process.arch}/apply_patch`), signal, update);
				if (tool.name === "apply_patch") throw new Error("父协调或只读子不提供 apply_patch 写入；父规划文档使用默认可编辑 Markdown 的文档工具");
				if (readonlyStarting) throw new Error("只读命令正在准备，不能同时启动另一命令");
				if (tool.name === "write_stdin" && !readonlyCommands) throw new Error("session_id 不属于本次会话中的命令");
				if (!readonlyCommands) {
					readonlyStarting = true;
					try {
						const workspace = await resolveWorkspaceIdentity(context.cwd);
						const sessionFile = context.sessionManager.getSessionFile();
						if (!sessionFile) throw new Error("只读容器需要持久 Session 保存执行引用");
						const binding = { cwd: context.cwd, sessionFile, sessionId: context.sessionManager.getSessionId(), lifetime: new AbortController() };
						readonlyCommands = createStructuredCommands({ workspace, image: await resolveContainerImage(STRUCTURED_READ_IMAGE, workspace.workspacePath),
							readPaths: [], writePaths: [], protectedPaths: [], hostPaths: true, readonlyWorkspace: readonlyResources },
							async (reference, toolCallId, toolName) => {
								pi.appendEntry("delivery-container", { ...reference, toolCallId, toolName, readonly: true });
								const saved = await nativeEntries(binding, context);
								const entry = saved.branch.findLast((row) => row.type === "custom" && row.customType === "delivery-container");
								if (!entry) throw new Error("只读容器执行引用缺失");
								saved.requireEntry(entry);
							});
					} finally { readonlyStarting = false; }
				}
				if (tool.name === "write_stdin") return readonlyCommands.stdin(args as StdinInput, signal, update);
				readonlyResources.splice(0, readonlyResources.length, ...readPaths(context));
				return readonlyCommands.exec(id, args as ExecInput, signal, update);
			},
		});
	});
	pi.on("session_shutdown", async () => {
		if (!structured || childDevelopment) return;
		if (readonlyCommands) {
			structuredClose = { clean: false, incomplete: true };
			structuredClose = await readonlyCommands.finish();
		} else structuredClose ??= { clean: true, incomplete: false };
		readonlyCommands = undefined;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!readonlyCommands?.active) return;
		structuredClose = { clean: false, incomplete: true };
		structuredClose = await readonlyCommands.finish();
		pi.appendEntry("delivery-container", { ...readonlyCommands.lastExecution, phase: "ended", readonly: true });
		readonlyCommands = undefined;
		if (!child) ctx.ui.notify("本回合未交回的只读命令已停止；旧 session_id 不再可用，请核对原始记录。", "warning");
	});
	pi.on("session_before_switch", () => readonlyCommands?.active ? { cancel: true } : undefined);
	pi.on("session_before_fork", () => readonlyCommands?.active ? { cancel: true } : undefined);
	pi.on("session_before_tree", () => readonlyCommands?.active ? { cancel: true } : undefined);
	const environment = (options: BuildSystemPromptOptions) => {
		const names = allowedReadTools(pi);
		const activeTools = pi.getActiveTools();
		const structuredMode = Boolean(structured && activeTools.includes("exec_command"));
		if (structuredMode && !structuredAllowed("exec_command")) throw new Error("Structured 工具未由交付扩展接管；请将 delivery-gate 放在 pi-codex-conversion 之前加载，再重新启动会话");
		if (structured && activeTools.some((name) => ["exec", "notebook"].includes(name)
			&& pi.getAllTools().some((tool) => tool.name === name && tool.sourceInfo.path === path.join(structured!.root, "dist", "index.js")))) throw new Error("Code/Notebook 不属于本次 Structured 支持范围，未委派");
		if (structuredMode) names.push(...activeTools.filter(structuredAllowed));
		return { ...snapshotReadOnlyEnvironment(options, pi.getAllTools().filter((tool) => names.includes(tool.name))),
			...(structuredMode ? { structured: { entry: path.join(structured!.root, "dist", "index.js"), version: "3.0.29" } } : {}) };
	};
	installPolicy(pi, child ? undefined : entryPath, childDevelopment ? entryPath : undefined, structuredAllowed);
	pi.on("session_start", () => { promptOptions = undefined; });
	pi.on("before_agent_start", (event) => {
		promptOptions = structuredClone(event.systemPromptOptions);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${CAPABILITY_NOTICE}\n不要把规划目标、旧记录或模型声明当成已实现功能或用户批准。`
				+ (childDevelopment ? "\n开发子会话只使用已交接的文件/容器工具，不修改父规划文档、不执行宿主 Shell、不批准或继续委派。"
					: child ? "\n子会话只能只读，不提供批准或文档编辑。" : "\n任务所需 Markdown 编辑默认允许，直接使用父文档工具，不申请单独文档授权；先读取现场并保留用户内容。每回合一次文档变更，等待原生终态后再继续。方案确认和实施确认仍独立。委派时按 adaptive-delivery Skill 的工作场景、复杂度和风险选择 agent 配置；delivery_models 查询可用模型，不统计费用。"),
		};
	});
	if (child) {
		pi.registerCommand(CHILD_STOP, { description: "内部子任务收尾，不授予任何权限", handler: async (_args, ctx) => ctx.shutdown() });
		pi.registerCommand(CHILD_READY, { description: "内部任务环境核对，不调用模型", handler: async (args, ctx) => {
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			pi.appendEntry(CHILD_READY, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				cwd: workspace.cwdPath, entryPath, environment: environment(ctx.getSystemPromptOptions()), projectTrusted: ctx.isProjectTrusted(),
				...(childDevelopment ? { owner: await childDevelopment.ready(args, ctx), developmentTools: pi.getAllTools().filter((tool) => (structured ? STRUCTURED_TOOLS : ["write", "edit", "bash"]).includes(tool.name)) } : {}) });
		} });
		if (childDevelopment) {
			pi.registerCommand(CHILD_ARM, { description: "内部 writer 交接，不生成批准", handler: async (args, ctx) => {
				await childDevelopment.arm(JSON.parse(args), ctx);
			} });
			pi.registerTool({ name: "edit", label: "开发文件编辑", description: "在已交接的子 writer 范围内精确编辑文件，禁止修改父规划文档。",
				parameters: createEditTool(".").parameters, execute: (id, input, signal) => childDevelopment.execute("edit", id, input, signal) });
			pi.registerTool({ name: "write", label: "开发文件写入", description: "在已交接的子 writer 范围内创建或完整重写文件，禁止修改父规划文档。",
				parameters: createWriteTool(".").parameters, execute: (id, input, signal) => childDevelopment.execute("write", id, input, signal) });
			pi.registerTool({ name: "bash", label: "容器命令", description: "仅在已批准的本地 Docker 镜像和明确挂载范围内执行 /bin/sh 命令。容器内 /workspace 对应 worktree，宿主路径和 Shell 配置不可用。不访问网络、凭据、规划文档或 Docker socket；未批准容器时拒绝，不回退宿主 Bash。内存 1 GiB；timeout 默认及上限均为 300 秒，测试耗时未知时省略 timeout，不随意缩短为 60 秒。",
				parameters: createBashTool(".").parameters, execute: (id, input, signal, update) => childDevelopment.execute("bash", id, input, signal, update) });
		}
		pi.on("session_shutdown", async (_event, ctx) => {
			pi.appendEntry(CHILD_EXIT, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				...(structured && !childDevelopment ? { structured: structuredClose } : {}),
				...(childDevelopment ? { development: await childDevelopment.finish(ctx) } : {}) });
		});
		return;
	}
	const approvals = installApprovals(pi);
	const writer = createParentDocumentWriter(pi);
	installModelCatalog(pi);
	const developer = createDevelopmentDelegator(pi, approvals);
	const active = new Map<AbortController, { run: Promise<unknown>; progress: ReturnType<typeof createTaskProgress> }>();
	const tasks = () => [...active.values()].map((item) => item.progress.snapshot()).concat(developer.progress ? [developer.progress] : []);
	const openTask = installTaskDetails(pi, tasks);
	pi.registerTool({ name: GIT_STATUS_TOOL, label: "Git 现状",
		description: "固定只读查询当前 worktree 的分支、HEAD、暂存/未暂存及未跟踪改动，路径按 JSON 转义。无 HEAD 或 detached 明确返回 null。最多读取 50 KiB，超限报错，不隐藏改动；没有命令或路径参数，不获取源码差异、不产生批准。",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_id, _input, signal, _update, ctx) => {
			const status = await readGitStatus(ctx.cwd, signal);
			const text = JSON.stringify(status, null, 2);
			if (Buffer.byteLength(text) > 50 * 1024) throw new Error("Git 状态超过 50 KiB，未返回不完整清单");
			return { content: [{ type: "text", text }], details: status };
		},
	});
	pi.registerTool({ name: REVIEW_TOOL, label: "独立候选审查",
		...taskRenderers("审查", openTask),
		description: "在本轮可信固定验收和当前候选一致时，沿只读子路径独立审查批准目标、当前代码、实际差异及原始验收记录。审查期间占用 writer lease，结束后核实候选与记录再交回。发现由父会话裁决，不自动等于审查通过；不恢复旧 Session 证据。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "本次审查重点和已知风险；工具自动附带原批准正文、代码路径、实际差异及验收记录，无须重述全部需求，不以实现者总结代替证据" }), agent: Type.Optional(agentSelection) }, { additionalProperties: false }),
		execute: async (id, input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未开始审查");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.review({ id, task: input.task, cwd: workspace.cwdPath, entryPath, readPaths: readPaths(ctx), parentSessionId: ctx.sessionManager.getSessionId(),
				...selectChildAgent(pi, ctx, input.agent), toolInput: input, environment: environment(promptOptions), projectTrusted: ctx.isProjectTrusted() }, signal, ctx,
				(message, progress) => update?.({ content: [{ type: "text", text: message }], details: { progress } }));
		},
	});
	pi.registerTool({ name: VALIDATION_TOOL, label: "固定候选验收",
		...taskRenderers("验收", openTask),
		description: "用独立标准 Pi 子会话执行本轮已批准的固定容器验收命令，不能修改或替换命令。实际输入、源码、镜像与前后候选必须一致，全部真实命令通过才报告本次验收通过；不代替独立审查。缺少容器授权或命令时明确未运行。",
		parameters: Type.Object({ agent: Type.Optional(agentSelection) }, { additionalProperties: false }),
		execute: async (id, input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未开始验收");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.validate({ id, task: "执行本轮批准的固定候选验收，不编辑文件、不改变验收要求。", cwd: workspace.cwdPath, entryPath, readPaths: readPaths(ctx),
				parentSessionId: ctx.sessionManager.getSessionId(), ...selectChildAgent(pi, ctx, input.agent), toolInput: input, environment: environment(promptOptions),
				projectTrusted: ctx.isProjectTrusted() }, signal, ctx, (message, progress) => update?.({ content: [{ type: "text", text: message }], details: { progress } }));
		},
	});
	pi.registerTool({ name: DEVELOPMENT_TOOL, label: "开发文件委派",
		...taskRenderers("开发", openTask),
		description: "将一次开发任务交给独立标准 Pi。要求本轮父 TUI 的方案与实施确认；原生环境使用受控 edit/write，Structured 使用批准容器内的 apply_patch/exec_command/write_stdin。命令须在实施确认中明确批准容器镜像/输入，不能用宿主 Shell 或未知工具覆盖替代。子任务不能修改父规划文档，不递归委派；原生终态落盘后才交回 writer，结果仍需核实。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "本节点的文件变更目标、现场事实和预期证据；工具自动附带已批准方案、实施正文、路径及命令，无须再次抄写或复制完整父历史" }), agent: Type.Optional(agentSelection) }, { additionalProperties: false }),
		execute: async (id, input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未委派");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.execute({ id, task: input.task, cwd: workspace.cwdPath, entryPath, readPaths: readPaths(ctx), parentSessionId: ctx.sessionManager.getSessionId(),
				...selectChildAgent(pi, ctx, input.agent), toolInput: input, environment: environment(promptOptions), projectTrusted: ctx.isProjectTrusted() }, signal, ctx,
				(message, progress) => update?.({ content: [{ type: "text", text: message }], details: { progress } }));
		},
	});
	pi.registerTool({
		name: DOCUMENT_EDIT_TOOL, label: "编辑规划文档",
		description: "默认允许父 TUI 精确编辑任务所需的 worktree 内 Markdown，无须文档授权。先读取现场并保留其他内容，每回合一次变更，原生结果落盘后才交回 writer；不编辑源码。",
		parameters: createEditTool(".").parameters,
		execute: (id, input, signal, _onUpdate, ctx) => writer.edit(id, input, signal, ctx),
	});
	pi.registerTool({
		name: DOCUMENT_WRITE_TOOL, label: "写入规划文档",
		description: "默认允许父 TUI 创建或完整重写任务所需的 worktree 内 Markdown，无须文档授权。已有文件先读取并保留用户内容，局部修改使用 delivery_document_edit。每回合一次变更；不编辑源码。",
		parameters: createWriteTool(".").parameters,
		execute: (id, input, signal, _onUpdate, ctx) => writer.write(id, input, signal, ctx),
	});
	pi.registerTool({
		name: DELEGATE_TOOL, label: "只读委派",
		...taskRenderers("只读", openTask),
		description: "在独立标准 Pi 会话中执行一次只读分析。使用父已启用的原生 read/grep/find/ls，或已核实 Structured 的只读容器命令/图片读取；发送任务前核对工具定义、基础指令、规则和 Skills。子不可写入或继续委派，不复制父完整历史。结果最多 2000 行或 50KB，原始证据保留在子 Session。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "目标、必要背景、只读边界及预期证据；不要复制父完整历史" }), agent: Type.Optional(agentSelection) }, { additionalProperties: false }),
		execute: async (id, params, signal, onUpdate, ctx) => {
			if (!ctx.model) throw new Error("当前模型未确定，未委派");
			if (!promptOptions) throw new Error("当前回合的基础环境未取得，未委派");
			const expectedEnvironment = environment(promptOptions);
			const selectedAgent = selectChildAgent(pi, ctx, params.agent);
			const controller = new AbortController();
			const operation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const notify = (message: string, progress: ReturnType<ReturnType<typeof createTaskProgress>["snapshot"]>) => onUpdate?.({ content: [{ type: "text" as const, text: message }], details: { progress } });
			const progress = createTaskProgress(id, "只读", params.task, notify);
			progress.phase("准备中");
			const run = (async () => {
				const workspace = await resolveWorkspaceIdentity(ctx.cwd);
				const result = await delegateReadOnly({ id, task: params.task, cwd: workspace.cwdPath, entryPath, readPaths: readPaths(ctx),
					parentSessionId: ctx.sessionManager.getSessionId(), ...selectedAgent, toolInput: params,
					environment: expectedEnvironment, projectTrusted: ctx.isProjectTrusted() }, operation,
					(data) => pi.appendEntry(DELEGATION_ENTRY, data),
					notify, ctx, progress);
				return { content: [{ type: "text" as const, text: `子任务执行结束，结果仍需父会话核实：\n${result.text}\n子会话：${result.sessionFile}` }], details: { ...result, progress: progress.snapshot() } };
			})();
			active.set(controller, { run, progress });
			try { return await run; } finally { active.delete(controller); }
		},
	});
	pi.on("session_before_switch", () => active.size ? { cancel: true } : undefined);
	pi.on("session_before_fork", () => active.size ? { cancel: true } : undefined);
	pi.on("session_shutdown", async (_event, ctx) => {
		for (const controller of active.keys()) controller.abort(new Error("父会话正在关闭或重载"));
		const results = await Promise.allSettled([...active.values()].map((item) => item.run));
		if (results.some((result) => result.status === "rejected")) ctx.ui.notify("委派已停止；存在取消或失败，请核对原生会话记录。", "warning");
	});
	pi.registerCommand("delivery-status", {
		description: "查看交付状态；details 显示诊断信息",
		handler: async (args, ctx) => {
			try {
				const workspace = await resolveWorkspaceIdentity(ctx.cwd);
				const stateRoot = await getWriterStateRoot(workspace);
				const lease = await new WriterLeaseManager(stateRoot).read(workspace.key);
				const running = tasks();
				const native = allowedReadTools(pi);
				const missing = ["grep", "find", "ls"].filter((name) => !native.includes(name));
				const structuredTools = pi.getActiveTools().filter(structuredAllowed);
				const structuredMode = Boolean(structured && structuredTools.includes("exec_command"));
				ctx.ui.notify(`交付状态 · ${structuredMode ? "Structured" : "原生 Pi"}\n工作区：${workspace.workspacePath}`
					+ `\n只读工具：${(structuredMode ? structuredTools : native).join(", ") || "无"}`
					+ (running.length ? running.map((task) => `\n${task.status} · ${task.name}\n${task.action}`).join("") : "\n当前没有运行中的子任务。")
					+ (writer.pending || developer.pending ? "\n文件操作尚在执行或收尾，请等待交回。" : "")
					+ (readonlyCommands?.active ? "\n只读命令尚未交回，等待最终结果。" : "")
					+ (lease && !writer.pending && !developer.pending ? "\n需要处理：现场有未交回的写入记录；核实原执行前暂停写入，不自动解锁。" : "")
					+ (!structuredMode && missing.length ? `\n仓库查找缺少 ${missing.join("/")}；需要时在项目 defaultTools 中启用。` : "")
					+ "\n/delivery-tasks 查看任务详情；/delivery-status details 查看诊断。"
					+ (args.trim() === "details" ? `\n\n${CAPABILITY_NOTICE}\n${lease ? `现场 lease：${lease.leaseId}\nowner：${lease.owner.kind}，PID ${lease.owner.pid}，Session ${lease.owner.sessionId}，执行 ${lease.owner.runId ?? "未记录"}\n不自动解锁，记录不证明执行已停止。` : "未发现 lease；不等于已取得授权。"}\n状态目录：${stateRoot}`
						+ running.map((task) => `\n任务 ${task.id}\n原始子 Session：${task.sessionFile ?? "尚未取得"}`).join("") : ""), "info");
			} catch (error) {
				ctx.ui.notify(`交付状态读取失败：${String(error)}`, "error");
			}
		},
	});
}
