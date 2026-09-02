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
	assert.doesNotMatch(skill.body, /默认最多三轮/);
	assert.match(skill.body, /不得重放结果未知/);
});
