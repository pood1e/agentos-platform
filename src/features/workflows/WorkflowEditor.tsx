import { clone, create } from "@bufbuild/protobuf";
import type { RJSFSchema } from "@rjsf/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, LoaderCircle, Play, RefreshCw, Save } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import {
  type Workflow,
  WorkflowLayoutSchema,
  WorkflowSchema,
} from "../../../gen/agentos/management/v1/workflow_pb.js";
import { object, text } from "../../../shared/json.js";
import { useAccess, useCapability } from "../../lib/access.js";
import { consoleClient, managementClient } from "../../lib/console.js";
import { graphScopes, nativeDocument } from "./document.js";
import { updateSpec, workflowOwner, workflowSpec } from "./draft.js";
import { useWorkflowPreparation } from "./use-workflow-preparation.js";
import { WorkflowFailure } from "./WorkflowFailure.js";
import { WorkflowGraph } from "./WorkflowGraph.js";
import { WorkflowSettings } from "./WorkflowSettings.js";

export function WorkflowEditor({ initial, isNew }: { initial: Workflow; isNew: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const access = useAccess().data;
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const [base, setBase] = useState(() => clone(WorkflowSchema, initial));
  const [name, setName] = useState(initial.agent?.ref?.name ?? "");
  const [source, setSource] = useState(initial.document);
  const [savedSource, setSavedSource] = useState(initial.document);
  const [savedSpec, setSavedSpec] = useState(JSON.stringify(workflowSpec(initial)));
  const [layout, setLayout] = useState(() => initial.layout ?? create(WorkflowLayoutSchema));
  const [scopeId, setScopeId] = useState("");
  const [selected, setSelected] = useState({ id: "", edge: false });
  const [input, setInput] = useState("");
  const message = useRef({ id: crypto.randomUUID(), text: "" });
  const schemas = useQuery({
    queryKey: ["workflows", "schema"],
    queryFn: () => managementClient.getWorkflowSchema({}),
    staleTime: Infinity,
  });
  const configuration = useQuery({
    queryKey: ["workflows", "configuration", access?.workspace?.uid, access?.subject],
    queryFn: () => consoleClient.getConfiguration({}),
  });
  const parsed = useMemo(() => {
    try {
      const result = nativeDocument(source);
      return { scopes: graphScopes(result.value) };
    } catch (error) {
      return { scopes: [], error };
    }
  }, [source]);
  const scope = parsed.scopes.find((item) => item.id === scopeId) ?? parsed.scopes[0];
  const dirty = isNew || source !== savedSource || JSON.stringify(workflowSpec(base)) !== savedSpec;
  const { query: current, ready: publishedReady, condition } = useWorkflowPreparation(base, isNew);
  function adopt(workflow: Workflow) {
    setBase(workflow);
    setSource(workflow.document);
    setSavedSource(workflow.document);
    setSavedSpec(JSON.stringify(workflowSpec(workflow)));
    setLayout(workflow.layout ?? create(WorkflowLayoutSchema));
  }
  function draft() {
    const workflow = clone(WorkflowSchema, base);
    workflow.document = source;
    workflow.layout = layout;
    if (
      isNew &&
      workflow.agent?.ref &&
      workflow.agent.resource &&
      workflow.agentTemplate?.ref &&
      workflow.agentTemplate.resource
    ) {
      workflow.agent.ref.name = name;
      workflow.agentTemplate.ref.name = name;
      const agent = workflow.agent.resource.value ?? {};
      workflow.agent.resource.value = {
        ...agent,
        metadata: { ...object(agent.metadata), name },
        spec: { ...object(agent.spec), template: { ref: { name } } },
      };
      const template = workflow.agentTemplate.resource.value ?? {};
      workflow.agentTemplate.resource.value = {
        ...template,
        metadata: { ...object(template.metadata), name },
      };
    }
    return workflow;
  }
  const publish = useMutation({
    mutationFn: () => managementClient.publishWorkflow({ workflow: draft(), create: isNew }),
    onSuccess: ({ workflow }) => {
      if (!workflow) return;
      adopt(workflow);
      void cache.invalidateQueries({ queryKey: ["workflows", "list"] });
      void cache.invalidateQueries({ queryKey: ["workflows", "ready"] });
      if (isNew) void navigate(`/workflows/${encodeURIComponent(name)}/edit`, { replace: true });
    },
  });
  const validate = useMutation({
    mutationFn: (_signature: string) => managementClient.validateWorkflow({ workflow: draft() }),
  });
  const saveLayout = useMutation({
    mutationFn: () =>
      managementClient.saveWorkflowLayout({
        ref: base.agent?.ref,
        layout,
        resourceVersion: text(object(workflowOwner(base).metadata).resourceVersion),
      }),
    onSuccess: ({ workflow }) => {
      if (workflow) setBase(workflow);
    },
  });
  const run = useMutation({
    mutationFn: () => {
      if (message.current.text !== input)
        message.current = { id: crypto.randomUUID(), text: input };
      return consoleClient.sendMessage({
        agent: base.agent?.ref,
        text: input,
        messageId: message.current.id,
      });
    },
    onSuccess: (result) =>
      void navigate(
        `/executions/${encodeURIComponent(name)}/${encodeURIComponent(result.contextId)}`,
      ),
  });
  const validationSignature = JSON.stringify([name, source, workflowSpec(base)]);
  const pending = publish.isPending || validate.isPending || saveLayout.isPending;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
      data-testid="workflow-editor"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to="/workflows" aria-label={t("workflow.back")}>
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {name || t("workflow.create")}
        </h1>
        <Badge variant={publishedReady ? "secondary" : "outline"}>
          {t(isNew ? "workflow.draft" : publishedReady ? "workflow.ready" : "workflow.preparing")}
        </Badge>
        {!isNew && (
          <Button
            variant="outline"
            disabled={pending || dirty || !current.data?.workflow}
            onClick={() => current.data?.workflow && adopt(current.data.workflow)}
          >
            <RefreshCw />
            {t("workflow.reload")}
          </Button>
        )}
        {editable && (
          <>
            <Button
              variant="outline"
              disabled={pending || !!parsed.error || !name}
              onClick={() => validate.mutate(validationSignature)}
            >
              {validate.isPending ? <LoaderCircle className="animate-spin" /> : <Check />}
              {t("workflow.validate")}
            </Button>
            <Button
              variant="outline"
              disabled={pending || isNew || dirty}
              onClick={() => saveLayout.mutate()}
            >
              <Save />
              {t("workflow.saveLayout")}
            </Button>
            <Button disabled={pending || !!parsed.error || !name} onClick={() => publish.mutate()}>
              {publish.isPending && <LoaderCircle className="animate-spin" />}
              {t("workflow.publish")}
            </Button>
          </>
        )}
      </header>
      {isNew && (
        <div className="space-y-2">
          <Label htmlFor="workflow-name">{t("configuration.identifier")}</Label>
          <Input
            id="workflow-name"
            value={name}
            maxLength={63}
            pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
            onChange={(event) => setName(event.target.value)}
            disabled={!editable || pending}
          />
        </div>
      )}
      <WorkflowFailure
        error={
          publish.error ??
          validate.error ??
          saveLayout.error ??
          run.error ??
          parsed.error ??
          schemas.error ??
          current.error
        }
      />
      {condition?.status === "False" && (
        <p role="status" className="text-sm text-muted-foreground">
          {text(condition.reason)}: {text(condition.message)}
        </p>
      )}
      {validate.isSuccess && validate.variables === validationSignature && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("workflow.valid")}
        </p>
      )}
      <Tabs defaultValue="graph" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="graph">{t("workflow.canvas")}</TabsTrigger>
          <TabsTrigger value="source">YAML</TabsTrigger>
          <TabsTrigger value="settings">{t("workflow.settings")}</TabsTrigger>
        </TabsList>
        <TabsContent value="graph" className="flex min-h-[32rem] flex-1 flex-col gap-3">
          <WorkflowGraph
            scopes={parsed.scopes}
            scope={scope}
            source={source}
            layout={layout}
            selected={selected}
            schema={schemas.data?.schema as RJSFSchema | undefined}
            editable={editable && !pending}
            setSource={setSource}
            setLayout={setLayout}
            onScope={setScopeId}
            onSelect={(id, edge) => setSelected({ id, edge })}
          />
        </TabsContent>
        <TabsContent value="source" className="flex min-h-96 flex-1">
          <Textarea
            aria-label={t("workflow.source")}
            value={source}
            spellCheck={false}
            className="min-h-96 flex-1 resize-y font-mono text-xs"
            readOnly={!editable || pending}
            onChange={(event) => {
              setSource(event.target.value);
              validate.reset();
            }}
          />
        </TabsContent>
        <TabsContent value="settings" className="overflow-y-auto p-1">
          <WorkflowSettings
            spec={workflowSpec(base)}
            identity={base.agentTemplate?.ref?.name || name}
            editable={editable && !pending}
            configuration={configuration.data}
            onChange={(spec) => setBase((value) => updateSpec(value, spec))}
          />
        </TabsContent>
      </Tabs>
      {!isNew && (
        <section className="flex flex-wrap gap-2 border-t pt-3">
          <Input
            aria-label={t("workflow.input")}
            placeholder={t("workflow.input")}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={run.isPending}
            className="min-w-56 flex-1"
          />
          <Button
            disabled={!publishedReady || dirty || !input.trim() || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}
            {t("workflow.run")}
          </Button>
          <Button asChild variant="outline">
            <Link to={`/workflows/${encodeURIComponent(name)}/history`}>
              {t("workflow.history")}
            </Link>
          </Button>
        </section>
      )}
    </div>
  );
}
