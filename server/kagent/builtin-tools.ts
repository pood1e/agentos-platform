import { create, type JsonObject } from "@bufbuild/protobuf";
import { EngineerToolsSchema } from "../../gen/agentos/console/v1/engineer_pb.js";
import type { AgentTemplate } from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import type { Agent } from "../../gen/kagent/api/v1alpha1/agents_pb.js";
import type { Harness } from "../../gen/kagent/api/v1alpha1/harnesses_pb.js";
import { agentKey } from "../read-model/agents.js";
import { object, text } from "../read-model/decode/messages.js";

const descriptions = {
  ask_user: "Ask the user for information needed to continue.",
  save_memory: "Save a verified finding and its sources to knowledge.",
  load_memory: "Search knowledge for relevant findings and sources.",
  preload_memory: "Automatically retrieve relevant knowledge before answering.",
  list_skills: "List the skills available to this engineer.",
  load_skill: "Read a skill's instructions.",
  load_skill_resource: "Read references, scripts and other files in a skill.",
  read_file: "Read a file in the engineer's execution workspace.",
  write_file: "Write a file in the engineer's execution workspace.",
  edit_file: "Replace text in a file in the engineer's execution workspace.",
  bash: "Run a command in the engineer's execution workspace.",
  list_files: "List files in the engineer's workspace or skills directory.",
  grep_file: "Search file contents in the engineer's workspace or skills directory.",
} satisfies Record<string, string>;

type Builtin = keyof typeof descriptions;

/** Mirrors the pinned Go ADK's memory, skill and user-input tool registration. */
export function builtinTools(template: JsonObject, harness: JsonObject) {
  if (harness.kagent === undefined) return [];
  const names: Builtin[] = ["ask_user"];
  if (object(harness.kagent).memory !== undefined)
    names.push("save_memory", "load_memory", "preload_memory");
  if (Array.isArray(template.skills) && template.skills.length) {
    names.push(
      "list_skills",
      "load_skill",
      "load_skill_resource",
      "read_file",
      "write_file",
      "edit_file",
      "bash",
    );
    const env = Array.isArray(harness.env) ? harness.env.map(object) : [];
    if (
      env.some(
        (entry) =>
          entry.name === "KAGENT_ENABLE_FILE_SEARCH_TOOLS" &&
          /^(true|t|1)$/i.test(text(entry.value)),
      )
    )
      names.push("list_files", "grep_file");
  }
  return names.map((name) => ({ name, description: descriptions[name] }));
}

export function engineerTools(agents: Agent[], templates: AgentTemplate[], harnesses: Harness[]) {
  const templateSpecs = new Map(
    templates.map((entry) => [agentKey(entry.ref), object(entry.resource?.value?.spec)]),
  );
  const harnessSpecs = new Map(
    harnesses.map((entry) => [agentKey(entry.ref), object(entry.resource?.value?.spec)]),
  );
  return agents.map((agent) => {
    const spec = object(agent.resource?.value?.spec);
    const namespace = agent.ref?.namespace ?? "";
    const resolve = (field: "template" | "harness", specs: ReadonlyMap<string, JsonObject>) =>
      spec[field] !== undefined
        ? object(spec[field])
        : (specs.get(`${namespace}/${text(object(spec[`${field}Ref`]).name)}`) ?? {});
    return create(EngineerToolsSchema, {
      engineer: agent.ref,
      builtinTools: builtinTools(
        resolve("template", templateSpecs),
        resolve("harness", harnessSpecs),
      ),
    });
  });
}
