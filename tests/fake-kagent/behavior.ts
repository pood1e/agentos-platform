import { randomUUID } from "node:crypto";
import { create, fromJson, type JsonValue, toJson, toJsonString } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  ArtifactSchema,
  type Message,
  MessageSchema,
  type Part,
  PartSchema,
  Role,
  SendMessageResponseSchema,
  type Task,
  TaskSchema,
  TaskState,
} from "../../gen/a2a_pb.js";
import { RoleDefinitionSchema } from "../../gen/agentos/console/v1/role_pb.js";
import { InvokeSessionOutputSchema } from "../../gen/kagent/api/v1/collaboration_pb.js";
import {
  messageText,
  parentTaskKey,
  partTypeKey,
  timelineKey,
} from "../../server/read-model/decode/messages.js";
import { fixtureIds, fixtureTasks } from "../fixtures/kagent.js";
import type { FakeKagent } from "./kagent.js";
import { awaitingApproval } from "./scenario.js";

function activity(name: string, args: JsonValue, output: JsonValue): Part[] {
  const id = randomUUID();
  return [
    create(PartSchema, {
      metadata: { [partTypeKey]: "function_call" },
      content: { case: "data", value: fromJson(ValueSchema, { id, name, args }) },
    }),
    create(PartSchema, {
      metadata: { [partTypeKey]: "function_response" },
      content: { case: "data", value: fromJson(ValueSchema, { id, name, response: { output } }) },
    }),
  ];
}

function finish(fake: FakeKagent, task: Task, text: string, parts: Part[] = []) {
  task.artifacts.push(
    create(ArtifactSchema, {
      artifactId: randomUUID(),
      metadata: { [timelineKey]: new Date(fake.now()).toISOString() },
      parts: [...parts, { content: { case: "text", value: text } }],
    }),
  );
  fake.update(task, TaskState.COMPLETED);
}

async function pausedOperation(fake: FakeKagent, text: string, parentId: string) {
  const fixtures = fixtureTasks();
  const root = fixtures.find((item) => item.id === fixtureIds.approvalRoot);
  const original = fixtures.find((item) => item.id === fixtureIds.approved);
  if (!root || !original) throw new Error("approval fixtures missing");
  const child = awaitingApproval(original);
  const owner = await fake.createChildSession(
    parentId,
    { namespace: "agentos", name: "coordinator" },
    text,
  );
  const member = await fake.createChildSession(
    owner.id,
    { namespace: "agentos", name: "remediation" },
    text,
  );
  const replacements = new Map([
    [root.id, randomUUID()],
    [child.id, randomUUID()],
    [root.contextId, owner.id],
    [child.contextId, member.id],
  ]);
  for (const task of [root, child])
    for (const message of task.history) replacements.set(message.messageId, randomUUID());
  const copy = (task: Task) =>
    fromJson(
      TaskSchema,
      JSON.parse(
        [...replacements].reduce(
          (json, [from, to]) => json.replaceAll(from, to),
          toJsonString(TaskSchema, task),
        ),
      ),
    );
  const operation = copy(root);
  const pending = copy(child);
  fake.update(operation, TaskState.COMPLETED);
  fake.update(pending, TaskState.INPUT_REQUIRED, pending.status?.message);
  return operation;
}

async function knowledge(fake: FakeKagent, task: Task) {
  const session = await fake.createChildSession(
    task.contextId,
    { namespace: "agentos", name: "knowledge" },
    "沉淀执行结果",
  );
  const message = create(MessageSchema, {
    messageId: randomUUID(),
    contextId: session.id,
    role: Role.USER,
    parts: [{ content: { case: "text", value: `沉淀任务 ${task.id} 已核验的结果，并保留来源。` } }],
  });
  const accepted = fake.accept(message);
  return activity(
    "dispatch_session",
    { session_id: session.id, message_id: message.messageId, message: messageText(message) },
    toJson(
      SendMessageResponseSchema,
      create(SendMessageResponseSchema, { payload: { case: "task", value: accepted } }),
    ),
  );
}

/** Deterministic role behavior; every result is delivered through the native A2A protocol. */
export async function execute(fake: FakeKagent, task: Task, message: Message) {
  if (fake.tasks.get(task.id) !== task || task.status?.state === TaskState.CANCELED) return;
  const role = fake.sessions.get(task.contextId)?.agent?.name;
  const text = messageText(message);
  if (role === "role-builder") {
    const draft = create(RoleDefinitionSchema, {
      name: "readonly-helper",
      displayName: "巡检助手",
      description: "只读检查服务运行状态",
      systemPrompt: "使用只读工具检查工作负载健康，报告证据与来源。",
      tools: [
        { server: "kagent-tool-server", tools: ["k8s_get_resources"], requireApproval: false },
        { server: "team-sessions", tools: ["search_knowledge"] },
      ],
    });
    return finish(
      fake,
      task,
      "工程师草稿已准备。",
      activity(
        "prepare_role",
        toJson(RoleDefinitionSchema, draft),
        toJson(RoleDefinitionSchema, draft),
      ),
    );
  }
  if (role === "assistant" && /configmap/i.test(text) && !message.metadata?.[parentTaskKey]) {
    const operation = await pausedOperation(fake, text, task.contextId);
    const user = operation.history.find((item) => item.role === Role.USER);
    const output = create(InvokeSessionOutputSchema, {
      sessionId: operation.contextId,
      contextId: operation.contextId,
      taskId: operation.id,
      state: TaskState.INPUT_REQUIRED,
      text: "等待用户审批。",
    });
    return finish(
      fake,
      task,
      "变更方案已交给团队，等待你的审批。",
      activity(
        "invoke_session",
        { session_id: operation.contextId, message_id: user?.messageId ?? "", message: text },
        toJson(InvokeSessionOutputSchema, output),
      ),
    );
  }
  if (role === "coordinator" && message.metadata?.[parentTaskKey])
    return finish(
      fake,
      task,
      "用户决定已处理，执行结果已核验；知识正在后台沉淀。",
      await knowledge(fake, task),
    );
  if (role === "knowledge")
    return finish(fake, task, "知识已保存并回查来源。", [
      ...activity("save_memory", { content: text }, { saved: true }),
      ...activity("load_memory", { query: task.id }, { source: task.id }),
    ]);
  finish(fake, task, `已处理：${text}`);
}
