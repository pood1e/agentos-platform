import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Role, TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { MCPAppToolSchema, ToolServerSchema } from "../../gen/kagent/api/v1/tools_pb.js";
import { partTypeKey } from "../../server/read-model/decode/messages.js";
import type { FakeKagent } from "./kagent.js";

export const appService = "lab-views";
export const appUri = "ui://lab-views/topology.html";
export const appTools = () =>
  [
    ["show_topology", { resourceUri: appUri }],
    ["graph_data", { visibility: ["app"] }],
    ["model_only", { visibility: ["model"] }],
    ["destroy", { visibility: ["app"] }],
    ["unclassified", { visibility: ["app"] }],
  ].map(([name, ui]) =>
    create(MCPAppToolSchema, {
      name: `${appService}_${name}`,
      inputSchema: { value: { type: "object" } },
      meta: { value: { ui } },
    }),
  );
let html: Promise<string> | undefined;
export function appHTML() {
  html ??= import("vite")
    .then(({ build }) =>
      build({
        configFile: false,
        logLevel: "silent",
        build: {
          write: false,
          minify: true,
          target: "esnext",
          lib: { entry: "tests/fixtures/mcp-app-view.ts", formats: ["es"], fileName: "app" },
        },
      }),
    )
    .then((result) => {
      const bundle = Array.isArray(result) ? result[0] : result;
      if (!("output" in bundle)) throw new Error("App build output missing");
      const js = bundle.output.find((item) => item.type === "chunk");
      if (js?.type !== "chunk") throw new Error("App bundle missing");
      return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:var(--font-sans,system-ui);background:var(--color-background-primary);color:var(--color-text-primary);padding:12px}</style></head><body><script src="data:text/javascript,document.body.dataset.dataResource=%27loaded%27"></script><h2>Topology App</h2><p id="input"></p><p id="result"></p><p id="theme"></p><button id="query">Refresh graph</button><button id="prefill">Continue</button><button id="unsafe">Unsafe link</button><button id="destroy">Write tool</button><button id="other-service_graph_data">Other service</button><p id="denied"></p><output></output><script type="module">${js.code.replaceAll("</script", "<\\/script")}</script></body></html>`;
    });
  return html;
}

export function appScenario(fake: FakeKagent) {
  if (!fake.toolServers.some((server) => server.ref === `agentos/${appService}`))
    fake.toolServers.push(
      create(ToolServerSchema, {
        ref: `agentos/${appService}`,
        groupKind: "RemoteMCPServer.kagent.dev",
        discoveredTools: appTools().map((tool) => ({ name: tool.name })),
      }),
    );
  fake.resources.save(
    "agentgatewaybackends",
    {
      metadata: {
        name: appService,
        labels: { "agentos.dev/project": "views", "agentos.dev/environment": "lab" },
      },
      spec: { mcp: { targets: [{ name: appService }] } },
    },
    true,
  );
  fake.resources.save(
    "agentgatewaybackends",
    {
      metadata: {
        name: `${appService}-coordinator`,
        labels: { "agentos.dev/engineer": "assistant", "agentos.dev/tool-access": "readOnly" },
      },
      spec: { mcp: { targets: [{ name: appService }] } },
    },
    true,
  );
  fake.templates.set(
    "assistant",
    create(AgentTemplateSchema, {
      ref: { namespace: "agentos", name: "assistant" },
      resource: {
        value: {
          metadata: { name: "assistant" },
          spec: {
            systemPrompt: "Assist",
            tools: [
              {
                mcp: {
                  server: { name: "lab-views-assistant", kind: "RemoteMCPServer" },
                  tools: ["lab-views_show_topology", "lab-views_graph_data"],
                },
              },
            ],
          },
        },
      },
    }),
  );
  const session = fake.createSession(
    { namespace: "agentos", name: "assistant" },
    "apps-proof",
    "拓扑视图",
  );
  const callId = "app-call";
  const task = create(TaskSchema, {
    id: "apps-task",
    contextId: session.id,
    history: [
      {
        messageId: "apps-input",
        role: Role.USER,
        parts: [{ content: { case: "text", value: "展示拓扑" } }],
      },
    ],
    artifacts: [
      {
        artifactId: "apps-result",
        parts: [
          ...["function_call", "function_response"].map((kind) => ({
            metadata: { [partTypeKey]: kind },
            content: {
              case: "data" as const,
              value: fromJson(ValueSchema, {
                id: callId,
                name: `${appService}_show_topology`,
                ...(kind === "function_call"
                  ? { args: { scope: "datacenter" } }
                  : { response: { output: { devices: 12, port: 8080 } } }),
              }),
            },
          })),
          { content: { case: "text", value: "拓扑已展示。" } },
        ],
      },
    ],
  });
  fake.update(task, TaskState.COMPLETED);
  return { session, task, callId };
}
