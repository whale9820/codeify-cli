import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codeify_cli.config import load_config, save_config


class ConfigTests(unittest.TestCase):
    def test_config_environment_and_flags_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_dir = Path(directory)
            with patch.dict(os.environ, {"CODEIFY_CONFIG_DIR": directory}, clear=False):
                save_config({"model": "file-model", "api_key": "file-key"})
                with patch.dict(os.environ, {"CODEIFY_MODEL": "env-model", "CODEIFY_API_KEY": "env-key"}, clear=False):
                    config = load_config({"model": "flag-model"})
            self.assertEqual(config.model, "flag-model")
            self.assertEqual(config.api_key, "env-key")
            self.assertEqual(config_dir.joinpath("config.json").stat().st_mode & 0o777, 0o600)

    def test_api_key_is_redacted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"CODEIFY_CONFIG_DIR": directory, "CODEIFY_API_KEY": "codeify-secret-value"}, clear=False):
                config = load_config()
                serialized = json.dumps(config.as_dict())
            self.assertNotIn("codeify-secret-value", serialized)
            self.assertEqual(config.masked_api_key, "code...alue")

    def test_codeify_environment_wins_over_openai_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "CODEIFY_CONFIG_DIR": directory,
                "CODEIFY_API_KEY": "codeify-key",
                "OPENAI_API_KEY": "openai-key",
                "CODEIFY_BASE_URL": "https://codeify.test/v1",
                "OPENAI_BASE_URL": "https://openai.test/v1",
            }
            with patch.dict(os.environ, environment, clear=False):
                config = load_config()
            self.assertEqual(config.api_key, "codeify-key")
            self.assertEqual(config.endpoint, "https://codeify.test/v1")
            self.assertEqual(config.auth_source, "environment:CODEIFY_API_KEY")


if __name__ == "__main__":
    unittest.main()
