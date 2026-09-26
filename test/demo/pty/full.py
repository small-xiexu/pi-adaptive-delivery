#!/usr/bin/env python3
"""原生 Pi + 真机终端的完整交付流程验证（一次方案确认并开始实施、开发、审查、返工、退出）。

用法：
    python3 test/demo/pty/full.py [隔离根目录]

环境变量：
    DEMO_MODEL        默认 openai/gpt-5.6-sol
    DEMO_THINKING     默认 medium
    PI_ADAPTIVE_STALL_MS  子会话里停顿看门狗的阈值（默认产品值 120 秒；验证时常设 15000）

会在隔离根目录下生成 run.log（分阶段屏幕 + 判定）、heartbeat.log（进度心跳）、raw.bin（原始字节）。

真机环境三条硬经验（都已在代码里处理，改动前请先读 test/demo/pty/README.md）：
  1. Pi TUI 会吞掉**同一写入里的连续按键** —— 面板导航必须一次一个键并校验光标；
  2. Pi TUI 会吞回车 —— 提交后必须校验会话记录是否生成，不成就重发；
  3. Pi TUI 会切换 alternate screen —— 屏幕模拟器必须隔离临时缓冲区与主缓冲区，不能把旧面板文字当成当前状态。
"""
import json
import os
import re
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("IDLE_MS", "60000")
import session as S  # noqa: E402

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "adaptive-pty-full")
COLS, ROWS = 100, 50
MODEL = os.environ.get("DEMO_MODEL", "openai/gpt-5.6-sol")
THINKING = os.environ.get("DEMO_THINKING", "medium")
LOG = os.path.join(ROOT, "run.log")
HEART = os.path.join(ROOT, "heartbeat.log")
TASK = ("/delivery-shape 把满减门槛从 100 改成 120（其余规则不变），补测试；实现交给 delivery_develop 委派给开发子会话；"
        "完成后安排一次独立代码审查。检查跑 node inputs/command.cjs。")
APPROVE_LABELS = ("确认方案", "批准实施", "确认实施", "Yes")
OTHER_LABELS = ("提出修改意见", "稍后再看", "暂不批准", "No")
SELECTOR_FOOTER_MARKERS = ("↑↓", "up/down")
BASELINE_SESSIONS = set()


def log(text):
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(f"{text}\n")
        handle.flush()


def heart(text):
    with open(HEART, "a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%H:%M:%S')} {text}\n")


def screen():
    return driver.screen.snapshot()


def count_sessions():
    return len(session_files())


def session_files():
    sessions = os.path.join(ROOT, "agent", "sessions")
    paths = []
    if not os.path.isdir(sessions):
        return paths
    for directory, _, files in os.walk(sessions):
        paths.extend(os.path.join(directory, name) for name in files if name.endswith(".jsonl"))
    return paths


def custom_records():
    for path in session_files():
        if path in BASELINE_SESSIONS:
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if record.get("type") == "custom":
                        yield record
        except OSError:
            continue


def has_custom_record(custom_type, predicate=None):
    for record in custom_records():
        if record.get("customType") != custom_type:
            continue
        data = record.get("data", {})
        if predicate is None or predicate(data):
            return True
    return False


def wait_for_record(custom_type, timeout=180, note=""):
    deadline = time.time() + timeout
    while time.time() < deadline and not driver.closed:
        driver.pump(quiet=0.5, timeout=1.5)
        if has_custom_record(custom_type):
            log(f"[Session 记录命中] {note or custom_type}")
            return True
    log(f"[Session 记录超时] {note or custom_type}")
    return False


def has_exit_record():
    return has_custom_record("delivery-activation", lambda data: data.get("enabled") is False)


def wait_for_exit(timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline and not driver.closed:
        driver.pump(quiet=0.5, timeout=1.5)
        if has_exit_record() or re.search(r"交付未启用|交付已退出|请先用 /delivery-shape", screen()):
            return True
    log(f"[退出记录超时] 当前 Session 未出现 delivery-activation enabled=false\n{screen()}")
    return False


def selector_footer_visible(text):
    lines = text.splitlines()
    footer_start = max(0, len(lines) - 8)
    for index, line in enumerate(lines):
        normalized = line.lower()
        has_navigation = any(marker in normalized for marker in SELECTOR_FOOTER_MARKERS)
        has_confirmation = "enter" in normalized or "回车" in line or "确认" in line
        if index >= footer_start and has_navigation and has_confirmation:
            return True
    return False


def wait_for(pattern, timeout=300, note=""):
    """等待屏幕匹配，期间每 15 秒记一次心跳（正文与字节都不动即视为停滞）。"""
    deadline, beat, last_bytes, last_transcript, stalled = time.time() + timeout, time.time(), len(driver.raw), driver.transcript(), None
    while time.time() < deadline and not driver.closed:
        driver.pump(quiet=0.5, timeout=1.5)
        if re.search(pattern, screen()):
            log(f"[命中 {time.strftime('%H:%M:%S')}] {note or pattern}")
            return True
        if time.time() - beat > 15:
            now, transcript = len(driver.raw), driver.transcript()
            if now == last_bytes and transcript == last_transcript:
                stalled = stalled or time.time()
                heart(f"{note or pattern} 停滞 {int(time.time() - stalled)} 秒（字节 {now}）")
                tail = [line for line in screen().splitlines() if line.strip()][-8:]
                heart("  屏幕尾部：" + "\n    ".join(line.rstrip()[:140] for line in tail))
            else:
                if stalled:
                    heart(f"{note or pattern} 恢复流动（停滞 {int(time.time() - stalled)} 秒）")
                    stalled = None
                heart(f"{note or pattern} 字节 {now}")
            last_bytes, last_transcript, beat = now, transcript, time.time()
    log(f"[超时 {time.strftime('%H:%M:%S')}] {note or pattern}")
    log(screen())
    return False


def send(text, expect_session=True, confirmation=None):
    """写入文本并回车；按 Session 或当前 UI 反馈确认回车确实生效。"""
    before = count_sessions()
    driver.write(text)
    driver.pump(quiet=0.6, timeout=4)
    for attempt in range(1, 6):
        driver.write("\r")
        driver.pump(quiet=1.0, timeout=5)
        if confirmation is not None and confirmation():
            log(f"  提交成功（第 {attempt} 次回车，当前反馈已确认）")
            return True
        if not expect_session:
            continue
        if count_sessions() > before:
            log(f"  提交成功（第 {attempt} 次回车后）")
            return True
        log(f"  第 {attempt} 次回车后仍未提交，重发回车")
    log("  提交失败：多次回车未取得提交确认")
    return False


def panel_state():
    """返回（当前选择器是否可见、光标所在标签、是否误入意见输入态）。"""
    text = screen()
    if not selector_footer_visible(text):
        return False, None, False
    editing = "你希望怎么改" in text or "Enter 发送意见" in text
    picked, labels = None, []
    for line in text.splitlines():
        for label in APPROVE_LABELS + OTHER_LABELS:
            if label in line:
                labels.append(label)
                if "→" in line:
                    picked = label
    return bool(labels), picked, editing


def accept(label=""):
    """面板按键：一次一个，按完立即校验光标；以 Session/通知确认提交结果。"""
    driver.wait_quiet(6, timeout=180)
    for _ in range(14):
        visible, picked, editing = panel_state()
        if editing:
            driver.write("\x1b")
            driver.pump(quiet=0.6, timeout=4)
            log(f"  {label}: 误入意见输入态 → 按 Esc 返回（可见={panel_state()[0]}）")
            continue
        if not visible:
            log(f"  {label}: 当前选择器不可见")
            return False
        if picked and any(word in picked for word in APPROVE_LABELS):
            driver.write("\r")
            driver.pump(quiet=1.0, timeout=6)
            if label == "方案审阅":
                return wait_for_record("delivery-approval", timeout=120, note="方案批准")
            if label == "unlock":
                return wait_for(r"已强制清理|现场已变化|未清理", timeout=90, note="unlock 结果")
            visible2, picked2, editing2 = panel_state()
            log(f"  {label}: 在「{picked}」按回车 → 可见={visible2}｜光标={picked2}｜意见态={editing2}")
            if not visible2:
                return True
            continue
        driver.write("\x1b[A")
        driver.pump(quiet=0.6, timeout=4)
        visible2, picked2, editing2 = panel_state()
        log(f"  {label}: 按上键 → 可见={visible2}｜光标={picked2}｜意见态={editing2}")
    return False


os.makedirs(ROOT, exist_ok=True)
log(f"\n########## 原生 Pi 真机终端全程 · {time.strftime('%F %T')} · root={ROOT} · {COLS}x{ROWS} · {MODEL} ##########")
env = S.build(ROOT, MODEL, THINKING)
env["PI_ADAPTIVE_STALL_MS"] = os.environ.get("PI_ADAPTIVE_STALL_MS", "15000")
cwd = S.project(ROOT)
BASELINE_SESSIONS.update(session_files())
log(f"工作区 {cwd}｜原生 Pi｜看门狗阈值 {env['PI_ADAPTIVE_STALL_MS']}ms")
log("settings: " + open(os.path.join(ROOT, "agent", "settings.json"), encoding="utf-8").read())
driver = S.Driver(cwd, env, ROWS, COLS)
try:
    heart("会话启动")
    submitted = False
    submission_feedback = lambda: panel_state()[0] or "invalid_prompt" in screen() or re.search(r"\bWorking\b|\bThinking\b|处理中|思考中", screen()) is not None
    for attempt in range(1, 4):
        if not send(TASK, expect_session=False, confirmation=submission_feedback):
            break
        deadline, outcome = time.time() + 300, "超时"
        while time.time() < deadline:
            driver.pump(quiet=0.6, timeout=1.5)
            if panel_state()[0]:
                outcome = "面板"
                break
            if "invalid_prompt" in screen():
                outcome = "内容过滤"
                break
        log(f"第 {attempt} 次提交结果：{outcome}（{time.strftime('%H:%M:%S')}）")
        if outcome == "面板":
            submitted = True
            break
        if outcome == "内容过滤":
            driver.wait_quiet(10, timeout=120)   # 等这一回合收尾再重投（上游偶发误判）
            continue
        break
    if not submitted:
        log("=== 未能进入方案审阅面板，结束 ===\n" + screen()[-1500:])
        raise SystemExit(0)
    log("=== 方案审阅面板 ===\n" + screen())
    if not accept("方案审阅"):
        log("=== 方案批准未形成 Session 记录，结束 ===")
        raise SystemExit(1)
    log("=== 已确认方案并开始实施 ===")
    driver.wait_quiet(90, timeout=2400)      # 开发 + 审查跑完且正文静止
    log("=== 正文静止后的屏幕 ===\n" + screen())
    heart("回合结束")
    for command, pattern in (("/delivery-status", r"当前阶段"), ("/delivery-tasks", r"子任务详情|还没有交付子任务")):
        send(command, expect_session=False, confirmation=lambda pattern=pattern: re.search(pattern, screen()) is not None)
        wait_for(pattern, timeout=90, note=command)
        log(f"=== {command} ===\n" + screen())
        if command == "/delivery-tasks":
            driver.write("\x1b")
            driver.pump(quiet=0.5, timeout=3)
    exit_feedback = r"交付已退出|交付未启用|请先用 /delivery-shape|仍有执行或排队消息|暂不能退出"
    send("/delivery-exit", expect_session=False, confirmation=lambda: has_exit_record() or re.search(exit_feedback, screen()) is not None)
    if not wait_for_exit(timeout=120):
        log("首次退出未形成收尾记录，等待回合完全空闲后重试；不自动调用 /delivery-unlock")
        driver.wait_quiet(15, timeout=180)
        send("/delivery-exit", expect_session=False, confirmation=lambda: has_exit_record() or re.search(exit_feedback, screen()) is not None)
        if not wait_for_exit(timeout=120):
            log("退出重试仍未形成收尾记录，保留现场并结束驱动器；需要人工核对原 Session")
    log("=== 最终屏幕 ===\n" + screen())
finally:
    with open(os.path.join(ROOT, "raw.bin"), "wb") as handle:
        handle.write(bytes(driver.raw))
    heart("会话结束")
    log(f"########## 结束 · 原始字节 {len(driver.raw)} · 子进程退出={driver.closed} ##########")
    driver.close()
