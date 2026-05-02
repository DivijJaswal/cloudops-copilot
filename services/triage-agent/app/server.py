import json
import os
import re
import time
import uuid

from flask import Flask, g, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import BadRequest, HTTPException

try:
    from .ollama_client import OllamaClient
    from .triage import triage_incident, triage_orchestration_engine
    from .triage_memory import PgTriageMemory
except ImportError:
    from ollama_client import OllamaClient
    from triage import triage_incident, triage_orchestration_engine
    from triage_memory import PgTriageMemory

app = Flask(__name__)
CORS(app)

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

llm_client = None
triage_memory = None


def llm_triage_enabled():
    return os.getenv("ENABLE_LLM_TRIAGE", "true").lower() != "false"


if llm_triage_enabled():
    llm_client = OllamaClient()
    try:
        triage_memory = PgTriageMemory()
        triage_memory.init()
        try:
            triage_memory.seed(llm_client.embed)
        except Exception as exc:
            print(f"triage memory seed skipped: {exc}")
    except Exception as exc:
        triage_memory = None
        print(f"triage memory disabled: {exc}")


def request_id_from_header(value):
    if value and REQUEST_ID_PATTERN.match(value.strip()):
        return value.strip()
    return f"req-{uuid.uuid4()}"


def access_logs_enabled():
    configured = app.config.get("ACCESS_LOGS")
    if configured is not None:
        return bool(configured)
    if app.config.get("TESTING"):
        return False
    return os.getenv("ACCESS_LOGS", "true").lower() != "false"


def route_label():
    if request.url_rule is None:
        return "unmatched"
    return request.url_rule.rule


def safe_request_path():
    return request.path or "/"


def write_structured_log(level, event, **fields):
    record = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "event": event,
        **fields
    }
    print(json.dumps(record), flush=True)


@app.before_request
def attach_request_id():
    g.request_id = request_id_from_header(request.headers.get("x-request-id"))
    g.request_started_at = time.perf_counter()


@app.after_request
def add_request_id_header(response):
    response.headers["X-Request-Id"] = getattr(g, "request_id", f"req-{uuid.uuid4()}")
    if access_logs_enabled():
        write_structured_log(
            "info",
            "http_request",
            requestId=response.headers["X-Request-Id"],
            method=request.method,
            route=route_label(),
            path=safe_request_path(),
            status=response.status_code,
            durationMs=round((time.perf_counter() - getattr(g, "request_started_at", time.perf_counter())) * 1000, 2)
        )
    return response


def error_response(status_code, error, message):
    return jsonify({
        "error": error,
        "message": message,
        "requestId": getattr(g, "request_id", None)
    }), status_code


@app.errorhandler(BadRequest)
def handle_bad_request(_exc):
    return error_response(400, "invalid_json", "Request body must be valid JSON.")


@app.errorhandler(HTTPException)
def handle_http_exception(exc):
    return error_response(exc.code or 500, exc.name.lower().replace(" ", "_"), exc.description)


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    write_structured_log(
        "error",
        "unhandled_error",
        requestId=getattr(g, "request_id", None),
        method=request.method,
        route=route_label(),
        path=safe_request_path(),
        message=str(exc)
    )
    return error_response(500, "internal_server_error", "Unexpected triage-agent failure.")


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "service": "triage-agent",
        "llmTriage": bool(llm_client),
        "vectorMemory": bool(triage_memory),
        "triageOrchestration": triage_orchestration_engine()
    })


@app.post("/triage")
def triage():
    payload = request.get_json(force=True)
    if not isinstance(payload, dict):
        return error_response(400, "invalid_request", "Request body must be a JSON object.")

    incident = payload.get("incident", {})
    runbooks = payload.get("runbooks", [])
    result = triage_incident(
        incident,
        runbooks,
        llm_client=llm_client,
        memory=triage_memory
    )
    result["requestId"] = g.request_id
    return jsonify(result)


if __name__ == "__main__":
    host = os.getenv("TRIAGE_AGENT_HOST", "127.0.0.1")
    port = int(os.getenv("TRIAGE_AGENT_PORT", "5001"))
    app.run(host=host, port=port, debug=False, use_reloader=False)
