import { randomUUID } from "node:crypto";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { expect, test } from "@playwright/test";
import { TaskSchema } from "../../gen/a2a_pb.js";
import { SessionService } from "../../gen/kagent/api/v1/sessions_pb.js";
import { createdAtKey, partTypeKey, timelineKey } from "../../server/read-model/decode/messages.js";
import { bindSessions, client, observeTask, resetKagent } from "./kagent.js";

test("renders native forks, partial joins and returns between context instances", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  const api = createClient(
    SessionService,
    createGrpcTransport({ baseUrl: "http://127.0.0.1:8093" }),
  );
  const roles = ["coordinator", "inspection", "diagnosis", "remediation", "knowledge"];
  const sessions = await Promise.all(
    roles.map(async (role) => {
      const { session } = await api.createSession({
        agent: { namespace: "agentos", name: role },
        requestId: randomUUID(),
      });
      if (!session) throw new Error("DAG session missing");
      return session;
    }),
  );
  await bindSessions(
    request,
    sessions.map((session) => session.id),
  );
  const context = (role: string) => sessions[roles.indexOf(role)]?.id ?? "";
  const origin = Date.now() - 20000;
  const at = (ms: number) => new Date(origin + ms).toISOString();
  const events: [string, number, boolean][] = [
    ["inspection", 1000, false],
    ["diagnosis", 2000, false],
    ["inspection", 5000, true],
    ["remediation", 6000, false],
    ["remediation", 10000, true],
    ["diagnosis", 12000, true],
    ["knowledge", 13000, false],
    ["knowledge", 13500, true],
  ];
  for (const role of roles) {
    const background = role === "knowledge";
    const state = background ? "TASK_STATE_WORKING" : "TASK_STATE_COMPLETED";
    const recorded: JsonValue = {
      id: `dag-${role}`,
      contextId: context(role),
      metadata: { [createdAtKey]: at(0) },
      status: { state, timestamp: at(14000) },
      history: [
        { role: "ROLE_USER", messageId: `input-${role}`, parts: [{ text: "核验双分支方案" }] },
      ],
      artifacts:
        role !== "coordinator"
          ? []
          : events.map(
              ([target, time, returned], index): JsonValue => ({
                artifactId: `dag-event-${index}`,
                metadata: { [timelineKey]: at(time) },
                parts: [
                  {
                    metadata: { [partTypeKey]: `function_${returned ? "response" : "call"}` },
                    data: {
                      id: target,
                      name: target === "knowledge" ? "dispatch_session" : "invoke_session",
                      ...(returned
                        ? {
                            response: {
                              output:
                                target === "knowledge"
                                  ? {
                                      task: {
                                        id: "dag-knowledge",
                                        contextId: context(target),
                                        status: { state: "TASK_STATE_WORKING" },
                                      },
                                    }
                                  : {
                                      task_id: `dag-${target}`,
                                      session_id: context(target),
                                      state: "TASK_STATE_COMPLETED",
                                      text: "核验完成",
                                    },
                            },
                          }
                        : {
                            args:
                              target === "knowledge"
                                ? {
                                    contextId: context(target),
                                    messageId: `input-${target}`,
                                    role: "ROLE_USER",
                                    parts: [{ text: "核验双分支方案" }],
                                  }
                                : {
                                    session_id: context(target),
                                    message_id: `input-${target}`,
                                    message: "核验双分支方案",
                                  },
                          }),
                    },
                  },
                ],
              }),
            ),
    };
    await observeTask(request, fromJson(TaskSchema, recorded));
  }
  await expect
    .poll(async () => (await client.listTasks({ query: "dag-coordinator" })).tasks[0]?.id)
    .toBe("dag-coordinator");
  await page.goto("/system-tasks?task=dag-coordinator");
  const row = (role: string) =>
    page.locator(`.react-flow__node[data-id="session:${context(role)}"] [data-row]`);
  await expect(row("inspection")).toHaveAttribute("data-row", "2");
  await expect(row("diagnosis")).toHaveAttribute("data-row", "2");
  await expect(row("remediation")).toHaveAttribute("data-row", "3");
  await expect(row("knowledge")).toHaveAttribute("data-row", "4");
  const position = async (role: string) => {
    const box = await row(role).boundingBox();
    if (!box) throw new Error(`Missing node: ${role}`);
    return box;
  };
  const inspection = await position("inspection"),
    diagnosis = await position("diagnosis"),
    remediation = await position("remediation"),
    knowledge = await position("knowledge");
  expect(inspection.y).toBeCloseTo(diagnosis.y, 1);
  expect(Math.abs(inspection.x - diagnosis.x)).toBeGreaterThan(inspection.width);
  expect(remediation.y).toBeGreaterThan(inspection.y + inspection.height);
  expect(knowledge.y).toBeGreaterThan(remediation.y + remediation.height);
  await expect(page.locator(".react-flow__node-agent")).toHaveCount(5);
  await expect(
    page.getByTestId("collaboration-graph").locator('[data-agent="agentos/knowledge"]'),
  ).toHaveAttribute("data-state", "WORKING");
  const paths = page.locator(".react-flow__edge-path");
  await expect(paths).toHaveCount(4);
  const curves = await paths.evaluateAll((paths) =>
    paths.map((path) => path.getAttribute("d") ?? ""),
  );
  expect(curves.every((path) => path.match(/C/g)?.length === 1 && !/[LQHV]/.test(path))).toBe(true);
});

test("separates two contexts of one engineer and reuses the first without moving its node", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  const api = createClient(
    SessionService,
    createGrpcTransport({ baseUrl: "http://127.0.0.1:8093" }),
  );
  const sessions = await Promise.all(
    ["coordinator", "inspection", "inspection"].map(async (role) => {
      const { session } = await api.createSession({
        agent: { namespace: "agentos", name: role },
        requestId: randomUUID(),
      });
      if (!session) throw new Error("instance missing");
      return session.id;
    }),
  );
  await bindSessions(request, sessions);
  const [root = "", first = "", second = ""] = sessions;
  const origin = Date.now() - 20000;
  const at = (ms: number) => new Date(origin + ms).toISOString();
  const rounds = [
    {
      id: "instance-a",
      contextId: first,
      prompt: "- 目标：核验设备 A\n- 上下文：原资产记录\n- 交付：差异清单\n- 边界：只读",
    },
    {
      id: "instance-b",
      contextId: second,
      prompt: `核验设备 B 的独立上下文\n上下文：preparedRevision=${"d".repeat(64)}。\n${"保留已确认的事实及证据引用，核验范围为设备当前状态和现有记录。".repeat(24)}\n末尾证据：[原始记录](/system-tasks?task=original)`,
    },
    {
      id: "instance-a-followup",
      contextId: first,
      prompt: "- 新增：核对设备 A 的管理地址\n- 交付：地址结论",
    },
  ];
  const task = (round: (typeof rounds)[number], working = false) =>
    fromJson(TaskSchema, {
      id: round.id,
      contextId: round.contextId,
      metadata: { [createdAtKey]: at(round.id.endsWith("followup") ? 8000 : 0) },
      status: {
        state: working ? "TASK_STATE_WORKING" : "TASK_STATE_COMPLETED",
        timestamp: at(15000),
      },
      history: [
        { role: "ROLE_USER", messageId: `input-${round.id}`, parts: [{ text: round.prompt }] },
      ],
    });
  for (const round of rounds) await observeTask(request, task(round, round.contextId === second));
  const events: [number, number, boolean][] = [
    [0, 1000, false],
    [1, 2000, false],
    [0, 5000, true],
    [1, 6000, true],
    [2, 8000, false],
    [2, 10000, true],
  ];
  await observeTask(
    request,
    fromJson(TaskSchema, {
      id: "instances-root",
      contextId: root,
      metadata: { [createdAtKey]: at(0) },
      status: { state: "TASK_STATE_COMPLETED", timestamp: at(16000) },
      history: [
        { role: "ROLE_USER", messageId: "instances-input", parts: [{ text: "对比两台设备" }] },
      ],
      artifacts: events.map(([index, time, returned]) => {
        const round = rounds[index];
        if (!round) throw new Error("round missing");
        return {
          artifactId: `${round.id}-${returned}`,
          metadata: { [timelineKey]: at(time) },
          parts: [
            {
              metadata: { [partTypeKey]: `function_${returned ? "response" : "call"}` },
              data: {
                id: round.id,
                name: "invoke_session",
                ...(returned
                  ? {
                      response: {
                        output: {
                          task_id: round.id,
                          session_id: round.contextId,
                          state: "TASK_STATE_COMPLETED",
                          text: "已核验",
                        },
                      },
                    }
                  : {
                      args: {
                        session_id: round.contextId,
                        message_id: `input-${round.id}`,
                        message: round.prompt,
                      },
                    }),
              },
            },
          ],
        };
      }),
    }),
  );
  await expect
    .poll(async () => (await client.listTasks({ query: "instances-root" })).tasks[0]?.id)
    .toBe("instances-root");
  await page.goto("/system-tasks?task=instances-root");
  const instance = (id: string) => page.locator(`[data-instance="${id}"]`);
  await expect(page.locator(".react-flow__node-agent")).toHaveCount(3);
  const labels = page.locator(".react-flow__edgelabel-renderer button");
  await expect(labels).toHaveCount(2);
  const repeated = labels.filter({ hasText: "2 轮" });
  await expect(repeated).toHaveCount(1);
  await expect(instance(first)).toHaveAttribute("data-state", "SUCCEEDED");
  await expect(instance(second)).toHaveAttribute("data-state", "WORKING");
  const names = await page.locator('[data-agent="agentos/inspection"] strong').allTextContents();
  expect(new Set(names).size).toBe(2);
  const geometry = () =>
    page
      .locator(".react-flow__viewport, .react-flow__node")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("style")));
  const before = await geometry();
  const other = rounds[1];
  if (!other) throw new Error("second context missing");
  await observeTask(request, task(other));
  await expect(instance(second)).toHaveAttribute("data-state", "SUCCEEDED");
  expect(await geometry()).toEqual(before);
  await instance(first).click();
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer.getByTestId("task-prompt")).toContainText("新增：核对设备 A");
  await expect(drawer.getByTestId("task-prompt").locator("li")).toHaveCount(2);
  await page.getByTestId("execution-picker").click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("option").first().click();
  await expect(drawer.getByTestId("task-prompt").locator("li")).toHaveCount(4);
  await expect(drawer).not.toContainText(other.prompt);
  await drawer.getByRole("button", { name: /关闭/ }).click();
  await expect(drawer).not.toBeVisible();
  await repeated.click();
  const picker = drawer.getByTestId("round-picker");
  await expect(picker).toContainText("第 3 轮");
  await expect(drawer.getByTestId("call-input")).toContainText("核对设备 A 的管理地址");
  await picker.click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("option").first().click();
  await expect(picker).toContainText("第 1 轮");
  await expect(drawer.getByTestId("call-input")).toContainText("核验设备 A");
  await expect(drawer.getByTestId("call-input")).not.toContainText("核对设备 A 的管理地址");
  await expect(page.getByTestId("execution-picker")).toHaveCount(0);
  await drawer.getByRole("button", { name: /关闭/ }).click();
  await instance(second).click();
  const prompt = drawer.getByTestId("task-prompt");
  const expand = prompt.getByRole("button", { name: "展开全文" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(prompt).not.toContainText("末尾证据");
  const viewport = drawer.locator('[data-slot="scroll-area-viewport"]');
  expect(
    await viewport.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await expand.click();
  await expect(prompt).toContainText("末尾证据");
  await expect(prompt.getByRole("link", { name: "原始记录" })).toHaveAttribute(
    "href",
    "/system-tasks?task=original",
  );
  await prompt.getByRole("button", { name: "收起全文" }).click();
  await expect(prompt).not.toContainText("末尾证据");
  await expect(page.getByTestId("execution-picker")).toHaveCount(0);
});
