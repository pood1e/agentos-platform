import argparse
import os
import sys
from pathlib import Path

from agentos.evaluation.v1.evaluation_pb2 import CompleteRequest, EvaluationJobInput
from google.protobuf.json_format import Parse

from .client import ExecutionClient
from .experiment import experiments


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    job = Parse(Path(args.snapshot).read_text(), EvaluationJobInput())
    if (
        job.candidate_id != os.environ["AGENTOS_CANDIDATE"]
        or job.binding_digest != os.environ["AGENTOS_BINDING"]
    ):
        raise ValueError("evaluation.bindingChanged")
    client = ExecutionClient(job.candidate_id)
    try:
        report = experiments(job, client)
        request = CompleteRequest(candidate_id=job.candidate_id)
        request.report.CopyFrom(report)
        client.complete(request)
        return int(any(row.error for row in report.samples))
    finally:
        client.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Evaluation failed ({type(error).__name__})", file=sys.stderr)
        raise SystemExit(1) from None
