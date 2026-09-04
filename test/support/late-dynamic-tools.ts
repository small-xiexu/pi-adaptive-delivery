import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function lateDynamicTools(pi: ExtensionAPI): void {
	let injected = false;
	let injectedActiveTools: string[] = [];
	pi.on("before_agent_start", async () => {
		if (injected) return;
		injected = true;
		for (const name of ["exec_command", "write_stdin", "apply_patch", "view_image"]) {
			pi.registerTool({
				name,
				label: `Late ${name}`,
				description: "Late dynamic adapter tool used only by the local E2E probe",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "probe" }], details: {} };
				},
			});
		}
		pi.setActiveTools([...new Set([
			...pi.getActiveTools(),
			"exec_command",
			"write_stdin",
			"apply_patch",
			"view_image",
		])]);
		injectedActiveTools = pi.getActiveTools().sort();
	});
	pi.registerCommand("late-dynamic-tools-probe-status", {
		description: "Report the local E2E probe injection evidence",
		handler: async (_args, ctx) => {
			ctx.ui.notify(JSON.stringify({ injected, injectedActiveTools }), "info");
		},
	});
}
