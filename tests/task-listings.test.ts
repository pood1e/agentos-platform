import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { environment, operator } from "./harness.js";

it("filters and counts executions before paging and binds cursors to their filters", async () => {
  const env = await environment();
  const reader = { subject: operator.subject, administrator: false };
  const request = { query: "", pageToken: "", pageSize: 1 };
  try {
    const all = await env.projection.operations(reader, { ...request, pageSize: 100 });
    expect(all.tasks.length).toBeGreaterThan(1);
    const [head, second] = all.tasks;
    if (!head || !second) throw new Error("Missing fixture executions");
    const state = head.state;
    const filtered = await env.projection.operations(reader, {
      ...request,
      pageSize: 100,
      states: [state],
    });
    const expected = all.tasks.filter((task) => task.state === state).map((task) => task.id);
    expect(filtered.tasks.map((task) => task.id)).toEqual(expected);
    expect(filtered.totalSize).toBe(expected.length);

    const first = await env.projection.operations(reader, request);
    expect(first.totalSize).toBe(all.totalSize);
    expect(first.nextPageToken).not.toBe("");
    const next = await env.projection.operations(reader, {
      ...request,
      pageToken: first.nextPageToken,
    });
    expect(next.tasks.map((task) => task.id)).toEqual([second.id]);
    expect(next.totalSize).toBe(all.totalSize);
    await expect(
      env.projection.operations(reader, {
        ...request,
        states: [state],
        pageToken: first.nextPageToken,
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(
      (await env.projection.operations(reader, { ...request, query: "no-such-execution" }))
        .totalSize,
    ).toBe(0);
  } finally {
    await env.close();
  }
});
