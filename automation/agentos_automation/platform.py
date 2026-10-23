from asyncio import to_thread
from pathlib import Path

import httpx2
from agentos.automation.v1.case_pb2 import CaseReference, CaseRequest
from agentos.kagent.v1.wire_pb2 import InvokeSessionOutput
from google.protobuf.json_format import MessageToDict, ParseDict
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from oauthlib.oauth2 import BackendApplicationClient


class Platform:
    def __init__(self, config):
        self.config = config

    async def authorization(self):
        oauth = self.config.platform_oauth
        client = BackendApplicationClient(client_id=oauth.client_id)
        secret = (await to_thread(Path(oauth.client_secret_file).read_text)).strip()
        async with httpx2.AsyncClient(timeout=15) as http:
            response = await http.post(
                oauth.token_endpoint,
                content=client.prepare_request_body(),
                headers={"content-type": "application/x-www-form-urlencoded"},
                auth=(oauth.client_id, secret),
            )
            response.raise_for_status()
            client.parse_request_body_response(response.text)
        return "Bearer " + client.access_token

    async def call(self, tool, reference, message=None):
        headers = {"Authorization": await self.authorization()}
        ref = CaseReference(key=reference["key"], version=int(reference["version"]))
        ref.agent.CopyFrom(self.config.trigger.agent)
        ref.agent.namespace = self.config.workspace
        arguments = MessageToDict(ref)
        if message is not None:
            arguments = MessageToDict(CaseRequest(case=ref, message=message))
        async with (
            httpx2.AsyncClient(headers=headers, timeout=620) as http,
            Client(
                streamable_http_client(self.config.platform_url, http_client=http),
                read_timeout_seconds=620,
                cache=None,
            ) as client,
        ):
            result = await client.call_tool(tool, arguments)
        if result.is_error or not result.structured_content:
            raise RuntimeError("Native case operation failed")
        return ParseDict(result.structured_content, InvokeSessionOutput())
