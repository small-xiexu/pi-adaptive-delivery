import { appendFileSync, promises as fs } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 仅隔离测试加载：在 CLI 中模拟父 TUI 上下文以注入 writer 故障，不加载正式入口或生成用户批准。
export default async function parentWriterFixture(pi: ExtensionAPI) {
	const scenario = process.env.ADAPTIVE_FIXTURE_SCENARIO!;
	const audit = (phase: string, details: Record<string, unknown>) => appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "fixture-events.jsonl"),
		JSON.stringify({ phase, scenario, pid: process.pid, ...details }) + "\n");
	const remove = fs.rm;
	let failCleanup = false;
	if (scenario === "writer-lock") {
		fs.rm = async (...args: Parameters<typeof remove>) => {
			if (failCleanup && String(args[0]).endsWith(".operation-lock")) { audit("writer-lock-cleanup-failed", {}); throw new Error("fixture lock cleanup failure"); }
			return remove(...args);
		};
		syncBuiltinESMExports();
	}
	const { createParentDocumentWriter, DOCUMENT_WRITE_TOOL } = await import(new URL("../product-package/extensions/delivery-gate/src/parent-writer.ts", import.meta.url).href) as typeof import("../../extensions/delivery-gate/src/parent-writer.ts");
	const { resolveWorkspaceIdentity, getWriterStateRoot, WriterLeaseManager } = await import(new URL("../product-package/extensions/delivery-gate/src/workspace.ts", import.meta.url).href) as typeof import("../../extensions/delivery-gate/src/workspace.ts");
	const grant = new AbortController();
	pi.on("session_shutdown", () => grant.abort());
	const state = async (cwd: string) => {
		const workspace = await resolveWorkspaceIdentity(cwd);
		const root = await getWriterStateRoot(workspace);
		return { workspace, leases: new WriterLeaseManager(root), file: path.join(root, "leases", `${workspace.key}.json`) };
	};
	pi.on("turn_end", async (event, ctx) => {
		if (scenario !== "writer-missing" || !event.toolResults.some((result) => result.toolName === DOCUMENT_WRITE_TOOL)) return;
		const file = ctx.sessionManager.getSessionFile()!;
		const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((row) => JSON.parse(row));
		await writeFile(file, rows.filter((row) => row.message?.role !== "toolResult" || row.message.toolName !== DOCUMENT_WRITE_TOOL).map((row) => JSON.stringify(row)).join("\n") + "\n");
	});
	const writer = createParentDocumentWriter(pi);
	let target: string | undefined;
	let operationSignal: AbortSignal | undefined;
	const open = fs.open;
	if (scenario === "writer-lock") pi.on("session_shutdown", () => { fs.rm = remove; syncBuiltinESMExports(); });
	if (scenario === "writer-wait" || scenario === "writer-close" || scenario === "writer-partial") {
		fs.open = async (...args: Parameters<typeof open>) => {
			const handle = await open(...args);
			if (args[0] === target) {
				const write = handle.writeFile.bind(handle);
				handle.writeFile = async (...content: Parameters<typeof write>) => {
					if (scenario === "writer-wait") {
						audit("writer-io-pending", {});
						const signal = AbortSignal.any([operationSignal!, grant.signal]);
						await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
						await setTimeout(20);
					}
					if (scenario === "writer-partial") { await write("部分内容", "utf8"); throw new Error("fixture partial I/O"); }
					await write(...content);
				};
				const close = handle.close.bind(handle);
				handle.close = async () => {
					await close(); audit("writer-handle-closed", {});
					if (scenario === "writer-close") throw new Error("fixture close failure");
				};
			}
			return handle;
		};
		syncBuiltinESMExports();
		pi.on("session_shutdown", () => { fs.open = open; syncBuiltinESMExports(); });
	}
	pi.registerTool({ name: DOCUMENT_WRITE_TOOL, label: "测试父文档 writer", description: "仅测试内部生命周期，不是真实批准入口",
		parameters: createWriteToolDefinition(process.cwd()).parameters,
		execute: (id, input, signal, _update, ctx) => { target = path.resolve(ctx.cwd, "plan.md"); operationSignal = signal; return writer.write(id, input, signal, { ...ctx, mode: "tui", hasUI: true }); } });
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== DOCUMENT_WRITE_TOOL) return;
		const { leases, workspace } = await state(ctx.cwd);
		const lease = await leases.read(workspace.key);
		audit("writer-tool-result", { toolCallId: event.toolCallId, isError: event.isError, lease, pending: writer.pending });
		if (scenario === "writer-persistence") await chmod(ctx.sessionManager.getSessionFile()!, 0o400);
		if (scenario === "writer-lock") failCleanup = true;
		if (scenario === "writer-tamper") return { content: [{ type: "text", text: "fixture replaced result" }] };
	});
	pi.on("turn_end", async (event, ctx) => {
		if (!event.toolResults.some((result) => result.toolName === DOCUMENT_WRITE_TOOL)) return;
		const { leases, workspace } = await state(ctx.cwd);
		audit("writer-turn-end", { pending: writer.pending, lease: await leases.read(workspace.key), sessionFile: ctx.sessionManager.getSessionFile() });
	});
	pi.on("agent_settled", async (_event, ctx) => {
		const { leases, workspace } = await state(ctx.cwd);
		audit("writer-settled", { pending: writer.pending, lease: await leases.read(workspace.key), sessionFile: ctx.sessionManager.getSessionFile() });
	});
	pi.registerCommand("fixture-writer-reload", { description: "隔离测试：真实资源 reload", handler: async (_args, ctx) => { await ctx.reload(); } });
}
