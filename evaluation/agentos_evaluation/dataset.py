import hashlib
from datetime import datetime

import rfc8785
from agentos.evaluation.v1.evaluation_pb2 import EvaluationBaseline
from google.protobuf.json_format import MessageToDict
from jsonschema import Draft202012Validator


def frozen_dataset(langfuse, baseline: EvaluationBaseline):
    version = datetime.fromisoformat(baseline.dataset_version)
    if version.tzinfo is None:
        raise ValueError("evaluation.datasetMismatch")
    dataset = langfuse.get_dataset(baseline.dataset, version=version)
    active = [item for item in dataset.items if item.status == "ACTIVE"]
    expected = {sample.id: sample for sample in baseline.samples}
    if len(expected) != len(baseline.samples) or set(expected) != {i.id for i in active}:
        raise ValueError("evaluation.datasetMismatch")
    input_schema = Draft202012Validator(MessageToDict(baseline.input_schema))
    output_schema = Draft202012Validator(MessageToDict(baseline.expected_output_schema))
    for item in active:
        sample = expected[item.id]
        input_schema.validate(item.input)
        output_schema.validate(item.expected_output)
        if (
            hashlib.sha256(rfc8785.dumps(item.input)).hexdigest() != sample.input_digest
            or item.input["agent"] != sample.agent
            or (item.metadata or {}).get("split") != sample.split
        ):
            raise ValueError("evaluation.datasetMismatch")
    if len(active) != len(dataset.items):
        raise ValueError("evaluation.datasetMismatch")
    return dataset
