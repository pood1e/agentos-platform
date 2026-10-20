import asyncio
import hmac
import json
from functools import cache
from pathlib import Path
from uuid import UUID

import httpx
import jwt
from agentos.automation.v1.automation_pb2 import CaseFeedback
from agentos.evaluation.v1.evaluation_pb2 import EvaluationFeedback
from google.protobuf.json_format import MessageToDict, ParseDict, ParseError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


@cache
def signing_keys(issuer):
    """Resolve the issuer's JWKS through OpenID Connect discovery."""
    try:
        discovery = httpx.get(issuer.rstrip("/") + "/.well-known/openid-configuration", timeout=15)
        return jwt.PyJWKClient(discovery.raise_for_status().json()["jwks_uri"])
    except (httpx.HTTPError, KeyError, ValueError) as error:
        raise jwt.PyJWKClientConnectionError("OIDC discovery failed") from error


def claim(claims, path):
    value = claims
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value if isinstance(value, list) else []


def application(config, bus, healthy):
    token = Path(config.evaluation_token_file).read_text().strip()
    if not token:
        raise ValueError("Evaluation feedback identity is required")

    async def human(request):
        authorization = request.headers.get("authorization", "")
        if not config.oidc_issuer or not authorization.startswith("Bearer "):
            raise PermissionError("Human authentication required")
        bearer = authorization.removeprefix("Bearer ")
        keys = await asyncio.to_thread(signing_keys, config.oidc_issuer)
        key = await asyncio.to_thread(keys.get_signing_key_from_jwt, bearer)
        claims = jwt.decode(
            bearer,
            key.key,
            algorithms=["RS256"],
            issuer=config.oidc_issuer,
            audience=config.oidc_audience,
            options={"require": ["sub", "exp", "iss", "aud"]},
        )
        if config.feedback_role not in claim(claims, config.role_claim):
            raise PermissionError("Environment feedback role required")
        return claims

    async def body(request):
        value = bytearray()
        async for chunk in request.stream():
            if len(value) + len(chunk) > 512_000:
                raise ValueError("Request exceeds the event size limit")
            value.extend(chunk)
        decoded = json.loads(value)
        if not isinstance(decoded, dict):
            raise ValueError("A structured event is required")
        return decoded

    async def evaluations(request: Request):
        if not hmac.compare_digest(
            request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()
        ):
            return JSONResponse({"error": "machine_authentication_required"}, 401)
        try:
            feedback = ParseDict(await body(request), EvaluationFeedback())
            UUID(feedback.candidate_id)
            if (
                feedback.workspace != config.workspace
                or not feedback.report.binding_digest
                or not feedback.report.HasField("completed_at")
            ):
                raise ValueError("Evaluation identity differs")
            return JSONResponse({"id": await bus.evaluation(feedback)})
        except (ValueError, TypeError, ParseError):
            return JSONResponse({"error": "invalid_evaluation"}, 400)

    async def feedback(request: Request):
        try:
            claims = await human(request)
            value = ParseDict(await body(request), CaseFeedback())
            UUID(value.id)
            if (
                not value.case_key
                or not value.version
                or not value.conclusion_id
                or not value.decision
                or len(value.correction) > 4000
            ):
                raise ValueError("A versioned conclusion is required")
            value.actor = claims["sub"]
            identifier = await bus.publish(
                "feedback.recorded", value.id, value.version, MessageToDict(value)
            )
            return JSONResponse({"id": identifier})
        except (PermissionError, jwt.PyJWTError):
            return JSONResponse({"error": "environment_authorization_required"}, 403)
        except (ValueError, TypeError, ParseError):
            return JSONResponse({"error": "invalid_feedback"}, 400)

    async def metrics(request: Request):
        try:
            await human(request)
        except (PermissionError, jwt.PyJWTError):
            return JSONResponse({"error": "environment_authorization_required"}, 403)
        if not config.metrics_url:
            return JSONResponse({"status": "unavailable", "reason": "metrics_not_configured"}, 503)
        parameters = await body(request)
        parameters["environment"] = config.environment
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                config.metrics_url,
                json=parameters,
                headers={"Authorization": request.headers["authorization"]},
            )
        return JSONResponse(response.json(), response.status_code)

    async def health(_request):
        return JSONResponse({"status": "ok"})

    async def ready(_request):
        return JSONResponse(
            {"status": "ready" if healthy() else "unavailable"},
            200 if healthy() else 503,
        )

    return Starlette(
        routes=[
            Route("/evaluations", evaluations, methods=["POST"]),
            Route("/feedback", feedback, methods=["POST"]),
            Route("/metrics", metrics, methods=["POST"]),
            Route("/healthz", health),
            Route("/readyz", ready),
        ]
    )
