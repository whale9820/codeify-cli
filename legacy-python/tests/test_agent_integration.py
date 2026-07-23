import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from codeify_cli.agent import CodingAgent
from codeify_cli.config import Config
from codeify_cli.sessions import Session, SessionStore
from codeify_cli.terminal import Terminal


class FakeResponsesHandler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, format, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length))
        self.__class__.requests.append(payload)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if len(self.__class__.requests) == 1:
            response = {
                "id": "resp_tool",
                "output": [{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file", "arguments": json.dumps({"path": "hello.txt"})}],
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            }
        else:
            response = {
                "id": "resp_final",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "The file says hello."}]}],
                "usage": {"input_tokens": 8, "output_tokens": 4, "total_tokens": 12},
            }
            delta = {"type": "response.output_text.delta", "delta": "The file says hello."}
            self.wfile.write(f"event: response.output_text.delta\ndata: {json.dumps(delta)}\n\n".encode())
        completed = {"type": "response.completed", "response": response}
        self.wfile.write(f"event: response.completed\ndata: {json.dumps(completed)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


class AgentIntegrationTests(unittest.TestCase):
    def test_tool_loop_uses_previous_response_id(self) -> None:
        FakeResponsesHandler.requests = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeResponsesHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as workspace_dir, tempfile.TemporaryDirectory() as sessions_dir:
                workspace = Path(workspace_dir)
                workspace.joinpath("hello.txt").write_text("hello\n", encoding="utf-8")
                config = Config(api_key="test-key", endpoint=f"http://127.0.0.1:{server.server_port}/v1", model="test-model", workspace=workspace, approval="full-auto")
                agent = CodingAgent(config, Terminal(color=False, quiet=True), SessionStore(Path(sessions_dir)), interactive=False)
                result = agent.run("Read hello.txt")
            self.assertEqual(result.text, "The file says hello.")
            self.assertEqual(result.response_id, "resp_final")
            self.assertEqual(len(result.tool_calls), 1)
            self.assertEqual(FakeResponsesHandler.requests[1]["previous_response_id"], "resp_tool")
            tool_output = FakeResponsesHandler.requests[1]["input"][0]
            self.assertEqual(tool_output["call_id"], "call_1")
            self.assertIn("hello", tool_output["output"])
        finally:
            server.shutdown()
            server.server_close()

    def test_compacted_session_replays_context_when_store_is_enabled(self) -> None:
        FakeResponsesHandler.requests = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeResponsesHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as workspace_dir, tempfile.TemporaryDirectory() as sessions_dir:
                workspace = Path(workspace_dir)
                workspace.joinpath("hello.txt").write_text("hello\n", encoding="utf-8")
                config = Config(api_key="test-key", endpoint=f"http://127.0.0.1:{server.server_port}/v1", model="test-model", workspace=workspace, approval="full-auto")
                compacted = Session.create(workspace, "test-model", config.endpoint)
                compacted.replay_input = [{"role": "user", "content": "compacted repository context"}]
                agent = CodingAgent(config, Terminal(color=False, quiet=True), SessionStore(Path(sessions_dir)), interactive=False)
                agent.run("Continue from the compacted context", session=compacted)
            first_input = FakeResponsesHandler.requests[0]["input"]
            self.assertEqual(first_input[0]["content"], "compacted repository context")
            self.assertEqual(first_input[1]["content"], "Continue from the compacted context")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
