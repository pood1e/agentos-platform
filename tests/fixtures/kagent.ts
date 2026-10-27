import { readFileSync } from "node:fs";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { type Task, TaskSchema } from "../../gen/a2a_pb.js";
import { type Agent, AgentSchema } from "../../gen/kagent/api/v1/agents_pb.js";
import { type Session, SessionSchema } from "../../gen/kagent/api/v1/sessions_pb.js";
import { agentInfo, type SessionInfo, sessionInfo } from "../../server/read-model/agents.js";
import { ingest, type TaskEntry } from "../../server/read-model/entry.js";
import { TaskGraph } from "../../server/read-model/graph.js";

/** Sanitized tasks recorded from the agentos kagent environment. */
const read = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./kagent/${name}.json`, import.meta.url), "utf8"),
  ) as JsonValue[];

export const fixtureAgents = (): Agent[] =>
  read("agents").map((item) => fromJson(AgentSchema, item));
export const fixtureSessions = (): Session[] =>
  read("sessions").map((item) => fromJson(SessionSchema, item));
export const fixtureTasks = (): Task[] => read("tasks").map((item) => fromJson(TaskSchema, item));

export const fixtureIds = {
  approvalRoot: "01a130a5-2363-76a6-8971-98a1a6459036",
  approvalContinuation: "01a130a8-764e-7c01-87c5-3fb41f07b490",
  approvalFinal: "01a130b0-9637-7d31-93f5-7e9fb23e9839",
  approved: "01a130a5-965c-73ec-8feb-0213f1e52dd5",
  question: "01a130a8-e89a-71b5-8310-92a258f760ac",
  rejected: "01a130bc-8bec-730a-a1e8-9efadfd9f185",
  dispatchRoot: "01a130dd-0e64-7b51-905e-22cfa972b980",
  inspection: "01a130dd-8a0c-7e3a-b122-4a7f18df2e4c",
  background: "01a130de-59b6-77b2-8e04-21a814d48ec9",
  builder: "01a13307-c0af-7ed4-b9f7-ee38d77b0a98",
  chat: "01a13309-e4a9-72f5-b164-5b98e3dc052b",
  chatContext: "01a13309-e1fc-7f0a-a274-21ac47fe36ca",
  chatRoot: "01a1330a-6edd-70a7-8d53-79b3d6516067",
  retiredMember: "01a1330c-3ef7-74ca-91ae-73d7f74b8e2e",
};

/** Projected fixture state that view tests amend before building an execution graph. */
export function fixtureState(tasks = fixtureTasks()) {
  const sessions = new Map(fixtureSessions().map((session) => [session.id, sessionInfo(session)]));
  const entries = new Map(
    tasks.map((task) => {
      const entry = ingest(task, sessions.get(task.contextId)?.agentId ?? "");
      return [entry.id, entry] as const;
    }),
  );
  const agents = fixtureAgents().map((agent) => agentInfo(agent));
  return {
    upsert: (entry: TaskEntry) => void entries.set(entry.id, entry),
    setSession: (session: SessionInfo) => void sessions.set(session.id, session),
    entry: (id: string) => entries.get(id),
    graph: () => new TaskGraph([...entries.values()], [...sessions.values()], agents),
  };
}

export const fixtureGraph = (tasks = fixtureTasks()) => fixtureState(tasks).graph();
