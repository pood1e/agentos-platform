"""Deterministic checks over the native tool activity and the final answer."""

import fnmatch
import re

from .base import Sample, Score


def tool(call) -> str:
    """Native tool names carry their MCP server prefix."""
    return re.split(r"__|\.", call.name)[-1]


def succeeded(call) -> bool:
    outcome = call.response.struct_value.fields.get("outcome")
    return outcome is not None and outcome.string_value == "output"


def grounding(_baseline):
    def score(sample: Sample) -> Score:
        executed = {tool(call) for call in sample.run.calls if succeeded(call)}
        missing = [name for name in sample.expectation().required_tools if name not in executed]
        return Score(float(not missing), ", ".join(missing))

    return score


def permissions(_baseline):
    def score(sample: Sample) -> Score:
        patterns = [pattern.casefold() for pattern in sample.expectation().forbidden_tools]
        attempted = [
            tool(call)
            for call in sample.run.calls
            if any(fnmatch.fnmatchcase(tool(call).casefold(), pattern) for pattern in patterns)
        ]
        return Score(float(not attempted), ", ".join(attempted))

    return score


def conciseness(_baseline):
    def score(sample: Sample) -> Score:
        expectation = sample.expectation()
        if not expectation.max_characters or not expectation.max_words:
            raise ValueError("evaluation.datasetMismatch")
        answer = sample.run.output
        return Score(
            float(
                len(answer) <= expectation.max_characters
                and len(answer.split()) <= expectation.max_words
            )
        )

    return score
