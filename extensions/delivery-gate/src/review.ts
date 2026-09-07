import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CandidateSnapshot } from "./candidate.ts";
import type { ContainerScope } from "./container.ts";

const execFileAsync = promisify(execFile);
const LIMIT = 16 * 1024 * 1024;
const within = (root: string, file: string) => {
	const relative = path.relative(root, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function prepareReview(scope: Omit<ContainerScope, "beforeCreate">, candidate: CandidateSnapshot) {
	const root = scope.workspace.workspacePath;
	const temporary = await realpath(os.tmpdir());
	if (within(root, temporary)) throw new Error("审查制品临时目录必须在被审查 worktree 之外");
	const directory = await mkdtemp(path.join(temporary, "adaptive-review-"));
	const env = { PATH: "/usr/bin:/bin", HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
	const git = async (args: string[], cwd: string, allowOne = false) => {
		try {
			return { code: 0, ...(await execFileAsync("/usr/bin/git", ["--no-replace-objects", "--literal-pathspecs", "--no-pager", "-c", "core.fsmonitor=false",
				"-c", "core.excludesFile=/dev/null", ...args], { cwd, env, encoding: "buffer", maxBuffer: LIMIT, timeout: 15_000 })) };
		} catch (error) {
			const result = error as Error & { code?: number; stdout?: Buffer; stderr?: Buffer };
			if (allowOne && result.code === 1 && Buffer.isBuffer(result.stdout)) return { code: 1, stdout: result.stdout, stderr: result.stderr };
			throw new Error(`审查 Git ${args[0]} 失败：${String(error)}`, { cause: error });
		}
	};
	const decode = (buffer: Buffer) => {
		const text = buffer.toString("utf8");
		if (!Buffer.from(text).equals(buffer)) throw new Error("审查路径含不能无损表示的 UTF-8 字节，未生成差异");
		return text;
	};
	const paths = [...new Set([...scope.readPaths, ...scope.writePaths].map((file) => path.resolve(scope.workspace.cwdPath, file)))];
	const relativePaths = paths.map((file) => path.relative(root, file));
	const source = (relative: string) => {
		const file = path.resolve(root, relative);
		if (!relative || path.isAbsolute(relative) || path.relative(root, file) !== relative || !paths.some((allowed) => within(allowed, file))) throw new Error("Git 审查路径不在本次明确范围内");
		return file;
	};
	const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root, true);
	const baseHead = head.code === 0 ? decode(head.stdout).trim() : undefined;
	if (baseHead && !/^[a-f0-9]+$/.test(baseHead)) throw new Error("Git 基线对象 ID 无效");
	const baseline = new Map<string, { oid: string; mode: number }>();
	if (baseHead) for (const row of decode((await git(["ls-tree", "-rz", "--full-tree", baseHead, "--", ...relativePaths], root)).stdout).split("\0").filter(Boolean)) {
		const split = row.indexOf("\t");
		const [mode, type, oid, extra] = row.slice(0, split).split(" ");
		const file = row.slice(split + 1);
		source(file);
		if (split < 0 || extra || type !== "blob" || !["100644", "100755"].includes(mode!) || !/^[a-f0-9]+$/.test(oid!)) throw new Error(`审查基线 ${file} 不是受支持的普通文件，未伪造差异`);
		baseline.set(file, { oid: oid!, mode: Number.parseInt(mode!, 8) & 0o777 });
	}
	const visible = decode((await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...relativePaths], root)).stdout).split("\0").filter(Boolean);
	const writable = scope.writePaths.map((file) => path.resolve(scope.workspace.cwdPath, file));
	const files = [...new Set([...baseline.keys(), ...visible, ...candidate.files.filter((file) => writable.some((allowed) => within(allowed, source(file))))])].sort();
	const current = new Set(candidate.files);
	await Promise.all(["before", "after"].map((name) => mkdir(path.join(directory, name))));
	const save = async (side: string, file: string, bytes: Buffer, mode: number) => {
		source(file);
		if (bytes.length > LIMIT) throw new Error(`审查文件 ${file} 超过 16 MiB，未生成截断差异`);
		const target = path.join(directory, side, file);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, bytes);
		await chmod(target, mode);
	};
	for (const file of files) {
		const target = source(file);
		const old = baseline.get(file);
		if (old) await save("before", file, (await git(["cat-file", "blob", old.oid], root)).stdout, old.mode);
		if (current.has(file)) {
			const info = await stat(target);
			if (!info.isFile() || info.size > LIMIT) throw new Error(`审查文件 ${file} 不是 16 MiB 内普通文件`);
			await save("after", file, await readFile(target), info.mode & 0o777);
		}
	}
	// 不在项目工作树上运行 diff/clean/textconv；原始 blob 和副本交给标准 Git no-index 比较。
	const diff = await git(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--", "before", "after"], directory, true);
	const diffFile = path.join(directory, "diff.patch");
	await writeFile(diffFile, diff.stdout);
	return { directory, diffFile, baseHead, files };
}
