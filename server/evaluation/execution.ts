import { clone, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Ajv } from "ajv";
import { TaskState } from "../../gen/a2a_pb.js";
import {
  CandidateState,
  type EvaluationExecutionService,
  EvaluationReportSchema,
  EvaluationVariant,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { InvokeSessionOutputSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import { digest } from "../../shared/digest.js";
import { text } from "../read-model/decode/messages.js";
import { messageIdentity } from "../shared/idempotency.js";
import { evaluationFailures } from "./gate.js";
import type { evaluationJobs } from "./jobs.js";
import { nativeEvaluationProof } from "./proofs.js";
import { nativeReady } from "./readiness.js";
import type { evaluationSandboxes } from "./sandbox.js";
import type { EvaluationStore } from "./store.js";
import { sampleAgent } from "./subject.js";

export interface ExecutionDependencies {
  store: EvaluationStore;
  jobs: ReturnType<typeof evaluationJobs>;
  sandboxes: ReturnType<typeof evaluationSandboxes>;
  bindExecution?: (
    session: import("../../gen/kagent/api/v1/sessions_pb.js").Session,
  ) => Promise<void>;
}

export function evaluationExecution({
  store,
  jobs,
  sandboxes,
  bindExecution,
}: ExecutionDependencies): ServiceImpl<typeof EvaluationExecutionService> {
  const schemas = new Ajv({ strict: true, allErrors: false });
  async function running(id: string) {
    const record = await store.get(id);
    if (record.candidate.state !== CandidateState.RUNNING || record.report)
      throw new ConnectError("Evaluation is no longer running", Code.FailedPrecondition);
    const job = await jobs.get(id);
    if (
      !job ||
      job.spec?.template.spec?.containers[0]?.image !== record.snapshot.baseline?.jobImage ||
      job.metadata?.labels?.["agentos.dev/binding"] !==
        record.candidate.bindingDigest.slice(0, 63) ||
      job.status?.conditions?.some((item) => item.type === "Failed" && item.status === "True")
    )
      throw new ConnectError(
        "Native evaluation Job differs from its frozen inputs",
        Code.FailedPrecondition,
      );
    return record;
  }
  return {
    async execute(request, context) {
      const record = await running(request.candidateId);
      const baseline = record.snapshot.baseline;
      const sample = baseline?.samples.find((sample) => sample.id === request.sampleId);
      if (
        !baseline ||
        !sample ||
        request.repetition > baseline.repetitions ||
        !request.input ||
        digest(request.input) !== sample.inputDigest ||
        request.input.agent !== sample.agent ||
        !schemas.validate(baseline.inputSchema ?? {}, request.input)
      )
        throw new ConnectError(
          "Input differs from the versioned dataset sample",
          Code.InvalidArgument,
        );
      const variant = request.variant === EvaluationVariant.CANDIDATE ? "candidate" : "released";
      const scope = sandboxes.scoped(request.candidateId, variant);
      const agent = sampleAgent(record.snapshot, sample.agent, variant, scope.prefix);
      const deadline = Date.now() + Math.min(600_000, baseline.timeoutSeconds * 500);
      for (;;) {
        const { agent: native } = await scope.clients.agents.getAgent(
          { ref: { namespace: store.namespace, name: agent } },
          { timeoutMs: 10_000, signal: context.signal },
        );
        if (native?.resource?.value && nativeReady(native.resource.value)) break;
        if (Date.now() > deadline)
          throw new ConnectError("Evaluation runtime was not prepared", Code.DeadlineExceeded);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        context.signal.throwIfAborted();
      }
      const messageId = messageIdentity(
        request.candidateId,
        request.sampleId,
        String(request.repetition),
        variant,
      );
      const { session } = await scope.clients.sessions.createSession(
        {
          agent: { namespace: store.namespace, name: agent },
          requestId: messageId,
          name: `Evaluation ${request.sampleId}`,
        },
        { timeoutMs: 60_000, signal: context.signal },
      );
      if (!session)
        throw new ConnectError("Native evaluation Session was not returned", Code.Unavailable);
      await bindExecution?.(session);
      const invoke = await sandboxes.invoke(request.candidateId, variant);
      const response = await invoke(
        session.id,
        messageId,
        text(request.input.message),
        context.signal,
        context.requestHeader.get("traceparent") ?? undefined,
      );
      if (response.isError || !response.structuredContent)
        throw new ConnectError("Native evaluation failed", Code.Aborted);
      const result = fromJsonString(
        InvokeSessionOutputSchema,
        JSON.stringify(response.structuredContent),
      );
      if (
        result.state !== TaskState.COMPLETED ||
        !result.taskId ||
        !result.text ||
        result.text.length > 65536
      )
        throw new ConnectError("Native evaluation did not complete", Code.Aborted);
      const calls = await nativeEvaluationProof(scope.clients, session, result.taskId, messageId);
      return { output: result.text, taskId: result.taskId, contextId: result.contextId, calls };
    },
    async complete(request) {
      const existing = await store.get(request.candidateId);
      if (existing.report) {
        const retained = clone(EvaluationReportSchema, existing.report);
        retained.feedbackSynchronized = false;
        const submitted = request.report && clone(EvaluationReportSchema, request.report);
        if (submitted) submitted.feedbackSynchronized = false;
        if (
          !submitted ||
          toJsonString(EvaluationReportSchema, retained) !==
            toJsonString(EvaluationReportSchema, submitted)
        )
          throw new ConnectError("Completed evaluation cannot be replaced", Code.AlreadyExists);
        return {};
      }
      const record = await running(request.candidateId);
      if (!request.report || request.report.bindingDigest !== record.candidate.bindingDigest)
        throw new ConnectError("Evaluation binding differs", Code.InvalidArgument);
      const report = clone(EvaluationReportSchema, request.report);
      report.feedbackSynchronized = false;
      const failures = evaluationFailures(record.snapshot, report);
      // Even a failing report is retained; native Job completion and the gate determine publication.
      if (
        failures.some((key) =>
          [
            "evaluation.sampleMismatch",
            "evaluation.bindingChanged",
            "evaluation.invalidScore",
          ].includes(key),
        )
      )
        throw new ConnectError("Evaluation report is malformed", Code.InvalidArgument);
      for (const row of report.samples) {
        if (row.error) continue;
        const sample = record.snapshot.baseline?.samples.find(
          (sample) => sample.id === row.sampleId,
        );
        if (!sample) throw new ConnectError("Evaluation sample is missing", Code.InvalidArgument);
        for (const variant of ["candidate", "released"] as const) {
          const scope = sandboxes.scoped(request.candidateId, variant);
          const requestId = messageIdentity(
            request.candidateId,
            sample.id,
            String(row.repetition),
            variant,
          );
          const { session } = await scope.clients.sessions.createSession(
            {
              agent: {
                namespace: store.namespace,
                name: sampleAgent(record.snapshot, sample.agent, variant, scope.prefix),
              },
              requestId,
              name: `Evaluation ${sample.id}`,
            },
            { timeoutMs: 30_000 },
          );
          if (!session)
            throw new ConnectError("Evaluation context is missing", Code.FailedPrecondition);
          await nativeEvaluationProof(
            scope.clients,
            session,
            variant === "candidate" ? row.candidateTaskId : row.releasedTaskId,
            requestId,
          );
        }
      }
      await store.report(request.candidateId, report);
      return {};
    },
  };
}
