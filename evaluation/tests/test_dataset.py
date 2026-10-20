import hashlib
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import rfc8785
from agentos.evaluation.v1.evaluation_pb2 import EvaluationBaseline
from agentos_evaluation.dataset import frozen_dataset


def fixture():
    items = [
        SimpleNamespace(
            id=name,
            status="ACTIVE",
            input={"agent": "engineer", "message": name},
            expected_output={"reference": name},
            metadata={"split": split},
        )
        for name, split in [("training", "train"), ("protected", "holdout")]
    ]
    baseline = EvaluationBaseline(dataset="operations", dataset_version="2026-10-17T00:00:00Z")
    baseline.input_schema.update({"type": "object", "required": ["agent", "message"]})
    baseline.expected_output_schema.update({"type": "object", "required": ["reference"]})
    for item in items:
        baseline.samples.add(
            id=item.id,
            agent="engineer",
            split=item.metadata["split"],
            input_digest=hashlib.sha256(rfc8785.dumps(item.input)).hexdigest(),
        )
    client = Mock()
    client.get_dataset.return_value = SimpleNamespace(items=items)
    return client, baseline, items


def test_reads_an_explicit_historical_version_and_requires_the_exact_protected_manifest():
    client, baseline, items = fixture()
    assert frozen_dataset(client, baseline).items == items
    assert client.get_dataset.call_args.kwargs["version"].isoformat() == "2026-10-17T00:00:00+00:00"
    client.get_dataset.return_value.items = items[:1]
    with pytest.raises(ValueError, match="datasetMismatch"):
        frozen_dataset(client, baseline)


@pytest.mark.parametrize("change", ["input", "split", "archived", "extra"])
def test_rejects_changed_samples_partition_drift_archived_or_extra_items(change):
    client, baseline, items = fixture()
    if change == "input":
        items[0].input["message"] = "different"
    elif change == "split":
        items[0].metadata["split"] = "holdout"
    elif change == "archived":
        items[0].status = "ARCHIVED"
    else:
        items.append(SimpleNamespace(id="unconfirmed", status="ACTIVE"))
    with pytest.raises(ValueError, match="datasetMismatch"):
        frozen_dataset(client, baseline)
