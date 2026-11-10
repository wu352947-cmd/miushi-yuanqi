"""pytest 共用：每个测试一个临时 SQLite 库，模型调用使用 mock。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
TESTS_DIR = Path(__file__).resolve().parent
for path in (ROOT, TESTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_SECRET", "test-secret")
    monkeypatch.setenv("MSYQ_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.delenv("APP_PASSWORD", raising=False)
    monkeypatch.delenv("MSYQ_MOCK", raising=False)
    monkeypatch.delenv("MSYQ_MOCK_400", raising=False)
    monkeypatch.delenv("MSYQ_SEED", raising=False)
    from server.app import app

    with TestClient(app) as test_client:
        yield test_client


def parse_sse(response) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    event = ""
    for line in response.iter_lines():
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            events.append((event, json.loads(line[len("data:"):].strip())))
    return events


@pytest.fixture()
def sse_parse():
    return parse_sse


def chat_events(client, text="今天有点累。", **extra):
    with client.stream("POST", "/api/chats/miao/messages", json={"text": text, **extra}) as response:
        assert response.status_code == 200, response.read()
        return parse_sse(response)
