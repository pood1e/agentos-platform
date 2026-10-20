from types import SimpleNamespace

from agentos.evaluation.v1.evaluation_pb2 import EvaluationJobInput
from agentos_evaluation import experiment


def test_experiments_include_native_trace_links_for_both_variants(monkeypatch):
    class FakeLangfuse:
        def get_trace_url(self, *, trace_id):
            return f"https://traces.test/project/example/traces/{trace_id}"

        def flush(self):
            pass

        def shutdown(self):
            pass

    def run_experiment(**kwargs):
        variant = kwargs["metadata"]["variant"]
        return SimpleNamespace(
            dataset_run_url="https://traces.test/project/example/datasets/cases/runs/run",
            experiment_url=None,
            item_results=[
                SimpleNamespace(
                    item=SimpleNamespace(id="case"),
                    evaluations=[SimpleNamespace(name="correctness", value=1)],
                    trace_id=f"{variant}-trace",
                    output={"taskId": f"{variant}-task"},
                )
            ],
        )

    monkeypatch.setattr(experiment, "Langfuse", FakeLangfuse)
    monkeypatch.setattr(
        experiment, "frozen_dataset", lambda *_: SimpleNamespace(run_experiment=run_experiment)
    )
    monkeypatch.setattr(experiment, "scorers", lambda _: {})
    job = EvaluationJobInput(binding_digest="digest", candidate_id="candidate")
    job.snapshot.baseline.repetitions = 1
    job.snapshot.baseline.samples.add(id="case")
    job.snapshot.baseline.rules.add(name="correctness")
    report = experiment.experiments(job, None)
    row = report.samples[0]
    assert row.candidate_trace_id == "candidate-trace"
    assert row.released_trace_id == "released-trace"
    assert row.candidate_trace_url.endswith("/traces/candidate-trace")
    assert row.released_trace_url.endswith("/traces/released-trace")
    assert not row.error
