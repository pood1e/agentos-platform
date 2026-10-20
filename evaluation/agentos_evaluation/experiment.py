from agentos.evaluation.v1.evaluation_pb2 import (
    EVALUATION_VARIANT_CANDIDATE,
    EVALUATION_VARIANT_RELEASED,
    EvaluationJobInput,
    EvaluationReport,
    ExecuteRequest,
    ExecuteResponse,
    SampleResult,
)
from google.protobuf.json_format import MessageToDict, ParseDict
from langfuse import Evaluation, Langfuse

from .client import ExecutionClient
from .dataset import frozen_dataset
from .scorers import Sample, Scorer, scorers


def evaluator(name: str, scorer: Scorer):
    def evaluate(*, input, output, expected_output, **_kwargs):
        score = scorer(Sample(input, expected_output, ParseDict(output, ExecuteResponse())))
        return Evaluation(name=name, value=score.value, comment=score.comment or None)

    evaluate.__name__ = name
    return evaluate


def experiments(job: EvaluationJobInput, client: ExecutionClient) -> EvaluationReport:
    baseline = job.snapshot.baseline
    evaluators = [evaluator(name, scorer) for name, scorer in scorers(baseline).items()]
    langfuse = Langfuse()
    dataset = frozen_dataset(langfuse, baseline)
    rows = {
        (sample.id, repetition): SampleResult(sample_id=sample.id, repetition=repetition)
        for sample in baseline.samples
        for repetition in range(1, baseline.repetitions + 1)
    }
    report = EvaluationReport(binding_digest=job.binding_digest)
    try:
        for repetition in range(1, baseline.repetitions + 1):
            for variant, enum in [
                ("released", EVALUATION_VARIANT_RELEASED),
                ("candidate", EVALUATION_VARIANT_CANDIDATE),
            ]:

                def task(*, item, _repetition=repetition, _variant=enum, **_kwargs):
                    request = ExecuteRequest(
                        candidate_id=job.candidate_id,
                        sample_id=item.id,
                        repetition=_repetition,
                        variant=_variant,
                    )
                    request.input.update(item.input)
                    result = client.execute(request)
                    langfuse.update_current_span(
                        metadata={
                            "kagent.task.id": result.task_id,
                            "kagent.session.id": result.context_id,
                        }
                    )
                    return MessageToDict(result)

                result = dataset.run_experiment(
                    name=baseline.name,
                    run_name=f"{job.candidate_id}:{variant}:{repetition}",
                    description=baseline.scenario_version,
                    task=task,
                    evaluators=evaluators,
                    max_concurrency=1,
                    metadata={
                        "candidate": job.candidate_id,
                        "binding": job.binding_digest,
                        "variant": variant,
                        "repetition": repetition,
                        "baselineVersion": baseline.version,
                        "environment": baseline.environment,
                    },
                )
                report.experiment_url = result.dataset_run_url or result.experiment_url or ""
                for item in result.item_results:
                    row = rows[(item.item.id, repetition)]
                    scores = getattr(row, variant)
                    scores.extend(
                        {"name": score.name, "value": float(score.value)}
                        for score in item.evaluations
                    )
                    setattr(row, f"{variant}_trace_id", item.trace_id or "")
                    output = item.output if isinstance(item.output, dict) else {}
                    setattr(row, f"{variant}_task_id", output.get("taskId", ""))
                    if len(scores) != len(baseline.rules) or not output.get("taskId"):
                        row.error = "evaluation.executionFailed"
        report.samples.extend(rows.values())
        report.completed_at.GetCurrentTime()
        langfuse.flush()
        return report
    finally:
        langfuse.shutdown()
