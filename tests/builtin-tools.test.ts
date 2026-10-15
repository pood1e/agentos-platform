import { create, type JsonObject } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AgentSchema } from "../gen/kagent/api/v1alpha1/agents_pb.js";
import { builtinTools, engineerTools } from "../server/kagent/builtin-tools.js";
import { environment } from "./harness.js";

describe("runtime-provided tools", () => {
  it("resolves memory per engineer even when they share a role", async () => {
    const { fake, clients } = environment();
    const { harnesses } = await clients.harnesses.listHarnesses({ namespace: "agentos" });
    const agents = ["standard", "memory"].map((harness) =>
      create(AgentSchema, {
        ref: { namespace: "agentos", name: `engineer-${harness}` },
        resource: {
          value: { spec: { templateRef: { name: "knowledge" }, harnessRef: { name: harness } } },
        },
      }),
    );
    const tools = engineerTools(agents, [...fake.templates.values()], harnesses);
    expect(tools[0]?.builtinTools.map((tool) => tool.name)).toEqual(["ask_user"]);
    expect(tools[1]?.builtinTools.map((tool) => tool.name)).toEqual([
      "ask_user",
      "save_memory",
      "load_memory",
      "preload_memory",
    ]);
  });

  it("supports inline configuration and does not infer tools for an unknown runtime", () => {
    const makeAgent = (harness: JsonObject) =>
      create(AgentSchema, {
        ref: { namespace: "agentos", name: "custom-engineer" },
        resource: { value: { spec: { template: { skills: [{ name: "delivery" }] }, harness } } },
      });
    const [native] = engineerTools([makeAgent({ kagent: {} })], [], []);
    expect(native?.builtinTools.map((tool) => tool.name)).toEqual([
      "ask_user",
      "list_skills",
      "load_skill",
      "load_skill_resource",
      "read_file",
      "write_file",
      "edit_file",
      "bash",
    ]);
    expect(engineerTools([makeAgent({ byo: {} })], [], [])[0]?.builtinTools).toEqual([]);
    expect(builtinTools({}, {})).toEqual([]);
  });

  it("shows optional filesystem search tools only when skills and their native flag are enabled", () => {
    const harness = {
      kagent: {},
      env: [{ name: "KAGENT_ENABLE_FILE_SEARCH_TOOLS", value: "true" }],
    };
    expect(builtinTools({}, harness).map((tool) => tool.name)).toEqual(["ask_user"]);
    const skill = { skills: [{ name: "triage" }] };
    expect(builtinTools(skill, harness).map((tool) => tool.name)).toContain("grep_file");
    expect(builtinTools(skill, { kagent: {} }).map((tool) => tool.name)).not.toContain("grep_file");
  });
});
