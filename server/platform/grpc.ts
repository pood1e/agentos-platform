import { createServer, type ServerHttp2Session } from "node:http2";
import { type ConnectNodeAdapterOptions, connectNodeAdapter } from "@connectrpc/connect-node";
import type { FastifyInstance } from "fastify";

/** Drains accepted RPCs and directs persistent clients to another ready instance. */
export function grpcServer(
  app: Pick<FastifyInstance, "addHook">,
  options: ConnectNodeAdapterOptions,
) {
  const sessions = new Set<ServerHttp2Session>();
  const server = createServer(connectNodeAdapter(options));
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      for (const session of sessions) session.close();
    });
  app.addHook("preClose", close);
  return {
    address: () => server.address(),
    listen: (port: number, host: string) =>
      new Promise<void>((resolve, reject) => {
        const error = (cause: Error) => reject(cause);
        server.once("error", error);
        server.listen(port, host, () => {
          server.off("error", error);
          resolve();
        });
      }),
  };
}
