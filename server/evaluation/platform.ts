import type { IncomingHttpHeaders } from "node:http";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { CoreV1Api, type KubeConfig } from "@kubernetes/client-node";
import type { FastifyInstance } from "fastify";
import {
  CandidateState,
  EvaluationService,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { type KagentClients, kagentClients, kagentTransport } from "../kagent/clients.js";
import type { KnowledgeConfig } from "../knowledge/service.js";
import type { ResourceStore } from "../management/resources.js";
import type { machineIdentities } from "../platform/machine-identities.js";
import { configurationArtifacts } from "./artifacts.js";
import { evaluationCleanup } from "./cleanup.js";
import { evaluationConfig } from "./config.js";
import { evaluationExecution } from "./execution.js";
import { registerEvaluationExecution } from "./execution-app.js";
import { evaluationFeedback } from "./feedback.js";
import { evaluationJobs } from "./jobs.js";
import { publications } from "./publication.js";
import { publicationReadiness } from "./readiness.js";
import { evaluationSandboxes } from "./sandbox.js";
import { candidateDrafts, evaluationService } from "./service.js";
import { configurationSnapshots } from "./snapshot.js";
import { configurationStaging, type StagingDependencies } from "./staging.js";
import { EvaluationStore } from "./store.js";

interface PlatformEvaluation {
  app: FastifyInstance;
  config: KubeConfig;
  native: KagentClients;
  store: ResourceStore;
  workspace: string;
  release: string;
  catalogName: string;
  knowledge: KnowledgeConfig;
  userId: string;
  mcpUrl: string;
  bind: ReturnType<typeof machineIdentities>["bind"];
  services: StagingDependencies["services"];
  bindExecution?: import("./execution.js").ExecutionDependencies["bindExecution"];
}

/** One API owns editing, native evaluation Jobs, publication and recovery. */
export async function platformEvaluation(options: PlatformEvaluation) {
  const configuration = evaluationConfig(),
    { app, config, native, workspace } = options;
  if (!configuration)
    return {
      clients: native,
      workspaces: new Map([[workspace, native]]),
      routes: {},
      machine: async () => {
        throw new Error("Evaluation is not configured");
      },
    };
  const token = process.env.AGENTOS_EVALUATION_TOKEN;
  if (!token || !configuration.baseline)
    throw new Error("Evaluation requires a backend identity and pack baseline");
  const core = config.makeApiClient(CoreV1Api);
  const isolated = kagentClients(
    kagentTransport({
      url: configuration.kagentUrl,
      namespace: configuration.namespace,
      userId: options.userId,
    }),
  );
  const store = new EvaluationStore(config, configuration.namespace, workspace);
  const publisher = publications(
    config,
    options.store,
    store,
    workspace,
    options.catalogName,
    options.bind,
  );
  const sandboxes = evaluationSandboxes(config, isolated, {
    namespace: configuration.namespace,
    workspace,
    release: options.release,
    platformMcpUrl: options.mcpUrl,
    userId: options.userId,
    knowledge: options.knowledge,
  });
  const jobs = evaluationJobs(config, {
    namespace: configuration.namespace,
    gatewayUrl: configuration.gatewayUrl,
    judgeUrl: configuration.judgeUrl,
    langfuseUrl: configuration.langfuseUrl,
    langfuseSecret: configuration.langfuseSecret,
    imagePullSecrets: configuration.imagePullSecrets,
  });
  const cleanup = evaluationCleanup(config, isolated, sandboxes, configuration.namespace);
  const synchronize = evaluationFeedback(config, configuration);
  const dependencies = {
    store,
    jobs,
    freeze: configurationSnapshots({
      store: options.store,
      core,
      workspace,
      catalogName: options.catalogName,
      platformImage: configuration.platformImage,
      packImage: configuration.packImage,
      baseline: configuration.baseline,
      knowledge: async () =>
        (await native.memory.list(options.knowledge.scope, { timeoutMs: 15_000 })).memories,
      artifacts: configurationArtifacts(
        new Set((process.env.AGENTOS_SKILL_ORIGINS ?? "").split(",").filter(Boolean)),
      ),
    }),
    prepare: sandboxes.prepare,
    validate: publisher.validate,
    publish: publisher.publish,
    ready: publicationReadiness(options.store),
    published: publisher.refresh,
    dispose: cleanup,
  };
  const service = evaluationService(dependencies);
  const internal = createClient(
    EvaluationService,
    createRouterTransport((router) => router.service(EvaluationService, service)),
  );
  const cleaned = new Set<string>();
  await publisher.refresh();
  await registerEvaluationExecution(
    app,
    evaluationExecution({
      store,
      jobs,
      sandboxes,
      bindExecution: options.bindExecution,
    }),
    token,
  );
  let stopped = false;
  const reconcile = async () => {
    try {
      for (const candidate of await store.list()) {
        if (stopped) break;
        const record = await store.get(candidate.id);
        if (record.report && !record.report.feedbackSynchronized) {
          try {
            await synchronize(record);
            await store.acknowledge(candidate.id);
          } catch (error) {
            app.log.warn({ err: error, candidate: candidate.id }, "evaluation feedback will retry");
          }
        }
        if (candidate.state === CandidateState.PUBLISHING) {
          await internal.publishCandidate({
            id: candidate.id,
            bindingDigest: candidate.bindingDigest,
          });
        } else if (candidate.jobName && !cleaned.has(candidate.id)) {
          const { candidate: current } = await internal.getCandidate({ id: candidate.id });
          if (current && current.state !== CandidateState.RUNNING) {
            if (current.state === CandidateState.STALE) await jobs.cancel(current.id);
            await cleanup(current.id);
            cleaned.add(current.id);
          }
        }
      }
    } catch (error) {
      app.log.warn({ err: error }, "evaluation reconciliation will retry");
    }
    if (!stopped) setTimeout(() => void reconcile(), 10_000).unref();
  };
  app.addHook("onClose", async () => {
    stopped = true;
  });
  void reconcile();
  return {
    clients: publisher.clients(native),
    workspaces: new Map([
      [workspace, native],
      [configuration.namespace, isolated],
    ]),
    routes: {
      evaluation: service,
      staging: configurationStaging({
        store: options.store,
        workspace,
        catalogName: options.catalogName,
        services: options.services,
        stage: candidateDrafts(dependencies),
      }),
    },
    machine: async (headers: IncomingHttpHeaders, role: string) => {
      const id = headers["x-agentos-candidate"],
        variant = headers["x-agentos-variant"];
      if (
        typeof id !== "string" ||
        typeof variant !== "string" ||
        !["candidate", "released"].includes(variant)
      )
        throw new Error("Evaluation scope is required");
      const { candidate } = await internal.getCandidate({ id });
      if (candidate?.state !== CandidateState.RUNNING) throw new Error("Evaluation has stopped");
      return sandboxes.handler(id, variant as "candidate" | "released", role);
    },
  };
}
