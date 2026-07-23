import json
import unittest

from codeify_cli.api import parse_sse


class ParseSseTests(unittest.TestCase):
    def test_parses_named_and_default_events(self) -> None:
        lines = iter([
            b"event: response.output_text.delta\n",
            b'data: {"type":"response.output_text.delta","delta":"hi"}\n',
            b"\n",
            b'data: {"type":"response.completed","response":{"id":"resp_1"}}\n',
            b"\n",
            b"data: [DONE]\n",
            b"\n",
        ])
        events = list(parse_sse(lines))
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].event, "response.output_text.delta")
        self.assertEqual(events[0].data["delta"], "hi")
        self.assertEqual(events[1].data["response"]["id"], "resp_1")

    def test_supports_multiline_data(self) -> None:
        value = {"hello": "world"}
        raw = json.dumps(value)
        events = list(parse_sse(iter([f"data: {raw}\n".encode(), b"\n"])))
        self.assertEqual(events[0].data, value)


if __name__ == "__main__":
    unittest.main()
