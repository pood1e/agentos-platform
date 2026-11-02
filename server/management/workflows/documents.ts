import { createHash } from "node:crypto";
import { ApiException, type CoreV1Api, type CustomObjectsApi } from "@kubernetes/client-node";
import { invalid } from "../../shared/errors.js";
import { resourceError } from "../resources.js";
import { workflowReferences } from "./references.js";

const manager = "agentos-workflows";
const ownerLabel = "agentos.dev/workflow";
const usedAt = "agentos.dev/workflow-last-used";
const workflowKey = "workflow.yaml";
export const documentDigest = (document: string) =>
  createHash("sha256").update(document).digest("hex");
const ownerKey = (name: string) => documentDigest(name).slice(0, 32);

export function workflowDocuments(core: CoreV1Api, custom: CustomObjectsApi, namespace: string) {
  return {
    async read(name: string, key: string) {
      try {
        const value = (await core.readNamespacedConfigMap({ namespace, name })).data?.[key];
        if (!value || Buffer.byteLength(value) > 65_536) throw invalid("workflow.invalidDocument");
        return value;
      } catch (error) {
        return resourceError(error);
      }
    },
    source(owner: string, document: string) {
      return {
        name: `workflow-${ownerKey(owner)}-${documentDigest(document).slice(0, 20)}`,
        key: workflowKey,
      };
    },
    async stage(owner: string, document: string) {
      const { name } = this.source(owner, document);
      try {
        await core.createNamespacedConfigMap({
          namespace,
          fieldManager: manager,
          fieldValidation: "Strict",
          body: {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: {
              name,
              namespace,
              labels: { "app.kubernetes.io/managed-by": manager, [ownerLabel]: ownerKey(owner) },
              annotations: { [usedAt]: new Date().toISOString() },
            },
            immutable: true,
            data: { [workflowKey]: document },
          },
        });
      } catch (error) {
        if (!(error instanceof ApiException && error.code === 409)) return resourceError(error);
        try {
          const existing = await core.readNamespacedConfigMap({ namespace, name });
          if (
            existing.immutable !== true ||
            existing.metadata?.labels?.[ownerLabel] !== ownerKey(owner) ||
            existing.data?.[workflowKey] !== document
          )
            throw invalid("workflow.sourceConflict");
          // A CAS metadata touch protects a reused historical source from concurrent GC.
          await core.replaceNamespacedConfigMap({
            namespace,
            name,
            body: {
              ...existing,
              metadata: {
                ...existing.metadata,
                annotations: {
                  ...existing.metadata?.annotations,
                  [usedAt]: new Date().toISOString(),
                },
              },
            },
          });
        } catch (error) {
          return resourceError(error);
        }
      }
    },
    async prune(owner: string, candidate: string) {
      try {
        const { items } = await core.listNamespacedConfigMap({
          namespace,
          labelSelector: `${ownerLabel}=${ownerKey(owner)}`,
        });
        const history = items
          .filter(
            (item) =>
              item.metadata?.labels?.[ownerLabel] === ownerKey(owner) &&
              item.metadata.labels["app.kubernetes.io/managed-by"] === manager &&
              item.immutable === true,
          )
          .sort((a, b) =>
            String(b.metadata?.creationTimestamp).localeCompare(
              String(a.metadata?.creationTimestamp),
            ),
          );
        const old = history.slice(10).filter((item) => {
          const lastUsed = new Date(
            item.metadata?.annotations?.[usedAt] ?? item.metadata?.creationTimestamp ?? "",
          ).getTime();
          return Number.isFinite(lastUsed) && Date.now() - lastUsed >= 86_400_000;
        });
        if (!old.length) return;
        const referenced = await workflowReferences(custom, core, namespace, candidate);
        for (const item of old) {
          const { name = "", resourceVersion, uid } = item.metadata ?? {};
          if (referenced.has(name)) continue;
          try {
            await core.deleteNamespacedConfigMap({
              namespace,
              name,
              body: { preconditions: { uid, resourceVersion } },
            });
          } catch (error) {
            if (!(error instanceof ApiException && [404, 409].includes(error.code))) throw error;
          }
        }
      } catch (error) {
        return resourceError(error);
      }
    },
  };
}

export type WorkflowDocuments = ReturnType<typeof workflowDocuments>;
