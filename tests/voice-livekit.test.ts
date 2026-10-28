import Fastify from "fastify";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
import { expect, it } from "vitest";
import { VoiceMode } from "../gen/agentos/console/v1/speech_pb.js";
import { signedWorker, voiceEnvironment } from "./fixtures/voice.js";

it("delivers the API ticket in a server-authenticated LiveKit CreateRoom request", async () => {
  const env = await voiceEnvironment();
  const server = Fastify();
  const requests: unknown[] = [];
  server.post("/twirp/livekit.RoomService/CreateRoom", async (request) => {
    const authorization = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const service = await new TokenVerifier(env.rooms.apiKey, env.rooms.apiSecret).verify(
      authorization,
    );
    expect(service.video).toEqual({ roomCreate: true });
    requests.push(request.body);
    return { name: (request.body as { name: string }).name };
  });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const rooms = new RoomServiceClient(
      address.replace("http:", "ws:"),
      env.rooms.apiKey,
      env.rooms.apiSecret,
    );
    env.rooms.createRoom.mockImplementation((options) => rooms.createRoom(options));
    const room = await env.room({ mode: VoiceMode.CALL });
    expect(requests).toEqual([
      {
        name: room.id,
        emptyTimeout: 60,
        maxParticipants: 2,
        agents: [{ agentName: env.rooms.agent, metadata: room.sessionToken }],
      },
    ]);
    expect((await env.tickets.verify(room.id, room.sessionToken)).session.subject).toBe(
      "user:operator",
    );
    expect(room.claims.roomConfig).toBeUndefined();
    expect(room.claims.video).not.toHaveProperty("roomCreate");
    expect(JSON.stringify(room.claims)).not.toContain(room.sessionToken);
    expect(
      await env.worker.getVoiceSession(
        { sessionId: room.id, sessionToken: room.sessionToken },
        signedWorker,
      ),
    ).toMatchObject({ mode: VoiceMode.CALL });
  } finally {
    await server.close();
    await env.close();
  }
});
