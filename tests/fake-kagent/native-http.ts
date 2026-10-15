import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { object, text } from "../../server/read-model/decode/messages.js";
import type { FakeKagent } from "./kagent.js";

export async function nativeRequest(
  fake: FakeKagent,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const match = /^\/api(?:s\/[^/]+)?\/[^/]+\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(
    url.pathname,
  );
  const embedding = url.pathname === "/v1/embeddings";
  if (!match && !embedding) return false;
  response.setHeader("Content-Type", "application/json");
  try {
    if (match && match[1] !== "agentos")
      throw new ConnectError("Namespace not found", Code.NotFound);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as JsonObject) : {};
    if (embedding) {
      if (request.headers.authorization !== "Bearer test-gateway-token") {
        response.statusCode = 401;
        response.end("{}");
        return true;
      }
      response.end(
        JSON.stringify({
          object: "list",
          model: body.model,
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
            },
          ],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
      return true;
    }
    if (!match) return false;
    const [, , plural, name] = match;
    let result: JsonObject;
    if (url.searchParams.get("dryRun") === "All") result = body;
    else if (request.method === "GET")
      result = name
        ? fake.resources.get(plural, name)
        : { apiVersion: "v1", kind: "List", items: fake.resources.list(plural) };
    else if (request.method === "POST" || request.method === "PUT")
      result = fake.resources.save(plural, body, request.method === "POST");
    else if (request.method === "DELETE" && name) {
      fake.resources.remove(plural, name, text(object(body.preconditions).resourceVersion));
      result = { status: "Success" };
    } else throw new ConnectError("Invalid method", Code.InvalidArgument);
    response.end(JSON.stringify(result));
  } catch (error) {
    response.statusCode =
      error instanceof ConnectError
        ? error.code === Code.Aborted || error.code === Code.AlreadyExists
          ? 409
          : error.code === Code.NotFound
            ? 404
            : 422
        : 500;
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
