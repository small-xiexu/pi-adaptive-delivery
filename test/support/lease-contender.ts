import { WriterLeaseManager, resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";

const [stateRoot, repo, sessionId] = process.argv.slice(2);
if (!stateRoot || !repo || !sessionId) throw new Error("Usage: lease-contender <state-root> <repo> <session-id>");

const manager = new WriterLeaseManager(stateRoot);
const identity = await resolveWorkspaceIdentity(repo);
const result = await manager.acquire(identity, {
	kind: "parent",
	sessionId,
	pid: process.pid,
});
process.stdout.write(`${JSON.stringify({ ok: result.ok, reason: result.ok ? undefined : result.reason })}\n`);
