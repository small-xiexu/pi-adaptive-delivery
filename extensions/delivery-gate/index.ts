import { createEditTool, createWriteTool, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { inheritedTools, installPolicy, CAPABILITY_NOTICE } from "./src/policy.ts";
import { GIT_STATUS_TOOL, readGitStatus, getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "./src/workspace.ts";
import { CHILD_ENV, CHILD_READY, CHILD_EXIT, CHILD_STOP, DELEGATE_TOOL, DELEGATION_ENTRY, delegateReadOnly, snapshotReadOnlyEnvironment } from "./src/subagents.ts";
import { installApprovals } from "./src/approvals.ts";
import { DeliveryPanel } from "./src/ui.ts";
import { createParentDocumentWriter, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL, documentRenderers } from "./src/parent-writer.ts";
import { CHILD_ARM, DEVELOPMENT_ENTRY, DEVELOPMENT_TOOL, REVIEW_TOOL, createChildDevelopment, createDevelopmentDelegator } from "./src/development.ts";
import { cleanupReviewArtifacts } from "./src/review.ts";
import { createTaskProgress, taskRenderers } from "./src/progress.ts";
import { installTaskDetails } from "./src/task-details.ts";
import { installStreamRetry } from "./src/stream-retry.ts";
import { agentSelection, selectChildAgent } from "./src/agent-selection.ts";
import { installActivation } from "./src/activation.ts";
import { installStallWatch } from "./src/stall-watch.ts";
import { deliveryStage, formatExecutionPaths, installExecutionPath } from "./src/execution-path.ts";

export default function adaptiveDelivery(pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV]) { installDelivery(pi); return; }
	installActivation(pi, (ctx) => installDelivery(pi, ctx)!);
}

function installDelivery(pi: ExtensionAPI, initialContext?: ExtensionContext) {
	const entryPath = fileURLToPath(import.meta.url);
	installStreamRetry(pi);
	// 内容级停顿看门狗：Pi 的字节级 idle 超时对 openai SDK 与插件自带的传输都不可靠。
	installStallWatch(pi);
	// 子进程启动前确定角色；该内部标记只去除协调权限，不提供批准能力。
	const child = Boolean(process.env[CHILD_ENV]);
	const childDevelopment = process.env[CHILD_ENV] === "development" ? createChildDevelopment() : undefined;
	let promptOptions: BuildSystemPromptOptions | undefined;
	const readPaths = (ctx: ExtensionContext) => {
		if (!promptOptions) throw new Error("本回合资源环境尚未核实");
		const options = promptOptions;
		// 子只接收本回合基础规则、Skills 和调用方明确加入的当前证据；不默认暴露父 Session 或历史委派记录。
		const resources = [...(options.contextFiles ?? []).map((file) => file.path), ...(options.skills ?? []).map((skill) => skill.baseDir)];
		if (child) resources.push(...JSON.parse(process.env.PI_ADAPTIVE_DELIVERY_READ_PATHS ?? "[]"));
		return [...new Set(resources)];
	};
	const environment = (options: BuildSystemPromptOptions) => snapshotReadOnlyEnvironment(options, inheritedTools(pi, entryPath));
	installPolicy(pi, entryPath);
	pi.on("session_start", () => { promptOptions = undefined; });
	pi.on("before_agent_start", (event, ctx) => {
		promptOptions = structuredClone(event.systemPromptOptions);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${CAPABILITY_NOTICE}\n只有用户执行 /delivery-shape 才启用交付；模型回复、普通对话和旧记录不改变交付状态。/delivery-status 用于查看简要进度和详情；结束交付需要用户明确选择。恢复优先由用户说“继续”触发，插件会自动核对已结束的残留占用。`
				+ (child ? "" : `\n受控交付已启用。先读取并遵循 ${fileURLToPath(new URL("../../skills/adaptive-delivery/SKILL.md", import.meta.url))}；没有变化时不重复全文读取。`)
				+ (childDevelopment ? "\n开发子会话沿用父 Pi 原有工具，遵守本次节点范围，不修改父规划文档、不批准或继续委派。"
					: child ? "\n本次子任务沿用父 Pi 的全部普通工具和权限；具体职责由委派任务说明。不批准、不继续委派，外部操作仍须遵守本轮授权。" : "\n方案确认后由 AI 内部维护实施计划：简单任务由父 Pi 直接修改并检查，复杂任务按需委派。每次委派明确提供当前 paths 和 inputs；范围内调整不重复请求确认。需要持续维护时沿用已有方案/台账；Markdown 编辑使用父文档工具并保留用户内容，每回合一次变更。委派时按工作场景、复杂度和风险选择推理级别，不另选模型。")
				+ (!child ? `\n本轮方案确认：${approvals.confirmedStage === "design" ? "已取得；核对剩余工作后可在原范围继续。" : "未取得；用户说继续时，先核对本会话已有方案、意见、进度和现场，再提交必要的方案确认，不重复需求访谈、不把历史确认当作本轮权限。"}` : "")
				+ (!child && ctx.model ? `\n子任务固定继承父 Pi 当前模型 ${ctx.model.provider}/${ctx.model.id}；可选推理级别：${getSupportedThinkingLevels(ctx.model).join("、")}。省略 thinking 继承父当前级别；父切换模型后，新任务跟随，已启动的任务保持原模型。` : ""),
		};
	});
	if (child) {
		pi.registerCommand(CHILD_STOP, { description: "内部子任务收尾，不授予任何权限", handler: async (_args, ctx) => ctx.shutdown() });
		pi.registerCommand(CHILD_READY, { description: "内部任务环境核对，不调用模型", handler: async (args, ctx) => {
			const request = JSON.parse(args) as { id: string; tools: string[] };
			// 插件启动钩子可能覆盖 CLI 的 --tools；在握手前承接父本轮明确选择，随后仍完整核验定义与来源。
			pi.setActiveTools(request.tools);
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			pi.appendEntry(CHILD_READY, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				cwd: workspace.cwdPath, entryPath, environment: environment(ctx.getSystemPromptOptions()), projectTrusted: ctx.isProjectTrusted(),
				...(childDevelopment ? { owner: await childDevelopment.ready(request.id, ctx) } : {}) });
		} });
		if (childDevelopment) {
			pi.registerCommand(CHILD_ARM, { description: "内部 writer 交接，不生成批准", handler: async (args, ctx) => {
				const grant = JSON.parse(args);
				await childDevelopment.arm(grant, ctx);
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
	let recoverResidual!: (ctx: ExtensionContext) => Promise<"none" | "recovered">;
	const developer = createDevelopmentDelegator(pi, approvals, async (ctx) => { await recoverResidual(ctx); });
	const active = new Map<AbortController, { run: Promise<unknown>; progress: ReturnType<typeof createTaskProgress> }>();
	const tasks = () => [...active.values()].map((item) => item.progress.snapshot()).concat(developer.progress ? [developer.progress] : []);
	const openTask = installTaskDetails(pi, tasks, initialContext);
	installExecutionPath(pi, approvals);
	recoverResidual = async (ctx: ExtensionContext): Promise<"none" | "recovered"> => {
		if (approvals.pending || active.size || (writer.pending && !writer.fault) || ctx.hasPendingMessages()) {
			throw new Error("当前仍有交互或任务在进行，等待本轮收尾后再继续。");
		}
		const workspace = await resolveWorkspaceIdentity(ctx.cwd);
		const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
		const blockage = await leases.inspectBlockage(workspace.key);
		if (!blockage.lease && !blockage.operationLock) return "none";
		const leaseId = blockage.lease?.leaseId;
		const target = leaseId
			? developer.canReconcileAfterUnlock(workspace.key, leaseId) ? "development"
				: writer.canReconcileAfterUnlock(workspace.key, leaseId) ? "document" : undefined
			: undefined;
		if (developer.fault || writer.fault) {
			if (!target) throw new Error("上次交付的结束状态与当前占用记录不一致，暂未清理；请查看详情后再继续。");
		}
		if (!target && (ctx.mode !== "tui" || !ctx.hasUI)) throw new Error("上次交付留下了无法自动核实的占用，当前模式不能确认清理。");
		if (!target) {
			const owner = blockage.lease?.record?.owner;
			const body = [
				"上次交付留下了占用记录，但原执行无法完整核实。",
				"当前会话没有在途交付任务；清理后保留已有改动，继续当前方案。",
				"清理不会恢复旧批准，也不代表检查或审查通过。",
			].join("\n");
			const detail = [body, "", `占用记录：${leaseId ?? "无法解析"}`,
				...(owner ? [`归属：${owner.kind}，PID ${owner.pid}，Session ${owner.sessionId}，执行 ${owner.runId ?? "未记录"}`] : []),
				`残留操作锁：${blockage.operationLock ? "存在" : "无"}`].join("\n");
			const choice = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) =>
				new DeliveryPanel("恢复交付", body, detail, ["清理残留并继续", "暂不处理"], tui, theme, done, 1));
			if (choice !== "清理残留并继续") throw new Error("已保留上次交付现场，未开始新的任务。");
		}
		const removed = await leases.discard(workspace.key, blockage);
		const reconciled = target === "development" && leaseId ? developer.reconcileAfterUnlock(workspace.key, leaseId)
			: target === "document" && leaseId ? writer.reconcileAfterUnlock(workspace.key, leaseId) : undefined;
		pi.appendEntry("delivery-unlock", { workspaceKey: workspace.key, leaseId, owner: blockage.lease?.record?.owner,
			operationLock: removed.operationLock, at: new Date().toISOString(),
			...(reconciled ? { reconciledRunId: reconciled.runId, inMemoryState: "cleared", recovery: "automatic" } : { inMemoryState: "none", recovery: "confirmed" }) });
		ctx.ui.notify(reconciled ? "已自动恢复上次交付，继续当前方案。" : "已清理上次交付的残留占用，继续当前方案。", "info");
		return "recovered";
	};
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
		description: "沿独立子路径检查和审查批准目标、当前代码、实际差异，并主动运行项目测试、编译或 lint。审查期间占用 writer lease，结束后核实候选与记录再交回。paths 只填写源码、测试或配置，inputs 只填写额外只读证据；父维护规划文档与范围重叠时在子 Session 启动前拒绝调用。发现由父会话裁决，不自动等于审查通过；不恢复旧 Session 证据。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "本次审查重点和已知风险" }), paths: Type.Array(Type.String({ minLength: 1 }), { description: "本次审查涉及的源码、配置或测试路径；必须位于当前 worktree 内；至少提供一个路径" }), inputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "纳入候选核对的只读输入路径" })), agent: Type.Optional(agentSelection) }, { additionalProperties: false }),
		execute: async (id, input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未开始审查");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.review({ id, task: input.task, cwd: workspace.cwdPath, entryPath, readPaths: readPaths(ctx), paths: input.paths, inputs: input.inputs, parentSessionId: ctx.sessionManager.getSessionId(),
				...selectChildAgent(pi, ctx, input.agent), toolInput: input, environment: environment(promptOptions), projectTrusted: ctx.isProjectTrusted() }, signal, ctx,
				(message, progress) => update?.({ content: [{ type: "text", text: message }], details: { progress } }));
		},
	});
	pi.registerTool({ name: DEVELOPMENT_TOOL, label: "开发文件委派",
		...taskRenderers("开发", openTask),
		description: "将一次本机开发任务交给独立标准 Pi。要求本轮父 TUI 的方案确认，并在 paths 中提供本节点范围；paths 只填写允许修改的源码、配置或测试，inputs 只填写额外只读证据，父维护规划文档重叠时在子 Session 启动前拒绝调用。继承父已启用的文件、Shell、联网及插件工具。子任务须遵守范围、不修改父规划文档、不递归委派；普通工具不受本 Package 路径拦截。Pi 进程与原生工具终态落盘后交回交付 writer，结果仍需核实。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "本节点的文件变更目标、现场事实和预期证据" }), paths: Type.Array(Type.String({ minLength: 1 }), { description: "本次开发允许修改的源码、配置或测试路径；必须位于当前 worktree 内；至少提供一个路径" }), inputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "纳入候选核对的只读输入路径" })), agent: Type.Optional(agentSelection) }, { additionalProperties: false }),
		execute: async (id, input, signal, update, ctx) => {
			if (!ctx.model || !promptOptions) throw new Error("当前模型或本回合基础环境未核实，未委派");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			return developer.execute({ id, task: input.task, cwd: workspace.cwdPath, entryPath, readPaths: readPaths(ctx), paths: input.paths, inputs: input.inputs, parentSessionId: ctx.sessionManager.getSessionId(),
				...selectChildAgent(pi, ctx, input.agent), toolInput: input, environment: environment(promptOptions), projectTrusted: ctx.isProjectTrusted() }, signal, ctx,
				(message, progress) => update?.({ content: [{ type: "text", text: message }], details: { progress } }));
		},
	});
	pi.registerTool({
		name: DOCUMENT_EDIT_TOOL, label: "编辑规划文档",
		...documentRenderers,
		description: "默认允许父 TUI 精确编辑任务所需的 worktree 内 Markdown，无须文档授权。先读取现场并保留其他内容，每回合一次变更，原生结果落盘后才交回 writer；不编辑源码。",
		parameters: createEditTool(".").parameters,
		execute: (id, input, signal, _onUpdate, ctx) => writer.edit(id, input, signal, ctx),
	});
	pi.registerTool({
		name: DOCUMENT_WRITE_TOOL, label: "写入规划文档",
		...documentRenderers,
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
	const showStatus = async (ctx: ExtensionContext) => {
		try {
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			const stateRoot = await getWriterStateRoot(workspace);
			const blockage = await new WriterLeaseManager(stateRoot).inspectBlockage(workspace.key);
			const lease = blockage.lease?.record;
			const running = tasks();
			const executing = running.filter((task) => !task.endedAt);
			const taskLabel = (task: ReturnType<typeof tasks>[number]) => task.name.split(" · ", 1)[0] || task.name;
			let stage = approvals.confirmedStage === "design" ? "等待下一步" : "等待方案确认";
			let next = approvals.confirmedStage === "design" ? "说“继续”推进剩余工作。" : "整理方案并提交确认。";
			if (approvals.pending) next = "在方案面板选择确认、提出意见或暂停。";
			else if (executing.length) { stage = "实施进行中"; next = "等待当前任务完成。"; }
			else if (!ctx.isIdle() || ctx.hasPendingMessages()) { stage = "当前回合未结束"; next = "等待本轮回合和排队消息完成。"; }
			else if (writer.pending || developer.pending || blockage.lease || blockage.operationLock) {
				stage = "等待恢复";
				next = "说“继续”，插件会自动核对并在安全时恢复。";
			} else if (approvals.confirmedStage === "design") {
				stage = "可以结束交付";
				next = "确认改动和结果后，可选择结束交付。";
			}
			const body = [`阶段：${stage}`, `下一步：${next}`, `运行中：${executing.length ? executing.map(taskLabel).join("；") : "无"}`].join("\n");
			const detail = `${body}\n\n工作区：${workspace.workspacePath}\n运行模式：Pi 原生\n沿用 Pi 的工具：${inheritedTools(pi, entryPath).map((tool) => tool.name).join(", ") || "无"}\n执行路径：\n${formatExecutionPaths(ctx.sessionManager.getBranch(), running)}\n`
				+ (lease ? `现场 lease：${lease.leaseId}\nowner：${lease.owner.kind}，PID ${lease.owner.pid}，Session ${lease.owner.sessionId}，执行 ${lease.owner.runId ?? "未记录"}\n记录不证明执行已停止。` : blockage.lease ? "占用记录无法解析，执行归属未知。" : "未发现 lease。")
				+ `\n残留操作锁：${blockage.operationLock ? "存在" : "无"}\n状态目录：${stateRoot}`
				+ running.map((task) => `\n任务 ${task.id}\n原始子 Session：${task.sessionFile ?? "尚未取得"}`).join("");
			if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify(`交付状态\n${body}\n\n使用 /delivery-status 查看详情。`, "info"); return false; }
			const canEnd = approvals.confirmedStage === "design" && !approvals.pending && !active.size && !ctx.hasPendingMessages()
				&& ctx.isIdle() && !writer.pending && !developer.pending && !blockage.lease && !blockage.operationLock;
			const choices = canEnd ? ["结束交付"] : [];
			const choice = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) =>
				new DeliveryPanel("交付状态", body, detail, choices, tui, theme, done, 0));
			return choice === "结束交付";
		} catch (error) {
			ctx.ui.notify(`交付状态读取失败：${String(error)}`, "error");
			return false;
		}
	};
	return {
		showStatus,
		initialize: async () => {},
		assertCanExit: async (ctx: ExtensionContext) => {
			if (approvals.pending || active.size || (writer.pending && !writer.fault) || (developer.pending && !developer.fault)) {
				throw new Error("交互或执行尚未收尾；先等待当前任务结束或说“继续”完成恢复。");
			}
			// 已结束且未自动收尾的失败是终态记录；退出时说明，不再永久阻塞。
			const stalled = [...(writer.pending && writer.fault ? [`父文档写入未收尾：${writer.fault}`] : []),
				...(developer.pending && developer.fault ? [`交付委派未收尾：${developer.fault}`] : [])];
			if (stalled.length) ctx.ui.notify("上次交付有未自动收尾的记录；说“继续”后会先核对，再决定是否恢复。", "warning");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
			try { await leases.assertIdle(workspace.key); }
			catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)} 先说“继续”完成恢复，再结束交付。`); }
		},
		cleanup: async (ctx: ExtensionContext) => {
			const directories = ctx.sessionManager.getEntries().flatMap((entry) => {
				if (entry.type !== "custom" || ![DELEGATION_ENTRY, DEVELOPMENT_ENTRY].includes(entry.customType)) return [];
				const directory = (entry.data as { reviewDirectory?: unknown }).reviewDirectory;
				return typeof directory === "string" ? [directory] : [];
			});
			const result = await cleanupReviewArtifacts(directories);
			if (result.failed.length) throw new Error(`审查制品清理失败：${result.failed.join("；")}`);
		},
	};
}
