import json
from types import SimpleNamespace

import pytest
from agentos.evaluation.v1.evaluation_pb2 import EvaluationBaseline, ExecuteResponse
from agentos_evaluation import scorers as registry
from agentos_evaluation.experiment import evaluator
from agentos_evaluation.scorers import Sample, Score, scorers
from agentos_evaluation.scorers import judge as judge_module
from google.protobuf.json_format import ParseDict

EXPECTED = {
    "reference": "Wednesdays 02:00-03:00 UTC",
    "requiredTools": ["search_knowledge"],
    "forbiddenTools": ["*delete*", "Shell"],
    "maxCharacters": 40,
    "maxWords": 8,
    "recovery": "not read by built-in scorers",
}


def sample(answer="Wednesdays 02:00-03:00 UTC", calls=(), expected=EXPECTED):
    run = ParseDict({"output": answer, "taskId": "task", "calls": list(calls)}, ExecuteResponse())
    return Sample({"agent": "assistant", "message": "When is the window?"}, expected, run)


def call(name, outcome="output"):
    return {"id": name, "name": name, "response": {"outcome": outcome}}


def baseline(*names):
    value = EvaluationBaseline(judge_model="judge", judge_prompt="Grade the answer.")
    for name in names:
        value.rules.add(name=name)
    return value


def test_grounding_requires_successful_executions_of_prefixed_native_tools():
    score = scorers(baseline("grounding"))["grounding"]
    assert score(sample(calls=[call("team-sessions__search_knowledge")])) == Score(1.0)
    failed = score(sample(calls=[call("team-sessions__search_knowledge", "error")]))
    assert failed == Score(0.0, "search_knowledge")


def test_permissions_reject_any_attempt_matching_a_forbidden_pattern():
    score = scorers(baseline("permissions"))["permissions"]
    assert score(sample(calls=[call("netbox.get_objects")])).value == 1
    attempted = score(sample(calls=[call("k8s__resources_DELETE", "error"), call("shell")]))
    assert attempted == Score(0.0, "resources_DELETE, shell")


def test_conciseness_applies_both_limits_and_requires_them():
    score = scorers(baseline("conciseness"))["conciseness"]
    assert score(sample()).value == 1
    assert score(sample(answer="word " * 9)).value == 0
    with pytest.raises(ValueError, match="datasetMismatch"):
        score(sample(expected={"reference": "only"}))


def test_correctness_judges_against_the_reference_with_a_bounded_schema(monkeypatch):
    requests = []

    class Responses:
        def __init__(self, verdicts):
            self.verdicts = verdicts

        def create(self, **request):
            requests.append(request)
            return SimpleNamespace(output_text=json.dumps(self.verdicts.pop(0)))

    verdicts = [{"correctness": 0.9, "reason": "matches"}, {"correctness": True, "reason": "x"}]
    monkeypatch.setenv("AGENTOS_JUDGE_URL", "http://judge.test/v1")
    monkeypatch.setenv("AGENTOS_TOKEN", "candidate-token")
    monkeypatch.setattr(
        judge_module, "OpenAI", lambda **_: SimpleNamespace(responses=Responses(verdicts))
    )
    score = scorers(baseline("correctness"))["correctness"]
    assert score(sample()) == Score(0.9, "matches")
    assert requests[0]["model"] == "judge"
    assert json.loads(requests[0]["input"])["reference"] == EXPECTED["reference"]
    with pytest.raises(ValueError, match="invalidScore"):
        score(sample())
    with pytest.raises(ValueError, match="datasetMismatch"):
        score(sample(expected={"maxWords": 1}))


def test_rules_resolve_to_unique_built_in_or_registered_scorers(monkeypatch):
    def recovery(_baseline):
        return lambda item: Score(float(item.expected_output["recovery"] != ""))

    entries = [SimpleNamespace(name="recovery", load=lambda: recovery)]
    monkeypatch.setattr(registry, "entry_points", lambda group: entries)
    assert scorers(baseline("recovery"))["recovery"](sample()).value == 1
    for names in [("unknown",), ("grounding", "grounding")]:
        with pytest.raises(ValueError, match="baselineMismatch"):
            scorers(baseline(*names))
    entries.append(SimpleNamespace(name="grounding", load=lambda: recovery))
    with pytest.raises(ValueError, match="baselineMismatch"):
        scorers(baseline("recovery"))


def test_langfuse_evaluators_report_the_rule_name_and_reason():
    evaluate = evaluator("grounding", scorers(baseline("grounding"))["grounding"])
    result = evaluate(
        input={"agent": "assistant", "message": "?"},
        output={"output": "answer", "calls": [call("search_knowledge", "error")]},
        expected_output=EXPECTED,
        metadata=None,
    )
    assert (result.name, result.value, result.comment) == ("grounding", 0.0, "search_knowledge")
    assert evaluate.__name__ == "grounding"
