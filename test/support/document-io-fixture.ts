import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 隔离夹具直接调用未注册的内部底层；不创建批准记录，不模拟父 TUI，也不改变产品入口权限。
export default function documentIOFixture(pi: ExtensionAPI): void {
	pi.registerCommand("fixture-document-io", {
		description: "隔离测试：真实 Pi 内验证文档 I/O 和现有 lease，不提供批准入口",
		handler: async (scenario, ctx) => {
			const { createPlanningDocumentTools } = await import(new URL("../product-package/extensions/delivery-gate/src/planning-documents.ts", import.meta.url).href) as typeof import("../../extensions/delivery-gate/src/planning-documents.ts");
			const { resolveWorkspaceIdentity, WriterLeaseManager } = await import(new URL("../product-package/extensions/delivery-gate/src/workspace.ts", import.meta.url).href) as typeof import("../../extensions/delivery-gate/src/workspace.ts");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			const leases = new WriterLeaseManager(path.join(ctx.cwd, "fixture-state"));
			const acquired = await leases.acquire(workspace, { kind: "parent", sessionId: ctx.sessionManager.getSessionId(), pid: process.pid });
			assert.ok(acquired.ok);
			const controller = new AbortController();
			let valid = scenario !== "denied";
			const tools = createPlanningDocumentTools({ workspace, paths: ["docs/plan.md"], sessionId: ctx.sessionManager.getSessionId(),
				leases, lease: acquired.reference, signal: controller.signal,
				authorize: async () => { if (!valid) throw new Error("fixture approval denied"); } });
			const file = path.join(ctx.cwd, "docs/plan.md");
			if (scenario === "success") {
				await tools.write("create", { path: file, content: "原文\n用户内容\n" });
				await tools.edit("edit", { path: file, edits: [{ oldText: "原文", newText: "更新" }] });
				assert.equal(await readFile(file, "utf8"), "更新\n用户内容\n");
			} else if (scenario === "denied" || scenario === "source") {
				await assert.rejects(tools.write("denied", { path: scenario === "source" ? "src.ts" : file, content: "不应写入" }), /denied|Markdown/);
				await assert.rejects(access(path.dirname(file)), { code: "ENOENT" });
				await assert.rejects(access(path.join(ctx.cwd, "src.ts")), { code: "ENOENT" });
			} else if (["inflight-cancel", "partial", "close-failure"].includes(scenario)) {
				const open = fs.open;
				let enter!: () => void;
				let unblock!: () => void;
				const entered = new Promise<void>((resolve) => { enter = resolve; });
				const blocked = new Promise<void>((resolve) => { unblock = resolve; });
				let closed = false;
				fs.open = async (...args: Parameters<typeof open>) => {
					const handle = await open(...args);
					if (args[0] === file) {
						const write = handle.writeFile.bind(handle);
						handle.writeFile = async (...input: Parameters<typeof write>) => {
							if (scenario === "inflight-cancel") { enter(); await blocked; }
							if (scenario === "partial") { await write("部分内容", "utf8"); throw new Error("fixture partial I/O"); }
							return write(...input);
						};
						const close = handle.close.bind(handle);
						handle.close = async () => {
							await close(); closed = true;
							if (scenario === "close-failure") throw new Error("fixture close failure");
						};
					}
					return handle;
				};
				syncBuiltinESMExports();
				try {
					const run = tools.write("fault", { path: file, content: "完整内容" });
					const failed = assert.rejects(run, /aborted|partial I\/O|close failure/);
					if (scenario === "inflight-cancel") {
						await entered;
						let settled = false;
						void run.then(() => { settled = true; }, () => { settled = true; });
						let nextStarted = false;
						const next = withFileMutationQueue(file, async () => { nextStarted = true; assert.equal(closed, true); });
						try {
							controller.abort();
							await new Promise<void>((resolve) => setImmediate(resolve));
							assert.equal(settled, false);
							assert.equal(nextStarted, false);
							assert.ok(await leases.read(workspace.key));
						} finally { unblock(); await failed; await next; }
					} else await failed;
					assert.equal(closed, true);
					assert.equal(await readFile(file, "utf8"), scenario === "partial" ? "部分内容" : "完整内容");
					if (scenario === "close-failure") await assert.rejects(tools.write("next", { path: file, content: "不应再写入" }), /清理失败/);
				} finally { unblock(); fs.open = open; syncBuiltinESMExports(); }
			} else {
				assert.ok(["queued-revoke", "queued-cancel", "queued-lease"].includes(scenario));
				await mkdir(path.dirname(file));
				await writeFile(file, "原文");
				let unblock!: () => void;
				let checked!: () => void;
				const blocked = new Promise<void>((resolve) => { unblock = resolve; });
				const initialCheck = new Promise<void>((resolve) => { checked = resolve; });
				const blocker = withFileMutationQueue(file, () => blocked);
				const read = leases.read.bind(leases);
				leases.read = async (key) => { const result = await read(key); checked(); return result; };
				const failed = assert.rejects(tools.edit("queued", { path: file, edits: [{ oldText: "原文", newText: "不应写入" }] }));
				try {
					await initialCheck;
					if (scenario === "queued-revoke") valid = false;
					if (scenario === "queued-cancel") controller.abort();
					if (scenario === "queued-lease") await leases.release(acquired.reference, { kind: "parent-owner", processToken: leases.processToken });
				} finally { unblock(); await blocker; }
				await failed;
				assert.equal(await readFile(file, "utf8"), "原文");
			}
			assert.equal(tools.cleanupFailed, scenario === "close-failure");
			const retained = await leases.read(workspace.key);
			assert.equal(Boolean(retained), scenario !== "queued-lease");
			pi.appendEntry("fixture-document-io", { scenario, pid: process.pid, workspaceKey: workspace.key,
				leaseRetained: Boolean(retained), cleanupFailed: tools.cleanupFailed });
		},
	});
}
