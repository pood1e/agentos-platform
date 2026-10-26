import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyInstance } from "fastify";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import type { EnvironmentTokens } from "../authorization/environment-tokens.js";
import type { jwtIdentity } from "../authorization/oidc.js";
import { environmentUrl, withEnvironmentHttp } from "../shared/environment-http.js";

/** Relays allowlisted environment APIs with the current user's exchanged identity. */
export function registerEnvironmentApis(
  app: FastifyInstance,
  config: GovernanceConfig,
  token: EnvironmentTokens,
  identity: ReturnType<typeof jwtIdentity> | undefined,
  origin: string,
) {
  for (const connection of config.environments) {
    const services = new Set<string>();
    for (const api of connection.apis) {
      if (
        !/^[\w.]+$/.test(api.service) ||
        services.has(api.service) ||
        api.readMethods.some((method) => api.writeMethods.includes(method)) ||
        [...api.readMethods, ...api.writeMethods].some((method) => !/^[A-Za-z]+$/.test(method))
      )
        throw new Error("Environment API method allowlists must be valid and disjoint");
      services.add(api.service);
    }
  }
  app.post<{ Params: { environment: string; service: string; method: string } }>(
    "/environments/:environment/rpc/:service/:method",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        const { environment, service, method } = request.params;
        const connection = config.environments.find(
          (item) => item.environment?.name === environment,
        );
        const api = connection?.apis.find((item) => item.service === service);
        if (!connection || !api || !/^[\w.]+$/.test(service) || !/^[A-Za-z]+$/.test(method))
          throw new ConnectError("Environment API not found", Code.NotFound);
        const read = api.readMethods.includes(method);
        if (!read && !api.writeMethods.includes(method))
          throw new ConnectError("Environment API not found", Code.NotFound);
        if (identity && request.headers.origin !== origin)
          throw new ConnectError("Request origin is invalid", Code.PermissionDenied);
        if (!request.headers["content-type"]?.startsWith("application/json"))
          throw new ConnectError("This endpoint requires unary Connect JSON", Code.InvalidArgument);
        const principal = identity
          ? await identity(new Headers(request.headers as Record<string, string>))
          : create(ExecutionIdentitySchema, {
              subject: "console",
              write: true,
              credential: { case: "service", value: true },
            });
        if (!read && !principal.write)
          throw new ConnectError("Execution has read-only permissions", Code.PermissionDenied);
        const accessToken = await token(environment, "catalog", principal);
        const abort = new AbortController();
        reply.raw.once("close", () => abort.abort());
        const url = environmentUrl(connection, `/${service}/${method}`);
        return await withEnvironmentHttp(connection, url, async (fetch) => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "Connect-Protocol-Version": "1",
            },
            body: JSON.stringify(request.body),
            redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
          });
          if (!response.headers.get("content-type")?.includes("application/json"))
            throw new ConnectError(
              "Environment API returned an invalid response",
              Code.Unavailable,
            );
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (response.body)
            for await (const chunk of response.body) {
              size += chunk.byteLength;
              if (size > 17 * 1024 * 1024) {
                abort.abort();
                throw new ConnectError(
                  "Environment response exceeds the limit",
                  Code.ResourceExhausted,
                );
              }
              chunks.push(chunk);
            }
          const body = Buffer.concat(chunks).toString("utf8");
          return reply.code(response.status).type("application/json").send(body);
        });
      } catch (error) {
        const failure = ConnectError.from(error, Code.Unavailable);
        const status =
          failure.code === Code.NotFound
            ? 404
            : failure.code === Code.PermissionDenied
              ? 403
              : failure.code === Code.Unauthenticated
                ? 401
                : failure.code === Code.InvalidArgument
                  ? 400
                  : 503;
        return reply.code(status).send({
          code: Code[failure.code]?.replace(
            /[A-Z]/g,
            (char, index) => `${index ? "_" : ""}${char.toLowerCase()}`,
          ),
          message: failure.rawMessage,
        });
      }
    },
  );
}
