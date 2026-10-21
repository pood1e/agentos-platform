import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { listTasks } from "../server/read-model/views/task.js";
import { fixtureIndex } from "./fixtures/kagent.js";

it("filters tags before paging and counting, binds cursors to tags and exposes only visible root vocabulary", () => {
  const index = fixtureIndex();
  const roots = index.relations().roots;
  const metadata = new Map([
    [roots[0].id, { tags: ["analysis", "maintenance"], tagsVersion: "1" }],
    [roots[1].id, { tags: ["analysis"], tagsVersion: "2" }],
    [roots[2].id, { tags: ["other"], tagsVersion: "1" }],
    ["invisible-task", { tags: ["private-tag"], tagsVersion: "1" }],
  ]);
  const request = { query: "", pageToken: "", pageSize: 1, tags: ["analysis"] };
  const page = listTasks(index, request, metadata);
  expect(page.totalSize).toBe(2);
  expect(page.availableTags).toEqual(["analysis", "maintenance", "other"]);
  expect(page.tasks[0].tags).toContain("analysis");
  expect(page.nextPageToken).not.toBe("");
  const next = listTasks(index, { ...request, pageToken: page.nextPageToken }, metadata);
  expect(next.tasks).toHaveLength(1);
  expect(next.tasks[0].id).not.toBe(page.tasks[0].id);
  expect(next.nextPageToken).toBe("");
  expect(() =>
    listTasks(
      index,
      { ...request, tags: ["maintenance"], pageToken: page.nextPageToken },
      metadata,
    ),
  ).toThrow(expect.objectContaining({ code: Code.InvalidArgument }));
  expect(
    listTasks(index, { ...request, tags: ["analysis", "maintenance"] }, metadata).tasks.map(
      (task) => task.id,
    ),
  ).toEqual([roots[0].id]);
  expect(listTasks(index, { ...request, tags: [], query: "maintenance" }, metadata).totalSize).toBe(
    1,
  );
});
