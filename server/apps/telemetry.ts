import { HostMetrics } from "@opentelemetry/host-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

// Loaded with `node --import` so platform instruments bind to this provider; OTEL_* variables configure export.
const sdk = new NodeSDK();
sdk.start();
new HostMetrics({ metricGroups: ["process.cpu", "process.memory"] }).start();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void sdk.shutdown().catch(() => {}));
