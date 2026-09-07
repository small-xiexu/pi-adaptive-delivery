import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPiFixture } from "../support/pi-fixture.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));

for (const scenario of ["success", "denied", "source", "queued-revoke", "queued-cancel", "queued-lease", "inflight-cancel", "partial", "close-failure"]) {
	test(`真实 Pi / 临时 Git 的文档底层 ${scenario}，不冒充正式 TUI 写入授权`, { timeout: 30_000 }, async (t) => {
		const fixture = await createPiFixture(source, "document-io");
		t.after(() => fixture.rpc.stop());
		await fixture.rpc.send("prompt", { message: "读取 input.txt，建立真实持久 Session" });
		await fixture.rpc.waitFor((record) => record.type === "agent_settled");
		await fixture.rpc.send("prompt", { message: `/fixture-document-io ${scenario}` });
		const state = (await fixture.rpc.send("get_state")).data;
		const rows = (await readFile(state.sessionFile, "utf8")).trimEnd().split("\n").map((row) => JSON.parse(row));
		const evidence = rows.filter((row) => row.customType === "fixture-document-io");
		assert.equal(evidence.length, 1);
		assert.deepEqual(evidence[0].data, { scenario, pid: fixture.rpc.process.pid, workspaceKey: evidence[0].data.workspaceKey,
			leaseRetained: scenario !== "queued-lease", cleanupFailed: scenario === "close-failure" });
		assert.equal(rows.some((row) => row.customType === "delivery-approval"), false);
		if (scenario === "success") assert.equal(await readFile(path.join(fixture.cwd, "docs/plan.md"), "utf8"), "更新\n用户内容\n");
		t.diagnostic(JSON.stringify({ root: fixture.root, pid: fixture.rpc.process.pid, scenario, sessionFile: state.sessionFile }));
	});
}
