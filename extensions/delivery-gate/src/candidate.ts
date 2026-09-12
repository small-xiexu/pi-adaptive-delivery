import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WorkspaceIdentity } from "./workspace.ts";

export interface CandidateScope {
	workspace: WorkspaceIdentity;
	readPaths: readonly string[];
	writePaths: readonly string[];
	protectedPaths: readonly string[];
}

const within = (root: string, file: string) => {
	const relative = path.relative(root, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// 只枚举明确的源码及输入范围；本机工具链、环境变量和范围外的依赖不属于文件快照。
export async function candidatePaths(scope: CandidateScope, signal?: AbortSignal, onEntry?: (file: string, info: Stats) => Promise<void>) {
	const { workspacePath: root, cwdPath: cwd } = scope.workspace;
	if (await realpath(root) !== root || !within(root, cwd)) throw new Error("候选工作区路径已变化");
	const protectedPaths = [path.join(root, ".git"), ...scope.protectedPaths];
	const paths = [...new Set([...scope.readPaths, ...scope.writePaths].map((file) => path.resolve(cwd, file)))].sort();
	async function inspect(file: string): Promise<void> {
		signal?.throwIfAborted();
		let info: Stats;
		try { info = await lstat(file); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("候选路径含链接或非独立普通文件");
		await onEntry?.(file, info);
		if (info.isDirectory()) for (const name of await readdir(file)) await inspect(path.join(file, name));
	}
	for (const file of paths) {
		if (file === root || !within(root, file)) throw new Error("候选仅接受明确的 worktree 内路径，不包含整个工作区");
		if (protectedPaths.some((target) => within(target, file) || within(file, target))) throw new Error("候选范围涉及规划文档、执行记录或 Git 等受保护路径");
		for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) {
			try { if (!(await lstat(parent)).isDirectory()) throw new Error("候选祖先不是普通目录"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
	for (const file of paths) if (!paths.some((other) => other !== file && within(other, file))) await inspect(file);
	return paths;
}

export interface CandidateSnapshot {
	digest: string;
	files: string[];
}

const identity = (info: Stats) => ({ dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, gid: info.gid,
	size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });

// 调用方持有 writer；此指纹不授予权限，也不提供对其他宿主进程的原子文件系统快照。
export async function captureCandidate(scope: CandidateScope, signal?: AbortSignal): Promise<CandidateSnapshot> {
	const entries: { path: string; identity: ReturnType<typeof identity>; content?: string }[] = [];
	const paths = await candidatePaths(scope, signal, async (file, info) => {
		const entry = { path: path.relative(scope.workspace.workspacePath, file), identity: identity(info) } as typeof entries[number];
		if (info.isFile()) {
			const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				if (!isDeepStrictEqual(identity(await handle.stat()), entry.identity)) throw new Error("候选文件在打开期间变化");
				const hash = createHash("sha256");
				for await (const chunk of handle.createReadStream({ autoClose: false })) {
					signal?.throwIfAborted();
					hash.update(chunk);
				}
				if (!isDeepStrictEqual(identity(await handle.stat()), entry.identity)) throw new Error("候选文件在读取期间变化");
				entry.content = hash.digest("hex");
			} finally { await handle.close(); }
		}
		entries.push(entry);
	});
	signal?.throwIfAborted();
	entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const digest = createHash("sha256").update(JSON.stringify({ workspace: scope.workspace,
		environment: { platform: process.platform, arch: process.arch, node: process.version }, paths, entries })).digest("hex");
	return { digest, files: entries.filter((entry) => entry.content !== undefined).map((entry) => entry.path) };
}
