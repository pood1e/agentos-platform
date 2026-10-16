import { ApiException, BatchV1Api, type KubeConfig } from "@kubernetes/client-node";
import type { CandidateRecord } from "./store.js";

export interface EvaluationJobConfig {
  namespace: string;
  gatewayUrl: string;
  judgeUrl: string;
  langfuseUrl: string;
  langfuseSecret: string;
  imagePullSecrets: string[];
}

/** Jobs own bounded evaluator execution; agent runtime state remains in kagent. */
export function evaluationJobs(config: KubeConfig, options: EvaluationJobConfig) {
  const api = config.makeApiClient(BatchV1Api);
  const name = (id: string) => `evaluation-${id}`;
  const get = (id: string) =>
    api
      .readNamespacedJob({ namespace: options.namespace, name: name(id) })
      .catch((error: unknown) => {
        if (error instanceof ApiException && error.code === 404) return undefined;
        throw error;
      });
  async function start(record: CandidateRecord) {
    const existing = await get(record.candidate.id);
    if (existing) {
      if (
        existing.metadata?.labels?.["agentos.dev/binding"] !==
        record.candidate.bindingDigest.slice(0, 63)
      )
        throw new Error("An existing evaluation has different immutable inputs");
      return existing;
    }
    const baseline = record.snapshot.baseline;
    if (!baseline) throw new Error("Evaluation baseline is required");
    return api.createNamespacedJob({
      namespace: options.namespace,
      body: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: name(record.candidate.id),
          labels: {
            "agentos.dev/candidate": record.candidate.id,
            "agentos.dev/binding": record.candidate.bindingDigest.slice(0, 63),
          },
        },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: baseline.timeoutSeconds,
          ttlSecondsAfterFinished: 604800,
          template: {
            metadata: {
              labels: {
                "agentos.dev/component": "evaluation",
                "agentos.dev/candidate": record.candidate.id,
              },
            },
            spec: {
              restartPolicy: "Never",
              automountServiceAccountToken: false,
              imagePullSecrets: options.imagePullSecrets.map((name) => ({ name })),
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                seccompProfile: { type: "RuntimeDefault" },
              },
              containers: [
                {
                  name: "evaluator",
                  image: baseline.jobImage,
                  imagePullPolicy: "IfNotPresent",
                  args: ["--snapshot", "/evaluation/snapshot.json"],
                  env: [
                    { name: "AGENTOS_URL", value: options.gatewayUrl },
                    { name: "AGENTOS_JUDGE_URL", value: options.judgeUrl },
                    { name: "AGENTOS_CANDIDATE", value: record.candidate.id },
                    { name: "AGENTOS_BINDING", value: record.candidate.bindingDigest },
                    {
                      name: "AGENTOS_TOKEN",
                      valueFrom: {
                        secretKeyRef: {
                          name: `candidate-${record.candidate.id}-access`,
                          key: "api-key",
                        },
                      },
                    },
                    { name: "LANGFUSE_BASE_URL", value: options.langfuseUrl },
                    {
                      name: "LANGFUSE_PUBLIC_KEY",
                      valueFrom: {
                        secretKeyRef: { name: options.langfuseSecret, key: "public-key" },
                      },
                    },
                    {
                      name: "LANGFUSE_SECRET_KEY",
                      valueFrom: {
                        secretKeyRef: { name: options.langfuseSecret, key: "secret-key" },
                      },
                    },
                  ],
                  resources: {
                    requests: { cpu: "100m", memory: "256Mi" },
                    limits: { cpu: "2", memory: "1Gi" },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ["ALL"] },
                  },
                  volumeMounts: [
                    { name: "snapshot", mountPath: "/evaluation", readOnly: true },
                    { name: "tmp", mountPath: "/tmp" },
                  ],
                },
              ],
              volumes: [
                {
                  name: "snapshot",
                  secret: {
                    secretName: `candidate-${record.candidate.id}`,
                    items: [{ key: "snapshot.json", path: "snapshot.json" }],
                  },
                },
                { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
              ],
            },
          },
        },
      },
    });
  }
  return { start, get, name };
}
