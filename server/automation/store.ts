import { create } from "@bufbuild/protobuf";
import postgres from "postgres";
import {
  type ScheduledRunPreset,
  ScheduledRunPresetSchema,
} from "../../gen/agentos/automation/v1/service_pb.js";

/** Native schedules the worker reserved for solution presets, shared with every replica. */
export async function presetStore(uri: string, workspace: string, ca?: string) {
  const sql = postgres(uri, {
    max: 2,
    connect_timeout: 10,
    idle_timeout: 20,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    onnotice: () => {},
  });
  try {
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('agentos_automation'))`;
      await transaction`create schema if not exists agentos_automation`;
      await transaction`revoke all on schema agentos_automation from public`;
      await transaction`create table if not exists agentos_automation.presets (
        workspace text not null, key text not null, scheduled_run_id text not null,
        primary key (workspace, key)
      )`;
    });
  } catch {
    await sql.end();
    throw new Error("Automation database is unavailable");
  }
  return {
    async list() {
      const rows = await sql`select key, scheduled_run_id from agentos_automation.presets
        where workspace = ${workspace} order by key`;
      return rows.map((row) =>
        create(ScheduledRunPresetSchema, { key: row.key, scheduledRunId: row.scheduled_run_id }),
      );
    },
    async replace(presets: ScheduledRunPreset[]) {
      await sql.begin(async (transaction) => {
        await transaction`delete from agentos_automation.presets where workspace = ${workspace}`;
        if (presets.length)
          await transaction`insert into agentos_automation.presets ${transaction(
            presets.map((preset) => ({
              workspace,
              key: preset.key,
              scheduled_run_id: preset.scheduledRunId,
            })),
          )}`;
      });
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
