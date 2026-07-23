import io
import os
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from codeify_cli.api import StreamEvent
from codeify_cli.terminal import Terminal


class TerminalTests(unittest.TestCase):
    def test_pi_style_banner_uses_compact_startup_surface(self) -> None:
        terminal = Terminal(color=False)
        output = io.StringIO()
        with redirect_stdout(output):
            terminal.banner("gpt-5.6-sol", "/tmp/project", "high")
        rendered = output.getvalue()
        self.assertIn("codeify v", rendered)
        self.assertIn("ctrl+c/ctrl+d", rendered)
        self.assertIn("/ commands", rendered)
        self.assertIn("! bash", rendered)
        self.assertIn("gpt-5.6-sol • high", rendered)

    def test_user_prompt_propagates_keyboard_interrupt(self) -> None:
        terminal = Terminal(color=False)
        with patch("builtins.input", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                terminal.user_prompt()

    def test_footer_right_aligns_model_like_pi(self) -> None:
        terminal = Terminal(color=False)
        output = io.StringIO()
        with patch("codeify_cli.terminal.shutil.get_terminal_size", return_value=os.terminal_size((40, 24))):
            with redirect_stdout(output):
                terminal.footer("/tmp/project", "gpt-5.6-sol", "high")
        status = output.getvalue().splitlines()[1]
        self.assertEqual(len(status), 40)
        self.assertTrue(status.startswith("0.0%/128k"))
        self.assertTrue(status.endswith("gpt-5.6-sol • high"))

    def test_streaming_text_has_no_chat_role_prefix(self) -> None:
        terminal = Terminal(color=False)
        output = io.StringIO()
        with redirect_stdout(output):
            terminal.on_stream_event(StreamEvent("message", {"type": "response.output_text.delta", "delta": "hello"}))
            terminal.end_stream()
        self.assertEqual(output.getvalue(), " hello\n")


if __name__ == "__main__":
    unittest.main()
