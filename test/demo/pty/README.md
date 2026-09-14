# 真机终端验证（PTY）

这些脚本用**真实 PTY + 真实 `pi` CLI + 真实模型**驱动交付流程，用来验证自动化测试覆盖不到的部分：面板渲染与按键、审批门的真实交互、子会话委派、退出与现场清理。它们**不属于** `npm test`（会调用真实模型并产生费用），需要手动运行。

| 文件 | 作用 |
|---|---|
| `session.py` | 可复用底座：PTY 会话 + 终端屏幕模拟、隔离 agent dir、demo 仓库生成 |
| `structured-full.py` | Structured 环境（`@howaboua/pi-codex-conversion`）下的完整流程：两次确认 → 委派开发 → 独立审查 → 返工 → 复审 → `/delivery-status` → `/delivery-tasks` → `/delivery-exit` |
| `gateway-proxy.mjs` | 停顿注入：第 1 个请求只发响应头后沉默，其余原样转发真网关，用于验证看门狗 |

## 运行

```bash
# 完整流程（隔离根目录可指定，不指定则用临时目录）
python3 test/demo/pty/structured-full.py /tmp/adaptive-pty-full

# 停顿注入 + 看门狗：先起代理，再让流程指向它
node test/demo/pty/gateway-proxy.mjs 8899 https://<你的网关> /tmp/gateway-proxy.log
DEMO_PROXY_BASEURL=http://127.0.0.1:8899 PI_ADAPTIVE_STALL_MS=15000 \
  python3 test/demo/pty/structured-full.py /tmp/adaptive-pty-stall
```

产物都在隔离根目录：`run.log`（分阶段屏幕 + 判定）、`heartbeat.log`（进度心跳）、`raw.bin`（原始字节）、`agent/sessions/**`（父子会话记录，核对 `delivery_*` 调用链的地方）。

隔离原则：临时 `HOME`/`TMPDIR`/agent dir，用户的 `auth.json`、`models-store.json`、`models.json`、`AGENTS.md` 只做**符号链接**，不复制凭证。

## 真机环境的两条硬经验

这两点曾让验证"看起来卡死"，实际都是插件 TUI 的输入处理，不是产品缺陷：

1. **不能在一个写入里连发按键。** 一次写入 4 个上键，插件 TUI 只处理第 1 个 → 光标停在「提出修改意见」并进入意见输入态，面板看起来像卡住。正确做法是**一次一个按键，按完立刻校验光标位置**（见 `structured-full.py` 的 `accept()`）。
2. **回车可能被吞。** 首次回车常常不提交，本次实测第 5 次才被接受。正确做法是回车后**校验会话记录是否生成**，不成就重发（见 `send()`）。

另外两点与产品无关但会影响验证：

3. **页脚会每 15 秒刷新**（token 计数、spinner），所以"等屏幕静止"不能看原始字节，要看**去掉底部页脚后的正文**（见 `Driver.transcript()` 与 `wait_quiet()`）。
4. **上游内容过滤会偶发误判**：同一段文本可能返回 `invalid_prompt`（不是本包的问题，Pi 也不会重试它）。验证脚本对这种情况会自动重投。

## 写入安全（重要）

`session.py::build()` 会把用户真实配置**符号链接**进隔离目录。**这些链接是只读的**：任何脚本要写 `models.json`、`settings.json` 之类同名文件，必须**先断开链接**再写，否则会顺着符号链接覆盖用户真实配置（历史事故见 `docs/实施计划.md` 第 13.116 节）。
