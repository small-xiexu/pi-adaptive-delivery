import assert from "node:assert/strict";
import test from "node:test";
import { installStallWatch } from "../../extensions/delivery-gate/src/stall-watch.ts";

function host() {
	const handlers = new Map<string, Function[]>();
	const notices: string[] = [];
	let aborts = 0;
	const sent: unknown[] = [];
	let clock = 1_000;
	const pi: any = {
		on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	};
	const ctx: any = { ui: { notify: (text: string) => notices.push(text) }, abort: () => { aborts += 1; } };
	const event = async (name: string, payload: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(payload, ctx); };
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	return { pi, notices, sent, event, wait, advance: (ms: number) => { clock += ms; },
		get aborts() { return aborts; }, get clock() { return clock; } };
}

const assistant = (stopReason: string) => ({ message: { role: "assistant", stopReason } });

test("停顿超过阈值才中断并自动续跑，正常增量不断重置计时", async () => {
	const h = host();
	installStallWatch(h.pi, { thresholdMs: 30, tickMs: 5, now: () => h.clock });
	await h.event("message_start", assistant("stop"));
	await h.wait(20);
	h.advance(10);
	await h.event("message_update", {});
	await h.wait(20);
	assert.equal(h.aborts, 0, "有增量就不该中断");
	h.advance(40);
	await h.wait(30);
	assert.equal(h.aborts, 1, "阈值内无增量应中断一次");
	assert.match(h.notices.at(-1)!, /已中断本次请求并自动继续（第 1\/2 次）/);
	assert.equal(h.sent.length, 0, "必须等回合收尾后再续跑");
	await h.event("agent_settled");
	assert.equal(h.sent.length, 1);
	assert.match(JSON.stringify(h.sent[0]), /从中断处继续/);
});

test("工具执行期间不计时，长时间命令不会被误判", async () => {
	const h = host();
	installStallWatch(h.pi, { thresholdMs: 30, tickMs: 5, now: () => h.clock });
	await h.event("message_start", assistant("toolUse"));
	await h.event("message_end", assistant("toolUse"));
	h.advance(10_000);
	await h.wait(30);
	assert.equal(h.aborts, 0, "消息结束后计时器必须停止");
	assert.equal(h.notices.length, 0);
});

test("连续停顿达到上限后停止自动恢复，完整回复会重置计数", async () => {
	const h = host();
	installStallWatch(h.pi, { thresholdMs: 20, tickMs: 5, now: () => h.clock });
	for (const round of [1, 2]) {
		await h.event("message_start", assistant("stop"));
		h.advance(30);
		await h.wait(20);
		assert.equal(h.aborts, round, `第 ${round} 次停顿应中断`);
		await h.event("message_end", assistant("aborted"));
		await h.event("agent_settled");
	}
	assert.match(h.notices.at(-1)!, /第 2\/2 次/);
	await h.event("message_start", assistant("stop"));
	h.advance(30);
	await h.wait(20);
	assert.equal(h.aborts, 2, "达到上限后不再中断");
	assert.match(h.notices.at(-1)!, /已达到自动恢复上限 2 次/);
	// 真正产出一份完整回复后计数重置，下一次停顿仍可恢复。
	await h.event("message_start", assistant("stop"));
	await h.event("message_end", assistant("stop"));
	h.advance(30);
	await h.event("message_start", assistant("stop"));
	h.advance(30);
	await h.wait(20);
	assert.equal(h.aborts, 3);
	assert.match(h.notices.at(-1)!, /第 1\/2 次/);
});

test("阈值非正或未启用时不安装计时器", async () => {
	const h = host();
	installStallWatch(h.pi, { thresholdMs: 0, tickMs: 5, now: () => h.clock });
	await h.event("message_start", assistant("stop"));
	h.advance(10_000);
	await h.wait(20);
	assert.equal(h.aborts, 0);
	assert.equal(h.notices.length, 0);
});
