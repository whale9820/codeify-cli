import tempfile
import unittest
from pathlib import Path

from codeify_cli.sessions import Session, SessionStore


class SessionStoreTests(unittest.TestCase):
    def test_round_trip_and_prefix_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = SessionStore(Path(directory))
            session = Session.create(Path(directory), "test-model", "http://example.test/v1", "Fix all tests")
            session.add_message("user", "Fix all tests")
            session.response_id = "resp_123"
            store.save(session)
            loaded = store.load(session.id[:6])
            self.assertEqual(loaded.id, session.id)
            self.assertEqual(loaded.response_id, "resp_123")
            self.assertEqual(store.list()[0].title, "Fix all tests")


if __name__ == "__main__":
    unittest.main()
