"""Projected workload credentials, reloaded for each gateway request."""

import asyncio
from pathlib import Path

from aiohttp import ClientConnectionError, ClientSession, ClientTimeout
from yarl import URL


def token_source(path: str):
    file = Path(path)

    async def token():
        return (await asyncio.to_thread(file.read_text)).strip()

    return token


def gateway_session(path: str, endpoint: str):
    origin = URL(endpoint).origin()
    token = token_source(path)

    async def authenticate(request, handler):
        scheme = {"ws": "http", "wss": "https"}.get(request.url.scheme, request.url.scheme)
        if request.url.with_scheme(scheme).origin() != origin:
            raise ClientConnectionError("Speech gateway redirect changed origin")
        request.headers["Authorization"] = f"Bearer {await token()}"
        return await handler(request)

    return ClientSession(
        middlewares=[authenticate], timeout=ClientTimeout(total=None, sock_connect=10)
    )
