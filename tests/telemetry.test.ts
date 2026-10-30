import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createHTTP2Server, type ServerHttp2Session } from "node:http2";
import { afterEach, expect, it } from "vitest";

const processes = new Map<ChildProcess, Promise<unknown>>();
const collectors = new Set<Server>();
afterEach(async () => {
  for (const [child, exited] of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
  processes.clear();
  for (const collector of collectors) {
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
  collectors.clear();
});

async function collector(handler: RequestListener) {
  const server = createServer(handler);
  collectors.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector did not listen");
  return `http://127.0.0.1:${address.port}/v1/metrics`;
}

async function start(settings: Record<string, string | undefined>) {
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
       console.log('READY ' + app.server.address().port);`,
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
  const exited = once(child, "exit");
  processes.set(child, exited);
  let diagnostic = "";
  let stdout = "";
  child.stderr?.on("data", (data: Buffer) => {
    diagnostic += data.toString();
  });
  const port = await Promise.race([
    new Promise<string>((resolve) => {
      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
        const match = /^READY (\d+)$/m.exec(stdout);
        if (match?.[1]) resolve(match[1]);
      });
    }),
    exited.then(() => {
      throw new Error(`Core exited before readiness: ${diagnostic}`);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Readiness timeout")), 5000).unref(),
    ),
  ]);
  const request = async () => {
    for (const [path, status] of [
      ["/healthz", "ok"],
      ["/readyz", "ready"],
    ])
      expect(
        await (
          await fetch(`http://127.0.0.1:${port}${path}`, {
            signal: AbortSignal.timeout(2000),
          })
        ).json(),
      ).toEqual({ status });
    expect(
      await (
        await fetch(`http://127.0.0.1:${port}/request`, {
          signal: AbortSignal.timeout(2000),
        })
      ).text(),
    ).toBe("ready");
  };
  await request();
  return {
    request,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Shutdown timeout")), 3000).unref(),
        ),
      ]);
      processes.delete(child);
      expect(child.exitCode).toBe(0);
      const logs = diagnostic + stdout.replace(/^READY \d+\n/m, "");
      expect(logs.length).toBeLessThan(1024);
      expect(logs).not.toContain("collector-secret");
      return logs;
    },
  };
}

it("starts, serves and exits with telemetry unconfigured", async () => {
  expect(await (await start({})).stop()).toBe("");
});

it.each([
  { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "not-an-otlp-url" },
  { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics" },
  {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc",
  },
  {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "not-an-otlp-url",
    OTEL_METRICS_EXPORTER: "invalid-exporter".repeat(1000),
  },
  {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics",
    OTEL_METRIC_EXPORT_INTERVAL: "-1",
  },
])("keeps core available with invalid or unavailable telemetry: %j", async (settings) => {
  const core = await start(settings);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await core.request();
  await core.stop();
});

it("bounds repeated Collector errors, even with SDK debug logging enabled", async () => {
  let exports = 0;
  const endpoint = await collector((request, response) => {
    request.resume();
    exports++;
    response.writeHead(400);
    response.end("collector-secret".repeat(1000));
  });
  const core = await start({
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
    OTEL_LOG_LEVEL: "ALL",
  });
  await expect.poll(() => exports).toBeGreaterThanOrEqual(5);
  await core.request();
  expect(await core.stop()).toContain("OpenTelemetry");
});

it("bounds shutdown when the Collector hangs despite a long configured timeout", async () => {
  let exports = 0;
  const endpoint = await collector((request) => {
    request.resume();
    exports++;
  });
  const core = await start({
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TIMEOUT: "60000",
    OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: "60000",
    OTEL_METRIC_EXPORT_TIMEOUT: "60000",
  });
  await expect.poll(() => exports).toBeGreaterThan(0);
  await core.request();
  await core.stop();
}, 10000);

it("bounds shutdown for a hanging gRPC Collector", async () => {
  let exports = 0;
  const server = createHTTP2Server();
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream) => {
    exports++;
    stream.on("error", () => {});
    stream.resume();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector did not listen");
  try {
    const core = await start({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${address.port}`,
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: "60000",
    });
    await expect.poll(() => exports).toBeGreaterThan(0);
    await core.request();
    await core.stop();
  } finally {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

it.each([
  { OTEL_SDK_DISABLED: "true" },
  { OTEL_METRICS_EXPORTER: "none" },
  { OTEL_METRICS_EXPORTER: "otlp, none" },
  { OTEL_SDK_DISABLED: " true " },
])(
  "keeps disabled telemetry silent: %j",
  async (disabled) => {
    let exports = 0;
    const endpoint = await collector((request, response) => {
      request.resume();
      exports++;
      response.end();
    });
    const core = await start({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint, ...disabled });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await core.stop()).toBe("");
    expect(exports).toBe(0);
  },
  10000,
);

it("exports enabled metrics as protobuf", async () => {
  const requests: { contentType: string; bytes: number }[] = [];
  const endpoint = await collector(async (request, response) => {
    let bytes = 0;
    for await (const data of request) bytes += data.length;
    requests.push({ contentType: request.headers["content-type"] ?? "", bytes });
    response.end();
  });
  const enabled = await start({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint });
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await enabled.stop();
  expect(
    requests.some(
      (request) => request.contentType === "application/x-protobuf" && request.bytes > 0,
    ),
  ).toBe(true);
}, 15000);
