import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxProfile, testEnvironment } from "./pi-fixture.ts";

const files = process.argv.slice(2);
const containers = files[0] === "--containers";
if (containers) files.shift();
let adapter: string | undefined;
if (files[0] === "--adapter") {
	files.shift();
	adapter = await realpath(files.shift() ?? "");
}
if (!files.length) throw new Error("请指定需要执行的测试文件。");
const sourceRoot = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-tests-")));
const env = testEnvironment(root);
const containerSocket = containers ? await realpath("/var/run/docker.sock") : undefined;
if (containers) env.PI_ADAPTIVE_CONTAINER_TESTS = "1";
if (adapter) env.ADAPTIVE_STRUCTURED_PACKAGE = adapter;
await Promise.all([env.HOME!, env.PI_CODING_AGENT_DIR!].map((dir) => mkdir(dir, { recursive: true })));
console.log(`# 隔离测试制品：${root}`);
let profile = sandboxProfile(root, sourceRoot, containerSocket);
if (adapter) {
	const modules = path.dirname(path.dirname(adapter));
	if (path.basename(modules) !== "node_modules") throw new Error("adapter 测试只接受已安装的 scoped Package 路径");
	profile += `\n(allow file-read* (subpath ${JSON.stringify(modules)}))`;
	for (let parent = path.dirname(modules); parent !== path.dirname(parent); parent = path.dirname(parent)) profile += `\n(allow file-read-metadata (literal ${JSON.stringify(parent)}))`;
}
const child = spawn("/usr/bin/sandbox-exec", [
	"-p", profile, process.execPath, "--import", "tsx", "--test", ...files,
], { cwd: sourceRoot, env, stdio: "inherit" });
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try {
	process.exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
} finally {
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", terminate);
}
