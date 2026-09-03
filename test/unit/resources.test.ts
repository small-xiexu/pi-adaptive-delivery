import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

interface FrontmatterResult {
	frontmatter: Record<string, string>;
	body: string;
}

function parseFrontmatter(source: string): FrontmatterResult {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
	if (!match) throw new Error("Missing Markdown frontmatter");
	const frontmatter: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^"|"$/g, "");
	}
	return { frontmatter, body: match[2]! };
}

test("ships three discoverable prompt templates and one skill", async () => {
	const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	for (const resource of [
		manifest.pi.extensions[0],
		"./prompts/delivery-shape.md",
		"./prompts/delivery-plan.md",
		"./prompts/delivery-run.md",
		"./skills/adaptive-delivery/SKILL.md",
	]) {
		await access(new URL(`../../${resource.replace(/^\.\//, "")}`, import.meta.url));
	}
});

test("prompt templates have descriptions and preserve phase boundaries", async () => {
	const prompts = await Promise.all(
		["delivery-shape", "delivery-plan", "delivery-run"].map(async (name) => ({
			name,
			...parseFrontmatter(await readFile(new URL(`../../prompts/${name}.md`, import.meta.url), "utf8")),
		})),
	);
	for (const prompt of prompts) {
		assert.ok(prompt.frontmatter.description, prompt.name);
		assert.doesNotMatch(prompt.body, /gpt-|claude-|gemini-/i, prompt.name);
		assert.match(prompt.body, /adaptive-delivery/i, prompt.name);
	}
	assert.match(prompts[0]!.body, /不得修改项目文件/);
	assert.match(prompts[0]!.body, /adaptive-delivery:solution:start/);
	assert.match(prompts[0]!.body, /adaptive-delivery-documents/);
	assert.match(prompts[0]!.body, /用户明确要求.*项目规则.*用户全局规则.*Package 默认/);
	assert.match(prompts[1]!.body, /本阶段禁止项目写入/);
	assert.match(prompts[1]!.body, /adaptive-delivery:plan:start/);
	assert.match(prompts[1]!.body, /"version": 2/);
	assert.match(prompts[1]!.body, /documents\.planPath/);
	assert.match(prompts[2]!.body, /delivery_submit_candidate/);
	assert.match(prompts[2]!.body, /delivery_runtime_status/);
	assert.match(prompts[2]!.body, /implementationWriter=parent/);
	assert.match(prompts[2]!.body, /delivery_delegate_worker/);
	assert.match(prompts[2]!.body, /工具按阶段开放/);
	assert.match(prompts[2]!.body, /当前不可见是正常行为/);
	assert.match(prompts[2]!.body, /只调用一次 `delivery_validate`/);
	assert.match(prompts[2]!.body, /不要调用 `delivery_runtime_status` 定时轮询/);
	assert.match(prompts[2]!.body, /可验证关闭义务/);
	assert.match(prompts[2]!.body, /closure review/);
	assert.doesNotMatch(prompts[2]!.body, /最多三轮/);
	assert.match(prompts[2]!.body, /不得自动 commit、push/);
});

test("skill uses valid Agent Skills identity and centralizes orchestration rules", async () => {
	const skill = parseFrontmatter(
		await readFile(new URL("../../skills/adaptive-delivery/SKILL.md", import.meta.url), "utf8"),
	);
	assert.equal(skill.frontmatter.name, "adaptive-delivery");
	assert.ok(skill.frontmatter.description);
	assert.match(skill.body, /所有修改型任务/);
	assert.match(skill.body, /同一个 cwd\/worktree 同时只有一个 writer/);
	assert.match(skill.body, /先用大白话对齐最终效果/);
	assert.match(skill.body, /可验证关闭义务/);
	assert.match(skill.body, /一次 closure review/);
	assert.match(skill.body, /同一最小复现仍失败/);
	assert.match(skill.body, /规划文档路径/);
	assert.match(skill.body, /docs\/<需求短名称>-技术方案\.md/);
	assert.match(skill.body, /create-only/);
	assert.match(skill.body, /自动展开 `\/delivery-plan`/);
	assert.match(skill.body, /自动展开 `\/delivery-run`/);
	assert.match(skill.body, /delivery_runtime_status/);
	assert.match(skill.body, /该动作只释放 writer 并保留批准链/);
	assert.match(skill.body, /`\/delivery-resume` 经 TUI 用户确认/);
	assert.match(skill.body, /`VALIDATING` 展开 `\/delivery-run`/);
	assert.match(skill.body, /公开 preflight.*至少有一个可用 model candidate/);
	assert.match(skill.body, /Pi 公开 `pi\.exec`/);
	assert.match(skill.body, /不得定时轮询 `delivery_runtime_status`/);
	assert.match(skill.body, /`standard\/high-risk` 从父 Pi 移除源码写入/);
	assert.match(skill.body, /terminal response 到达后才自动冻结 candidate/);
	assert.doesNotMatch(skill.body, /默认最多三轮/);
	assert.match(skill.body, /不得重放结果未知/);
});

test("README leads with the user workflow and keeps machine contracts out of the quick path", async () => {
	const source = await readFile(new URL("../../README.md", import.meta.url), "utf8");
	assert.match(source, /## 最终效果/);
	assert.match(source, /## 第一次使用/);
	assert.match(source, /\/delivery-shape 继续 P6\.1/);
	assert.match(source, /Package 会在对话区显示批准摘要，并自动生成实施计划/);
	assert.match(source, /当前 v0\.1 不会合并或覆盖已经存在的需求文档/);
	assert.match(source, /确认 resume.*Package 会自动继续当前阶段/);
	assert.match(source, /worker 和 reviewer 配置至少一个 fallback/);
	assert.match(source, /父 Pi 看不到 `edit\/write`/);
	assert.match(source, /固定验证本身不再启动 reviewer 或依赖模型/);
	assert.match(source, /defaultTtlMs.*300000/s);
	assert.match(source, /## 常见恢复/);
	assert.ok(source.indexOf("## 第一次使用") < source.indexOf("## 维护者参考"));
	assert.doesNotMatch(source, /```adaptive-delivery-(?:documents|plan)/);
});
