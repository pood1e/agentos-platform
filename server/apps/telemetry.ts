export {};

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (
  endpoint &&
  process.env.OTEL_SDK_DISABLED?.toLowerCase() !== "true" &&
  process.env.OTEL_METRICS_EXPORTER?.toLowerCase() !== "none"
) {
  const reported = new Set<"SDK" | "initialization" | "shutdown">();
  const report = (phase: "SDK" | "initialization" | "shutdown") => {
    if (reported.has(phase)) return;
    reported.add(phase);
    console.warn(
      `OpenTelemetry ${phase} failed; check OTEL configuration and Collector. Further ${phase} diagnostics are suppressed.`,
    );
  };
  const timeout = (value: string | undefined) => {
    const milliseconds = Number(value);
    return String(
      Number.isFinite(milliseconds) && milliseconds > 0 ? Math.min(milliseconds, 1000) : 1000,
    );
  };
  process.env.OTEL_METRICS_EXPORTER ??= "otlp";
  // Bound the transport as well as the reader: a reader timeout leaves queued HTTP requests alive.
  process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = timeout(
    process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT ?? process.env.OTEL_EXPORTER_OTLP_TIMEOUT,
  );
  process.env.OTEL_METRIC_EXPORT_TIMEOUT = timeout(process.env.OTEL_METRIC_EXPORT_TIMEOUT);

  let sdk: import("@opentelemetry/sdk-node").NodeSDK | undefined;
  const shutdown = () => sdk?.shutdown().catch(() => report("shutdown"));
  try {
    const [{ NodeSDK }, { HostMetrics }, { diag, DiagLogLevel }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/host-metrics"),
      import("@opentelemetry/api"),
    ]);
    const ignore = () => {};
    diag.setLogger(
      {
        error: () => report("SDK"),
        warn: () => report("SDK"),
        info: ignore,
        debug: ignore,
        verbose: ignore,
      },
      DiagLogLevel.WARN,
    );
    // NodeSDK otherwise replaces the bounded diagnostic logger with its console logger.
    const level = process.env.OTEL_LOG_LEVEL;
    delete process.env.OTEL_LOG_LEVEL;
    try {
      sdk = new NodeSDK({ spanProcessors: [], logRecordProcessors: [] });
    } finally {
      if (level !== undefined) process.env.OTEL_LOG_LEVEL = level;
    }
    sdk.start();
    new HostMetrics({ metricGroups: ["process.cpu", "process.memory"] }).start();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => void shutdown());
  } catch {
    report("initialization");
    void shutdown();
  }
}
