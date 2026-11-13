import type { ToolServer } from "../gen/kagent/api/v1/tools_pb.js";

export const kagentApiVersion = "api.kagent.dev/v1alpha3";
export const defaultModelConfig = "default-model-config";
export const displayNameAnnotation = "agentos.dev/display-name";

/** Native tool server references are `namespace/name`. */
export const toolServerName = (server: Pick<ToolServer, "ref">) =>
  server.ref.split("/").at(-1) ?? server.ref;

/** Set on a workspace directory page when some native authorities could not answer. */
export const partialDirectoryHeader = "x-agentos-directory-partial";
