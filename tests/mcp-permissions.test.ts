import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ToolBindingSchema } from "../gen/agentos/console/v1/role_pb.js";
import { ConnectionSchema } from "../gen/agentos/management/v1/management_pb.js";
import { ToolServerSchema } from "../gen/kagent/api/v1/tools_pb.js";
import { serverTargets } from "../server/governance/access-plans.js";
import { ToolBindings } from "../server/governance/tool-bindings.js";
import { ownIdentities, toolRequirements } from "../src/features/agents/mcp-services.js";
import { newRole } from "../src/features/agents/role-draft.js";
import { fixturePlans } from "./fixtures/access-plans.js";

const access = new ToolBindings(serverTargets(fixturePlans()));
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
  tools("kagent-collaboration", ["search_memory"]),
];

describe("Agent tool access", () => {
  it("starts role drafts with available native team memory", () => {
    const draft = newRole();
    expect(access.bindings("inspection", draft.tools, "validate")).toEqual(draft.tools);
  });

  it("merges overlapping identities without duplicate tools or weaker approval requirements", () => {
    const bindings = [
      create(ToolBindingSchema, {
        server: "lab-kubernetes-remediation",
        tools: [read, write],
      }),
      create(ToolBindingSchema, {
        server: "lab-kubernetes-remediation-changes",
        tools: [read, write],
      }),
    ];
    const merged = access.bindings("remediation", bindings, "normalize");
    expect(merged).toEqual([
      create(ToolBindingSchema, { server: "lab-kubernetes-remediation", tools: [read] }),
      create(ToolBindingSchema, {
        server: "lab-kubernetes-remediation-changes",
        tools: [write],
        requireApproval: true,
      }),
    ]);
    expect(access.bindings("remediation", merged ?? [], "normalize")).toEqual(merged);
  });

  it("offers only the Agent's own identities and platform servers", () => {
    const permissions = access.requirements("inspection");
    const names = new Set(permissions.map((item) => item.server));
    expect(names.has("lab-kubernetes-inspection")).toBe(true);
    expect(names.has("kagent-collaboration")).toBe(true);
    expect(names.has("kagent-tool-server")).toBe(true);
    expect(names.has("lab-kubernetes-remediation")).toBe(false);
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
        "validate",
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
    expect(access.bindings("inspection", borrowed, "validate")).toBeUndefined();
    expect(access.bindings("inspection", borrowed, "normalize")).toEqual([]);
  });

  it("uses ready policy decisions for configuration while rejecting unknown tools", () => {
    const bindings = [
      create(ToolBindingSchema, { server: "kagent-collaboration", tools: ["search_memory"] }),
      create(ToolBindingSchema, { server: "lab-kubernetes-remediation", tools: [read, write] }),
    ];
    expect(access.requirements("remediation")).toContainEqual(
      expect.objectContaining({
        server: "lab-kubernetes-remediation-changes",
        tool: write,
        requireApproval: true,
      }),
    );
    expect(access.bindings("remediation", bindings, "validate")).toEqual([
      create(ToolBindingSchema, { server: "kagent-collaboration", tools: ["search_memory"] }),
      create(ToolBindingSchema, { server: "lab-kubernetes-remediation", tools: [read] }),
      create(ToolBindingSchema, {
        server: "lab-kubernetes-remediation-changes",
        tools: [write],
        requireApproval: true,
      }),
    ]);
    expect(
      access.bindings(
        "remediation",
        [
          ...bindings,
          create(ToolBindingSchema, { server: "kagent-collaboration", tools: ["unknown_tool"] }),
        ],
        "validate",
      ),
    ).toBeUndefined();
    expect(
      access.bindings(
        "remediation",
        [create(ToolBindingSchema, { server: "lab-kubernetes-remediation", tools: ["pods_list"] })],
        "validate",
      ),
    ).toBeUndefined();
  });

  it("keeps simulation write tools in their write view without approval pauses", () => {
    const simulation = new ToolBindings(
      serverTargets(
        fixturePlans().map((plan) => ({
          ...plan,
          status: {
            ...plan.status,
            targets: plan.status?.targets?.map((target) => ({
              ...target,
              tools: target.tools?.map((tool) => ({ ...tool, requireApproval: false })),
            })),
          },
        })),
      ),
    );
    expect(simulation.requirements("remediation")).toContainEqual(
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
        "validate",
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
        "validate",
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
      credentialBindings: [{ identity: "inspection", server: servers[1] }],
    });
    expect(ownIdentities("inspection", service).map((item) => item.ref)).toEqual([
      "agentos/lab-kubernetes-inspection",
    ]);
    expect(ownIdentities("diagnosis", service)).toEqual([]);
  });
});

it("requires an explicit execution identity for environment tool bindings", () => {
  const policy = new ToolBindings(
    new Map([
      [
        "ownerless",
        {
          server: "ownerless",
          service: "ops",
          environment: "lab",
          catalog: false,
          tools: [{ name: "inspect", write: false, requireApproval: false }],
        },
      ],
    ]),
  );
  expect(policy.usable("analysis", "ownerless")).toBe(false);
  expect(
    policy.bindings(
      "analysis",
      [create(ToolBindingSchema, { server: "ownerless", tools: ["ops_inspect"] })],
      "validate",
    ),
  ).toBeUndefined();
});
