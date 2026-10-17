import { create, toJson } from "@bufbuild/protobuf";
import { CoreV1Api, type KubeConfig } from "@kubernetes/client-node";
import {
  type EvaluationConfiguration,
  EvaluationFeedbackSchema,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import type { CandidateRecord } from "./store.js";

/** The environment acknowledges only after its event stream has persisted the evaluation fact. */
export function evaluationFeedback(config: KubeConfig, options: EvaluationConfiguration) {
  const core = config.makeApiClient(CoreV1Api);
  return async (record: CandidateRecord) => {
    const credentials = await core.readNamespacedSecret({
      namespace: options.namespace,
      name: options.feedbackSecret,
    });
    const authorization = Buffer.from(credentials.data?.Authorization ?? "", "base64").toString();
    if (!authorization) throw new Error("Evaluation feedback identity is missing");
    const response = await fetch(
      new URL("evaluations", `${options.feedbackUrl.replace(/\/$/, "")}/`),
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify(
          toJson(
            EvaluationFeedbackSchema,
            create(EvaluationFeedbackSchema, {
              candidateId: record.candidate.id,
              workspace: record.snapshot.workspace,
              report: record.report,
            }),
          ),
        ),
      },
    );
    if (!response.ok) throw new Error(`Evaluation feedback was not persisted (${response.status})`);
    const receipt: unknown = await response.json();
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("id" in receipt) ||
      receipt.id !== record.candidate.id
    )
      throw new Error("Evaluation feedback acknowledgement differs");
  };
}
