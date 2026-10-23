import asyncio
import hmac
import os
from contextlib import asynccontextmanager

from agentos.voice.v1.worker_pb2 import EndSessionRequest, StartSessionRequest
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from google.protobuf.json_format import MessageToDict, Parse, ParseError
from google.protobuf.message import Message
from livekit.plugins import silero

from agentos_voice.sessions import Configuration, Sessions


@asynccontextmanager
async def lifespan(app: FastAPI):
    vad = await asyncio.to_thread(
        silero.VAD.load, min_speech_duration=0.2, min_silence_duration=0.8
    )
    app.state.sessions = Sessions(
        Configuration(
            url=os.environ["LIVEKIT_URL"],
            public_url=os.environ["LIVEKIT_PUBLIC_URL"],
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
            capacity=int(os.environ.get("VOICE_CAPACITY", "4")),
        ),
        vad,
    )
    try:
        yield
    finally:
        await app.state.sessions.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def authenticate(request: Request):
    token = os.environ.get("AGENTOS_VOICE_TOKEN", "")
    if not token or not hmac.compare_digest(
        request.headers.get("authorization", ""), "Bearer " + token
    ):
        raise HTTPException(401)


async def parse(request: Request, message: Message):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 64 * 1024:
            raise HTTPException(413)
    try:
        return Parse(body.decode(), message)
    except (ValueError, UnicodeDecodeError, ParseError) as error:
        raise HTTPException(400) from error


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.get("/readyz", dependencies=[Depends(authenticate)])
async def ready(request: Request):
    await request.app.state.sessions.ready()
    return {"status": "ready"}


@app.post("/calls/start", dependencies=[Depends(authenticate)])
async def start(request: Request):
    message = await parse(request, StartSessionRequest())
    connection = await request.app.state.sessions.start(message)
    return JSONResponse(MessageToDict(connection), headers={"Cache-Control": "no-store"})


@app.post("/calls/end", dependencies=[Depends(authenticate)])
async def end(request: Request):
    await request.app.state.sessions.end(await parse(request, EndSessionRequest()))
    return {}
