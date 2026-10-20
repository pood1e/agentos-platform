"""Scorers named by baseline rules: built-in agent checks and solution-pack entry points."""

from importlib.metadata import entry_points

from agentos.evaluation.v1.evaluation_pb2 import EvaluationBaseline

from .base import Sample, Score, Scorer, ScorerFactory
from .checks import conciseness, grounding, permissions
from .judge import correctness

GROUP = "agentos.evaluation.scorers"
BUILTIN: dict[str, ScorerFactory] = {
    "correctness": correctness,
    "grounding": grounding,
    "permissions": permissions,
    "conciseness": conciseness,
}


def scorers(baseline: EvaluationBaseline) -> dict[str, Scorer]:
    factories = dict(BUILTIN)
    for entry in entry_points(group=GROUP):
        if entry.name in factories:
            raise ValueError("evaluation.baselineMismatch")
        factories[entry.name] = entry.load()
    names = [rule.name for rule in baseline.rules]
    if len(set(names)) != len(names) or not factories.keys() >= set(names):
        raise ValueError("evaluation.baselineMismatch")
    return {name: factories[name](baseline) for name in names}


__all__ = ["Sample", "Score", "Scorer", "ScorerFactory", "scorers"]
