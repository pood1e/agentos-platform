"""Scorer contract: one executed dataset item becomes a value in [0, 1]."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from agentos.evaluation.v1.evaluation_pb2 import EvaluationBaseline, ExecuteResponse, Expectation
from google.protobuf.json_format import ParseDict


@dataclass(frozen=True)
class Score:
    value: float
    comment: str = ""

    def __post_init__(self):
        if (
            isinstance(self.value, bool)
            or not isinstance(self.value, int | float)
            or not 0 <= self.value <= 1
        ):
            raise ValueError("evaluation.invalidScore")


@dataclass(frozen=True)
class Sample:
    """A dataset item and the native run it produced."""

    input: Mapping[str, Any]
    expected_output: Mapping[str, Any]
    run: ExecuteResponse

    def expectation(self) -> Expectation:
        return ParseDict(dict(self.expected_output), Expectation(), ignore_unknown_fields=True)


Scorer = Callable[[Sample], Score]
# Solution packs register factories under a rule name in the agentos.evaluation.scorers group.
ScorerFactory = Callable[[EvaluationBaseline], Scorer]
