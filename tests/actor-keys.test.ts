import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { actorKeyServer } from "../server/authorization/keys.js";

it("serves refreshed keys over HTTP/1.1 and closes the private listener with the platform", async () => {
  const app = Fastify();
  const keys = vi.fn(async () => ({ keys: [{ kid: "old", kty: "RSA" }] }));
  const server = actorKeyServer(app, keys);
  const url = await server.listen({ port: 0, host: "127.0.0.1" });
  try {
    const first = await fetch(`${url}/keys/actor`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("content-type")).toContain("application/jwk-set+json");
    expect((await first.json()).keys[0].kid).toBe("old");
    keys.mockResolvedValueOnce({ keys: [{ kid: "new", kty: "RSA" }] });
    expect((await (await fetch(`${url}/keys/actor`)).json()).keys[0].kid).toBe("new");
    keys.mockRejectedValueOnce(new Error("Issuer unavailable"));
    expect((await fetch(`${url}/keys/actor`)).status).toBe(503);
    expect((await fetch(`${url}/keys/actor`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${url}/authorize/model`)).status).toBe(404);
  } finally {
    await app.close();
  }
  await expect(fetch(`${url}/keys/actor`)).rejects.toThrow();
});
