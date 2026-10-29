export {};

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const disabled =
  process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true" ||
  process.env.OTEL_METRICS_EXPORTER?.split(",").some(
    (exporter) => exporter.trim().toLowerCase() === "none",
  );

if (endpoint && !disabled) {
  process.env.OTEL_METRICS_EXPORTER ??= "otlp";
  process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT ??= "1000";
  process.env.OTEL_TRACES_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";

  let diagnostics = 0;
  const report = (...values: unknown[]) => {
    if (diagnostics++ >= 8) return;
    const message = values
      .slice(0, 4)
      .map((value) =>
        value instanceof Error ? value.message : typeof value === "string" ? value : "",
      )
      .join(" ")
      .slice(0, 512);
    console.warn("OpenTelemetry:", message);
  };
  let sdk: import("@opentelemetry/sdk-node").NodeSDK | undefined;
  const stop = () =>
    void Promise.resolve()
      .then(() => sdk?.shutdown())
      .catch(report);
  try {
    const [{ NodeSDK }, { HostMetrics }, { diag, DiagLogLevel }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/host-metrics"),
      import("@opentelemetry/api"),
    ]);
    const configured = process.env.OTEL_LOG_LEVEL;
    const level = DiagLogLevel[configured?.toUpperCase() as keyof typeof DiagLogLevel];
    diag.setLogger(
      { error: report, warn: report, info: report, debug: report, verbose: report },
      {
        logLevel: typeof level === "number" ? level : DiagLogLevel.WARN,
        suppressOverrideMessage: true,
      },
    );
    // NodeSDK otherwise replaces the bounded diagnostic logger with its console logger.
    delete process.env.OTEL_LOG_LEVEL;
    try {
      sdk = new NodeSDK();
    } finally {
      if (configured !== undefined) process.env.OTEL_LOG_LEVEL = configured;
    }
    sdk.start();
    new HostMetrics({ metricGroups: ["process.cpu", "process.memory"] }).start();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  } catch (error) {
    report("initialization failed", error);
    stop();
  }
}
