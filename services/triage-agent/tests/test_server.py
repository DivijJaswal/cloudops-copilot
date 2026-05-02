import contextlib
import io
import json
import os
import unittest

os.environ["ENABLE_LLM_TRIAGE"] = "false"

try:
    from app.server import app  # noqa: E402
except ModuleNotFoundError as exc:
    if exc.name != "flask" or os.getenv("CLOUDOPS_REQUIRE_TRIAGE_DEPS") == "true":
        raise
    app = None


@unittest.skipIf(app is None, "Flask is not installed in this Python environment")
class ServerTest(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["ACCESS_LOGS"] = False

    def tearDown(self):
        app.config.pop("ACCESS_LOGS", None)

    def test_triage_echoes_request_id(self):
        with app.test_client() as client:
            response = client.post(
                "/triage",
                json={
                    "incident": {
                        "id": "INC-AGENT",
                        "service": "triage-agent",
                        "title": "Request id propagation",
                        "severity": "SEV3",
                        "signals": [],
                        "logs": []
                    },
                    "runbooks": []
                },
                headers={"x-request-id": "req-agent-123"}
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Request-Id"], "req-agent-123")
        self.assertEqual(response.get_json()["requestId"], "req-agent-123")

    def test_health_reports_triage_orchestration(self):
        with app.test_client() as client:
            response = client.get("/health", headers={"x-request-id": "req-health"})

        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertIn(payload["triageOrchestration"], {"langgraph", "linear-compat"})

    def test_triage_returns_structured_json_for_bad_payloads(self):
        with app.test_client() as client:
            malformed_response = client.post(
                "/triage",
                data="{",
                content_type="application/json",
                headers={"x-request-id": "req-bad-json"}
            )
            non_object_response = client.post(
                "/triage",
                json=[],
                headers={"x-request-id": "req-bad-shape"}
            )

        malformed_payload = malformed_response.get_json()
        non_object_payload = non_object_response.get_json()

        self.assertEqual(malformed_response.status_code, 400)
        self.assertEqual(malformed_response.headers["X-Request-Id"], "req-bad-json")
        self.assertEqual(malformed_payload["error"], "invalid_json")
        self.assertEqual(malformed_payload["requestId"], "req-bad-json")

        self.assertEqual(non_object_response.status_code, 400)
        self.assertEqual(non_object_response.headers["X-Request-Id"], "req-bad-shape")
        self.assertEqual(non_object_payload["error"], "invalid_request")
        self.assertEqual(non_object_payload["requestId"], "req-bad-shape")

    def test_unknown_routes_return_structured_json(self):
        with app.test_client() as client:
            response = client.get("/missing", headers={"x-request-id": "req-missing"})

        payload = response.get_json()

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.headers["X-Request-Id"], "req-missing")
        self.assertEqual(payload["error"], "not_found")
        self.assertEqual(payload["requestId"], "req-missing")

    def test_access_log_includes_request_id(self):
        app.config["ACCESS_LOGS"] = True
        output = io.StringIO()

        with app.test_client() as client:
            with contextlib.redirect_stdout(output):
                response = client.get("/health?token=secret", headers={"x-request-id": "req-agent-log"})

        payload = json.loads(output.getvalue().strip())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["event"], "http_request")
        self.assertEqual(payload["requestId"], "req-agent-log")
        self.assertEqual(payload["method"], "GET")
        self.assertEqual(payload["route"], "/health")
        self.assertEqual(payload["path"], "/health")
        self.assertNotIn("secret", json.dumps(payload))
        self.assertEqual(payload["status"], 200)
        self.assertIsInstance(payload["durationMs"], float)

    def test_unknown_route_access_log_uses_bounded_route_label(self):
        app.config["ACCESS_LOGS"] = True
        output = io.StringIO()

        with app.test_client() as client:
            with contextlib.redirect_stdout(output):
                response = client.get("/missing/path?token=secret", headers={"x-request-id": "req-agent-missing"})

        payload = json.loads(output.getvalue().strip())

        self.assertEqual(response.status_code, 404)
        self.assertEqual(payload["route"], "unmatched")
        self.assertEqual(payload["path"], "/missing/path")
        self.assertNotIn("secret", json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
