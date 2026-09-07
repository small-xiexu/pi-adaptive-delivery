import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxProfile, testEnvironment } from "./pi-fixture.ts";

const files = process.argv.slice(2);
const containers = files[0] === "--containers";
if (containers) files.shift();
if (!files.length) throw new Error("请指定需要执行的测试文件。");
const sourceRoot = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-tests-")));
const env = testEnvironment(root);
const containerSocket = containers ? await realpath("/var/run/docker.sock") : undefined;
if (containers) env.PI_ADAPTIVE_CONTAINER_TESTS = "1";
await Promise.all([env.HOME!, env.PI_CODING_AGENT_DIR!].map((dir) => mkdir(dir, { recursive: true })));
console.log(`# 隔离测试制品：${root}`);
const child = spawn("/usr/bin/sandbox-exec", [
	"-p", sandboxProfile(root, sourceRoot, containerSocket), process.execPath, "--import", "tsx", "--test", ...files,
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
