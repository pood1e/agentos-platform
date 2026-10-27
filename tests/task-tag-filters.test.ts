import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { environment, operator } from "./harness.js";

it("filters tags before paging and counting, binds cursors to tags and exposes only visible root vocabulary", async () => {
  const env = await environment();
  const reader = { subject: operator.subject, administrator: false };
  try {
    await env.reconcile.refresh();
    const all = await env.projection.operations(reader, { query: "", pageToken: "", pageSize: 3 });
    const [first, second, third] = all.tasks.map((task) => task.id);
    if (!first || !second || !third) throw new Error("Missing fixture operations");
    await env.tags.save(first, ["analysis", "maintenance"], "0");
    await env.tags.save(second, ["analysis"], "0");
    await env.tags.save(third, ["other"], "0");
    await env.tags.save("invisible-task", ["private-tag"], "0");
    const request = { query: "", pageToken: "", pageSize: 1, tags: ["analysis"] };
    const page = await env.projection.operations(reader, request);
    expect(page.totalSize).toBe(2);
    expect(page.availableTags).toEqual(["analysis", "maintenance", "other"]);
    expect(page.tasks[0]?.tags).toContain("analysis");
    expect(page.nextPageToken).not.toBe("");
    const next = await env.projection.operations(reader, {
      ...request,
      pageToken: page.nextPageToken,
    });
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]?.id).not.toBe(page.tasks[0]?.id);
    expect(next.nextPageToken).toBe("");
    await expect(
      env.projection.operations(reader, {
        ...request,
        tags: ["maintenance"],
        pageToken: page.nextPageToken,
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(
      (
        await env.projection.operations(reader, { ...request, tags: ["analysis", "maintenance"] })
      ).tasks.map((task) => task.id),
    ).toEqual([first]);
    expect(
      (await env.projection.operations(reader, { ...request, tags: [], query: "maintenance" }))
        .totalSize,
    ).toBe(1);
  } finally {
    await env.close();
  }
});
