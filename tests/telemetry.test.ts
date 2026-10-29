import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";

const processes = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of processes) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
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
      `import {metrics} from '@opentelemetry/api';
       import {platformApp, closeOnSignal} from './server/apps/platform.ts';
       import {registerHealth} from './server/shared/health.ts';
       const calls = metrics.getMeter('core').createCounter('core.requests');
       const app = platformApp();
       app.log.level = 'silent';
       registerHealth(app, () => true);
       app.get('/request', async () => { calls.add(1); return 'ready'; });
       closeOnSignal(app, []);
       await app.listen({port: 0, host: '127.0.0.1'});
       console.log(app.server.address().port);`,
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
  for (const [path, status] of [
    ["/healthz", "ok"],
    ["/readyz", "ready"],
  ])
    expect(await (await fetch(url + path, { signal: AbortSignal.timeout(2000) })).json()).toEqual({
      status,
    });
  expect(await (await fetch(`${url}/request`, { signal: AbortSignal.timeout(2000) })).text()).toBe(
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
    return diagnostic;
  };
}

it("starts, serves and exits with telemetry unconfigured", async () => {
  await (await start({}))();
});

it.each([
  { protocol: "http/protobuf", endpoint: "not-an-otlp-url" },
  { protocol: "http/protobuf", endpoint: "http://127.0.0.1:1/v1/metrics" },
  { protocol: "grpc", endpoint: "http://127.0.0.1:1" },
])(
  "keeps core readiness, requests and shutdown available with $protocol collector $endpoint",
  async ({ protocol, endpoint }) => {
    const stop = await start({
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: protocol,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await stop();
  },
);

it("bounds diagnostics during repeated exporter failure at debug level", async () => {
  const stop = await start({
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics",
    OTEL_LOG_LEVEL: "DEBUG",
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const diagnostics = await stop();
  expect(diagnostics).toContain("OpenTelemetry:");
  expect(diagnostics.trim().split("\n").length).toBeLessThanOrEqual(8);
});

it("bounds initialization diagnostics for invalid exporter configuration", async () => {
  const stop = await start({
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "not-an-otlp-url",
    OTEL_METRICS_EXPORTER: "invalid-exporter".repeat(1000),
  });
  expect((await stop()).length).toBeLessThan(1024);
});

it("exits when a collector accepts requests without responding", async () => {
  const collector = createServer(() => {});
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("Collector did not listen");
  try {
    const exporting = once(collector, "request");
    const stop = await start({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${address.port}/v1/metrics`,
    });
    await exporting;
    await stop();
  } finally {
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
});

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
    const disabledModes: Record<string, string>[] = [
      { OTEL_SDK_DISABLED: "true" },
      { OTEL_METRICS_EXPORTER: "none" },
      { OTEL_METRICS_EXPORTER: "otlp, none" },
    ];
    for (const disabled of disabledModes) {
      const stop = await start({ ...settings, ...disabled });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await stop()).toBe("");
      expect(requests).toEqual([]);
    }
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
