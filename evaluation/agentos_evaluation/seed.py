"""Freeze solution-pack training cases and protected holdouts as a native Langfuse dataset."""

import argparse
import hashlib
import json
import re
from datetime import UTC
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import rfc8785
from jsonschema import Draft202012Validator
from langfuse import Langfuse
from langfuse.api import NotFoundError


def digest(value):
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()


def case_metadata(case, baseline):
    return {
        "split": case["split"],
        "case": case["name"],
        "scenarioVersion": baseline["scenarioVersion"],
    }


def seed(baseline_file: Path, cases_file: Path, holdout_file: Path | None, job_image: str):
    if not re.fullmatch(r".+@sha256:[a-f0-9]{64}", job_image):
        raise ValueError("Evaluator image must be immutable")
    baseline = json.loads(baseline_file.read_text())
    training = json.loads(cases_file.read_text())
    if any(case["split"] != "train" for case in training):
        raise ValueError("Repository cases must contain training data only")
    definition = digest({"baseline": baseline, "training": training})
    client = Langfuse()
    try:
        try:
            native = client.api.datasets.get(baseline["dataset"])
        except NotFoundError:
            native = None
        existing = (
            {item.id: item for item in client.get_dataset(baseline["dataset"]).items}
            if native
            else {}
        )
        if holdout_file:
            protected = json.loads(holdout_file.read_text())
            holdouts = protected["cases"]
            knowledge = baseline["knowledgeSeed"] + protected["knowledgeSeed"]
        elif native:
            holdouts = [
                {
                    "name": item.metadata["case"],
                    "split": "holdout",
                    "input": item.input,
                    "expectedOutput": item.expected_output,
                }
                for item in existing.values()
                if item.metadata.get("split") == "holdout"
            ]
            knowledge = native.metadata["knowledgeSeed"]
        else:
            raise ValueError("Initial baseline requires a protected holdout file")
        if not holdouts or any(case["split"] != "holdout" for case in holdouts):
            raise ValueError("Protected baseline must include holdout cases")
        cases = sorted(training + holdouts, key=lambda case: case["name"])
        if len({case["name"] for case in cases}) != len(cases):
            raise ValueError("Dataset case names must be unique")
        input_schema = Draft202012Validator(baseline["inputSchema"])
        expected_schema = Draft202012Validator(baseline["expectedOutputSchema"])
        for case in cases:
            input_schema.validate(case["input"])
            expected_schema.validate(case["expectedOutput"])
        metadata = {
            "definitionDigest": definition,
            "manifestDigest": digest(cases),
            "knowledgeSeed": knowledge,
        }
        if native:
            if (
                native.metadata != metadata
                or native.input_schema != baseline["inputSchema"]
                or native.expected_output_schema != baseline["expectedOutputSchema"]
            ):
                raise ValueError("Baseline changed; confirm a new baseline version")
        else:
            client.api.datasets.create(
                name=baseline["dataset"],
                description=baseline["scenarioVersion"],
                metadata=metadata,
                input_schema=baseline["inputSchema"],
                expected_output_schema=baseline["expectedOutputSchema"],
            )
        references, versions, ids = [], [], set()
        for case in cases:
            identifier = str(uuid5(NAMESPACE_URL, f"{baseline['dataset']}/{case['name']}"))
            ids.add(identifier)
            item = existing.get(identifier)
            if item:
                if (
                    item.input != case["input"]
                    or item.expected_output != case["expectedOutput"]
                    or item.metadata != case_metadata(case, baseline)
                    or item.status != "ACTIVE"
                ):
                    raise ValueError("Existing sample differs from its confirmed baseline")
            else:
                item = client.api.dataset_items.create(
                    dataset_name=baseline["dataset"],
                    id=identifier,
                    input=case["input"],
                    expected_output=case["expectedOutput"],
                    metadata=case_metadata(case, baseline),
                )
            versions.append(item.version or item.updated_at)
            references.append(
                {
                    "id": identifier,
                    "name": case["name"],
                    "split": case["split"],
                    "agent": case["input"]["agent"],
                    "inputDigest": digest(case["input"]),
                }
            )
        if set(existing) - ids or any(version is None for version in versions):
            raise ValueError("Native dataset manifest is incomplete")
        baseline.update(
            jobImage=job_image,
            datasetVersion=max(versions).astimezone(UTC).isoformat(),
            samples=references,
            knowledgeSeed=knowledge,
        )
        return baseline
    finally:
        client.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--holdout-file", type=Path)
    parser.add_argument("--job-image", required=True)
    args = parser.parse_args()
    frozen = seed(args.baseline, args.cases, args.holdout_file, args.job_image)
    print(json.dumps(frozen, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
