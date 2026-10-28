import uuid

import aiohttp
import pytest
from agentos_voice.platform import Platform, PlatformError
from aiohttp import web


async def test_dispatch_ticket_retries_first_message_and_rotates_bound_ticket(serve, tmp_path):
    token = tmp_path / "token"
    token.write_text("first-worker-token")
    room = str(uuid.uuid4())
    initial_ticket = "api-dispatch-ticket"
    bound_ticket = "api-conversation-ticket"
    requests = []
    sent = 0

    async def handle(request):
        nonlocal sent
        assert request.headers["Authorization"] == f"Bearer {token.read_text()}"
        body = await request.json()
        assert body["sessionId"] == room
        method = request.match_info["method"]
        requests.append((method, body))
        if method == "GetVoiceSession":
            assert body["sessionToken"] == initial_ticket
            return web.json_response({"mode": "VOICE_MODE_CALL"})
        if method == "SendVoiceTurn":
            sent += 1
            if sent <= 2:
                assert body["messageId"] == room
                assert body["sessionToken"] == initial_ticket
            else:
                assert body["messageId"] != room
                assert body["sessionToken"] == bound_ticket
            if sent == 1:
                token.write_text("rotated-worker-token")
                return web.json_response({"code": "unavailable"}, status=503)
            return web.json_response(
                {"contextId": "native-conversation", "taskId": "task", "sessionToken": bound_ticket}
            )
        assert body["sessionToken"] == bound_ticket
        assert body["taskId"] == "task"
        return web.json_response({"done": True} if method == "GetVoiceAnswer" else {})

    url = await serve("/agentos.voice.v1.VoiceService/{method}", handle)
    async with aiohttp.ClientSession() as http:
        platform = Platform(url, str(token), http, room, initial_ticket)
        await platform.session()
        first = await platform.send_turn(str(uuid.uuid4()), "巡检")
        assert first.context_id == "native-conversation"
        assert platform.session_token == bound_ticket
        assert (await platform.answer(first.task_id)).done
        await platform.cancel_turn(first.task_id)
        await platform.send_turn(str(uuid.uuid4()), "继续")
    assert len(requests) == 6
    assert requests[1][1] == requests[2][1]


async def test_worker_identity_and_ticket_never_follow_redirects(serve, tmp_path):
    token = tmp_path / "token"
    token.write_text("private-worker-token")
    forwarded = []

    async def capture(request):
        forwarded.append(dict(request.headers))
        return web.json_response({})

    target = await serve("/{path:.*}", capture)

    async def redirect(request):
        raise web.HTTPTemporaryRedirect(target + request.path)

    url = await serve("/{path:.*}", redirect)
    async with aiohttp.ClientSession() as http:
        platform = Platform(url, str(token), http, str(uuid.uuid4()), "private-api-ticket")
        with pytest.raises(PlatformError):
            await platform.session()
    assert not forwarded
