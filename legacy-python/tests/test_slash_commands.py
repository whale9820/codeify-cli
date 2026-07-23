import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from codeify_cli.config import Config
from codeify_cli.sessions import Session
from codeify_cli.slash_commands import handle_slash_command
from codeify_cli.terminal import Terminal


class SlashCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.terminal = Terminal(color=False)
        self.config = Config()

    def call(self, prompt: str, session: Session | None = None):
        output = io.StringIO()
        with redirect_stdout(output):
            result = handle_slash_command(prompt, session, self.config, self.terminal)
        self.config = result[1]
        return result, output.getvalue()

    def test_help_includes_pi_commands_and_reasoning(self) -> None:
        (_, output) = self.call("/help")
        for command in ("/settings", "/export", "/resume", "/reload", "/debug", "/reasoning [LEVEL]"):
            self.assertIn(command, output)

    def test_reasoning_setting_updates_runtime_config(self) -> None:
        (result, output) = self.call("/reasoning high")
        self.assertEqual(result[1].reasoning, "high")
        self.assertIn("Reasoning set to high", output)

    def test_export_import_and_compact_preserve_session_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            session = Session.create(workspace, "test-model", "https://example.test/v1", "first task")
            session.add_message("assistant", "completed the first task")
            session_store_dir = workspace / "sessions"
            export_path = workspace / "session.jsonl"
            with patch.dict(os.environ, {"CODEIFY_CONFIG_DIR": str(session_store_dir)}):
                self.config = Config(workspace=workspace)
                with redirect_stdout(io.StringIO()):
                    handle_slash_command(f"/export {export_path}", session, self.config, self.terminal)
                    imported, _, _ = handle_slash_command(f"/import {export_path}", None, self.config, self.terminal)
                self.assertIsNotNone(imported)
                self.assertEqual(Path(imported.workspace).resolve(), workspace.resolve())
                with redirect_stdout(io.StringIO()):
                    compacted, _, _ = handle_slash_command("/compact keep the recent decisions", imported, self.config, self.terminal)
                self.assertIs(compacted, imported)
                self.assertIsNone(imported.response_id)
                self.assertIn("recent decisions", imported.replay_input[0]["content"])


if __name__ == "__main__":
    unittest.main()
