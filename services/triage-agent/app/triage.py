import json
from typing import Any, Literal, TypedDict

try:
    from langgraph.graph import END, START, StateGraph
    LANGGRAPH_AVAILABLE = True
except ModuleNotFoundError:
    END = "__end__"
    START = "__start__"
    StateGraph = None
    LANGGRAPH_AVAILABLE = False

CATEGORY_KEYWORDS = {
    "rollout": ["deploy", "deployment", "rollout", "patch", "version", "ingest"],
    "capacity": ["storage", "capacity", "scale-up", "quota", "allowlist"],
    "latency": ["latency", "timeout", "p95", "cache", "slow"],
    "auth": ["permission", "rbac", "jwt", "forbidden", "unauthorized"],
    "dependency": ["dependency", "cve", "bom", "base image", "upgrade"]
}

SEVERITY_CONFIDENCE = {
    "SEV1": 0.94,
    "SEV2": 0.88,
    "SEV3": 0.76,
    "SEV4": 0.62
}


class TriageState(TypedDict, total=False):
    incident: dict[str, Any]
    runbooks: list[dict[str, Any]]
    llm_client: Any
    memory: Any
    incidentText: str
    evidenceText: str
    initialCategory: str
    matchedRunbooks: list[dict[str, Any]]
    embedding: list[float]
    similarCases: list[dict[str, Any]]
    result: dict[str, Any]
    orchestrationSteps: list[str]


_TRIAGE_GRAPH = None


def triage_incident(incident, runbooks, llm_client=None, memory=None):
    try:
        state = get_triage_graph().invoke({
            "incident": incident,
            "runbooks": runbooks,
            "llm_client": llm_client,
            "memory": memory,
            "orchestrationSteps": []
        })
        return attach_orchestration(state["result"], state)
    except Exception as exc:
        fallback = deterministic_triage_incident(incident, runbooks)
        fallback["source"] = "triage-agent-fallback"
        fallback["llmError"] = str(exc)
        fallback["orchestration"] = {
            "engine": triage_orchestration_engine(),
            "steps": ["graph_error", "deterministic_triage"],
            "fallback": True
        }
        return fallback


def triage_orchestration_engine():
    return "langgraph" if LANGGRAPH_AVAILABLE else "linear-compat"


def get_triage_graph():
    global _TRIAGE_GRAPH
    if _TRIAGE_GRAPH is None:
        _TRIAGE_GRAPH = build_triage_graph()
    return _TRIAGE_GRAPH


def build_triage_graph():
    if not LANGGRAPH_AVAILABLE:
        return LinearTriageGraph()

    builder = StateGraph(TriageState)
    builder.add_node("collect_evidence", collect_evidence_node)
    builder.add_node("match_runbooks", match_runbooks_node)
    builder.add_node("retrieve_memory", retrieve_memory_node)
    builder.add_node("draft_llm_triage", draft_llm_triage_node)
    builder.add_node("save_memory", save_memory_node)
    builder.add_node("deterministic_triage", deterministic_triage_node)

    builder.add_edge(START, "collect_evidence")
    builder.add_edge("collect_evidence", "match_runbooks")
    builder.add_conditional_edges(
        "match_runbooks",
        route_after_runbook_match,
        {
            "llm": "retrieve_memory",
            "fallback": "deterministic_triage"
        }
    )
    builder.add_edge("retrieve_memory", "draft_llm_triage")
    builder.add_edge("draft_llm_triage", "save_memory")
    builder.add_edge("save_memory", END)
    builder.add_edge("deterministic_triage", END)

    return builder.compile()


class LinearTriageGraph:
    def invoke(self, state):
        current = collect_evidence_node(state)
        current = {**state, **current}
        current = {**current, **match_runbooks_node(current)}
        if route_after_runbook_match(current) == "llm":
            current = {**current, **retrieve_memory_node(current)}
            current = {**current, **draft_llm_triage_node(current)}
            current = {**current, **save_memory_node(current)}
            return current
        return {**current, **deterministic_triage_node(current)}


def append_step(state, step):
    return [*state.get("orchestrationSteps", []), step]


def collect_evidence_node(state):
    incident = state["incident"]
    incident_text = build_incident_text(incident)
    evidence_text = " ".join([
        incident.get("service", ""),
        incident.get("title", ""),
        " ".join(incident.get("signals", [])),
        " ".join(incident.get("logs", []))
    ]).lower()
    return {
        "incidentText": incident_text,
        "evidenceText": evidence_text,
        "initialCategory": classify(evidence_text),
        "orchestrationSteps": append_step(state, "collect_evidence")
    }


def match_runbooks_node(state):
    return {
        "matchedRunbooks": rank_runbooks(
            state.get("evidenceText", ""),
            state.get("runbooks", [])
        )[:3],
        "orchestrationSteps": append_step(state, "match_runbooks")
    }


def route_after_runbook_match(state) -> Literal["llm", "fallback"]:
    return "llm" if state.get("llm_client") else "fallback"


def retrieve_memory_node(state):
    llm_client = state["llm_client"]
    memory = state.get("memory")
    embedding = llm_client.embed(state["incidentText"])
    similar_cases = memory.search(embedding, limit=4) if memory else []
    return {
        "embedding": embedding,
        "similarCases": similar_cases,
        "orchestrationSteps": append_step(state, "retrieve_memory")
    }


def draft_llm_triage_node(state):
    incident = state["incident"]
    runbooks = state.get("matchedRunbooks", [])
    similar_cases = state.get("similarCases", [])
    prompt = build_triage_prompt(incident, runbooks, similar_cases)
    llm_payload = state["llm_client"].chat_json(prompt)
    return {
        "result": normalize_llm_result(llm_payload, incident, runbooks, similar_cases),
        "orchestrationSteps": append_step(state, "draft_llm_triage")
    }


def save_memory_node(state):
    memory = state.get("memory")
    if memory and state.get("embedding"):
        memory.save_case(state["incident"], state["result"], state["embedding"])
    return {
        "orchestrationSteps": append_step(state, "save_memory")
    }


def deterministic_triage_node(state):
    return {
        "result": deterministic_triage_incident(state["incident"], state.get("runbooks", [])),
        "orchestrationSteps": append_step(state, "deterministic_triage")
    }


def attach_orchestration(result, state):
    return {
        **result,
        "orchestration": {
            "engine": triage_orchestration_engine(),
            "steps": state.get("orchestrationSteps", []),
            "fallback": result.get("source") == "triage-agent-fallback"
        }
    }


def llm_triage_incident(incident, runbooks, llm_client, memory=None):
    incident_text = build_incident_text(incident)
    embedding = llm_client.embed(incident_text)
    similar_cases = memory.search(embedding, limit=4) if memory else []
    matched_runbooks = rank_runbooks(incident_text.lower(), runbooks)[:3]

    prompt = build_triage_prompt(incident, matched_runbooks, similar_cases)
    llm_payload = llm_client.chat_json(prompt)
    result = normalize_llm_result(llm_payload, incident, matched_runbooks, similar_cases)

    if memory:
        memory.save_case(incident, result, embedding)

    return result


def deterministic_triage_incident(incident, runbooks):
    text = " ".join([
        incident.get("service", ""),
        incident.get("title", ""),
        " ".join(incident.get("signals", [])),
        " ".join(incident.get("logs", []))
    ]).lower()

    category = classify(text)
    matched_runbooks = rank_runbooks(text, runbooks)
    root_cause = probable_root_cause(incident)
    recommended_actions = build_actions(matched_runbooks, category)

    return {
        "incidentId": incident.get("id"),
        "category": category,
        "confidence": confidence(incident, matched_runbooks),
        "summary": build_summary(incident, category),
        "probableRootCause": root_cause,
        "runbooks": matched_runbooks[:3],
        "recommendedActions": recommended_actions,
        "similarCases": [],
        "evidence": build_evidence(incident, matched_runbooks[:3], []),
        "source": "triage-agent-fallback"
    }


def build_incident_text(incident):
    return "\n".join([
        f"Service: {incident.get('service', '')}",
        f"Title: {incident.get('title', '')}",
        f"Severity: {incident.get('severity', '')}",
        f"Status: {incident.get('status', '')}",
        f"Environment: {incident.get('environment', '')}",
        f"Region: {incident.get('region', '')}",
        f"Owner: {incident.get('owner', '')}",
        f"Deployment Version: {incident.get('deploymentVersion', '')}",
        "Signals:",
        "\n".join(f"- {signal}" for signal in incident.get("signals", [])),
        "Logs:",
        "\n".join(f"- {line}" for line in incident.get("logs", []))
    ])


def build_triage_prompt(incident, runbooks, similar_cases):
    schema = {
        "incidentId": "string",
        "category": "rollout|capacity|latency|auth|dependency|service",
        "confidence": "number between 0 and 1",
        "summary": "one concise sentence",
        "probableRootCause": "specific root-cause hypothesis grounded in logs/signals",
        "recommendedActions": ["ordered action strings"],
        "runbooks": [
            {
                "id": "runbook id",
                "title": "runbook title"
            }
        ],
        "similarCasesUsed": ["past triage case ids used"]
    }

    return [
        {
            "role": "system",
            "content": (
                "You are CloudOps Copilot, a senior cloud operations triage assistant. "
                "Use incident logs, signals, candidate runbooks, and retrieved historical "
                "triage cases to produce a practical operator-ready triage result. "
                "Return only valid JSON. Do not include markdown."
            )
        },
        {
            "role": "user",
            "content": json.dumps({
                "outputSchema": schema,
                "incident": incident,
                "candidateRunbooks": runbooks,
                "similarPastTriageCases": similar_cases,
                "instructions": [
                    "Prefer evidence from logs/signals over generic advice.",
                    "Use similar past cases only when they match the current failure mode.",
                    "Recommended actions should be concrete and safe for production operations.",
                    "Do not invent runbook ids that are not in candidateRunbooks."
                ]
            }, indent=2)
        }
    ]


def normalize_llm_result(payload, incident, runbooks, similar_cases):
    runbook_by_id = {runbook.get("id"): runbook for runbook in runbooks}
    selected_runbooks = []
    for item in as_list(payload.get("runbooks")):
        runbook_id = item.get("id") if isinstance(item, dict) else item
        if runbook_id in runbook_by_id:
            selected_runbooks.append(runbook_by_id[runbook_id])

    if not selected_runbooks:
        selected_runbooks = runbooks[:3]

    similar_ids = set(as_list(payload.get("similarCasesUsed")))
    selected_cases = [
        case for case in similar_cases
        if not similar_ids or case.get("id") in similar_ids
    ][:3]

    confidence_value = payload.get("confidence", confidence(incident, selected_runbooks))
    try:
        confidence_value = float(confidence_value)
    except (TypeError, ValueError):
        confidence_value = confidence(incident, selected_runbooks)

    return {
        "incidentId": incident.get("id"),
        "category": valid_category(payload.get("category")) or classify(build_incident_text(incident).lower()),
        "confidence": max(0.0, min(confidence_value, 1.0)),
        "summary": as_text(payload.get("summary")) or build_summary(incident, "service"),
        "probableRootCause": as_text(payload.get("probableRootCause")) or probable_root_cause(incident),
        "runbooks": selected_runbooks,
        "recommendedActions": as_list(payload.get("recommendedActions")) or build_actions(selected_runbooks, "service"),
        "similarCases": selected_cases,
        "evidence": build_evidence(incident, selected_runbooks, selected_cases),
        "source": "ollama-rag"
    }


def as_text(value):
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def as_list(value):
    if isinstance(value, list):
        return [item for item in value if item]
    if isinstance(value, str):
        value = value.strip()
        return [value] if value else []
    return []


def valid_category(value):
    value = as_text(value)
    if value in set(CATEGORY_KEYWORDS) | {"service"}:
        return value
    return None


def classify(text):
    scores = {
        category: sum(1 for keyword in keywords if keyword in text)
        for category, keywords in CATEGORY_KEYWORDS.items()
    }
    best_category = max(scores, key=scores.get)
    return best_category if scores[best_category] > 0 else "service"


def rank_runbooks(text, runbooks):
    scored = []
    for runbook in runbooks:
        keywords = runbook.get("keywords", [])
        score = sum(1 for keyword in keywords if keyword.lower() in text)
        if score > 0:
            enriched = dict(runbook)
            enriched["matchScore"] = score
            scored.append(enriched)
    return sorted(scored, key=lambda runbook: runbook["matchScore"], reverse=True)


def build_evidence(incident, runbooks, similar_cases):
    text = build_incident_text(incident).lower()
    return {
        "signals": [
            {"id": f"signal-{index + 1}", "text": signal}
            for index, signal in enumerate(incident.get("signals", [])[:8])
        ],
        "logLines": evidence_log_lines(incident)[:10],
        "runbooks": [
            {
                "id": runbook.get("id"),
                "title": runbook.get("title"),
                "matchedKeywords": [
                    keyword for keyword in runbook.get("keywords", [])
                    if keyword.lower() in text
                ]
            }
            for runbook in runbooks[:5]
        ],
        "similarCases": [
            {
                "id": case.get("id"),
                "title": case.get("title"),
                "category": case.get("category"),
                "similarity": case.get("similarity")
            }
            for case in similar_cases[:5]
        ]
    }


def evidence_log_lines(incident):
    logs = [
        {
            "id": f"log-{index + 1}",
            "observedAt": None,
            "level": "ERROR" if "ERROR" in line else "WARN" if "WARN" in line else "INFO",
            "source": incident.get("service"),
            "message": line
        }
        for index, line in enumerate(incident.get("logs", []))
    ]
    severe = [
        log for log in logs
        if log["level"] in {"ERROR", "WARN"}
    ]
    return severe or logs


def probable_root_cause(incident):
    logs = incident.get("logs", [])
    for line in logs:
        if "ERROR" in line or "failed" in line.lower():
            return line
    signals = incident.get("signals", [])
    return signals[0] if signals else "No root-cause signal available yet."


def build_actions(runbooks, category):
    if runbooks:
        return runbooks[0].get("steps", [])

    fallback = {
        "rollout": [
            "Compare current and previous deployment versions.",
            "Pause rollout if error rate is still increasing.",
            "Replay a failed request in staging."
        ],
        "capacity": [
            "Check quota, allowlist, and capacity freshness.",
            "Verify safety gate reason before override."
        ],
        "latency": [
            "Check p95 latency by dependency.",
            "Enable fallback path if latency budget is exceeded."
        ],
        "service": [
            "Inspect recent changes and service logs.",
            "Attach findings to the incident ticket."
        ]
    }
    return fallback.get(category, fallback["service"])


def confidence(incident, runbooks):
    base = SEVERITY_CONFIDENCE.get(incident.get("severity"), 0.6)
    if runbooks:
        return min(base + 0.06, 0.98)
    return base


def build_summary(incident, category):
    return (
        f"{incident.get('service', 'unknown-service')} has a {category} incident "
        f"({incident.get('severity', 'unknown severity')}) in {incident.get('region', 'unknown-region')}."
    )
