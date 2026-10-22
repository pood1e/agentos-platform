import type { JsonObject } from "@bufbuild/protobuf";
import type {
  ConfigurationSnapshot,
  ResourceProposal,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { meta } from "../management/native.js";
import { object, text } from "../read-model/decode/messages.js";
import { type Variant, variantName } from "./names.js";

const probe = "probe";

export function evaluationSubject(
  resources: JsonObject[],
  proposals: ResourceProposal[],
  namespace: string,
  reference: string,
) {
  const changed = proposals.flatMap((proposal) =>
    !proposal.delete && proposal.resource?.value ? [proposal.resource.value] : [],
  );
  const agents = resources.filter((value) => value.kind === "Agent");
  const agent =
    changed.find((value) => value.kind === "Agent") ??
    agents.find((value) => {
      const spec = object(value.spec);
      return changed.some(
        (entry) =>
          (entry.kind === "AgentTemplate" &&
            meta(entry).name === object(object(spec.template).ref).name) ||
          (entry.kind === "Harness" && meta(entry).name === object(spec.harnessRef).name) ||
          (entry.kind === "ModelConfig" &&
            resources.some(
              (template) =>
                template.kind === "AgentTemplate" &&
                meta(template).name === object(object(spec.template).ref).name &&
                object(object(template.spec).modelConfig).name === meta(entry).name,
            )),
      );
    });
  if (agent) return { subject: { namespace, name: text(meta(agent).name) } };
  if (!agents.some((value) => meta(value).name === reference))
    throw new Error("Evaluation reference agent is missing");
  return {
    subject: { namespace, name: reference },
    subjectModelConfig: text(
      meta(changed.find((value) => value.kind === "ModelConfig") ?? {}).name,
    ),
    subjectHarness: text(meta(changed.find((value) => value.kind === "Harness") ?? {}).name),
  };
}

export function sampleAgent(
  snapshot: ConfigurationSnapshot,
  sample: string,
  variant: Variant,
  prefix: string,
) {
  if (sample !== "$subject") return variantName(prefix, sample);
  const subject = snapshot.subject?.name;
  if (!subject) throw new Error("Evaluation subject is missing");
  const existed = snapshot.resources.some(
    (entry) => entry.kind === "Agent" && text(object(entry.value?.metadata).name) === subject,
  );
  const name =
    variant === "released" && !existed
      ? snapshot.baseline?.referenceAgent
      : variant === "candidate" && (snapshot.subjectHarness || snapshot.subjectModelConfig)
        ? probe
        : subject;
  if (!name) throw new Error("Evaluation reference agent is missing");
  return variantName(prefix, name);
}

export function subjectProbe(snapshot: ConfigurationSnapshot, values: JsonObject[]) {
  if (!snapshot.subjectModelConfig && !snapshot.subjectHarness) return [];
  const agent = values.find(
    (value) => value.kind === "Agent" && meta(value).name === snapshot.subject?.name,
  );
  const spec = object(agent?.spec);
  const template = values.find(
    (value) =>
      value.kind === "AgentTemplate" && meta(value).name === object(object(spec.template).ref).name,
  );
  if (!agent || !template) throw new Error("Evaluation reference configuration is missing");
  const templateSpec = object(template.spec);
  return [
    {
      ...template,
      metadata: { ...meta(template), name: probe },
      spec: {
        ...templateSpec,
        ...(snapshot.subjectModelConfig
          ? {
              modelConfig: {
                ...object(templateSpec.modelConfig),
                name: snapshot.subjectModelConfig,
              },
            }
          : {}),
      },
    },
    {
      ...agent,
      metadata: { ...meta(agent), name: probe },
      spec: {
        ...spec,
        template: { ref: { ...object(object(spec.template).ref), name: probe } },
        ...(snapshot.subjectHarness
          ? { harnessRef: { ...object(spec.harnessRef), name: snapshot.subjectHarness } }
          : {}),
      },
    },
  ];
}
