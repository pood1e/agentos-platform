import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AgentSchema } from "../gen/kagent/api/v1/agents_pb.js";
import { builtinTools, engineerTools } from "../server/kagent/builtin-tools.js";
import { environment } from "./harness.js";

const filesystem = ["read_file", "write_file", "edit_file", "bash", "list_files", "grep_file"];

describe("runtime-provided tools", () => {
  it("resolves memory per engineer even when they share a role", async () => {
    const { fake, clients } = environment();
    const { harnesses } = await clients.harnesses.listHarnesses({ namespace: "agentos" });
    const agents = ["standard", "memory"].map((harness) =>
      create(AgentSchema, {
        ref: { namespace: "agentos", name: `engineer-${harness}` },
        resource: {
          value: {
            spec: { template: { ref: { name: "knowledge" } }, harnessRef: { name: harness } },
          },
        },
      }),
    );
    const tools = engineerTools(agents, [...fake.templates.values()], harnesses);
    expect(tools[0]?.builtinTools.map((tool) => tool.name)).toEqual(["ask_user", ...filesystem]);
    expect(tools[1]?.builtinTools.map((tool) => tool.name)).toEqual([
      "ask_user",
      ...filesystem,
      "save_memory",
      "load_memory",
      "preload_memory",
    ]);
  });

  it("resolves inline templates through their referenced Harness", async () => {
    const { clients } = environment();
    const { harnesses } = await clients.harnesses.listHarnesses({ namespace: "agentos" });
    const makeAgent = (harness: string) =>
      create(AgentSchema, {
        ref: { namespace: "agentos", name: "custom-engineer" },
        resource: {
          value: {
            spec: {
              template: { inline: { skills: [{ name: "delivery" }] } },
              harnessRef: { name: harness },
            },
          },
        },
      });
    const [native] = engineerTools([makeAgent("standard")], [], harnesses);
    expect(native?.builtinTools.map((tool) => tool.name)).toEqual([
      "ask_user",
      ...filesystem,
      "list_skills",
      "load_skill",
      "load_skill_resource",
    ]);
    expect(engineerTools([makeAgent("unknown")], [], harnesses)[0]?.builtinTools).toEqual([]);
    expect(builtinTools({}, {})).toEqual([]);
  });

  it("provides native filesystem tools independently of skills", () => {
    const names = builtinTools({}, { kagent: {} }).map((tool) => tool.name);
    expect(names).toEqual(["ask_user", ...filesystem]);
    expect(
      builtinTools({ skills: [{ name: "triage" }] }, { kagent: {} }).map((tool) => tool.name),
    ).toEqual([...names, "list_skills", "load_skill", "load_skill_resource"]);
  });
});
