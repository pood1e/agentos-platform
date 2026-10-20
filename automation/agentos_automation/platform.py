from pathlib import Path

import httpx2
from agentos.automation.v1.case_pb2 import CaseReference, CaseRequest
from agentos.kagent.v1.wire_pb2 import InvokeSessionOutput
from google.protobuf.json_format import MessageToDict, ParseDict
from mcp import Client
from mcp.client.streamable_http import streamable_http_client


class Platform:
    def __init__(self, config):
        self.config = config
        self.authorization = "Bearer " + Path(config.platform_token_file).read_text().strip()

    async def call(self, tool, reference, message=None):
        headers = {"Authorization": self.authorization}
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
