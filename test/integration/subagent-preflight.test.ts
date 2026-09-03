import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { SubagentBoundary } from "../../extensions/delivery-gate/src/subagents.ts";

const execFileAsync = promisify(execFile);

test("preflights the builtin scout through the bundled public API", async () => {
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-preflight-agent-"));
	const repo = await mkdtemp(path.join(os.tmpdir(), "adaptive-preflight-repo-"));
	await execFileAsync("git", ["init", "-q"], { cwd: repo });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const model = {
			id: "adaptive-test-model",
			name: "Adaptive Test Model",
			provider: "adaptive-test",
			api: "openai-responses",
			baseUrl: "http://127.0.0.1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 4096,
		};
		const boundary = new SubagentBoundary({ events: { on: () => () => {}, emit: () => {} } } as any);
		boundary.bindSession("preflight-session");
		boundary.applyAccess("readonly");
		const contract = await boundary.preflight(
			"scout",
			"Inspect the repository without modifying files.",
			{
				cwd: repo,
				model,
				thinkingLevel: "low",
				modelRegistry: { getAvailable: () => [model] },
				sessionManager: {
					getSessionFile: () => undefined,
					getLeafId: () => undefined,
				},
			} as any,
			repo,
		);

		assert.equal(contract.agent.name, "scout");
		assert.equal(contract.agent.source, "builtin");
		assert.equal(contract.context, "fresh");
		assert.deepEqual(contract.modelCandidates, ["adaptive-test/adaptive-test-model:low"]);
		assert.equal(contract.tools.effectiveAllowlist.includes("bash"), false);
		assert.equal(contract.tools.effectiveAllowlist.includes("write"), false);
		assert.equal(contract.tools.disableAmbientExtensions, true);
		assert.equal(contract.tools.capabilityAudit?.extensionsDenied, true);
		assert.deepEqual(contract.tools.effectiveMcpTools, []);
		assert.ok(contract.launchContractDigest);
		boundary.dispose();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
