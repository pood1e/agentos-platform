import type { ListEngineerRunsRequest } from "../../gen/agentos/console/v1/console_service_pb.js";
import type { TaskEntry } from "./entry.js";
import type { Viewer } from "./listings.js";
import { pageOf } from "./page.js";
import type { TaskRecord } from "./records.js";
import { terminal } from "./state.js";
import { engineerRun } from "./views/run.js";
import { runState } from "./views/runs.js";

interface RunSource {
  list(viewer: Viewer, engineer: string): Promise<TaskRecord[]>;
  read(viewer: Viewer, records: TaskRecord[]): Promise<TaskEntry[]>;
  background(entries: TaskEntry[]): Promise<Map<string, boolean>>;
}

export function engineerRunListings(source: RunSource) {
  return {
    async engineerRuns(viewer: Viewer, request: ListEngineerRunsRequest) {
      const states = [...new Set(request.states)].sort((a, b) => a - b);
      const records = await source.list(viewer, request.engineer);
      // State filters resolve active interactions before selecting a page.
      const live = await source.read(
        viewer,
        records.filter(
          ({ summary }) =>
            (states.length > 0 && !terminal(summary.state)) ||
            (summary.statusAt ?? summary.createdAt) === undefined,
        ),
      );
      const hydrated = new Map(live.map((entry) => [entry.id, entry]));
      const rows = records
        .map((record) => ({ record, entry: hydrated.get(record.summary.id) ?? record.summary }))
        .filter(({ entry }) => !states.length || states.includes(runState(entry)))
        .map((row) => ({
          ...row,
          id: row.entry.id,
          time: row.entry.statusAt ?? row.entry.createdAt ?? 0,
        }))
        .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const scope = `engineer-runs:${JSON.stringify([viewer.subject, request.engineer, states, viewer.systemOnly === true])}`;
      const page = pageOf(rows, { ...request, query: "" }, scope, (row) => row);
      for (const entry of await source.read(
        viewer,
        page.items.filter(({ id }) => !hydrated.has(id)).map(({ record }) => record),
      ))
        hydrated.set(entry.id, entry);
      const entries = page.items.flatMap(({ id }) => hydrated.get(id) ?? []);
      const background = await source.background(entries);
      return {
        runs: entries.map((entry) => engineerRun(entry, background.get(entry.id) ?? false)),
        nextPageToken: page.nextPageToken,
      };
    },
  };
}
