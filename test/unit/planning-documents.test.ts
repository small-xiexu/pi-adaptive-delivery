import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createPlanningDocumentTools } from "../../extensions/delivery-gate/src/planning-documents.ts";
import { resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";

async function host(paths = ["docs/方案.md", "docs/计划.md"], authorize = async () => {}) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "planning-documents-")));
	const cwd = path.join(root, "repo");
	await mkdir(cwd);
	execFileSync("git", ["init", "--quiet"], { cwd });
	const workspace = await resolveWorkspaceIdentity(cwd);
	const stateRoot = path.join(root, "state");
	const leases = new WriterLeaseManager(stateRoot);
	const acquired = await leases.acquire(workspace, { kind: "parent", sessionId: "parent", pid: process.pid });
	assert.ok(acquired.ok);
	const controller = new AbortController();
	const scope = { workspace, paths, owner: acquired.record.owner, leases, lease: acquired.reference, authorize, signal: controller.signal };
	return { root, cwd, stateRoot, scope, leases, controller, tools: createPlanningDocumentTools(scope),
		file: path.join(cwd, "docs/方案.md"),
		release: () => leases.releaseParent(acquired.reference, acquired.record.owner, async () => {}, new AbortController().signal),
	};
}

// 只在测试中拦截指定文件句柄；真实文件与 Pi 队列照常执行，不给生产底层增加故障开关。
function interceptHandles(t: TestContext, target: string, intercept: (handle: FileHandle) => void) {
	const open = fs.open;
	t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
		const handle = await open(...args);
		if (args[0] === target) intercept(handle);
		return handle;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("原生编辑支持创建、持续修改与完整重写，不要求标题或 JSON 契约", async () => {
	const h = await host();
	await h.tools.write("create", { path: "docs/方案.md", content: "已有用户内容\n当前结论\n待补充\n" });
	const result = await h.tools.edit("edit", { path: "docs/方案.md", edits: [{ oldText: "待补充", newText: "新增证据" }] });
	assert.equal(await readFile(h.file, "utf8"), "已有用户内容\n当前结论\n新增证据\n");
	assert.match(JSON.stringify(result), /新增证据/);
	await h.tools.write("rewrite", { path: h.file, content: "明确的完整重写\n" });
	assert.equal(await readFile(h.file, "utf8"), "明确的完整重写\n");
	assert.equal((await h.leases.read(h.scope.workspace.key))?.leaseId, h.scope.lease.leaseId, "底层不会自行释放 writer");
});

test("父文件底层拒绝显式提供的 Git 元数据保护目录", async () => {
	const h = await host(["metadata/forbidden.md"]);
	const tools = createPlanningDocumentTools(h.scope, [path.join(h.cwd, "metadata")]);
	await assert.rejects(tools.write("metadata", { path: "metadata/forbidden.md", content: "禁止" }), /受保护路径/);
	await assert.rejects(access(path.join(h.cwd, "metadata/forbidden.md")), { code: "ENOENT" });
});

test("再次编辑读取最新正文，保留用户随后新增的无关内容", async () => {
	const h = await host();
	await h.tools.write("create", { path: "docs/方案.md", content: "结论一\n保留段落\n" });
	await writeFile(h.file, "用户补充\n结论一\n保留段落\n");
	await h.tools.edit("update", { path: "@docs/方案.md", edits: [{ oldText: "结论一", newText: "结论二" }] });
	assert.equal(await readFile(h.file, "utf8"), "用户补充\n结论二\n保留段落\n");
});

test("原生编辑保留 BOM/CRLF，重复或冲突匹配不造成部分修改", async () => {
	const h = await host();
	await h.tools.write("create", { path: h.file, content: "\uFEFF第一行\r\n第二行\r\n第二行\r\n" });
	await h.tools.edit("edit", { path: h.file, edits: [{ oldText: "第一行", newText: "替换行" }] });
	const before = await readFile(h.file);
	assert.equal(before.toString(), "\uFEFF替换行\r\n第二行\r\n第二行\r\n");
	await assert.rejects(h.tools.edit("ambiguous", { path: h.file, edits: [{ oldText: "第二行", newText: "未知" }] }));
	await assert.rejects(h.tools.edit("partial", { path: h.file, edits: [{ oldText: "替换行", newText: "不应写入" }, { oldText: "不存在", newText: "未知" }] }));
	assert.deepEqual(await readFile(h.file), before);
});

for (const target of ["docs/other.md", "new/other.md", "src/index.ts", "../outside.md"]) {
	test(`未列明文档 ${target} 不创建文件或父目录`, async () => {
		const h = await host();
		await assert.rejects(h.tools.write("denied", { path: target, content: "不应写入" }), /Markdown 文档范围/);
		await assert.rejects(access(path.resolve(h.cwd, target)), { code: "ENOENT" });
		await assert.rejects(access(path.join(h.cwd, "new")), { code: "ENOENT" });
	});
}

for (const target of ["src.ts", "../outside.md"]) {
	test(`即使输入范围错误地包含 ${target}，也不能执行写入`, async () => {
		const h = await host([target]);
		await assert.rejects(h.tools.write("denied", { path: target, content: "不应写入" }), /Markdown 文档范围/);
		await assert.rejects(access(path.resolve(h.cwd, target)), { code: "ENOENT" });
	});
}

for (const kind of ["file-symlink", "directory-symlink", "hardlink"]) {
	test(`拒绝 ${kind}，范围外文件不变`, async () => {
		const h = await host();
		const outside = path.join(h.root, "outside");
		await mkdir(outside);
		const protectedFile = path.join(outside, "方案.md");
		await writeFile(protectedFile, "保留");
		if (kind === "directory-symlink") await symlink(outside, path.join(h.cwd, "docs"));
		else {
			await mkdir(path.dirname(h.file));
			if (kind === "file-symlink") await symlink(protectedFile, h.file);
			else await link(protectedFile, h.file);
		}
		await assert.rejects(h.tools.write("denied", { path: h.file, content: "不应写入" }), /符号链接|独立普通文件/);
		assert.equal(await readFile(protectedFile, "utf8"), "保留");
	});
}

for (const change of ["session", "child", "lease", "pid", "token", "missing", "corrupt"]) {
	test(`父 writer ${change} 不可核实时，文件和目录均未写入`, async () => {
		const h = await host();
		const file = path.join(h.stateRoot, "leases", `${h.scope.workspace.key}.json`);
		const record = JSON.parse(await readFile(file, "utf8"));
		if (change === "session") record.owner.sessionId = "other-session";
		if (change === "child") record.owner.kind = "child";
		if (change === "lease") record.leaseId = "replaced";
		if (change === "pid") record.owner.pid++;
		if (change === "token") record.owner.processToken = "other-owner";
		if (change === "missing") await h.release();
		else await writeFile(file, change === "corrupt" ? "invalid" : JSON.stringify(record));
		await assert.rejects(h.tools.write("denied", { path: h.file, content: "不应写入" }));
		await assert.rejects(access(path.dirname(h.file)), { code: "ENOENT" });
	});
}

test("构造后改变输入路径数组不能扩大底层范围", async () => {
	const paths = ["docs/方案.md"];
	const h = await host(paths);
	paths.push("other.md");
	await assert.rejects(h.tools.write("denied", { path: "other.md", content: "不应写入" }), /Markdown 文档范围/);
});

test("预先取消不写入，写入错误不自动释放 lease", async (t) => {
	const h = await host();
	const abort = new AbortController();
	abort.abort(new Error("fixture cancellation"));
	await assert.rejects(h.tools.write("cancelled", { path: h.file, content: "不应写入" }, abort.signal), /fixture cancellation/);
	await assert.rejects(access(path.dirname(h.file)), { code: "ENOENT" });
	await h.tools.write("create", { path: h.file, content: "保留" });
	await chmod(h.file, 0o400);
	t.after(() => chmod(h.file, 0o600));
	await assert.rejects(h.tools.write("failed", { path: h.file, content: "不应写入" }), /EACCES|EPERM/);
	assert.equal(await readFile(h.file, "utf8"), "保留");
	assert.equal((await h.leases.read(h.scope.workspace.key))?.leaseId, h.scope.lease.leaseId);
});

test("并发编辑复用 Pi 的同文件队列，不丢失各自的无关修改", async () => {
	const h = await host();
	await h.tools.write("create", { path: h.file, content: "甲待办\n乙待办\n" });
	await Promise.all([
		h.tools.edit("first", { path: h.file, edits: [{ oldText: "甲待办", newText: "甲完成" }] }),
		h.tools.edit("second", { path: "docs/方案.md", edits: [{ oldText: "乙待办", newText: "乙完成" }] }),
	]);
	assert.equal(await readFile(h.file, "utf8"), "甲完成\n乙完成\n");
});

for (const change of ["lease", "symlink", "cancel"]) {
	test(`初次核验后 ${change} 变化，Pi 队列中的编辑仍然拒绝`, async (t) => {
		const h = await host();
		await h.tools.write("create", { path: h.file, content: "原文" });
		const protectedFile = path.join(h.root, "outside.md");
		await writeFile(protectedFile, "原文");
		let enter!: () => void;
		let unblock!: () => void;
		let checked!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const blocked = new Promise<void>((resolve) => { unblock = resolve; });
		const initialCheck = new Promise<void>((resolve) => { checked = resolve; });
		const blocker = withFileMutationQueue(h.file, async () => { enter(); await blocked; });
		t.after(async () => { unblock(); await blocker; });
		await entered;
		const read = h.leases.read.bind(h.leases);
		t.mock.method(h.leases, "read", async (key: string) => {
			const result = await read(key);
			checked();
			return result;
		});
		const abort = new AbortController();
		const failed = assert.rejects(h.tools.edit("queued", { path: h.file, edits: [{ oldText: "原文", newText: "不应写入" }] }, abort.signal));
		await initialCheck;
		if (change === "lease") await h.release();
		if (change === "symlink") {
			await unlink(h.file);
			await symlink(protectedFile, h.file);
		}
		if (change === "cancel") abort.abort();
		unblock();
		await blocker;
		await failed;
		assert.equal(await readFile(h.file, "utf8"), "原文");
		assert.equal(await readFile(protectedFile, "utf8"), "原文");
	});
}

test("canonical cwd 别名共享文档路径与父 writer，另一会话无法获取 writer", async () => {
	const h = await host();
	const alias = path.join(h.root, "repo-alias");
	await symlink(h.cwd, alias);
	const workspace = await resolveWorkspaceIdentity(alias);
	assert.deepEqual(workspace, h.scope.workspace);
	const other = await h.leases.acquire(workspace, { kind: "parent", sessionId: "other", pid: process.pid });
	assert.equal(other.ok, false);
	const tools = createPlanningDocumentTools({ ...h.scope, workspace });
	await tools.write("create", { path: "docs/方案.md", content: "原文" });
	assert.equal(await readFile(h.file, "utf8"), "原文");
});

test("持有 lease 不能替代批准核验，拒绝时不创建文档目录", async () => {
	const h = await host(undefined, async () => { throw new Error("fixture approval revoked"); });
	await assert.rejects(h.tools.write("denied", { path: h.file, content: "不应写入" }), /approval revoked/);
	await assert.rejects(access(path.dirname(h.file)), { code: "ENOENT" });
});

test("排队期间批准失效，已通过初次核验的编辑仍不写入", async (t) => {
	let valid = true;
	const h = await host(undefined, async () => { if (!valid) throw new Error("fixture approval revoked"); });
	await h.tools.write("create", { path: h.file, content: "原文" });
	let unblock!: () => void;
	let checked!: () => void;
	const blocked = new Promise<void>((resolve) => { unblock = resolve; });
	const initialCheck = new Promise<void>((resolve) => { checked = resolve; });
	const blocker = withFileMutationQueue(h.file, () => blocked);
	t.after(async () => { unblock(); await blocker; });
	const read = h.leases.read.bind(h.leases);
	t.mock.method(h.leases, "read", async (key: string) => { const result = await read(key); checked(); return result; });
	const failed = assert.rejects(h.tools.edit("queued", { path: h.file, edits: [{ oldText: "原文", newText: "不应写入" }] }), /approval revoked/);
	await initialCheck;
	valid = false;
	unblock();
	await failed;
	assert.equal(await readFile(h.file, "utf8"), "原文");
});

test("最终批准核验等待期间失去 lease，不能继续截断文件", async (t) => {
	let opened = false;
	const h = await host(undefined, async () => { if (opened) { opened = false; await h.release(); } });
	await h.tools.write("create", { path: h.file, content: "原文" });
	interceptHandles(t, h.file, (handle) => {
		const stat = handle.stat.bind(handle);
		t.mock.method(handle, "stat", async () => { const result = await stat(); opened = true; return result; });
	});
	await assert.rejects(h.tools.write("denied", { path: h.file, content: "不应写入" }), /父 writer/);
	assert.equal(await readFile(h.file, "utf8"), "原文");
});

for (const boundary of ["stat", "truncate"] as const) {
	test(`批准在 ${boundary} 完成后失效，不开始下一次内容写入且等待句柄关闭`, async (t) => {
		const h = await host();
		await h.tools.write("create", { path: h.file, content: "原文" });
		let closed = false;
		interceptHandles(t, h.file, (handle) => {
			const original = handle[boundary].bind(handle);
			t.mock.method(handle, boundary, async (...args: any[]) => {
				const result = await (original as Function)(...args);
				h.controller.abort(new Error("fixture approval revoked"));
				return result;
			});
			const close = handle.close.bind(handle);
			t.mock.method(handle, "close", async () => { await close(); closed = true; });
		});
		await assert.rejects(h.tools.write("cancelled", { path: h.file, content: "不应写入" }), /approval revoked/);
		assert.equal(closed, true);
		assert.equal(h.tools.cleanupFailed, false);
		assert.equal(await readFile(h.file, "utf8"), boundary === "stat" ? "原文" : "");
		assert.ok(await h.leases.read(h.scope.workspace.key));
	});
}

test("部分 I/O 失败保留实际内容，不误报成功或回滚，lease 仍由调用方持有", async (t) => {
	const h = await host();
	interceptHandles(t, h.file, (handle) => {
		const write = handle.writeFile.bind(handle);
		t.mock.method(handle, "writeFile", async () => { await write("部分内容", "utf8"); throw new Error("fixture partial I/O failure"); });
	});
	await assert.rejects(h.tools.write("partial", { path: h.file, content: "完整内容" }), /partial I\/O/);
	assert.equal(await readFile(h.file, "utf8"), "部分内容");
	assert.equal(h.tools.cleanupFailed, false);
	assert.ok(await h.leases.read(h.scope.workspace.key));
});

for (const kind of ["edit", "write"] as const) {
	test(`${kind} 句柄关闭报错时保留清理失败标志，不能因 Promise 结束当作已清理`, async (t) => {
		const h = await host();
		await h.tools.write("create", { path: h.file, content: "原文" });
		interceptHandles(t, h.file, (handle) => {
			const close = handle.close.bind(handle);
			t.mock.method(handle, "close", async () => { await close(); throw new Error("fixture close failure"); });
		});
		const run = kind === "edit" ? h.tools.edit("failed", { path: h.file, edits: [{ oldText: "原文", newText: "更新" }] })
			: h.tools.write("failed", { path: h.file, content: "更新" });
		await assert.rejects(run, /close failure/);
		assert.equal(h.tools.cleanupFailed, true);
		assert.equal(await readFile(h.file, "utf8"), kind === "edit" ? "原文" : "更新");
		assert.ok(await h.leases.read(h.scope.workspace.key));
		await assert.rejects(h.tools.write("next", { path: h.file, content: "不应再写入" }), /清理失败/);
		assert.equal(await readFile(h.file, "utf8"), kind === "edit" ? "原文" : "更新");
	});
}

test("取消正在等待的写入时，Promise 与原生文件队列都等待 I/O 和关闭真正结束", async (t) => {
	const h = await host();
	let enter!: () => void;
	let unblock!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const blocked = new Promise<void>((resolve) => { unblock = resolve; });
	let closed = false;
	interceptHandles(t, h.file, (handle) => {
		const write = handle.writeFile.bind(handle);
		t.mock.method(handle, "writeFile", async (...args: Parameters<typeof write>) => { enter(); await blocked; await write(...args); });
		const close = handle.close.bind(handle);
		t.mock.method(handle, "close", async () => { await close(); closed = true; });
	});
	const run = h.tools.write("in-flight", { path: h.file, content: "已提交的 I/O 仍可能写入" });
	const failed = assert.rejects(run, /aborted/);
	t.after(async () => { unblock(); await failed; });
	await entered;
	let settled = false;
	void run.then(() => { settled = true; }, () => { settled = true; });
	let nextStarted = false;
	const next = withFileMutationQueue(h.file, async () => { nextStarted = true; assert.equal(closed, true); });
	h.controller.abort();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	assert.equal(nextStarted, false);
	assert.ok(await h.leases.read(h.scope.workspace.key));
	unblock();
	await failed;
	await next;
	assert.equal(h.tools.cleanupFailed, false);
	assert.equal(await readFile(h.file, "utf8"), "已提交的 I/O 仍可能写入");
});
