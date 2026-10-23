import { readFileSync } from "node:fs";
import { coordinationQueue } from "./coordination.js";

const uri = process.env.AGENTOS_EXECUTION_DATABASE_URL;
if (!uri) throw new Error("AGENTOS_EXECUTION_DATABASE_URL is required");
const jobs = await coordinationQueue(
  uri,
  process.env.KAGENT_NAMESPACE ?? "agentos",
  { error: () => console.error("Coordination queue is unavailable") },
  process.env.AGENTOS_EXECUTION_DATABASE_CA
    ? readFileSync(process.env.AGENTOS_EXECUTION_DATABASE_CA, "utf8")
    : undefined,
);
try {
  const ids = process.argv.slice(2).filter((arg) => arg !== "--execute");
  const options = { ...(ids.length ? { ids } : {}), limit: 100 };
  console.log(await jobs.boss.previewRedrive(jobs.failed, options));
  if (process.argv.includes("--execute"))
    console.log("Replayed", await jobs.boss.redrive(jobs.failed, options));
} finally {
  await jobs.boss.stop();
}
