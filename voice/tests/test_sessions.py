import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import jwt
import pytest
from agentos.voice.v1.worker_pb2 import EndSessionRequest, StartSessionRequest
from agentos_voice.sessions import Configuration, Sessions
from fastapi import HTTPException


class Call:
    def __init__(self, request, vad):
        self.closed = asyncio.Event()
        self.joined = asyncio.Event()
        self.start = AsyncMock()
        self.close = AsyncMock()


@pytest.fixture
async def sessions(monkeypatch):
    monkeypatch.setattr("agentos_voice.sessions.Call", Call)
    value = Sessions(
        Configuration("http://localhost:7880", "wss://voice.test", "key", "x" * 32, 1), None
    )
    await value.livekit.aclose()
    value.livekit = SimpleNamespace(
        room=SimpleNamespace(
            list_rooms=AsyncMock(return_value=SimpleNamespace(rooms=[])),
            create_room=AsyncMock(),
            delete_room=AsyncMock(),
        ),
        aclose=AsyncMock(),
    )
    yield value
    await value.close()


def request(owner="owner"):
    value = StartSessionRequest(call_id=str(uuid4()), owner=owner)
    value.speech.transcription.endpoint.base_url = "http://asr.test/v1"
    value.speech.synthesis.voices.add(model="magpie", voice="0", language_code="zh")
    return value


async def test_room_token_and_identity_isolation(sessions):
    value = request()
    connection = await sessions.start(value)
    assert (await sessions.start(value)) == connection
    claims = jwt.decode(connection.token, options={"verify_signature": False})
    assert claims["sub"] == "caller"
    assert claims["video"]["room"] == value.call_id
    assert claims["video"]["canPublishSources"] == ["microphone"]
    assert not claims["video"].get("roomAdmin")
    assert connection.url == "wss://voice.test"
    value.owner = "someone-else"
    with pytest.raises(HTTPException) as start_error:
        await sessions.start(value)
    assert start_error.value.status_code == 403
    with pytest.raises(HTTPException) as end_error:
        await sessions.end(EndSessionRequest(call_id=value.call_id, owner=value.owner))
    assert end_error.value.status_code == 403
    assert not sessions.active[value.call_id].call.closed.is_set()


async def test_hangup_before_join_releases_capacity_and_room(sessions):
    value = request()
    await sessions.start(value)
    call = sessions.active[value.call_id].call
    with pytest.raises(HTTPException) as error:
        await sessions.start(request())
    assert error.value.status_code == 429
    async with asyncio.timeout(1):
        await sessions.end(EndSessionRequest(call_id=value.call_id, owner=value.owner))
    assert not sessions.active
    call.close.assert_awaited_once()
    sessions.livekit.room.delete_room.assert_awaited_once()
    await sessions.start(request())


async def test_worker_api_requires_internal_bearer_and_rejects_unknown_proto_fields(
    sessions, monkeypatch
):
    import httpx2
    from agentos_voice.app import app

    monkeypatch.setenv("AGENTOS_VOICE_TOKEN", "worker-token")
    app.state.sessions = sessions
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app), base_url="http://worker.test"
    ) as client:
        assert (await client.get("/healthz")).status_code == 200
        assert (await client.get("/readyz")).status_code == 401
        assert (await client.post("/calls/start", json={})).status_code == 401
        headers = {"Authorization": "Bearer worker-token"}
        assert (
            await client.post("/calls/start", json={"unmodeled": True}, headers=headers)
        ).status_code == 400
        assert (
            await client.post("/calls/start", content="x" * 65537, headers=headers)
        ).status_code == 413
