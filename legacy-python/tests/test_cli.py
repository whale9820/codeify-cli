import unittest

from codeify_cli.cli import build_parser, normalize_argv


class CliTests(unittest.TestCase):
    def test_direct_prompt_becomes_run(self) -> None:
        parsed = build_parser().parse_args(normalize_argv(["fix", "the", "tests"]))
        self.assertEqual(parsed.command, "run")
        self.assertEqual(parsed.prompt, ["fix", "the", "tests"])

    def test_global_options_stay_before_run(self) -> None:
        parsed = build_parser().parse_args(normalize_argv(["--model", "example", "fix", "tests"]))
        self.assertEqual(parsed.command, "run")
        self.assertEqual(parsed.model, "example")

    def test_named_command_is_unchanged(self) -> None:
        self.assertEqual(normalize_argv(["sessions", "list"]), ["sessions", "list"])

    def test_global_json_can_follow_command(self) -> None:
        parsed = build_parser().parse_args(normalize_argv(["doctor", "--json"]))
        self.assertTrue(parsed.json)

    def test_init_endpoint_stays_init_specific(self) -> None:
        parsed = build_parser().parse_args(normalize_argv(["init", "--endpoint", "https://example.test/v1", "--key", "secret"]))
        self.assertEqual(parsed.init_endpoint, "https://example.test/v1")


if __name__ == "__main__":
    unittest.main()
