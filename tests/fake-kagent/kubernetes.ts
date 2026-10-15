import type { IncomingMessage, ServerResponse } from "node:http";
import { fromJson, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import type { FakeKagent } from "./kagent.js";
import { nativeRequest } from "./native-http.js";

/** Native API semantics for versioned template replacement, which kagent alpha11 lacks. */
export async function kubernetesRequest(
  fake: FakeKagent,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const match =
    /^\/apis\/api\.kagent\.dev\/v1alpha3\/namespaces\/([^/]+)\/agenttemplates\/([^/]+)$/.exec(
      url.pathname,
    );
  if (!match || request.method !== "PUT") return nativeRequest(fake, request, response);
  response.setHeader("Content-Type", "application/json");
  try {
    if (match[1] !== "agentos") throw new ConnectError("Namespace not found", Code.NotFound);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
    const result = fake.replaceTemplate(
      fromJson(AgentTemplateSchema, {
        ref: { namespace: match[1], name: match[2] },
        resource: { apiVersion: "api.kagent.dev/v1alpha3", kind: "AgentTemplate", value },
      }),
    );
    response.end(JSON.stringify(result.resource?.value));
  } catch (error) {
    response.statusCode =
      error instanceof ConnectError
        ? error.code === Code.Aborted
          ? 409
          : error.code === Code.NotFound
            ? 404
            : 422
        : 400;
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Status",
        status: "Failure",
        code: response.statusCode,
        reason: response.statusCode === 409 ? "Conflict" : "Invalid",
      }),
    );
  }
  return true;
}
