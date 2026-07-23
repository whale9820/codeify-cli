import tempfile
import unittest
import os
from pathlib import Path

from codeify_cli.tools import ApprovalPolicy, ToolRegistry, is_read_only_command


class ToolRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary.name)
        self.registry = ToolRegistry(self.workspace, ApprovalPolicy("full-auto", interactive=False))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_write_read_edit_and_search(self) -> None:
        created = self.registry.execute("write_file", {"path": "src/app.py", "content": "name = 'old'\n"})
        self.assertTrue(created.ok)
        edited = self.registry.execute("edit_files", {"edits": [{"path": "src/app.py", "old_text": "old", "new_text": "new"}]})
        self.assertTrue(edited.ok)
        read = self.registry.execute("read_file", {"path": "src/app.py"})
        self.assertIn("name = 'new'", read.output)
        searched = self.registry.execute("search_files", {"query": "new", "path": "."})
        self.assertTrue(searched.ok)
        self.assertIn("src/app.py", searched.output)

    def test_path_escape_is_blocked(self) -> None:
        result = self.registry.execute("read_file", {"path": "/etc/hosts"})
        self.assertFalse(result.ok)
        self.assertIn("outside the workspace", result.output)

    def test_sensitive_file_is_blocked(self) -> None:
        self.workspace.joinpath(".env").write_text("TOKEN=secret\n", encoding="utf-8")
        result = self.registry.execute("read_file", {"path": ".env"})
        self.assertFalse(result.ok)
        self.assertIn("sensitive", result.output)

    def test_plan_mode_blocks_writes(self) -> None:
        registry = ToolRegistry(self.workspace, ApprovalPolicy("plan", interactive=False))
        result = registry.execute("write_file", {"path": "blocked.txt", "content": "no"})
        self.assertFalse(result.ok)
        self.assertFalse(self.workspace.joinpath("blocked.txt").exists())

    def test_dangerous_command_is_blocked(self) -> None:
        result = self.registry.execute("run_command", {"command": "sudo reboot"})
        self.assertFalse(result.ok)
        self.assertIn("blocked", result.output)

    def test_safe_command_classification_rejects_mutating_flags_and_external_paths(self) -> None:
        self.assertTrue(is_read_only_command("git status", self.workspace))
        self.assertFalse(is_read_only_command("sed -i '' file.txt", self.workspace))
        self.assertFalse(is_read_only_command("head /etc/passwd", self.workspace))
        self.assertFalse(is_read_only_command("git branch new-branch", self.workspace))

    def test_search_cannot_read_sensitive_file(self) -> None:
        self.workspace.joinpath("private.pem").write_text("secret-value\n", encoding="utf-8")
        result = self.registry.execute("search_files", {"query": "secret-value", "path": "."})
        self.assertNotIn("secret-value", result.output)

    def test_commands_do_not_inherit_secret_environment_variables(self) -> None:
        os.environ["CODEIFY_TEST_SECRET"] = "should-not-leak"
        try:
            result = self.registry.execute("run_command", {"command": "python3 -c 'import os; print(os.getenv(\"CODEIFY_TEST_SECRET\"))'"})
        finally:
            os.environ.pop("CODEIFY_TEST_SECRET", None)
        self.assertTrue(result.ok)
        self.assertEqual(result.output, "None")


if __name__ == "__main__":
    unittest.main()
