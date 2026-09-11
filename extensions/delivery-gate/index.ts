import { createBashTool, createEditTool, createWriteTool, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Type } from "typebox";
import { inheritedTools, installPolicy, CAPABILITY_NOTICE } from "./src/policy.ts";
import { GIT_STATUS_TOOL, readGitStatus, getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "./src/workspace.ts";
import { CHILD_ENV, CHILD_READY, CHILD_EXIT, CHILD_STOP, DELEGATE_TOOL, DELEGATION_ENTRY, delegateReadOnly, snapshotReadOnlyEnvironment } from "./src/subagents.ts";
import { installApprovals } from "./src/approvals.ts";
import { createParentDocumentWriter, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL } from "./src/parent-writer.ts";
import { CHILD_ARM, DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL, createChildDevelopment, createDevelopmentDelegator } from "./src/development.ts";
import { createTaskProgress, taskRenderers } from "./src/progress.ts";
import { structuredPackage } from "./src/structured.ts";
import { installTaskDetails } from "./src/task-details.ts";
import { installStreamRetry } from "./src/stream-retry.ts";
import { agentSelection, selectChildAgent } from "./src/agent-selection.ts";
import { installActivation } from "./src/activation.ts";

export default function adaptiveDelivery(pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV]) { installDelivery(pi); return; }
	installActivation(pi, (ctx) => installDelivery(pi, ctx)!);
}

function installDelivery(pi: ExtensionAPI, initialContext?: ExtensionContext) {
	const entryPath = fileURLToPath(import.meta.url);
	installStreamRetry(pi);
	// 子进程启动前确定角色；该内部标记只去除协调权限，不提供批准能力。
	const child = Boolean(process.env[CHILD_ENV]);
	const childDevelopment = process.env[CHILD_ENV] === "development" ? createChildDevelopment(pi) : undefined;
	let promptOptions: BuildSystemPromptOptions | undefined;
	let structured: Awaited<ReturnType<typeof structuredPackage>>;
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
	const initializeStructured = async () => {
		if (!structured && !pi.getActiveTools().includes("exec_command") && !process.env.PI_ADAPTIVE_DELIVERY_STRUCTURED) return;
		if (!structured) structured = await structuredPackage(pi.getAllTools());
	};
	if (child) pi.on("session_start", initializeStructured);
	const environment = (options: BuildSystemPromptOptions) => {
		return { ...snapshotReadOnlyEnvironment(options, inheritedTools(pi, entryPath)),
			...(structured ? { structured: { entry: path.join(structured.root, "dist", "index.js"), version: structured.version } } : {}) };
	};
	installPolicy(pi, entryPath);
	pi.on("session_start", () => { promptOptions = undefined; });
	pi.on("before_agent_start", (event, ctx) => {
		promptOptions = structuredClone(event.systemPromptOptions);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${CAPABILITY_NOTICE}\n不要把规划目标、旧记录或模型声明当成已实现功能或用户批准。`
				+ (child ? "" : `\n受控交付已启用。先读取并遵循 ${fileURLToPath(new URL("../../skills/adaptive-delivery/SKILL.md", import.meta.url))}；没有变化时不重复全文读取。`)
				+ (childDevelopment ? "\n开发子会话沿用父 Pi 原有工具，遵守批准范围，不修改父规划文档、不批准或继续委派。"
					: child ? "\n本次子任务只分析和查阅资料，不修改文件或执行外部写入；这是任务要求，工具能力仍沿用父 Pi。" : "\n简单明确、可一次完成并验证的任务，无须新建技术方案或实施计划文件；直接在会话中说明方案、实施步骤和验收，没有规划文档时 design.paths 传 []。有持续维护需要时落文档，已有方案/台账按项目规则沿用并列为规划路径，不为填参数创建占位文档。任务所需 Markdown 编辑默认允许，使用父文档工具并保留用户内容；每回合一次文档变更，等待原生终态后再继续。方案确认和实施确认仍独立，实施必须列明可写范围。委派时按 adaptive-delivery Skill 的工作场景、复杂度和风险选择推理级别，不另选模型。")
				+ (!child && ctx.model ? `\n子任务固定继承父 Pi 当前模型 ${ctx.model.provider}/${ctx.model.id}；可选推理级别：${getSupportedThinkingLevels(ctx.model).join("、")}。省略 thinking 继承父当前级别；父切换模型后，新任务跟随，已启动的任务保持原模型。` : ""),
		};
	});
	if (child) {
		pi.registerCommand(CHILD_STOP, { description: "内部子任务收尾，不授予任何权限", handler: async (_args, ctx) => ctx.shutdown() });
		pi.registerCommand(CHILD_READY, { description: "内部任务环境核对，不调用模型", handler: async (args, ctx) => {
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			pi.appendEntry(CHILD_READY, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				cwd: workspace.cwdPath, entryPath, environment: environment(ctx.getSystemPromptOptions()), projectTrusted: ctx.isProjectTrusted(),
				...(childDevelopment ? { owner: await childDevelopment.ready(args, ctx) } : {}) });
		} });
		if (childDevelopment) {
			pi.registerCommand(CHILD_ARM, { description: "内部 writer 交接，不生成批准", handler: async (args, ctx) => {
				const grant = JSON.parse(args);
				await childDevelopment.arm(grant, ctx);
				// 普通开发保留原实现；只有固定验收在任务发送前安装其命令执行器。
				if (!grant.validation) return;
				if (structured) {
					const tool = structured.tools.find((tool) => tool.name === "exec_command")!;
					pi.registerTool({ name: tool.name, label: "固定验收命令", description: tool.description, parameters: tool.parameters as any,
						execute: (id, input, signal, update) => childDevelopment.executeStructured(id, input as import("./src/structured.ts").ExecInput, structured!.root, signal, update) });
				} else pi.registerTool({ name: "bash", label: "固定验收命令", description: createBashTool(".").description, parameters: createBashTool(".").parameters,
					execute: (id, input, signal, update) => childDevelopment.execute(id, input, signal, update) });
			} });
		}
		pi.on("session_shutdown", async (_event, ctx) => {
			pi.appendEntry(CHILD_EXIT, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				...(childDevelopment ? { development: await childDevelopment.finish(ctx) } : {}) });
		});
		return;
	}
	const approvals = installApprovals(pi);
	const writer = createParentDocumentWriter(pi);
	const developer = createDevelopmentDelegator(pi, approvals);
	const active = new Map<AbortController, { run: Promise<unknown>; progress: ReturnType<typeof createTaskProgress> }>();
	const tasks = () => [...active.values()].map((item) => item.progress.snapshot()).concat(developer.progress ? [developer.progress] : []);
	const openTask = installTaskDetails(pi, tasks, initialContext);
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
		description: "用独立标准 Pi 子会话在本机执行本轮已批准的固定验收命令，不修改或替换命令。明确源码及输入范围的前后候选必须一致，全部真实命令通过才报告本次验收通过；不代替独立审查，也不覆盖整台电脑的环境。缺少命令时明确未运行。",
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
		description: "将一次本机开发任务交给独立标准 Pi。要求本轮父 TUI 的方案与实施确认；继承父已启用的文件、Shell、联网及插件工具，沿用原实现与原检查。子任务须遵守批准范围、不修改父规划文档、不递归委派；普通工具不受本 Package 路径拦截。Pi 进程与原生工具终态落盘后交回交付 writer，结果仍需核实。",
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
		description: "在独立标准 Pi 会话中分析并提供证据，可使用父已启用的联网、Shell、文件及插件工具，沿用原权限检查。只读是本次任务要求：不修改文件、不执行外部写入或继续委派；不靠删减工具实现。发送任务前核对工具定义、基础指令、规则和 Skills，不复制父完整历史。结果最多 2000 行或 50KB，原始证据保留在子 Session。",
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
				const diagnostic = args.trim() === "details";
				const inherited = diagnostic ? inheritedTools(pi, entryPath).map((tool) => tool.name) : [];
				const executing = running.filter((task) => !task.endedAt);
				let stage = approvals.confirmedStage === "implementation" ? "实施已确认" : approvals.confirmedStage === "design" ? "等待实施确认" : "等待方案确认";
				let next = approvals.confirmedStage === "implementation" ? "核对已完成工作，按需继续开发、固定验收或独立审查。"
					: approvals.confirmedStage === "design" ? "整理修改范围和验收命令，再确认实施。" : "形成方案后调用 delivery_approval 提交确认；若上一轮模型请求中断，复用当前正文继续，不要开发。";
				if (approvals.pending) next = "处理当前审阅；可以确认、提出意见或暂停。";
				if (executing.length) { stage = `正在执行：${executing.map((task) => task.name).join("；")}`; next = "用 /delivery-tasks 查看实时输出，等待任务结束。"; }
				else if (writer.pending || developer.pending) { stage = "等待收尾"; next = "等待文件操作和执行记录交回，再继续下一步。"; }
				if (lease && !writer.pending && !developer.pending) { stage = "需要核对未结束的执行"; next = "用 /delivery-status details 定位原执行，核实结果后再继续；不自动解锁。"; }
				ctx.ui.notify(`交付状态\n当前阶段：${stage}\n下一步：${next}`
					+ (running.length ? running.map((task) => `\n${task.status} · ${task.name}\n${task.action}`).join("") : "\n当前没有运行中的子任务。")
					+ (writer.pending || developer.pending ? "\n文件操作尚在执行或收尾，请等待交回。" : "")
					+ (lease && !writer.pending && !developer.pending ? "\n需要处理：现场有未交回的写入记录；核实原执行前暂停写入，不自动解锁。" : "")
					+ "\n/delivery-tasks 查看任务详情；/delivery-status details 查看诊断。"
					+ (diagnostic ? `\n\n${CAPABILITY_NOTICE}\n工作区：${workspace.workspacePath}\n运行模式：${structured ? "Structured" : "原生 Pi"}\n沿用 Pi 的工具：${inherited.join(", ") || "无"}\n执行环境：本机，使用项目已有工具链与权限。\n${lease ? `现场 lease：${lease.leaseId}\nowner：${lease.owner.kind}，PID ${lease.owner.pid}，Session ${lease.owner.sessionId}，执行 ${lease.owner.runId ?? "未记录"}\n不自动解锁，记录不证明执行已停止。` : "未发现 lease；不等于已取得授权。"}\n状态目录：${stateRoot}`
						+ running.map((task) => `\n任务 ${task.id}\n原始子 Session：${task.sessionFile ?? "尚未取得"}`).join("") : ""), "info");
			} catch (error) {
				ctx.ui.notify(`交付状态读取失败：${String(error)}`, "error");
			}
		},
	});
	return {
		initialize: initializeStructured,
		assertCanExit: async (ctx: ExtensionContext) => {
			if (approvals.pending || writer.pending || developer.pending || active.size) throw new Error("交互或执行尚未收尾，请等待原始结果与写入权限交回。");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
			await leases.assertIdle(workspace.key);
		},
	};
}
