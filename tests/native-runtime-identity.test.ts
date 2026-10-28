import { randomUUID } from "node:crypto";
import { createServer, type ServerHttp2Session } from "node:http2";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { SessionSchema, SessionService } from "../gen/kagent/api/v1/sessions_pb.js";
import { nativeRuntimeIdentity } from "../server/authorization/actor.js";
import { kagentClients, kagentTransport } from "../server/kagent/clients.js";

it("forwards native Actor credentials and relies on current kagent authentication", async () => {
  const id = randomUUID();
  const { privateKey } = await generateKeyPair("ES256");
  const token = await new SignJWT({ "actor.ate.dev": { actorName: `session-${id}` } })
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);
  const received: Headers[] = [];
  const connections = new Set<ServerHttp2Session>();
  let upstreamError: ConnectError | undefined;
  let session = create(SessionSchema, {
    id,
    agent: { namespace: "workspace", name: "assistant" },
  });
  const server = createServer(
    connectNodeAdapter({
      routes: (router) => {
        router.service(SessionService, {
          getSession: (request, context) => {
            received.push(new Headers(context.requestHeader));
            expect(request.sessionId).toBe(id);
            if (upstreamError) throw upstreamError;
            const credential = context.requestHeader.get("authorization");
            if (credential !== `Bearer ${token}` && credential !== "Bearer controller")
              throw new ConnectError("Native Actor rejected", Code.Unauthenticated);
            return { session };
          },
        });
      },
    }),
  );
  server.on("session", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Native server missing");
  try {
    const clients = kagentClients(
      kagentTransport({
        url: `http://127.0.0.1:${address.port}`,
        namespace: "workspace",
        userId: "console",
        token: "controller",
      }),
    );
    const identity = nativeRuntimeIdentity(clients.sessions, new Set(["workspace"]));
    expect(await identity(token)).toMatchObject({ id });
    expect(received.at(-1)?.get("authorization")).toBe(`Bearer ${token}`);
    expect(received.at(-1)?.get("x-user-id")).toBeNull();

    upstreamError = new ConnectError("Actor replaced", Code.Unauthenticated);
    await expect(identity(token)).rejects.toMatchObject({ code: Code.Unauthenticated });
    upstreamError = new ConnectError("Native service unavailable", Code.Unavailable);
    await expect(identity(token)).rejects.toMatchObject({ code: Code.Unavailable });
    upstreamError = undefined;
    await expect(identity(`${token}forged`)).rejects.toMatchObject({ code: Code.Unauthenticated });

    session = create(SessionSchema, { id, agent: { namespace: "foreign", name: "assistant" } });
    await expect(identity(token)).rejects.toMatchObject({ code: Code.Unauthenticated });
    session = create(SessionSchema, {
      id: randomUUID(),
      agent: { namespace: "workspace", name: "assistant" },
    });
    await expect(identity(token)).rejects.toMatchObject({ code: Code.Unauthenticated });

    const calls = received.length;
    for (const malformed of ["", "not-a-jwt", "eyJhbGciOiJFUzI1NiJ9.e30.signature"])
      await expect(identity(malformed)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(received).toHaveLength(calls);

    await clients.sessions.getSession({ sessionId: id });
    expect(received.at(-1)?.get("authorization")).toBe("Bearer controller");
    expect(received.at(-1)?.get("x-user-id")).toBe("console");
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
