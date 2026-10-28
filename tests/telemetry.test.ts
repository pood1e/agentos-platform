import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";

const processes = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of processes) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
  }
  processes.clear();
});

async function start(settings: Record<string, string>) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("OTEL_")),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./server/apps/telemetry.ts",
      "--input-type=module",
      "--eval",
      `import {createServer} from 'node:http';
       import {metrics} from '@opentelemetry/api';
       const calls = metrics.getMeter('core').createCounter('core.requests');
       const server = createServer((req,res) => { calls.add(1); res.end('ready'); });
       server.listen(0, '127.0.0.1', () => console.log(server.address().port));
       process.once('SIGTERM', () => server.close());`,
    ],
    {
      env: {
        ...env,
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
        OTEL_METRIC_EXPORT_INTERVAL: "100",
        OTEL_METRIC_EXPORT_TIMEOUT: "300",
        OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: "300",
        ...settings,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.add(child);
  let diagnostic = "";
  child.stderr?.on("data", (data: Buffer) => {
    diagnostic += data.toString();
  });
  if (!child.stdout) throw new Error("Core stdout is unavailable");
  const [data] = await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw new Error(`Core exited before readiness: ${diagnostic}`);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Readiness timeout")), 5000).unref(),
    ),
  ]);
  const url = `http://127.0.0.1:${Number(String(data).trim())}`;
  for (const path of ["/readyz", "/request"])
    expect(await (await fetch(url + path, { signal: AbortSignal.timeout(2000) })).text()).toBe(
      "ready",
    );
  return async () => {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([
      exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Shutdown timeout")), 3000).unref(),
      ),
    ]);
    processes.delete(child);
    expect(child.exitCode).toBe(0);
    expect(diagnostic.length).toBeLessThan(8192);
  };
}

it("starts, serves and exits with telemetry unconfigured", async () => {
  await (await start({}))();
});

it.each(["not-an-otlp-url", "http://127.0.0.1:1/v1/metrics"])(
  "keeps core readiness, requests and shutdown available with collector %s",
  async (endpoint) => {
    const stop = await start({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await stop();
  },
);

it("exports only when enabled and keeps disabled telemetry silent", async () => {
  const requests: { contentType: string; bytes: number }[] = [];
  const collector = createServer(async (request, response) => {
    let bytes = 0;
    for await (const data of request) bytes += data.length;
    requests.push({ contentType: request.headers["content-type"] ?? "", bytes });
    response.end();
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("Collector did not listen");
  const settings = {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${address.port}/v1/metrics`,
  };
  try {
    const disabled = await start({ ...settings, OTEL_SDK_DISABLED: "true" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await disabled();
    expect(requests).toEqual([]);
    const enabled = await start(settings);
    for (let attempt = 0; !requests.length && attempt < 30; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await enabled();
    expect(
      requests.some(
        (request) => request.contentType === "application/x-protobuf" && request.bytes > 0,
      ),
    ).toBe(true);
  } finally {
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
}, 15000);
