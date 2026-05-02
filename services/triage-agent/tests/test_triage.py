import unittest

from app.triage import triage_incident, triage_orchestration_engine


class FakeLlmClient:
    def embed(self, text):
        self.embedded_text = text
        return [0.1, 0.2, 0.3]

    def chat_json(self, messages):
        self.messages = messages
        return {
            "category": "rollout",
            "confidence": 0.91,
            "summary": "partner-api has a rollout regression in patch ingest.",
            "probableRootCause": "Patch payload parser is incompatible with the deployed schema.",
            "recommendedActions": ["Pause rollout", "Replay failed payload in staging"],
            "runbooks": [{"id": "RB-1"}],
            "similarCasesUsed": ["CASE-1"]
        }


class NoisyLlmClient(FakeLlmClient):
    def chat_json(self, messages):
        self.messages = messages
        return {
            "category": "invented-category",
            "confidence": "not-a-number",
            "summary": "",
            "probableRootCause": None,
            "recommendedActions": "Inspect service logs",
            "runbooks": [{"id": "RB-1"}],
            "similarCasesUsed": "CASE-1"
        }


class FakeMemory:
    def __init__(self):
        self.saved = None

    def search(self, embedding, limit=4):
        self.embedding = embedding
        self.limit = limit
        return [{
            "id": "CASE-1",
            "title": "Previous patch ingest failure",
            "category": "rollout",
            "similarity": 0.92,
            "rootCause": "Parser rejected a new payload shape.",
            "resolutionSteps": ["Pause rollout"]
        }]

    def save_case(self, incident, triage_result, embedding):
        self.saved = {
            "incident": incident,
            "triage_result": triage_result,
            "embedding": embedding
        }


class TriageTest(unittest.TestCase):
    def test_classifies_rollout_incident(self):
        incident = {
            "id": "INC-TEST",
            "service": "partner-api",
            "title": "Patch deployment ingest failure",
            "severity": "SEV2",
            "region": "local",
            "signals": ["work request retries exhausted"],
            "logs": ["ERROR patch ingest failed"]
        }
        runbooks = [
            {
                "id": "RB-1",
                "title": "Patch ingest",
                "keywords": ["patch", "ingest"],
                "steps": ["Pause rollout", "Replay payload"]
            }
        ]

        result = triage_incident(incident, runbooks)

        self.assertEqual(result["category"], "rollout")
        self.assertEqual(result["runbooks"][0]["id"], "RB-1")
        self.assertIn("Pause rollout", result["recommendedActions"])
        self.assertEqual(result["orchestration"]["engine"], triage_orchestration_engine())
        self.assertEqual(result["orchestration"]["fallback"], True)
        self.assertEqual(result["evidence"]["logLines"][0]["message"], "ERROR patch ingest failed")
        self.assertEqual(result["evidence"]["runbooks"][0]["matchedKeywords"], ["patch", "ingest"])
        self.assertEqual(
            result["orchestration"]["steps"],
            ["collect_evidence", "match_runbooks", "deterministic_triage"]
        )

    def test_uses_llm_and_vector_memory_when_available(self):
        incident = {
            "id": "INC-TEST",
            "service": "partner-api",
            "title": "Patch deployment ingest failure",
            "severity": "SEV2",
            "region": "local",
            "signals": ["work request retries exhausted"],
            "logs": ["ERROR patch ingest failed"]
        }
        runbooks = [{
            "id": "RB-1",
            "title": "Patch ingest",
            "keywords": ["patch", "ingest"],
            "steps": ["Pause rollout", "Replay payload"]
        }]
        llm_client = FakeLlmClient()
        memory = FakeMemory()

        result = triage_incident(incident, runbooks, llm_client=llm_client, memory=memory)

        self.assertEqual(result["source"], "ollama-rag")
        self.assertEqual(result["confidence"], 0.91)
        self.assertEqual(result["similarCases"][0]["id"], "CASE-1")
        self.assertEqual(result["evidence"]["similarCases"][0]["id"], "CASE-1")
        self.assertEqual(memory.saved["triage_result"]["incidentId"], "INC-TEST")
        self.assertEqual(result["orchestration"]["engine"], triage_orchestration_engine())
        self.assertEqual(result["orchestration"]["fallback"], False)
        self.assertEqual(
            result["orchestration"]["steps"],
            ["collect_evidence", "match_runbooks", "retrieve_memory", "draft_llm_triage", "save_memory"]
        )

    def test_normalizes_noisy_llm_payloads(self):
        incident = {
            "id": "INC-TEST",
            "service": "partner-api",
            "title": "Patch deployment ingest failure",
            "severity": "SEV2",
            "region": "local",
            "signals": ["work request retries exhausted"],
            "logs": ["ERROR patch ingest failed"]
        }
        runbooks = [{
            "id": "RB-1",
            "title": "Patch ingest",
            "keywords": ["patch", "ingest"],
            "steps": ["Pause rollout", "Replay payload"]
        }]

        result = triage_incident(incident, runbooks, llm_client=NoisyLlmClient(), memory=FakeMemory())

        self.assertEqual(result["category"], "rollout")
        self.assertGreater(result["confidence"], 0)
        self.assertEqual(result["recommendedActions"], ["Inspect service logs"])
        self.assertEqual(result["similarCases"][0]["id"], "CASE-1")
        self.assertEqual(result["orchestration"]["fallback"], False)


if __name__ == "__main__":
    unittest.main()
