import type { Interaction } from "../../../../gen/agentos/console/v1/task_pb.js";
import { awaiting } from "../../status/activity.js";
import { approvals } from "./approvals.js";
import type { Link } from "./links.js";
import { type CollaborationStep, eventTime, sequenceFor } from "./sequence.js";

export interface FlowActivity {
  id: string;
  agentId: string;
  taskId: string;
  kind: "entry" | "execution" | "resume" | "approval" | "continued" | "review";
  root: boolean;
  final: boolean;
  step?: CollaborationStep;
  interaction?: Interaction;
  returns: Link[];
  startedAt?: number;
  endedAt?: number;
}

export interface FlowConnection {
  id: string;
  source: string;
  target: string;
  phase: "dispatch" | "return" | "approval";
  link: Link;
}

interface TaskFlow {
  entry: FlowActivity;
  outgoing: CollaborationStep[];
  resumes: FlowActivity[];
}

const completion = (link: Link) => eventTime(link, "finished") ?? eventTime(link, "returned");

export interface FlowInput {
  participants: string[];
  links: Link[];
  root?: { taskId: string; agentId: string };
  window: { start?: number; completedAt?: number };
  interactions: Interaction[];
}

export function collaborationFlow({ participants, links, root, window, interactions }: FlowInput) {
  const steps = sequenceFor(links.filter((link) => link.kind !== "review"));
  const activities: FlowActivity[] = [];
  const connections: FlowConnection[] = [];
  const constraints: { source: string; target: string }[] = [];
  const tasks = new Map<string, TaskFlow>();
  const rootAgent = root?.agentId ?? participants[0];
  const addEntry = (taskId: string, agentId: string, step?: CollaborationStep) => {
    const isRoot = Boolean(root && taskId === root.taskId && !step);
    const entry: FlowActivity = {
      id: step?.link.id ?? `task:${taskId || agentId}`,
      agentId,
      taskId,
      kind: step ? "execution" : "entry",
      root: isRoot,
      final: false,
      step,
      returns: [],
      startedAt: step?.link.startedAt ?? (isRoot ? window.start : undefined),
      endedAt: step ? eventTime(step.link, "finished") : undefined,
    };
    activities.push(entry);
    return entry;
  };
  if (rootAgent) {
    const taskId = root?.taskId ?? "";
    tasks.set(taskId, { entry: addEntry(taskId, rootAgent), outgoing: [], resumes: [] });
  }
  const executions = new Map(
    steps.map((step) => [
      step.link.id,
      addEntry(step.link.targetTaskId ?? "", step.link.target, step),
    ]),
  );
  for (const step of steps) {
    const { link } = step;
    if (!tasks.has(link.sourceTaskId)) {
      const owners = [...executions.values()].filter(
        (entry) => entry.taskId === link.sourceTaskId && entry.agentId === link.source,
      );
      tasks.set(link.sourceTaskId, {
        entry:
          owners.length === 1 && owners[0] ? owners[0] : addEntry(link.sourceTaskId, link.source),
        outgoing: [],
        resumes: [],
      });
    }
    tasks.get(link.sourceTaskId)?.outgoing.push(step);
  }
  for (const task of tasks.values()) {
    const batches = new Map<string, Link[]>();
    const returned = task.outgoing
      .map(({ link }) => link)
      .filter(
        (link) =>
          link.kind === "invoke" &&
          eventTime(link, "returned") !== undefined &&
          !links.some(
            (next) => next.kind === "resume" && next.sourceTaskId === link.targetTaskId,
          ) &&
          !interactions.some(
            (interaction) =>
              interaction.taskId === link.targetTaskId && awaiting(interaction.state),
          ),
      )
      .sort((a, b) => (completion(a) ?? 0) - (completion(b) ?? 0) || a.id.localeCompare(b.id));
    for (const link of returned) {
      const next = task.outgoing.find(
        (step) =>
          step.link.id !== link.id &&
          step.link.startedAt !== undefined &&
          step.link.startedAt > (completion(link) ?? Infinity),
      );
      const key = next?.link.id ?? "final";
      batches.set(key, [...(batches.get(key) ?? []), link]);
    }
    for (const batch of batches.values()) {
      const first = batch[0];
      if (!first) continue;
      const resume: FlowActivity = {
        id: `resume:${first.id}`,
        agentId: task.entry.agentId,
        taskId: task.entry.taskId,
        kind: "resume",
        root: task.entry.root,
        final: false,
        returns: batch,
        startedAt: completion(batch.at(-1) ?? first),
        endedAt: completion(batch.at(-1) ?? first),
      };
      task.resumes.push(resume);
      activities.push(resume);
    }
    const last = task.resumes.at(-1) ?? task.entry;
    const hasLaterDispatch = task.outgoing.some(
      ({ link }) =>
        link.kind !== "background" &&
        (link.startedAt === undefined ||
          last.endedAt === undefined ||
          link.startedAt > last.endedAt),
    );
    last.final = !hasLaterDispatch;
    if (last.root && last.final) last.endedAt = window.completedAt ?? last.endedAt;
    for (let i = 1; i < task.resumes.length; i++) {
      const previous = task.resumes[i - 1];
      const current = task.resumes[i];
      if (previous && current) constraints.push({ source: previous.id, target: current.id });
    }
  }
  for (const step of steps) {
    const { link } = step;
    const task = tasks.get(link.sourceTaskId);
    const execution = executions.get(link.id);
    if (!task || !execution) continue;
    const source =
      task.resumes.findLast(
        (resume) =>
          !resume.returns.some((returned) => returned.id === link.id) &&
          link.startedAt !== undefined &&
          resume.startedAt !== undefined &&
          resume.startedAt < link.startedAt,
      ) ?? task.entry;
    connections.push({
      id: `dispatch:${link.id}`,
      source: source.id,
      target: execution.id,
      phase: "dispatch",
      link,
    });
    const destination = task.resumes.find((resume) => resume.returns.includes(link));
    if (!destination) continue;
    const child =
      link.targetTaskId && link.targetTaskId !== link.sourceTaskId
        ? tasks.get(link.targetTaskId)
        : undefined;
    const terminal =
      child?.resumes.findLast(
        (resume) =>
          resume.endedAt !== undefined &&
          completion(link) !== undefined &&
          resume.endedAt <= (completion(link) ?? 0),
      ) ?? execution;
    connections.push({
      id: `return:${link.id}`,
      source: terminal.id,
      target: destination.id,
      phase: "return",
      link,
    });
  }
  approvals(
    { activities, connections, constraints },
    interactions,
    sequenceFor(links.filter((link) => link.kind === "review")),
  );
  for (const agentId of participants) {
    if (!activities.some((activity) => activity.agentId === agentId)) addEntry("", agentId);
  }
  return { activities, connections, constraints, steps };
}

export type CollaborationFlow = ReturnType<typeof collaborationFlow>;
