#!/usr/bin/env python3
"""Screen 模拟器的终端 alternate screen 回归测试。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from session import Screen  # noqa: E402


class ScreenAlternateBufferTests(unittest.TestCase):
    def test_alternate_screen_isolated_from_primary_screen(self):
        screen = Screen(6, 30)
        screen.feed("normal screen")

        screen.feed("\x1b[?1049h")
        screen.feed("方案审阅\n↑↓ 选择 · Enter 确定 · Esc 暂停")
        self.assertIn("方案审阅", screen.snapshot())
        self.assertNotIn("normal screen", screen.snapshot())

        screen.feed("\x1b[?1049l")
        self.assertEqual(screen.snapshot(), "normal screen")

    def test_alternate_screen_handles_1047_alias(self):
        screen = Screen(4, 20)
        screen.feed("primary")
        screen.feed("\x1b[?1047h")
        screen.feed("panel")
        self.assertEqual(screen.snapshot(), "panel")

        screen.feed("\x1b[?1047l")
        self.assertEqual(screen.snapshot(), "primary")


if __name__ == "__main__":
    unittest.main()
