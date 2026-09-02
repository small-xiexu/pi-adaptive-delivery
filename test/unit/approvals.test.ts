import assert from "node:assert/strict";
import test from "node:test";

import {
	createApprovalRecord,
	digestApprovalContent,
	findLatestAssistantEntry,
	parseApprovalRecord,
	requireTuiUserConfirmation,
	validateApprovalRecord,
} from "../../extensions/delivery-gate/src/approvals.ts";

const branch = [
	{ type: "message", id: "user-1", message: { role: "user", content: "request" } },
	{
		type: "message",
		id: "assistant-1",
		message: { role: "assistant", content: [{ type: "text", text: "solution" }] },
	},
	{ type: "message", id: "user-2", message: { role: "user", content: "confirm?" } },
] as const;

test("creates and validates an immutable approval record", () => {
	const entry = findLatestAssistantEntry(branch);
	assert.ok(entry);
	const record = createApprovalRecord(
		"solution",
		{
			sessionId: "session-1",
			entry,
			branchAnchorEntryId: "user-2",
			canonicalCwd: "/repo",
			gitRoot: "/repo",
		},
		new Date("2026-01-01T00:00:00.000Z"),
	);

	assert.equal(record.contentDigest, digestApprovalContent(entry.message.content));
	assert.deepEqual(parseApprovalRecord(record), record);
	assert.deepEqual(
		validateApprovalRecord(record, {
			sessionId: "session-1",
			branch,
			canonicalCwd: "/repo",
			gitRoot: "/repo",
		}),
		{ ok: true },
	);
});

test("canonical digest ignores object key insertion order", () => {
	assert.equal(
		digestApprovalContent({ a: 1, b: { c: 2, d: 3 } }),
		digestApprovalContent({ b: { d: 3, c: 2 }, a: 1 }),
	);
});

test("rejects stale branch, cwd, Git root, session, or content", () => {
	const entry = findLatestAssistantEntry(branch);
	assert.ok(entry);
	const record = createApprovalRecord("plan", {
		sessionId: "session-1",
		entry,
		branchAnchorEntryId: "user-2",
		canonicalCwd: "/repo",
		gitRoot: "/repo",
	});

	const cases = [
		{ sessionId: "other", branch, canonicalCwd: "/repo", gitRoot: "/repo" },
		{ sessionId: "session-1", branch, canonicalCwd: "/other", gitRoot: "/repo" },
		{ sessionId: "session-1", branch, canonicalCwd: "/repo", gitRoot: "/other" },
		{ sessionId: "session-1", branch: branch.slice(0, 2), canonicalCwd: "/repo", gitRoot: "/repo" },
		{
			sessionId: "session-1",
			branch: branch.map((item) =>
				item.id === "assistant-1"
					? { ...item, message: { ...item.message, content: "changed" } }
					: item,
			),
			canonicalCwd: "/repo",
			gitRoot: "/repo",
		},
	];

	for (const context of cases) {
		assert.equal(validateApprovalRecord(record, context).ok, false);
	}
});

test("rejects malformed approval records", () => {
	for (const value of [
		null,
		{},
		{ version: 2 },
		{
			version: 1,
			kind: "solution",
			sessionId: "session",
			entryId: "entry",
			contentDigest: "not-a-digest",
			branchAnchorEntryId: "anchor",
			canonicalCwd: "/repo",
			approvedAt: new Date().toISOString(),
		},
	]) {
		assert.equal(parseApprovalRecord(value), undefined);
	}
});

test("only an actual TUI confirmation grants privilege", async () => {
	for (const mode of ["print", "json", "rpc"] as const) {
		let prompted = false;
		const allowed = await requireTuiUserConfirmation(
			{
				mode,
				ui: {
					confirm: async () => {
						prompted = true;
						return true;
					},
				} as any,
			},
			{ title: "Approve", message: "Grant access?" },
		);
		assert.equal(allowed, false, mode);
		assert.equal(prompted, false, mode);
	}

	for (const confirmation of [false, true]) {
		const allowed = await requireTuiUserConfirmation(
			{
				mode: "tui",
				ui: { confirm: async () => confirmation } as any,
			},
			{ title: "Approve", message: "Grant access?" },
		);
		assert.equal(allowed, confirmation);
	}
});
