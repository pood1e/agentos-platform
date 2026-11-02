import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import { useAccess, useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { newWorkflow } from "./draft.js";
import { WorkflowEditor } from "./WorkflowEditor.js";
import { WorkflowFailure } from "./WorkflowFailure.js";

export function WorkflowPage({ isNew = false }: { isNew?: boolean } = {}) {
  const { name = "" } = useParams();
  const { t } = useTranslation();
  const access = useAccess().data;
  const namespace = access?.workspace ?? "";
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const workflow = useQuery({
    queryKey: ["workflows", "definition", namespace, access?.subject, name],
    queryFn: () => managementClient.getWorkflow({ ref: { namespace, name } }),
    enabled: !!namespace && !isNew,
    refetchOnWindowFocus: false,
  });
  if (!namespace) return <p role="status">{t("management.loading")}</p>;
  if (isNew)
    return editable ? <WorkflowEditor key="new" initial={newWorkflow(namespace)} isNew /> : null;
  if (workflow.error) return <WorkflowFailure error={workflow.error} />;
  if (!workflow.data?.workflow) return <p role="status">{t("management.loading")}</p>;
  return (
    <WorkflowEditor key={`${namespace}/${name}`} initial={workflow.data.workflow} isNew={false} />
  );
}
