import base64
from urllib.parse import parse_qs

import httpx2
from agentos.automation.v1.automation_pb2 import AutomationConfig
from agentos_automation.platform import Platform


async def test_source_client_credentials_are_reissued_and_rotated_without_static_platform_tokens(
    tmp_path, monkeypatch
):
    secret = tmp_path / "client-secret"
    secret.write_text("first-secret")
    config = AutomationConfig()
    config.platform_oauth.token_endpoint = "https://id.example.test/token"
    config.platform_oauth.client_id = "case-worker"
    config.platform_oauth.client_secret_file = str(secret)
    proofs = []

    def token(request):
        assert parse_qs(request.content.decode())["grant_type"] == ["client_credentials"]
        proofs.append(base64.b64decode(request.headers["authorization"].split()[1]).decode())
        return httpx2.Response(
            200,
            json={
                "access_token": f"signed-{len(proofs)}",
                "token_type": "Bearer",
                "expires_in": 60,
            },
        )

    native = httpx2.AsyncClient
    monkeypatch.setattr(
        "agentos_automation.platform.httpx2.AsyncClient",
        lambda **options: native(**options, transport=httpx2.MockTransport(token)),
    )
    platform = Platform(config)
    assert await platform.authorization() == "Bearer signed-1"
    secret.write_text("rotated-secret")
    assert await platform.authorization() == "Bearer signed-2"
    assert proofs == ["case-worker:first-secret", "case-worker:rotated-secret"]
