import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAccess } from "../../lib/access.js";
import { consoleClient, managementClient } from "../../lib/console.js";
import { ExecutionScopeTabs, useExecutionScope } from "../shared/execution-scope.js";
import { pageSize } from "../shared/paging.js";
import { WorkflowFailure } from "./WorkflowFailure.js";

export function WorkflowHistory() {
  const { name = "" } = useParams();
  const { t } = useTranslation();
  const access = useAccess().data;
  const namespace = access?.workspace?.namespace ?? "";
  const scope = useExecutionScope();
  const { systemOnly } = scope;
  // Page tokens are bound to the execution scope that issued them.
  const [cursor, setCursor] = useState({ systemOnly, token: "" });
  const token = cursor.systemOnly === systemOnly ? cursor.token : "";
  const setToken = (next: string) => setCursor({ systemOnly, token: next });
  const [session, setSession] = useState("");
  const runs = useQuery({
    queryKey: ["workflows", "history", namespace, access?.subject, name, systemOnly, token],
    queryFn: () =>
      consoleClient.listAgentRuns({
        agent: { namespace, name },
        pageSize,
        pageToken: token,
        systemOnly,
      }),
    enabled: !!namespace,
    refetchInterval: 5000,
  });
  const definition = useQuery({
    queryKey: ["workflows", "session", namespace, access?.subject, session],
    queryFn: () => managementClient.getSessionWorkflow({ sessionId: session }),
    enabled: !!session,
  });
  return (
    <section className="min-h-0 flex-1 space-y-4 overflow-y-auto">
      <header className="flex items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">
          {name} · {t("workflow.history")}
        </h1>
        <ExecutionScopeTabs scope={scope} />
        <Button asChild variant="outline">
          <Link to={`/workflows/${encodeURIComponent(name)}/edit`}>{t("workflow.back")}</Link>
        </Button>
      </header>
      <WorkflowFailure error={runs.error ?? definition.error} />
      <div className="divide-y rounded-lg border">
        {runs.data?.runs.map((run) => (
          <div key={run.taskId} className="flex flex-wrap items-center gap-2 p-3">
            <p className="min-w-0 flex-1 truncate text-sm">{run.prompt || run.taskId}</p>
            <Button variant="ghost" size="sm" onClick={() => setSession(run.contextId)}>
              {t("workflow.pinnedDefinition")}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link
                to={`/executions/${encodeURIComponent(name)}/${encodeURIComponent(run.contextId)}`}
              >
                {t("task.execution")}
              </Link>
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={!token} onClick={() => setToken("")}>
          {t("workflow.firstPage")}
        </Button>
        <Button
          variant="outline"
          disabled={!runs.data?.nextPageToken}
          onClick={() => setToken(runs.data?.nextPageToken ?? "")}
        >
          {t("workflow.nextPage")}
        </Button>
      </div>
      {definition.data && (
        <div className="space-y-2">
          <p className="break-all font-mono text-xs">{definition.data.preparedRevision}</p>
          <Textarea
            readOnly
            className="min-h-80 font-mono text-xs"
            aria-label={t("workflow.pinnedDefinition")}
            value={new TextDecoder().decode(definition.data.document)}
          />
        </div>
      )}
    </section>
  );
}
