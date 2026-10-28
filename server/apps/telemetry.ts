export {};

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (
  endpoint &&
  process.env.OTEL_SDK_DISABLED?.toLowerCase() !== "true" &&
  process.env.OTEL_METRICS_EXPORTER?.toLowerCase() !== "none"
) {
  process.env.OTEL_METRICS_EXPORTER ??= "otlp";
  process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT ??= "1000";
  process.env.OTEL_TRACES_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";

  let sdk: import("@opentelemetry/sdk-node").NodeSDK | undefined;
  try {
    const [{ NodeSDK }, { HostMetrics }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/host-metrics"),
    ]);
    sdk = new NodeSDK();
    sdk.start();
    new HostMetrics({ metricGroups: ["process.cpu", "process.memory"] }).start();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => void sdk?.shutdown().catch(() => {}));
  } catch (error) {
    void sdk?.shutdown().catch(() => {});
    console.warn(
      "OpenTelemetry initialization failed",
      error instanceof Error ? error.message : error,
    );
  }
}
