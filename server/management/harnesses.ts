import { create, type JsonObject } from "@bufbuild/protobuf";
import type {
  DeleteHarnessRequest,
  SaveHarnessRequest,
} from "../../gen/agentos/management/v1/management_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1alpha1/common_pb.js";
import { HarnessSchema } from "../../gen/kagent/api/v1alpha1/harnesses_pb.js";
import { object, text } from "../read-model/decode/messages.js";
import { conflict, invalid } from "../shared/errors.js";
import { meta, resource } from "./native.js";
import type { ResourceStore } from "./resources.js";

export function asHarness(value: JsonObject) {
  const spec = object(value.spec);
  const conditions = object(value.status).conditions;
  return create(HarnessSchema, {
    ref: { namespace: text(meta(value).namespace), name: text(meta(value).name) },
    resource: resource(value),
    runtime: ["kagent", "codex", "claude", "byo"].find((key) => spec[key] !== undefined) ?? "",
    workloadImage: text(object(spec.workload).image),
    ready:
      Array.isArray(conditions) &&
      conditions.some((item) => object(item).type === "Ready" && object(item).status === "True"),
  });
}

export function harnessCommands(store: ResourceStore, namespace: string) {
  function local(ref: ResourceReference | undefined) {
    if (!ref?.name || (ref.namespace && ref.namespace !== namespace))
      throw invalid("harness.invalidReference");
    return ref.name;
  }
  async function list(requestedNamespace: string) {
    if (requestedNamespace && requestedNamespace !== namespace)
      throw invalid("harness.invalidReference");
    return { harnesses: (await store.list("harnesses")).map(asHarness) };
  }
  async function save(request: SaveHarnessRequest) {
    const name = local(request.harness?.ref);
    const value = request.harness?.resource?.value;
    if (
      value?.kind !== "Harness" ||
      (meta(value).name && meta(value).name !== name) ||
      (meta(value).namespace && meta(value).namespace !== namespace)
    )
      throw invalid("harness.invalidReference");
    if (!request.create && !meta(value).resourceVersion) throw conflict("configuration.conflict");
    const saved = await store.save(
      "harnesses",
      { ...value, metadata: { ...meta(value), name, namespace } },
      request.create,
    );
    return { harness: asHarness(saved) };
  }
  async function remove(request: DeleteHarnessRequest) {
    const name = local(request.ref);
    const current = await store.get("harnesses", name);
    if (object(meta(current).labels)["app.kubernetes.io/managed-by"] === "Helm")
      throw invalid("harness.presetProtected");
    if (
      (await store.list("agents")).some(
        (item) => object(object(item.spec).harnessRef).name === name,
      )
    )
      throw invalid("harness.inUse");
    await store.remove("harnesses", name, request.resourceVersion);
    return {};
  }
  return { list, save, remove };
}
