import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import {
  ExtMcp,
  McpHeaderSchema,
  McpRequestSchema,
} from "../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { actorTokenHeader } from "../server/authorization/actor.js";
import { mcpAuthorization } from "../server/authorization/mcp.js";

it("checks each call using the verified Session even when arguments assert another identity", async () => {
  const session = create(SessionSchema, { id: "native-session", creator: "alice" });
  let revoked = false;
  const checked: string[] = [];
  const client = createClient(
    ExtMcp,
    createRouterTransport((router) =>
      router.service(
        ExtMcp,
        mcpAuthorization(
          async (token) => {
            if (token !== "host-signed") throw new Error("Identity rejected");
            return session;
          },
          async (actual, tool, target) => {
            checked.push(actual.id);
            if (
              revoked ||
              target.serviceNames[0] !== "connector" ||
              tool.name !== "read" ||
              tool.arguments?.resource !== "alice/item"
            )
              throw new Error("Out of scope");
          },
        ),
      ),
    ),
  );
  const request = create(McpRequestSchema, {
    method: "tools/call",
    serviceNames: ["connector"],
    headers: [{ key: actorTokenHeader, value: new TextEncoder().encode("Bearer host-signed") }],
  });
  const call = async (resource = "alice/item") => {
    request.mcpRequest = new TextEncoder().encode(
      JSON.stringify({
        name: "read",
        arguments: {
          resource,
          session_id: "victim",
          initiator: "admin",
          grant_id: "powerful",
          service_names: ["another-connector"],
        },
      }),
    );
    return (await client.checkRequest(request)).result.case;
  };
  expect(await call()).toBe("pass");
  expect(await call("bob/item")).toBe("error");
  revoked = true;
  expect(await call()).toBe("error");
  expect(checked).toEqual([session.id, session.id, session.id]);
  request.method = "resources/read";
  expect((await client.checkRequest(request)).result.case).toBe("error");
  request.method = "tools/call";
  request.mcpRequest = new TextEncoder().encode('{"name":42}');
  expect((await client.checkRequest(request)).result.case).toBe("error");
  request.headers.push(request.headers[0]);
  expect((await client.checkRequest(request)).result.case).toBe("error");
  request.headers = [];
  request.metadataContext = { session_id: session.id, actorToken: "host-signed" };
  expect((await client.checkRequest(request)).result.case).toBe("error");
  request.headers = [
    create(McpHeaderSchema, {
      key: actorTokenHeader,
      value: new TextEncoder().encode("Bearer client-forged"),
    }),
  ];
  expect((await client.checkRequest(request)).result.case).toBe("error");
});

it("allows discovery to read only ui resources and rejects other resource schemes", async () => {
  const client = createClient(
    ExtMcp,
    createRouterTransport((router) =>
      router.service(
        ExtMcp,
        mcpAuthorization(
          async () => {
            throw new Error("Actor missing");
          },
          async () => {},
          async () => ({}),
        ),
      ),
    ),
  );
  const check = async (uri: string) =>
    (
      await client.checkRequest({
        method: "resources/read",
        mcpRequest: new TextEncoder().encode(JSON.stringify({ uri })),
      })
    ).result.case;
  expect(await check("ui://service/view.html")).toBe("pass");
  expect(await check("file:///etc/passwd")).toBe("error");
  expect(await check("https://untrusted.example/data")).toBe("error");
});
