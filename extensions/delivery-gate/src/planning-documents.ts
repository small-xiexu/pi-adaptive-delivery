import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createEditTool, createWriteTool, type EditToolInput, type WriteToolInput } from "@earendil-works/pi-coding-agent";
import { type WorkspaceIdentity, type WriterLeaseOwner, type WriterLeaseReference, WriterLeaseManager } from "./workspace.ts";

interface DocumentScope {
	workspace: WorkspaceIdentity;
	paths: readonly string[];
	owner: WriterLeaseOwner;
	lease: WriterLeaseReference;
	leases: WriterLeaseManager;
	authorize: () => Promise<void>;
	signal: AbortSignal;
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// 内部执行底层。父 Markdown 默认可编辑；调用方绑定本次目标路径并负责 lease 的完整生命周期。
export function createPlanningDocumentTools(scope: DocumentScope, protectedPaths: readonly string[] = []) {
	const { workspacePath: root, cwdPath: cwd, key } = scope.workspace;
	const { leases, authorize, signal: approvalSignal } = scope;
	const owner = structuredClone(scope.owner);
	const lease = { ...scope.lease };
	const allowed = scope.paths.map((value) => path.resolve(cwd, value));
	const protectedTargets = [path.join(root, ".git"), ...protectedPaths.map((value) => path.resolve(cwd, value))];
	let cleanupFailed = false;

	async function close(handle: FileHandle): Promise<void> {
		try { await handle.close(); } catch (error) { cleanupFailed = true; throw error; }
	}

	async function requireWriter(): Promise<void> {
		const current = await leases.read(key);
		if (cleanupFailed) throw new Error("文档句柄清理失败，停止后续变更并保留 writer");
		if (!current || lease.workspaceKey !== key || current.leaseId !== lease.leaseId
			|| current.workspace.workspacePath !== root || owner.kind !== "parent" || !isDeepStrictEqual(current.owner, owner)
			|| owner.pid !== process.pid || owner.processToken !== leases.processToken) {
			throw new Error("当前会话未持有该 worktree 的父 writer，文件操作未获准");
		}
	}

	async function checkPath(target: string): Promise<void> {
		if (!within(root, cwd) || !within(root, target)
			|| !allowed.includes(target) || path.extname(target).toLowerCase() !== ".md") {
			throw new Error("目标不在明确的 Markdown 文档范围内");
		}
		if (protectedTargets.some((entry) => within(entry, target) || within(target, entry))) throw new Error("不能修改规划文档、执行记录或 Git 元数据等受保护路径");
		if (await realpath(root) !== root) throw new Error("worktree 根目录已发生路径替换");
		const parts = path.relative(root, target).split(path.sep);
		let cursor = root;
		for (let i = 0; i < parts.length; i++) {
			cursor = path.join(cursor, parts[i]!);
			try {
				const info = await lstat(cursor);
				if (info.isSymbolicLink()) throw new Error("文档路径包含符号链接，未执行变更");
				if (i === parts.length - 1 ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) {
					throw new Error("文档路径不是独立普通文件及目录");
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
				throw error;
			}
		}
	}

	async function execute(operation: "edit" | "write", id: string, input: EditToolInput | WriteToolInput, callerSignal?: AbortSignal) {
		const signal = callerSignal ? AbortSignal.any([callerSignal, approvalSignal]) : approvalSignal;
		signal.throwIfAborted();
		// 与 Pi 的 @file 输入习惯一致；向原生工具传固定绝对路径，避免二次解析改变目标。
		const target = path.resolve(cwd, input.path.startsWith("@") ? input.path.slice(1) : input.path);
		await checkPath(target);
		await authorize();
		await requireWriter();
		signal.throwIfAborted();

		const writeFile = async (_file: string, content: string) => {
			await checkPath(target);
			await authorize();
			await requireWriter();
			signal.throwIfAborted();
			const handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW | (operation === "write" ? constants.O_CREAT : 0), 0o666);
			try {
				const info = await handle.stat();
				if (!info.isFile() || info.nlink !== 1) throw new Error("文档写入目标不是独立普通文件");
				await authorize();
				await requireWriter();
				signal.throwIfAborted();
				await handle.truncate(0);
				signal.throwIfAborted();
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await close(handle);
			}
		};
		if (operation === "edit") {
			const native = createEditTool(cwd, { operations: {
				access: () => access(target, constants.R_OK | constants.W_OK),
				readFile: async () => {
					const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
					try { return await handle.readFile(); } finally { await close(handle); }
				},
				writeFile,
			} });
			return native.execute(id, { ...(input as EditToolInput), path: target }, signal);
		}
		const native = createWriteTool(cwd, { operations: {
			mkdir: async (directory) => {
				await checkPath(target);
				await authorize();
				await requireWriter();
				signal.throwIfAborted();
				await mkdir(directory, { recursive: true });
			},
			writeFile,
		} });
		return native.execute(id, { ...(input as WriteToolInput), path: target }, signal);
	}

	return {
		get cleanupFailed() { return cleanupFailed; },
		edit: (id: string, input: EditToolInput, signal?: AbortSignal) => execute("edit", id, input, signal),
		write: (id: string, input: WriteToolInput, signal?: AbortSignal) => execute("write", id, input, signal),
	};
}
