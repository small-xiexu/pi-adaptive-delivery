// 停顿注入用的本地转发代理：第 1 个请求只发响应头后沉默（模拟 provider 停顿），
// 其余请求原样转发到真网关。用于验证停顿看门狗在真实模型 + 真实网关下的行为。
//
//   node test/demo/pty/gateway-proxy.mjs <端口> <上游 baseUrl> [日志文件]
//
// 然后把 provider 指过来，例如 demo 脚本的 DEMO_PROXY_BASEURL=http://127.0.0.1:8899。
// 不读取、不打印任何凭证：Authorization 等请求头原样透传。
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 8899);
const target = process.argv[3] ?? "https://sub2api.shelfcanvas.top";
const logFile = process.argv[4] ?? "gateway-proxy.log";
let stalled = false;
const log = (text) => appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);

createServer(async (request, response) => {
	if (!stalled) {
		stalled = true;
		log(`第 1 个请求 ${request.method} ${request.url} → 【沉默】`);
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.flushHeaders();
		return;
	}
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const headers = { ...request.headers };
	delete headers.host;
	delete headers["content-length"];
	delete headers["accept-encoding"];
	const started = Date.now();
	try {
		const upstream = await fetch(target + request.url, {
			method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
		log(`转发 ${request.method} ${request.url} → ${upstream.status}${upstream.headers.get("content-type")?.includes("event-stream") ? " (stream)" : ""}`);
		response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
		let bytes = 0;
		for await (const chunk of upstream.body) { bytes += chunk.length; response.write(chunk); }
		response.end();
		log(`  ↑ 完成 ${Date.now() - started}ms，${bytes} 字节`);
	} catch (error) {
		log(`  ↑ 失败 ${String(error)}`);
		response.writeHead(502, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: String(error) } }));
	}
}).listen(port, "127.0.0.1", () => log(`代理启动 http://127.0.0.1:${port} → ${target}`));
