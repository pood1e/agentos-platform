import { readFileSync } from "node:fs";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ToolBindingSchema } from "../gen/agentos/console/v1/role_pb.js";
import { ConnectionSchema } from "../gen/agentos/management/v1/management_pb.js";
import { ToolServerSchema } from "../gen/kagent/api/v1alpha1/tools_pb.js";
import { serverTargets, ToolBindings } from "../server/governance/bindings.js";
import { parseCatalog } from "../shared/tool-catalog.js";
import { ownIdentities, toolRequirements } from "../src/features/engineers/mcp-services.js";

const pack = new URL("fixtures/pack/", import.meta.url);
const file = (name: string) => readFileSync(new URL(name, pack), "utf8");
const platformTools = readFileSync(
  new URL("../charts/agentos/presets/platform-tools.yaml", import.meta.url),
  "utf8",
);
const backend = (name: string, labels: Record<string, string>, service = name): JsonObject => ({
  metadata: { name, labels },
  spec: { mcp: { targets: [{ name: service }] } },
});
const environment = { "agentos.dev/environment": "lab", "agentos.dev/governance": "approval" };
const access = new ToolBindings(
  parseCatalog(file("toolsets.yaml"), platformTools),
  serverTargets([
    backend("lab-kubernetes", { ...environment, "agentos.dev/project": "kubernetes" }),
    backend(
      "lab-kubernetes-inspection",
      {
        ...environment,
        "agentos.dev/engineer": "inspection",
        "agentos.dev/tool-access": "readOnly",
      },
      "lab-kubernetes",
    ),
    backend(
      "lab-kubernetes-remediation",
      {
        ...environment,
        "agentos.dev/engineer": "remediation",
        "agentos.dev/tool-access": "readOnly",
      },
      "lab-kubernetes",
    ),
    backend(
      "lab-kubernetes-remediation-changes",
      { ...environment, "agentos.dev/engineer": "remediation", "agentos.dev/tool-access": "write" },
      "lab-kubernetes",
    ),
  ]),
);
const tools = (name: string, names: string[]) =>
  create(ToolServerSchema, {
    ref: `agentos/${name}`,
    discoveredTools: names.map((tool) => ({ name: tool })),
  });
const read = "lab-kubernetes_pods_list";
const write = "lab-kubernetes_resources_create_or_update";
const exec = "lab-kubernetes_pods_exec";
const servers = [
  tools("lab-kubernetes", [read, write]),
  tools("lab-kubernetes-inspection", [read, write]),
  tools("lab-kubernetes-remediation", [read]),
  tools("lab-kubernetes-remediation-changes", [write, exec]),
  tools("team-sessions", ["search_knowledge"]),
];

describe("engineer tool access", () => {
  it("intersects the caller's write permission with the Agent's environment ceiling and denies unknown tools", () => {
    expect(access.permitsCall("inspection", ["lab-kubernetes"], "pods_list", false)).toBe(true);
    expect(
      access.permitsCall("inspection", ["lab-kubernetes"], "resources_create_or_update", true),
    ).toBe(false);
    expect(
      access.permitsCall("remediation", ["lab-kubernetes"], "resources_create_or_update", false),
    ).toBe(false);
    expect(
      access.permitsCall("remediation", ["lab-kubernetes"], "resources_create_or_update", true),
    ).toBe(true);
    expect(access.permitsCall("remediation", ["lab-kubernetes"], "unknown", true)).toBe(false);
    expect(access.permitsCall("remediation", ["unrelated"], "pods_list", true)).toBe(false);
    expect(access.permitsTool("remediation", write, false)).toBe(false);
    expect(access.permitsTool("inspection", write, true)).toBe(false);
    expect(access.permitsTool("inspection", "create_session", false)).toBe(true);
  });
  it("offers only the engineer's own identities and platform servers", () => {
    const permissions = access.requirements("inspection", servers);
    expect(new Set(permissions.map((item) => item.server))).toEqual(
      new Set(["lab-kubernetes-inspection", "team-sessions"]),
    );
    expect(permissions).toContainEqual(
      expect.objectContaining({ tool: read, requireApproval: false }),
    );
    expect(permissions).not.toContainEqual(
      expect.objectContaining({ tool: write, requireApproval: true }),
    );
  });

  it("requires confirmation for writes and rejects borrowed identities", () => {
    expect(
      access.bindings(
        "remediation",
        [
          {
            $typeName: "agentos.console.v1.ToolBinding",
            server: "lab-kubernetes-remediation",
            tools: [read, write],
            requireApproval: false,
          },
        ],
        servers,
        true,
      ),
    ).toEqual([
      expect.objectContaining({
        server: "lab-kubernetes-remediation",
        tools: [read],
        requireApproval: false,
      }),
      expect.objectContaining({
        server: "lab-kubernetes-remediation-changes",
        tools: [write],
        requireApproval: true,
      }),
    ]);
    const borrowed = [
      {
        $typeName: "agentos.console.v1.ToolBinding" as const,
        server: "lab-kubernetes-remediation",
        tools: [read],
        requireApproval: false,
      },
    ];
    expect(access.bindings("inspection", borrowed, servers, true)).toBeUndefined();
    expect(access.bindings("inspection", borrowed, servers, false)).toEqual([]);
  });

  it.each([
    ["missing servers", []],
    ["empty discovery", servers.map((server) => tools(server.ref.split("/").at(-1) ?? "", []))],
    ["partial discovery", [tools("team-sessions", ["list_agents"])]],
  ])(
    "preserves configured tools during %s without weakening execution requirements",
    (_name, discovered) => {
      const bindings = [
        create(ToolBindingSchema, { server: "team-sessions", tools: ["search_knowledge"] }),
        create(ToolBindingSchema, { server: "lab-kubernetes-remediation", tools: [read, write] }),
        create(ToolBindingSchema, { server: "lab-kubernetes-inspection", tools: [read] }),
        create(ToolBindingSchema, { server: "team-sessions", tools: ["unknown_tool"] }),
      ];
      expect(access.bindings("remediation", bindings, discovered, false)).toEqual([
        create(ToolBindingSchema, { server: "team-sessions", tools: ["search_knowledge"] }),
        create(ToolBindingSchema, { server: "lab-kubernetes-remediation", tools: [read] }),
        create(ToolBindingSchema, {
          server: "lab-kubernetes-remediation-changes",
          tools: [write],
          requireApproval: true,
        }),
      ]);
      expect(
        access.bindings("remediation", bindings.slice(0, 2), discovered, true),
      ).toBeUndefined();
    },
  );

  it("keeps simulation write tools in their write view without approval pauses", () => {
    const simulation = new ToolBindings(
      parseCatalog(file("toolsets.yaml"), platformTools),
      serverTargets([
        backend("lab-kubernetes", {
          ...environment,
          "agentos.dev/governance": "direct",
          "agentos.dev/project": "kubernetes",
        }),
        backend(
          "lab-kubernetes-remediation",
          {
            ...environment,
            "agentos.dev/engineer": "remediation",
            "agentos.dev/tool-access": "readOnly",
          },
          "lab-kubernetes",
        ),
        backend(
          "lab-kubernetes-remediation-changes",
          {
            ...environment,
            "agentos.dev/engineer": "remediation",
            "agentos.dev/tool-access": "write",
          },
          "lab-kubernetes",
        ),
      ]),
    );
    expect(simulation.requirements("remediation", servers)).toContainEqual(
      expect.objectContaining({
        server: "lab-kubernetes-remediation-changes",
        tool: write,
        requireApproval: false,
      }),
    );
    expect(
      simulation.bindings(
        "remediation",
        [
          create(ToolBindingSchema, {
            server: "lab-kubernetes-remediation",
            tools: [read, write],
            requireApproval: true,
          }),
        ],
        servers,
        true,
      ),
    ).toEqual([
      expect.objectContaining({
        server: "lab-kubernetes-remediation",
        tools: [read],
        requireApproval: false,
      }),
      expect.objectContaining({
        server: "lab-kubernetes-remediation-changes",
        tools: [write],
        requireApproval: false,
      }),
    ]);
    expect(
      simulation.bindings(
        "inspection",
        [
          create(ToolBindingSchema, {
            server: "lab-kubernetes-remediation-changes",
            tools: [write],
          }),
        ],
        servers,
        true,
      ),
    ).toBeUndefined();
  });

  it("reads decisions and identities in the role editor", () => {
    const lookup = toolRequirements([
      {
        $typeName: "agentos.console.v1.ToolRequirement",
        server: "s",
        tool: "t",
        requireApproval: true,
      },
    ]);
    expect(lookup("s", "t")).toBe(true);
    expect(lookup("s", "other")).toBeUndefined();
    const service = create(ConnectionSchema, {
      credentialBindings: [{ engineer: "inspection", server: servers[1] }],
    });
    expect(ownIdentities("inspection", service).map((item) => item.ref)).toEqual([
      "agentos/lab-kubernetes-inspection",
    ]);
    expect(ownIdentities("diagnosis", service)).toEqual([]);
  });
});
