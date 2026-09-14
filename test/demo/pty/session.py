#!/usr/bin/env python3
"""真机终端验证的可复用底座：真实 PTY + 真实 `pi` CLI + 终端屏幕模拟。

只用标准库。被同目录的流程脚本（如 structured-full.py）导入使用，也可以单独当作
交互式会话控制器：

    python3 session.py <root> [--drive]

`--drive` 会在 <root>/ctrl 上轮询命令文件，支持的命令见下方 COMMANDS。

隔离原则（见 docs/技术方案.md 第 14 节）：临时 HOME / TMPDIR / agent dir；用户的
`auth.json`、`models-store.json`、`models.json`、`AGENTS.md` 只做**符号链接**，不复制
凭证。注意：链接进来的文件是**只读**的，任何脚本写入前必须先断开链接，否则会顺着
符号链接覆盖用户真实配置。
"""
import codecs
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import termios
import time

PACKAGE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PI = os.environ.get("PI_BIN") or shutil.which("pi") or "/opt/homebrew/bin/pi"
USER_AGENT = os.path.join(os.path.expanduser("~"), ".pi", "agent")
STRUCTURED_ADAPTER = os.environ.get("STRUCTURED_ADAPTER") or os.path.join(
    USER_AGENT, "npm", "node_modules", "@howaboua", "pi-codex-conversion")


class Screen:
    """够用的终端屏幕模拟：光标定位、擦除、滚动、CSI/OSC 序列。"""

    CSI = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z])")
    OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")

    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = self.col = 0
        self.pending = ""

    def _erase_line(self, mode):
        if mode in (0, None):
            for col in range(self.col, self.cols):
                self.grid[self.row][col] = " "
        elif mode == 2:
            self.grid[self.row] = [" "] * self.cols
        elif mode == 1:
            for col in range(0, min(self.col + 1, self.cols)):
                self.grid[self.row][col] = " "

    def _erase_display(self, mode):
        if mode == 2:
            self.grid = [[" "] * self.cols for _ in range(self.rows)]
        elif mode in (0, None):
            self._erase_line(0)
            for row in range(self.row + 1, self.rows):
                self.grid[row] = [" "] * self.cols
        elif mode == 1:
            self._erase_line(1)
            for row in range(0, self.row):
                self.grid[row] = [" "] * self.cols

    def _newline(self):
        self.row += 1
        if self.row >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
            self.row = self.rows - 1

    def _putc(self, char):
        if char == "\n":
            self._newline()
        elif char == "\r":
            self.col = 0
        elif char == "\b":
            self.col = max(0, self.col - 1)
        elif char == "\t":
            self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
        elif ord(char) < 32:
            return
        else:
            if self.col >= self.cols:
                self.col = 0
                self._newline()
            self.grid[self.row][self.col] = char
            self.col += 1

    def feed(self, text):
        data, self.pending = self.pending + text, ""
        index = 0
        while index < len(data):
            if data[index] != "\x1b":
                self._putc(data[index])
                index += 1
                continue
            osc = self.OSC.match(data, index)
            if osc:
                index = osc.end()
                continue
            csi = self.CSI.match(data, index)
            if csi:
                params = [int(p) for p in csi.group(1).replace("?", "").split(";") if p.isdigit()]
                self._control(csi.group(2), params)
                index = csi.end()
                continue
            if data[index:index + 2] == "\x1b]" or len(data) - index <= 2:
                self.pending = data[index:]
                return
            index += 3 if data[index + 1] in "()[]#%" else 2

    def _control(self, final, params):
        first = params[0] if params else None
        if final in ("H", "f"):
            self.row = max(0, min(self.rows - 1, (params[0] if params else 1) - 1))
            self.col = max(0, min(self.cols - 1, (params[1] if len(params) > 1 else 1) - 1))
        elif final == "A":
            self.row = max(0, self.row - (first or 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (first or 1))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + (first or 1))
        elif final == "D":
            self.col = max(0, self.col - (first or 1))
        elif final == "E":
            self.row = min(self.rows - 1, self.row + (first or 1))
            self.col = 0
        elif final == "F":
            self.row = max(0, self.row - (first or 1))
            self.col = 0
        elif final == "G":
            self.col = max(0, min(self.cols - 1, (first or 1) - 1))
        elif final == "d":
            self.row = max(0, min(self.rows - 1, (first or 1) - 1))
        elif final == "J":
            self._erase_display(first)
        elif final == "K":
            self._erase_line(first)
        elif final == "S":
            self.grid = self.grid[(first or 1):] + [[" "] * self.cols for _ in range(first or 1)]
        elif final == "T":
            self.grid = [[" "] * self.cols for _ in range(first or 1)] + self.grid[: -(first or 1)]

    def snapshot(self):
        lines = ["".join(row).rstrip() for row in self.grid]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)


class Driver:
    """真实 PTY 上的 pi 会话；按键与文本都必须**慢慢发**（见 README）。"""

    def __init__(self, cwd, env, rows=50, cols=100):
        self.screen = Screen(rows, cols)
        self.raw = bytearray()
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.closed = False
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execve(PI, [PI], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, quiet=0.5, timeout=3.0):
        """读到安静为止；返回时屏幕已包含这段时间的全部输出。"""
        deadline, last = time.time() + timeout, time.time()
        while time.time() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if ready:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    self.closed = True
                    return
                if not data:
                    self.closed = True
                    return
                self.raw += data
                self.screen.feed(self.decoder.decode(data))
                last = time.time()
            elif time.time() - last >= quiet:
                return

    def write(self, text):
        """带超时写入：子进程忙时不读 stdin，直接 os.write 可能永久阻塞。"""
        data = text.encode("utf-8")
        while data:
            _, writable, _ = select.select([], [self.fd], [], 3.0)
            if not writable:
                raise TimeoutError("PTY 写入超时（子进程未读取输入）")
            data = data[os.write(self.fd, data[:256]):]

    def transcript(self, footer_rows=4):
        """去掉底部状态栏/页脚后的正文：用于判断“回合是否结束”。

        插件会每 15 秒刷新页脚（token 计数、spinner），只看原始字节永远等不到静止。
        """
        lines = self.screen.snapshot().splitlines()
        return "\n".join(lines[: max(0, len(lines) - footer_rows)])

    def wait_for(self, pattern, timeout=300, quiet=0.5):
        deadline = time.time() + timeout
        while time.time() < deadline and not self.closed:
            self.pump(quiet=quiet, timeout=1.5)
            if re.search(pattern, self.screen.snapshot()):
                return True
        return False

    def wait_quiet(self, seconds, timeout=1800, footer_rows=4):
        """正文连续 seconds 秒不变即认为回合结束。"""
        deadline, last, quiet_since = time.time() + timeout, self.transcript(footer_rows), time.time()
        while time.time() < deadline and not self.closed:
            self.pump(quiet=0.5, timeout=1.5)
            now = self.transcript(footer_rows)
            if now != last:
                last, quiet_since = now, time.time()
            elif time.time() - quiet_since >= seconds:
                return True
        return False

    def close(self):
        try:
            os.kill(self.pid, 9)
        except ProcessLookupError:
            pass


def build(root, model="openai/gpt-5.6-sol", thinking="medium"):
    """准备隔离 agent dir 并返回子进程环境变量。"""
    os.makedirs(os.path.join(root, "home"), exist_ok=True)
    agent = os.path.join(root, "agent")
    os.makedirs(agent, exist_ok=True)
    files = ["auth.json", "models-store.json", "AGENTS.md"]
    if not os.environ.get("PROBE_BASEURL"):
        files.append("models.json")
    for name in files:
        source = os.path.join(USER_AGENT, name)
        if os.path.exists(source):
            os.symlink(source, os.path.join(agent, name))
    provider, model_id = model.split("/")
    adapter = os.environ.get("STRUCTURED_ADAPTER")
    if os.environ.get("PROBE_BASEURL"):
        with open(os.path.join(agent, "models.json"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"providers": {provider: {"baseUrl": os.environ["PROBE_BASEURL"]}}}))
    settings = {
        "packages": [adapter, PACKAGE] if adapter else [PACKAGE],
        "defaultProvider": provider,
        "defaultModel": model_id,
        "defaultThinkingLevel": thinking,
        "compaction": {"enabled": True},
        "httpIdleTimeoutMs": int(os.environ.get("IDLE_MS", "60000")),
        "retry": {"enabled": True, "maxRetries": 2},
    }
    if adapter:
        settings["defaultTools"] = ["read", "bash", "write", "edit", "grep", "find", "ls"]
        with open(os.path.join(agent, "pi-codex-conversion.json"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"executionMode": "normal", "voiceFeaturesOnly": False,
                "scope": {"allProviders": "on", "additionalProviders": []}, "voice": {"audioSetupCompleted": True},
                "openai": {"forceCachedWebSockets": False, "cacheKeepalive": False, "lunaCacheKeepaliveMinutes": 0, "verbosity": "low"}}))
    with open(os.path.join(agent, "settings.json"), "w", encoding="utf-8") as handle:
        handle.write(json.dumps(settings, indent=2))
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME", "TZ")}
    env.update({"HOME": os.path.join(root, "home"), "TMPDIR": root, "PI_CODING_AGENT_DIR": agent,
        "TERM": "xterm-256color", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
        "LC_ALL": "en_US.UTF-8", "LANG": "en_US.UTF-8"})
    return env


def project(root):
    """建一个可跑的 demo 仓库（订单结算服务）并提交基线。"""
    cwd = os.path.join(root, "repo")
    files = {
        "package.json": json.dumps({"name": "demo-order-service", "private": True, "type": "module", "version": "0.3.0"}, indent=2) + "\n",
        "AGENTS.md": "# demo 订单结算服务规则\n\n- 只在 `src/` 与 `test/` 下改动。\n- 金额一律以“分”为单位计算，对外返回元；禁止直接对元做浮点加减乘。\n- 检查统一执行 `node inputs/command.cjs`（它跑 node --test）。\n- 不提交、不推送、不发布。\n",
        "inputs/command.cjs": 'const { spawnSync } = require("node:child_process");\nconst env = { ...process.env };\ndelete env.NODE_TEST_CONTEXT;\nconst run = spawnSync(process.execPath, ["--test"], { stdio: "inherit", env });\nprocess.exit(run.status ?? 1);\n',
        "src/money.js": '/** 金额换算：对外用元，内部一律用分。 */\nexport function toCents(yuan) {\n  return Math.round(yuan * 100);\n}\n\nexport function toYuan(cents) {\n  return cents / 100;\n}\n\nexport function sumCents(values) {\n  return values.reduce((total, value) => total + toCents(value), 0);\n}\n',
        "src/discount.js": '/** 现有活动：满 100 减 10（以分为单位计算，返回分）。 */\nexport function fullReduction(cents) {\n  return cents >= 10000 ? cents - 1000 : cents;\n}\n',
        "src/cart.js": 'import { sumCents } from "./money.js";\n\n/** 购物车小计，入参为每件商品的价格（元）。 */\nexport function subtotal(prices) {\n  return sumCents(prices);\n}\n',
        "src/checkout.js": 'import { subtotal } from "./cart.js";\nimport { fullReduction } from "./discount.js";\nimport { toYuan } from "./money.js";\n\n/** 结算：小计（分）→ 满减 → 返回元。 */\nexport function checkout(prices) {\n  const cents = fullReduction(subtotal(prices));\n  return { cents, total: toYuan(cents) };\n}\n',
        "src/index.js": 'export { toCents, toYuan, sumCents } from "./money.js";\nexport { fullReduction } from "./discount.js";\nexport { subtotal } from "./cart.js";\nexport { checkout } from "./checkout.js";\n',
        "test/money.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { toCents, toYuan, sumCents } from "../src/money.js";\n\ntest("元与分互转", () => {\n  assert.equal(toCents(19.99), 1999);\n  assert.equal(toYuan(1999), 19.99);\n});\n\ntest("按分累加避免浮点误差", () => {\n  assert.equal(sumCents([0.1, 0.2]), 30);\n});\n',
        "test/discount.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { fullReduction } from "../src/discount.js";\n\ntest("满 100 减 10", () => {\n  assert.equal(fullReduction(10000), 9000);\n  assert.equal(fullReduction(12000), 11000);\n  assert.equal(fullReduction(9999), 9999);\n});\n',
        "test/cart.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { subtotal } from "../src/cart.js";\n\ntest("购物车小计以分为单位", () => {\n  assert.equal(subtotal([19.99, 0.01]), 2000);\n});\n',
        "test/checkout.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { checkout } from "../src/checkout.js";\n\ntest("120 元走满减", () => {\n  assert.deepEqual(checkout([120]), { cents: 11000, total: 110 });\n});\n\ntest("90 元不变", () => {\n  assert.deepEqual(checkout([90]), { cents: 9000, total: 90 });\n});\n',
    }
    for name, content in files.items():
        target = os.path.join(cwd, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if not os.path.exists(target):
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(content)
    os.makedirs(os.path.join(cwd, "docs"), exist_ok=True)
    if not os.path.isdir(os.path.join(cwd, ".git")):
        subprocess.run(["git", "init", "-q"], cwd=cwd, check=True)
    subprocess.run(["git", "add", "-A"], cwd=cwd, check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=cwd).returncode != 0:
        subprocess.run(["git", "-c", "user.name=Demo", "-c", "user.email=demo@example.invalid",
                        "commit", "-qm", "订单结算服务基线"], cwd=cwd, check=True)
    return cwd


COMMANDS = """
命令文件（每行一条，追加即可）：
  send <文本>        输入文本并回车
  raw <文本>         只输入文本，不回车
  key <转义序列>      注入按键（Python 转义，如 \\x1b[A、\\r）
  wait <秒> <正则>    等到屏幕匹配后抓屏
  settle <秒>        等安静后抓屏
  snap               立即抓屏
  beat               输出字节数与进程状态
  quit               结束会话
"""


def drive(root, control, out):
    env = build(root)
    cwd = project(root)
    driver = Driver(cwd, env)
    log = open(out, "a", encoding="utf-8")
    offset = 0
    while True:
        time.sleep(0.3)
        if not os.path.exists(control):
            driver.pump(quiet=0.3, timeout=0.5)
            continue
        with open(control, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
        for line in lines[offset:]:
            offset += 1
            if not line.strip():
                continue
            command, _, rest = line.partition(" ")
            if command == "send":
                driver.write(rest + "\r")
            elif command == "raw":
                driver.write(rest)
            elif command == "key":
                driver.write(rest.encode("utf-8").decode("unicode_escape"))
            elif command == "wait":
                seconds, _, pattern = rest.partition(" ")
                driver.wait_for(pattern, timeout=min(float(seconds), 300))
            elif command == "settle":
                driver.pump(quiet=float(rest or 2), timeout=float(rest or 2) * 3)
            elif command == "beat":
                continue
            elif command == "quit":
                break
            driver.pump(quiet=0.6, timeout=4)
            log.write(f"\n===== [{offset}] {line[:60]} =====\n{driver.screen.snapshot()}\n")
            log.flush()
        if offset > 4000 or any(line.strip() == "quit" for line in lines):
            break
    driver.close()
    log.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        print(COMMANDS)
        sys.exit(1)
    root_path = sys.argv[1]
    if "--drive" in sys.argv:
        drive(root_path, os.path.join(root_path, "ctrl"), os.path.join(root_path, "session.log"))
    else:
        env = build(root_path)
        cwd = project(root_path)
        driver = Driver(cwd, env)
        print(f"已启动隔离会话：{cwd}｜Ctrl+C 结束")
        try:
            while not driver.closed:
                driver.pump(quiet=0.5, timeout=2)
        except KeyboardInterrupt:
            pass
        finally:
            driver.close()
