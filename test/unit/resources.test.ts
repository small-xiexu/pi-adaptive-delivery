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

test("shaping resources require a markdown-safe recommendation format", async () => {
	const [prompt, skill] = await Promise.all([
		readFile(new URL("../../prompts/delivery-shape.md", import.meta.url), "utf8"),
		readFile(new URL("../../skills/adaptive-delivery/SKILL.md", import.meta.url), "utf8"),
	]);
	assert.match(prompt, /推荐部分固定使用两行纯文本/);
	assert.match(prompt, /不要给该标签添加 Markdown 加粗/);
	assert.match(skill, /第一行只写“推荐答案：”，第二行写具体推荐/);
	assert.match(skill, /不要给“推荐答案”标签添加 Markdown 加粗/);
});

test("ships Adaptive Delivery resources and the bundled multi-agent entry points", async () => {
	const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	for (const resource of [
		...manifest.pi.extensions,
		"./prompts/delivery-shape.md",
		"./prompts/delivery-plan.md",
		"./prompts/delivery-run.md",
		"./skills/adaptive-delivery/SKILL.md",
	]) {
		await access(new URL(`../../${resource.replace(/^\.\//, "")}`, import.meta.url));
	}
	assert.equal(manifest.dependencies["beautiful-mermaid"], "1.1.3");
	assert.equal(manifest.dependencies["@resvg/resvg-js"], "2.6.2");
	assert.equal(manifest.dependencies["@mermaid-js/mermaid-cli"], undefined);
	assert.equal(manifest.dependencies.puppeteer, undefined);
	assert.equal(manifest.dependencies["pi-subagents"], "0.64.0");
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
	assert.match(prompts[0]!.body, /方案追问/);
	assert.match(prompts[0]!.body, /每次只问一个问题/);
	assert.match(prompts[0]!.body, /极小.*默认零追问/);
	assert.match(prompts[0]!.body, /用户可以只回答“按推荐”/);
	assert.match(prompts[0]!.body, /普通项目取证由父 Pi 直接使用/);
	assert.match(prompts[0]!.body, /不得重试同一任务/);
	assert.match(prompts[0]!.body, /先用 `grep`、`find`、`ls` 定位事实/);
	assert.match(prompts[0]!.body, /`read` 每次最多 500 行.*累计最多 5000 行/);
	assert.match(prompts[0]!.body, /事实已经闭合时立即成案/);
	assert.doesNotMatch(prompts[0]!.body, /一次列出所有问题|同时列出问题清单/);
	assert.match(prompts[0]!.body, /中大型任务.*1 至 3 张图/);
	assert.match(prompts[0]!.body, /高风险任务必须用适用图表/);
	assert.match(prompts[0]!.body, /复杂流程按.*阶段拆图/);
	assert.match(prompts[0]!.body, /流程\/状态图通常不超过约 10 个主要节点/);
	assert.match(prompts[0]!.body, /sequenceDiagram.*stateDiagram-v2.*classDiagram.*erDiagram.*xychart-beta/s);
	assert.match(prompts[0]!.body, /不要调用 Bash、外部服务或额外工具生成图片/);
	assert.match(prompts[0]!.body, /确认后，Extension 会立即 create-only 写入技术方案文档/);
	assert.match(prompts[0]!.body, /仍不开放源码写入/);
	assert.match(prompts[1]!.body, /本阶段禁止项目写入/);
	assert.match(prompts[1]!.body, /技术方案文档已经由 `\/delivery-approve-solution` 同步/);
	assert.match(prompts[1]!.body, /只 create-only 写入实施计划/);
	assert.match(prompts[1]!.body, /PLANNING 不重做 SHAPING 的源码研究/);
	assert.match(prompts[1]!.body, /`read` 每次最多 500 行.*累计最多 5000 行/);
	assert.match(prompts[1]!.body, /需求短名称.*documents\.requirementName.*完全相同/);
	assert.match(prompts[1]!.body, /adaptive-delivery:plan:start/);
	assert.match(prompts[1]!.body, /"version": 2/);
	assert.match(prompts[1]!.body, /documents\.planPath/);
	assert.match(prompts[1]!.body, /canonical project-relative/);
	assert.match(prompts[1]!.body, /\.git.*\.pi.*node_modules/);
	assert.match(prompts[1]!.body, /repairCommand.*repairTimeoutMs/);
	assert.match(prompts[1]!.body, /Tiny 不支持 repair command/);
	assert.match(prompts[1]!.body, /不得只挂载一个源码子目录/);
	assert.match(prompts[1]!.body, /同一机器、同一容器\/沙箱和同等测试范围的最近真实耗时/);
	assert.match(prompts[1]!.body, /批准命令自身必须提供确定性终止边界/);
	assert.match(prompts[1]!.body, /不得声称保留旧 candidate\/evidence/);
	assert.match(prompts[1]!.body, /plan-v2 `single` 与 Tiny 路由必须由父 Pi/);
	assert.match(prompts[2]!.body, /delivery_submit_candidate/);
	assert.match(prompts[2]!.body, /delivery_runtime_status/);
	assert.match(prompts[2]!.body, /implementationWriter=parent/);
	assert.match(prompts[2]!.body, /delivery_delegate_worker/);
	assert.match(prompts[2]!.body, /worker 无条件不得修改已批准 solution、plan 或任何 `progressTargets`/);
	assert.match(prompts[2]!.body, /不要把进度文档交给 worker 修改/);
	assert.match(prompts[2]!.body, /工具按阶段开放/);
	assert.match(prompts[2]!.body, /当前不可见是正常行为/);
	assert.match(prompts[2]!.body, /只调用一次 `delivery_validate`/);
	assert.match(prompts[2]!.body, /不要调用 `delivery_runtime_status` 定时轮询/);
	assert.match(prompts[2]!.body, /可验证关闭义务/);
	assert.match(prompts[2]!.body, /delivery_begin_rework\(\{ reason:/);
	assert.match(prompts[2]!.body, /不要传入 `acceptedFindings`/);
	assert.match(prompts[2]!.body, /closure review/);
	assert.match(prompts[2]!.body, /每次调用前重新读取目标文件的当前 exact 区块/);
	assert.match(prompts[2]!.body, /`oldText` 和 `newText` 都必须非空/);
	assert.match(prompts[2]!.body, /不支持删除/);
	assert.doesNotMatch(prompts[2]!.body, /最多三轮/);
	assert.match(prompts[2]!.body, /不得自动 commit、push/);
});

test("skill uses valid Agent Skills identity and centralizes orchestration rules", async () => {
	const skill = parseFrontmatter(
		await readFile(new URL("../../skills/adaptive-delivery/SKILL.md", import.meta.url), "utf8"),
	);
	assert.equal(skill.frontmatter.name, "adaptive-delivery");
	assert.ok(skill.frontmatter.description);
	assert.match(skill.body, /任何源码写入前.*Delivery Contract/);
	assert.match(skill.body, /只有用户明确输入 `\/delivery-shape` 才能调用 `delivery_begin`/);
	assert.match(skill.body, /纯问答、只读梳理、状态盘点、诊断和代码评审保持 `IDLE`/);
	assert.match(skill.body, /同一个 cwd\/worktree 同时只有一个 writer/);
	assert.match(skill.body, /先用大白话对齐最终效果/);
	assert.match(skill.body, /方案追问是本 Skill 内置行为/);
	assert.match(skill.body, /每轮只问一个问题/);
	assert.match(skill.body, /极小需求默认零追问/);
	assert.match(skill.body, /所有高影响歧义关闭后立即停止/);
	assert.match(skill.body, /方案追问面向用户确认产品和范围；oracle 面向高风险技术取舍/);
	assert.match(skill.body, /普通 SHAPING\/PLANNING 取证由父 Pi 直接使用/);
	assert.match(skill.body, /公开只读委派只提供高风险 `oracle`/);
	assert.match(skill.body, /不向模型暴露 scout 或 reviewer/);
	assert.match(skill.body, /取证先搜索定位，再读取必要切片/);
	assert.match(skill.body, /父 Pi `read` 每次最多 500 行.*累计最多 5000 行/);
	assert.match(skill.body, /PLANNING 沿用批准方案/);
	assert.match(skill.body, /计划中的 timeout 优先使用同环境、同范围最近耗时并留足余量/);
	assert.match(skill.body, /不能假设 `pi\.exec` 会清理全部外部进程/);
	assert.match(skill.body, /## 技术方案图表/);
	assert.match(skill.body, /只使用六类受支持 Mermaid/);
	assert.match(skill.body, /支持图片协议时显示本地 PNG，否则显示 Unicode 字符图/);
	assert.match(skill.body, /每张图只回答一个主要问题/);
	assert.match(skill.body, /复杂流程按阶段或职责拆成 2 至 3 张图/);
	assert.match(skill.body, /可验证关闭义务/);
	assert.match(skill.body, /delivery_begin_rework\(\{ reason:/);
	assert.match(skill.body, /不要传入 `acceptedFindings`/);
	assert.match(skill.body, /一次 closure review/);
	assert.match(skill.body, /同一最小复现仍失败/);
	assert.match(skill.body, /规划文档路径/);
	assert.match(skill.body, /docs\/<需求短名称>-技术方案\.md/);
	assert.match(skill.body, /create-only/);
	assert.match(skill.body, /确认后立即 create-only 写入技术方案/);
	assert.match(skill.body, /批准 plan 后.*只 create-only 写入实施计划/);
	assert.match(skill.body, /repairCommand.*repairTimeoutMs/);
	assert.match(skill.body, /计划修订不会保留 runtime candidate、validation 或 review evidence/);
	assert.match(skill.body, /worker 路由必须重新取得唯一 worker terminal proof/);
	assert.match(skill.body, /plan-v2 `single` 与 Tiny 路由必须由父 Pi/);
	assert.match(skill.body, /exact `newText` 已唯一存在时可作为幂等成功/);
	assert.match(skill.body, /`oldText\/newText` 均须非空且当前入口不支持删除/);
	assert.match(skill.body, /runtime 在其他状态不暴露该工具/);
	assert.match(skill.body, /人工改动或 symlink 漂移必须拒绝覆盖/);
	assert.match(skill.body, /Unicode NFC 后的空白视为等价/);
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
	assert.match(skill.body, /worker 无条件不得修改已批准 solution、plan 或任何 `progressTargets`/);
	assert.match(skill.body, /worker terminal 后、repair 前复验/);
	assert.match(skill.body, /repair 完成后、candidate freeze 前再次复验/);
	assert.match(skill.body, /重复发生 runtime proof failure 必须保留原 `resumeState`/);
	assert.doesNotMatch(skill.body, /默认最多三轮/);
	assert.match(skill.body, /不得重放结果未知/);
});

test("README leads with the user workflow and keeps machine contracts out of the quick path", async () => {
	const source = await readFile(new URL("../../README.md", import.meta.url), "utf8");
	assert.match(source, /## 最终效果/);
	assert.match(source, /## 第一次使用/);
	assert.match(source, /\/delivery-shape 继续 P6\.1/);
	assert.match(source, /普通问答、项目梳理、状态盘点、诊断和代码评审保持 `IDLE`/);
	assert.match(source, /Package 会在对话区显示批准摘要，立即把已批准技术方案写入项目/);
	assert.match(source, /当前版本不会合并或覆盖无法证明来源的需求文档/);
	assert.match(source, /确认 resume.*Package 会自动继续当前阶段/);
	assert.match(source, /worker 和 reviewer 配置至少一个 fallback/);
	assert.match(source, /父 Pi 看不到 `edit\/write`/);
	assert.match(source, /单次 `read` 最多 500 行.*累计最多 5000 行/);
	assert.match(source, /active-tools 用于让模型看到当前阶段应使用的工具，但不是唯一授权边界/);
	assert.match(source, /非用户中断且 runtime 看到 `killed=true` 时按超时失败处理/);
	assert.match(source, /固定验证本身不再启动 reviewer 或依赖模型/);
	assert.match(source, /Package 已把“方案追问”内置/);
	assert.match(source, /满足严格低风险.*Tiny 默认不追问.*升级 Standard\/High-Risk/);
	assert.match(source, /### 技术方案图表/);
	assert.match(source, /当前保证六类图/);
	assert.match(source, /复杂流程不会全部塞进一张大图/);
	assert.match(source, /不使用 `mmdc`\/Chromium，不上传源码/);
	assert.match(source, /批准 solution 后.*create-only.*技术方案/);
	assert.match(source, /现场仍与 Package 上次同步 evidence 完全一致/);
	assert.match(source, /同目录临时文件和原子替换/);
	assert.match(source, /同内容替换.*保持只读并拒绝覆盖/);
	assert.match(source, /defaultTtlMs.*300000/s);
	assert.match(source, /## 常见恢复/);
	assert.ok(source.indexOf("## 第一次使用") < source.indexOf("## 维护者参考"));
	assert.doesNotMatch(source, /```adaptive-delivery-(?:documents|plan)/);
});
