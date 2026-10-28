import { ConnectError, type Interceptor } from "@connectrpc/connect";
import { codeToString } from "@connectrpc/connect/protocol-connect";
import type { ConnectNodeAdapterOptions } from "@connectrpc/connect-node";
import { metrics } from "@opentelemetry/api";

// Instruments resolve the global provider that `server/apps/telemetry.ts` registers before startup.
const meter = metrics.getMeter("agentos-platform");
// Semantic-convention buckets in seconds, refined below 5 ms for authorization decisions.
const seconds = {
  unit: "s",
  advice: {
    explicitBucketBoundaries: [
      0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
    ],
  },
};
const rpcDurations = {
  client: meter.createHistogram("rpc.client.call.duration", {
    ...seconds,
    description: "Duration of outgoing Connect RPCs, such as kagent requests",
  }),
  server: meter.createHistogram("rpc.server.call.duration", {
    ...seconds,
    description: "Duration of incoming Connect RPCs, including gateway authorization",
  }),
};
const httpDuration = meter.createHistogram("http.server.request.duration", {
  ...seconds,
  description: "Duration of gateway external authorization requests",
});

/** Records Connect RPCs with the OpenTelemetry RPC semantic conventions. */
export function rpcMetrics(kind: "client" | "server"): Interceptor {
  return (next) => async (request) => {
    const start = performance.now();
    let status = "ok";
    try {
      return await next(request);
    } catch (error) {
      status = codeToString(ConnectError.from(error).code);
      throw error;
    } finally {
      rpcDurations[kind].record((performance.now() - start) / 1000, {
        "rpc.system.name": "connectrpc",
        "rpc.method": `${request.service.typeName}/${request.method.name}`,
        "rpc.response.status_code": status,
      });
    }
  };
}

type HttpHandler = NonNullable<ConnectNodeAdapterOptions["fallback"]>;

/** Records plain HTTP handlers by route, method and status; unknown paths share one route. */
export function httpMetrics(routes: readonly string[], handler: HttpHandler): HttpHandler {
  return (request, response) => {
    const start = performance.now();
    response.once("close", () =>
      httpDuration.record((performance.now() - start) / 1000, {
        "http.route": routes.find((route) => route === request.url) ?? "unmatched",
        "http.request.method": request.method ?? "",
        "http.response.status_code": response.statusCode,
      }),
    );
    return handler(request, response);
  };
}
