"""LLM judge that grades an answer against the dataset reference through the platform gateway."""

import json
import os

from langfuse.openai import OpenAI

from .base import Sample, Score

FORMAT = {
    "type": "json_schema",
    "name": "correctness",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "correctness": {"type": "number", "minimum": 0, "maximum": 1},
            "reason": {"type": "string"},
        },
        "required": ["correctness", "reason"],
        "additionalProperties": False,
    },
}


def correctness(baseline):
    model = OpenAI(
        base_url=os.environ["AGENTOS_JUDGE_URL"],
        api_key=os.environ["AGENTOS_TOKEN"],
        timeout=120,
        max_retries=0,
    )

    def score(sample: Sample) -> Score:
        reference = sample.expectation().reference
        if not reference:
            raise ValueError("evaluation.datasetMismatch")
        response = model.responses.create(
            model=baseline.judge_model,
            instructions=baseline.judge_prompt,
            input=json.dumps(
                {
                    "question": sample.input["message"],
                    "reference": reference,
                    "answer": sample.run.output,
                },
                ensure_ascii=False,
            ),
            max_output_tokens=600,
            text={"format": FORMAT},
        )
        judgement = json.loads(response.output_text)
        return Score(judgement["correctness"], judgement["reason"][:400])

    return score
