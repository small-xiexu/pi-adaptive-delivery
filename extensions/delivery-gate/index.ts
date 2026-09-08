import { createBashTool, createEditTool, createWriteTool, type BuildSystemPromptOptions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { allowedReadTools, installPolicy, CAPABILITY_NOTICE } from "./src/policy.ts";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "./src/workspace.ts";
import { CHILD_ENV, CHILD_READY, CHILD_EXIT, CHILD_STOP, DELEGATE_TOOL, DELEGATION_ENTRY, delegateReadOnly, snapshotReadOnlyEnvironment } from "./src/subagents.ts";
import { installApprovals } from "./src/approvals.ts";
import { createParentDocumentWriter, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL } from "./src/parent-writer.ts";
import { CHILD_ARM, DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL, createChildDevelopment, createDevelopmentDelegator } from "./src/development.ts";

export default function adaptiveDelivery(pi: ExtensionAPI): void {
	const entryPath = fileURLToPath(import.meta.url);
	// 子进程启动前确定角色；该内部标记只去除协调权限，不提供批准能力。
	const child = Boolean(process.env[CHILD_ENV]);
	const childDevelopment = process.env[CHILD_ENV] === "development" ? createChildDevelopment(pi) : undefined;
	let promptOptions: BuildSystemPromptOptions | undefined;
	const environment = (options: BuildSystemPromptOptions) => {
		const names = allowedReadTools(pi);
		return snapshotReadOnlyEnvironment(options, pi.getAllTools().filter((tool) => names.includes(tool.name)));
	};
	installPolicy(pi, child ? undefined : entryPath, childDevelopment ? entryPath : undefined);
	pi.on("session_start", () => { promptOptions = undefined; });
	pi.on("before_agent_start", (event) => {
		promptOptions = structuredClone(event.systemPromptOptions);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${CAPABILITY_NOTICE}\n不要把规划目标、旧记录或模型声明当成已实现功能或用户批准。`
				+ (childDevelopment ? "\n开发子会话只使用已交接的文件/容器工具，不修改父规划文档、不执行宿主 Shell、不批准或继续委派。"
					: child ? "\n子会话只能只读，不提供批准或文档编辑。" : "\n文档编辑先读取现场，只在明确授权路径内维护；每个回合只发起一次文档变更，等待原生终态后再继续。"),
		};
	});
	if (child) {
		pi.registerCommand(CHILD_STOP, { description: "内部子任务收尾，不授予任何权限", handler: async (_args, ctx) => ctx.shutdown() });
		pi.registerCommand(CHILD_READY, { description: "内部任务环境核对，不调用模型", handler: async (args, ctx) => {
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			pi.appendEntry(CHILD_READY, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				cwd: workspace.cwdPath, entryPath, environment: environment(ctx.getSystemPromptOptions()), projectTrusted: ctx.isProjectTrusted(),
				...(childDevelopment ? { owner: await childDevelopment.ready(args, ctx), developmentTools: pi.getAllTools().filter((tool) => ["write", "edit", "bash"].includes(tool.name)) } : {}) });
		} });
		if (childDevelopment) {
			pi.registerCommand(CHILD_ARM, { description: "内部 writer 交接，不生成批准", handler: async (args, ctx) => {
				await childDevelopment.arm(JSON.parse(args), ctx);
			} });
			pi.registerTool({ name: "edit", label: "开发文件编辑", description: "在已交接的子 writer 范围内精确编辑文件，禁止修改父规划文档。",
				parameters: createEditTool(".").parameters, execute: (id, input, signal) => childDevelopment.execute("edit", id, input, signal) });
			pi.registerTool({ name: "write", label: "开发文件写入", description: "在已交接的子 writer 范围内创建或完整重写文件，禁止修改父规划文档。",
				parameters: createWriteTool(".").parameters, execute: (id, input, signal) => childDevelopment.execute("write", id, input, signal) });
			pi.registerTool({ name: "bash", label: "容器命令", description: "仅在已批准的本地 Docker 镜像和明确挂载范围内执行 /bin/sh 命令。容器内 /workspace 对应 worktree，宿主路径和 Shell 配置不可用。不访问网络、凭据、规划文档或 Docker socket；未批准容器时拒绝，不回退宿主 Bash。timeout 最多 300 秒。",
				parameters: createBashTool(".").parameters, execute: (id, input, signal, update) => childDevelopment.execute("bash", id, input, signal, update) });
		}
		pi.on("session_shutdown", async (_event, ctx) => {
			pi.appendEntry(CHILD_EXIT, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				...(childDevelopment ? { development: await childDevelopment.finish(ctx) } : {}) });
		});
		return;
	}
	const approvals = installApprovals(pi);
	const writer = createParentDocumentWriter(pi, approvals);
	const developer = createDevelopmentDelegator(pi, approvals);
	pi.registerTool({ name: REVIEW_TOOL, label: "独立候选审查",
		description: "在本轮可信固定验收和当前候选一致时，沿只读子路径独立审查批准目标、当前代码、实际差异及原始验收记录。审查期间占用 writer lease，结束后核实候选与记录再交回。发现由父会话裁决，不自动等于审查通过；不恢复旧 Session 证据。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "本次审查重点和已知风险；工具自动附带原批准正文、代码路径、实际差异及验收记录，无须重述全部需求，不以实现者总结代替证据" }) }, { additionalProperties: false }),
		execute: async (id, input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未开始审查");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.review({ id, task: input.task, cwd: workspace.cwdPath, entryPath, parentSessionId: ctx.sessionManager.getSessionId(),
				model: ctx.model, thinking: pi.getThinkingLevel(), environment: environment(promptOptions), projectTrusted: ctx.isProjectTrusted() }, signal, ctx,
				(message) => update?.({ content: [{ type: "text", text: message }], details: {} }));
		},
	});
	pi.registerTool({ name: VALIDATION_TOOL, label: "固定候选验收",
		description: "用独立标准 Pi 子会话执行本轮已批准的固定容器验收命令，不能修改或替换命令。实际输入、源码、镜像与前后候选必须一致，全部真实命令通过才报告本次验收通过；不代替独立审查。缺少容器授权或命令时明确未运行。",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (id, _input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未开始验收");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.validate({ id, task: "执行本轮批准的固定候选验收，不编辑文件、不改变验收要求。", cwd: workspace.cwdPath, entryPath,
				parentSessionId: ctx.sessionManager.getSessionId(), model: ctx.model, thinking: pi.getThinkingLevel(), environment: environment(promptOptions),
				projectTrusted: ctx.isProjectTrusted() }, signal, ctx, (message) => update?.({ content: [{ type: "text", text: message }], details: {} }));
		},
	});
	pi.registerTool({ name: DEVELOPMENT_TOOL, label: "开发文件委派",
		description: "将一次开发任务交给独立标准 Pi。要求本轮父 TUI 的方案、实施及规划文档授权；支持受控原生 edit/write 与只读工具，命令须在实施确认中明确批准容器镜像/输入，不能用宿主 Bash 或未知工具覆盖替代。子任务不能修改父规划文档，不递归委派；原生终态落盘后才交回 writer，结果仍需核实。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "本节点的文件变更目标、现场事实和预期证据；工具自动附带已批准方案、实施正文、路径及命令，无须再次抄写或复制完整父历史" }) }, { additionalProperties: false }),
		execute: async (id, input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未委派");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.execute({ id, task: input.task, cwd: workspace.cwdPath, entryPath, parentSessionId: ctx.sessionManager.getSessionId(),
				model: ctx.model, thinking: pi.getThinkingLevel(), environment: environment(promptOptions), projectTrusted: ctx.isProjectTrusted() }, signal, ctx,
				(message) => update?.({ content: [{ type: "text", text: message }], details: {} }));
		},
	});
	pi.registerTool({
		name: DOCUMENT_EDIT_TOOL, label: "编辑规划文档",
		description: "在本轮父 TUI 的文档授权范围内精确编辑 Markdown，保留其他内容。每回合一次文档变更，原生结果落盘后才交回 writer；不编辑源码。",
		parameters: createEditTool(".").parameters,
		execute: (id, input, signal, _onUpdate, ctx) => writer.edit(id, input, signal, ctx),
	});
	pi.registerTool({
		name: DOCUMENT_WRITE_TOOL, label: "写入规划文档",
		description: "在本轮父 TUI 的文档授权范围内创建或完整重写 Markdown。已有文件先读取并保留用户内容，局部修改使用 delivery_document_edit。每回合一次文档变更；不编辑源码。",
		parameters: createWriteTool(".").parameters,
		execute: (id, input, signal, _onUpdate, ctx) => writer.write(id, input, signal, ctx),
	});
	const active = new Map<AbortController, Promise<unknown>>();
	pi.registerTool({
		name: DELEGATE_TOOL, label: "只读委派",
		description: "在独立标准 Pi 会话中执行一次只读分析。仅支持父会话已启用的原生 read/grep/find/ls；发送任务前核对工具定义、基础指令、规则和 Skills。需要其他能力或临时插件状态时不要用它冒充开发。结果最多 2000 行或 50KB，原始证据保留在子 Session。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "目标、必要背景、只读边界及预期证据；不要复制父完整历史" }) }),
		execute: async (id, params, signal, onUpdate, ctx) => {
			if (!ctx.model) throw new Error("当前模型未确定，未委派");
			if (!promptOptions) throw new Error("当前回合的基础环境未取得，未委派");
			const expectedEnvironment = environment(promptOptions);
			const controller = new AbortController();
			const operation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const run = (async () => {
				const workspace = await resolveWorkspaceIdentity(ctx.cwd);
				const result = await delegateReadOnly({ id, task: params.task, cwd: workspace.cwdPath, entryPath,
					parentSessionId: ctx.sessionManager.getSessionId(), model: ctx.model!, thinking: pi.getThinkingLevel(),
					environment: expectedEnvironment, projectTrusted: ctx.isProjectTrusted() }, operation,
					(data) => pi.appendEntry(DELEGATION_ENTRY, data),
					(message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }), ctx);
				return { content: [{ type: "text" as const, text: `子任务执行结束，结果仍需父会话核实：\n${result.text}\n子会话：${result.sessionFile}` }], details: result };
			})();
			active.set(controller, run);
			try { return await run; } finally { active.delete(controller); }
		},
	});
	pi.on("session_before_switch", () => active.size ? { cancel: true } : undefined);
	pi.on("session_before_fork", () => active.size ? { cancel: true } : undefined);
	pi.on("session_shutdown", async (_event, ctx) => {
		for (const controller of active.keys()) controller.abort(new Error("父会话正在关闭或重载"));
		const results = await Promise.allSettled(active.values());
		if (results.some((result) => result.status === "rejected")) ctx.ui.notify("委派已停止；存在取消或失败，请核对原生会话记录。", "warning");
	});
	pi.registerCommand("delivery-status", {
		description: "查看当前交付编排能力与工作区",
		handler: async (_args, ctx) => {
			try {
				const workspace = await resolveWorkspaceIdentity(ctx.cwd);
				const stateRoot = await getWriterStateRoot(workspace);
				const lease = await new WriterLeaseManager(stateRoot).read(workspace.key);
				ctx.ui.notify(`${CAPABILITY_NOTICE}\n工作区：${workspace.workspacePath}\n父文档 writer：${writer.pending ? "尚未完成终态交接，暂停新写入" : "本进程无当前文档执行"}\n开发/验收/审查：${developer.pending ? "尚未完成终态交接" : "本进程无当前执行"}`
					+ (lease ? `\n现场 lease：${lease.leaseId}\n记录 owner：${lease.owner.kind}，PID ${lease.owner.pid}，Session ${lease.owner.sessionId}，执行 ${lease.owner.runId ?? "未记录"}`
						+ `\n状态目录：${stateRoot}\n记录存在不等于进程仍在运行，也不证明已经停止；未核实原执行与工具终态前禁止替代写入，不自动解锁。`
						: "\n现场未发现 lease 记录；不等于已取得授权，操作时仍核实批准和 lease。"), "info");
			} catch (error) {
				ctx.ui.notify(`${CAPABILITY_NOTICE}\n工作区未核实：${String(error)}`, "error");
			}
		},
	});
}
