import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import type { EvaluationService } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { can, publicationCapabilities } from "../../shared/permissions.js";
import { requestIdentity } from "../platform/access.js";
import type { EvaluationStore } from "./store.js";

/** Public publication requires every affected resource permission before committing the snapshot. */
export function authorizedEvaluation(
  service: Required<ServiceImpl<typeof EvaluationService>>,
  store: Pick<EvaluationStore, "get">,
): Required<ServiceImpl<typeof EvaluationService>> {
  return {
    ...service,
    async publishCandidate(request, context) {
      const { snapshot } = await store.get(request.id);
      const capabilities = [
        Capability.EVALUATIONS_MANAGE,
        ...publicationCapabilities(snapshot.proposals),
      ];
      if (!capabilities.every((capability) => can(context.values.get(requestIdentity), capability)))
        throw new ConnectError("Permission denied", Code.PermissionDenied);
      return service.publishCandidate(request, context);
    },
  };
}
