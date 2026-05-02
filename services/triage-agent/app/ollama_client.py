import json
import os
import re

import requests


class OllamaClient:
    def __init__(
        self,
        base_url=None,
        chat_model=None,
        embedding_model=None,
        timeout_seconds=None
    ):
        self.base_url = (base_url or os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")).rstrip("/")
        self.chat_model = chat_model or os.getenv("OLLAMA_CHAT_MODEL", "llama3.1")
        self.embedding_model = embedding_model or os.getenv("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text")
        self.timeout_seconds = int(timeout_seconds or os.getenv("OLLAMA_TIMEOUT_SECONDS", "60"))

    def embed(self, text):
        response = requests.post(
            f"{self.base_url}/api/embeddings",
            json={"model": self.embedding_model, "prompt": text},
            timeout=self.timeout_seconds
        )
        response.raise_for_status()
        embedding = response.json().get("embedding")
        if not embedding:
            raise RuntimeError("Ollama embedding response did not include an embedding")
        return embedding

    def chat_json(self, messages):
        response = requests.post(
            f"{self.base_url}/api/chat",
            json={
                "model": self.chat_model,
                "messages": messages,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0.1
                }
            },
            timeout=self.timeout_seconds
        )
        response.raise_for_status()
        content = response.json().get("message", {}).get("content", "")
        return parse_json_content(content)


def parse_json_content(content):
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, flags=re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))
