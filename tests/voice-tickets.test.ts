import { randomUUID } from "node:crypto";
import { Code } from "@connectrpc/connect";
import { decodeJwt } from "jose";
import { expect, it, vi } from "vitest";
import { VoiceMode } from "../gen/agentos/console/v1/speech_pb.js";
import { voiceTickets } from "../server/voice/tickets.js";
import { signingKey } from "./fixtures/voice.js";

it("validates the room, signature, workspace, mode and lifetime of every voice ticket", async () => {
  const api = voiceTickets(signingKey, "agentos");
  const issued = await api.create({
    id: randomUUID(),
    subject: "alice",
    mode: VoiceMode.CALL,
    languageCode: "zh",
    text: "",
    contextId: randomUUID(),
    nativeSessionCredential: "kagent-session.fixture",
  });
  const ticket = await api.verify(issued.id, issued.token);
  expect(ticket.session).toMatchObject({ id: issued.id, subject: "alice", mode: VoiceMode.CALL });
  expect(ticket.session.nativeSessionCredential).toBe("kagent-session.fixture");
  const denied = { code: Code.PermissionDenied };
  await expect(api.verify(randomUUID(), issued.token)).rejects.toMatchObject(denied);
  const parts = issued.token.split(".");
  parts[1] = Buffer.from(
    JSON.stringify({
      ...decodeJwt(issued.token),
      session: { ...ticket.session, subject: "mallory" },
    }),
  ).toString("base64url");
  await expect(api.verify(issued.id, parts.join("."))).rejects.toMatchObject(denied);
  await expect(
    voiceTickets(signingKey, "other").verify(issued.id, issued.token),
  ).rejects.toMatchObject(denied);
  await expect(
    voiceTickets("voice-secret-0123456789abcdef0123456789", "agentos").verify(
      issued.id,
      issued.token,
    ),
  ).rejects.toMatchObject(denied);
  vi.useFakeTimers();
  try {
    vi.setSystemTime((ticket.expiresAt + 1) * 1000);
    await expect(api.verify(issued.id, issued.token)).rejects.toMatchObject(denied);
  } finally {
    vi.useRealTimers();
  }
});

it.each([VoiceMode.DICTATION, VoiceMode.READ_ALOUD])(
  "limits transient mode %i tickets to two minutes",
  async (mode) => {
    const api = voiceTickets(signingKey, "agentos");
    const issued = await api.create({
      id: randomUUID(),
      subject: "alice",
      mode,
      languageCode: "",
      text: "hello",
      contextId: "",
    });
    const ticket = await api.verify(issued.id, issued.token);
    expect(ticket.expiresAt - ticket.issuedAt).toBe(120);
  },
);
