import os

import httpx
from agentos.evaluation.v1.evaluation_pb2 import (
    CompleteRequest,
    CompleteResponse,
    ExecuteRequest,
    ExecuteResponse,
)
from google.protobuf.json_format import MessageToDict, ParseDict
from opentelemetry import trace


class ExecutionClient:
    def __init__(self, candidate_id: str):
        self.candidate_id = candidate_id
        self.http = httpx.Client(
            base_url=os.environ["AGENTOS_URL"].rstrip("/"),
            timeout=httpx.Timeout(620, connect=15),
            headers={
                "Authorization": "Bearer " + os.environ["AGENTOS_TOKEN"],
                "Connect-Protocol-Version": "1",
            },
        )

    def execute(self, request: ExecuteRequest) -> ExecuteResponse:
        context = trace.get_current_span().get_span_context()
        headers = {}
        if context.is_valid:
            headers["traceparent"] = f"00-{context.trace_id:032x}-{context.span_id:016x}-01"
        response = self.http.post(
            "/agentos.evaluation.v1.EvaluationExecutionService/Execute",
            json=MessageToDict(request),
            headers=headers,
        )
        if not response.is_success:
            raise RuntimeError("evaluation.executionFailed")
        return ParseDict(response.json(), ExecuteResponse())

    def complete(self, request: CompleteRequest) -> CompleteResponse:
        response = self.http.post(
            "/agentos.evaluation.v1.EvaluationExecutionService/Complete",
            json=MessageToDict(request),
        )
        if not response.is_success:
            raise RuntimeError("evaluation.feedbackPending")
        return ParseDict(response.json(), CompleteResponse())

    def close(self):
        self.http.close()
