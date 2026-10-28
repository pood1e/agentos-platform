import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const provider = `
  import { metrics } from '@opentelemetry/api';
  const original = metrics.getMeterProvider();
  await import('./server/apps/telemetry.ts');
  console.log(metrics.getMeterProvider() === original ? 'disabled' : 'enabled');
`;

function run(source: string, settings: Record<string, string | undefined> = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("OTEL_")),
  );
  return execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    env: { ...env, ...settings },
    timeout: 5_000,
  });
}

it("starts without a telemetry provider or collector configuration", async () => {
  const { stdout, stderr } = await run(provider);
  expect(stdout.trim()).toBe("disabled");
  expect(stderr).toBe("");
});

it.each([{ OTEL_SDK_DISABLED: "TRUE" }, { OTEL_METRICS_EXPORTER: "none" }])(
  "honors explicit telemetry disablement with an endpoint configured: %j",
  async (disabled) => {
    const { stdout, stderr } = await run(provider, {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics",
      ...disabled,
    });
    expect(stdout.trim()).toBe("disabled");
    expect(stderr).toBe("");
  },
);

it("exports metrics to the configured collector and shuts down", async () => {
  const requests: Buffer[] = [];
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("Collector did not start");
  try {
    const { stdout, stderr } = await run(
      `${provider}
        metrics.getMeter('telemetry-test').createCounter('test.requests').add(1);
        process.kill(process.pid, 'SIGTERM');
      `,
      {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${address.port}/v1/metrics`,
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
      },
    );
    expect(stdout.trim()).toBe("enabled");
    expect(stderr).toBe("");
    expect(requests.some((body) => body.includes("test.requests"))).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      collector.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("continues application work and exits when the collector is unavailable", async () => {
  const { stdout } = await run(
    `${provider}
      metrics.getMeter('telemetry-test').createCounter('test.requests').add(1);
      console.log('application ready');
      process.kill(process.pid, 'SIGTERM');
    `,
    {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
    },
  );
  expect(stdout).toContain("application ready");
});

it("continues application startup with an invalid exporter configuration", async () => {
  const { stdout, stderr } = await run(`${provider} console.log('application ready');`, {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "not a URL",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
  });
  expect(stdout).toContain("application ready");
  expect(stderr.length).toBeLessThan(1_000);
});
