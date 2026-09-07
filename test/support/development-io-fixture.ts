import { appendFileSync, promises as fs } from "node:fs";
import { access, chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 只加载于隔离夹具；不改变产品入口、批准来源或 Pi 实现。
export default async function developmentIoFixture(pi: ExtensionAPI) {
	if (process.env.PI_ADAPTIVE_DELIVERY_CHILD !== "development") return;
	const scenario = process.env.ADAPTIVE_FIXTURE_SCENARIO;
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const audit = (phase: string, data: Record<string, unknown> = {}) => appendFileSync(path.join(agentDir, "fixture-events.jsonl"),
		JSON.stringify({ phase, ...data, pid: process.pid, child: true, scenario }) + "\n");
	pi.on("tool_call", async (_event, ctx) => {
		const root = path.join(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ctx.cwd, encoding: "utf8" }).trim(), "pi-adaptive-delivery", "leases");
		const files = await readdir(root).catch((error) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const file = files.find((entry) => entry.endsWith(".json"));
		audit("development-lease", { lease: file ? JSON.parse(await readFile(path.join(root, file), "utf8")) : null });
	});
	pi.on("tool_result", async (event, ctx) => {
		if (scenario === "development-child-persistence") await chmod(ctx.sessionManager.getSessionFile()!, 0o400);
		if (scenario === "development-crash" && event.toolName === "write") process.kill(process.pid, "SIGKILL");
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (scenario !== "development-child-tamper") return;
		const file = ctx.sessionManager.getSessionFile()!;
		const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		rows.find((row) => row.message?.role === "toolResult").message.content = [{ type: "text", text: "篡改已落盘结果" }];
		await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	});
	if (!["development-wait", "development-partial", "development-close"].includes(scenario ?? "")) return;
	if (await access(path.join(agentDir, "development-fault-used")).then(() => true, () => false)) return;
	const open = fs.open;
	fs.open = async (...args: Parameters<typeof open>) => {
		const handle = await open(...args);
		if (String(args[0]) !== path.join(process.cwd(), "src/value.js")) return handle;
		const write = handle.writeFile.bind(handle);
		handle.writeFile = async (...content: Parameters<typeof write>) => {
			if (scenario === "development-wait") {
				audit("development-io-pending");
				const deadline = Date.now() + 15_000;
				while (!await access(path.join(agentDir, "development-unblock")).then(() => true, () => false)) {
					if (Date.now() >= deadline) throw new Error("fixture I/O unblock timeout");
					await setTimeout(20);
				}
			}
			if (scenario === "development-partial") { await write("部分写入"); throw new Error("fixture partial write"); }
			await write(...content);
		};
		const close = handle.close.bind(handle);
		handle.close = async () => {
			await close();
			audit("development-handle-closed");
			if (scenario === "development-close") throw new Error("fixture handle close failure");
		};
		return handle;
	};
	syncBuiltinESMExports();
	pi.on("session_shutdown", () => { fs.open = open; syncBuiltinESMExports(); });
}
