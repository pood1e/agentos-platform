import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { CoreV1Api, V1Secret } from "@kubernetes/client-node";
import { LRUCache } from "lru-cache";
import {
  type SpeechConfiguration,
  SpeechConfigurationSchema,
} from "../../gen/agentos/console/v1/speech_pb.js";
import type { SaveSpeechConfigurationRequest } from "../../gen/agentos/management/v1/management_pb.js";
import { resourceError } from "../management/resources.js";
import { invalid } from "../shared/errors.js";
import { validateSpeechConfiguration } from "./config.js";

export interface SpeechSettings {
  configuration: SpeechConfiguration;
  resourceVersion: string;
  transcriptionCredential?: string;
  synthesisCredential?: string;
}
export type SpeechSource = () => Promise<SpeechSettings>;

export const speechSettingsView = (settings: SpeechSettings) => ({
  configuration: settings.configuration,
  resourceVersion: settings.resourceVersion,
  transcriptionCredentialConfigured: !!settings.transcriptionCredential,
  synthesisCredentialConfigured: !!settings.synthesisCredential,
});

/** Configuration and credentials change in one versioned Kubernetes Secret. */
export function speechSettingsStore(
  core: Pick<CoreV1Api, "readNamespacedSecret" | "replaceNamespacedSecret">,
  namespace: string,
  name: string,
) {
  const decode = (value?: string) => (value ? Buffer.from(value, "base64").toString("utf8") : "");
  async function settings(secret: V1Secret): Promise<SpeechSettings> {
    const configuration = validateSpeechConfiguration(
      fromJsonString(
        SpeechConfigurationSchema,
        decode(secret.data?.["configuration.json"]) || "{}",
      ),
    );
    const reference = decode(secret.data?.["credentials-secret"]);
    const providers = ["transcription", "synthesis"] as const;
    const external =
      reference &&
      providers.some(
        (kind) => configuration[kind] && !Object.hasOwn(secret.data ?? {}, `${kind}-api-key`),
      )
        ? await core.readNamespacedSecret({ namespace, name: reference })
        : undefined;
    const credential = (kind: (typeof providers)[number]) =>
      decode(
        Object.hasOwn(secret.data ?? {}, `${kind}-api-key`)
          ? secret.data?.[`${kind}-api-key`]
          : external?.data?.[`${kind}-api-key`],
      );
    return {
      configuration,
      resourceVersion: secret.metadata?.resourceVersion ?? "",
      transcriptionCredential: credential("transcription"),
      synthesisCredential: credential("synthesis"),
    };
  }
  async function read() {
    try {
      return await settings(await core.readNamespacedSecret({ namespace, name }));
    } catch (error) {
      return resourceError(error);
    }
  }
  const cache = new LRUCache<string, SpeechSettings>({ max: 1, ttl: 1000, fetchMethod: read });
  return {
    async load() {
      return (await cache.fetch(name)) ?? read();
    },
    async get() {
      return speechSettingsView(await read());
    },
    async save(request: SaveSpeechConfigurationRequest) {
      let configuration: SpeechConfiguration;
      try {
        if (!request.configuration) throw new Error("Missing configuration");
        configuration = validateSpeechConfiguration(request.configuration);
      } catch {
        throw invalid("management.invalid");
      }
      try {
        const current = await core.readNamespacedSecret({ namespace, name });
        const data: Record<string, string> = {
          ...current.data,
          "configuration.json": Buffer.from(
            toJsonString(SpeechConfigurationSchema, configuration),
          ).toString("base64"),
        };
        for (const kind of ["transcription", "synthesis"] as const) {
          const key = request[`${kind}Credential`];
          if (key !== undefined)
            data[`${kind}-api-key`] = Buffer.from(key.trim()).toString("base64");
        }
        const updated = await core.replaceNamespacedSecret({
          namespace,
          name,
          body: {
            ...current,
            metadata: { ...current.metadata, resourceVersion: request.resourceVersion },
            data,
          },
        });
        const snapshot = await settings(updated);
        cache.set(name, snapshot);
        return { settings: speechSettingsView(snapshot) };
      } catch (error) {
        return resourceError(error);
      }
    },
  };
}
export type SpeechSettingsStore = ReturnType<typeof speechSettingsStore>;
