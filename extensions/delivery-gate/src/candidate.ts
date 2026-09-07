import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { containerMounts, type ContainerScope } from "./container.ts";

export interface CandidateSnapshot {
	digest: string;
	files: string[];
}

const identity = (info: Stats) => ({ dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, gid: info.gid,
	size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });

// 调用方持有 writer；此指纹不授予权限，也不提供对其他宿主进程的原子文件系统快照。
export async function captureCandidate(scope: Omit<ContainerScope, "beforeCreate">, commands: readonly string[], signal?: AbortSignal): Promise<CandidateSnapshot> {
	const entries: { path: string; identity: ReturnType<typeof identity>; content?: string }[] = [];
	const mounts = await containerMounts(scope, signal, async (file, info) => {
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
	const digest = createHash("sha256").update(JSON.stringify({ workspace: scope.workspace, image: scope.image, interpreter: "/bin/sh", commands,
		mounts: mounts.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0), entries })).digest("hex");
	return { digest, files: entries.filter((entry) => entry.content !== undefined).map((entry) => entry.path) };
}
