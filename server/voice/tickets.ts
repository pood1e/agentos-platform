import {
  create,
  fromJson,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError } from "@connectrpc/connect";
import { jwtVerify, SignJWT } from "jose";
import { VoiceMode } from "../../gen/agentos/console/v1/speech_pb.js";
import { type VoiceSession, VoiceSessionSchema } from "../../gen/agentos/voice/v1/voice_pb.js";

const denied = () => new ConnectError("Voice session is invalid or expired", Code.PermissionDenied);
const lifetime = (mode: VoiceMode) => (mode === VoiceMode.CALL ? 1800 : 120);

/** API-only signing keys bind each short-lived ticket to one room and conversation. */
export function voiceTickets(secret: string, workspace: string) {
  const key = new TextEncoder().encode(secret);
  if (key.length < 32) throw new Error("Voice session signing key requires at least 32 bytes");
  const issuer = `agentos:${workspace}:voice`;
  const audience = "agentos-voice";
  const validator = createValidator();
  const sign = (session: VoiceSession, issuedAt: number, expiresAt: number) =>
    new SignJWT({ session: toJson(VoiceSessionSchema, session) })
      .setProtectedHeader({ alg: "HS256", typ: "agentos-voice+jwt" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(key);
  return {
    async create(
      input: MessageInitShape<typeof VoiceSessionSchema> & { id: string },
      deadline?: number,
    ) {
      const session = create(VoiceSessionSchema, input);
      const issuedAt = Math.floor(Date.now() / 1000);
      return {
        id: session.id,
        token: await sign(
          session,
          issuedAt,
          Math.min(issuedAt + lifetime(session.mode), deadline ?? Number.POSITIVE_INFINITY),
        ),
      };
    },
    async verify(id: string, token: string) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          typ: "agentos-voice+jwt",
          issuer,
          audience,
          requiredClaims: ["iat", "exp"],
          maxTokenAge: "30m",
        });
        const session = fromJson(VoiceSessionSchema, payload.session as JsonValue);
        if (
          validator.validate(VoiceSessionSchema, session).kind !== "valid" ||
          session.id !== id ||
          !payload.iat ||
          !payload.exp ||
          payload.exp - payload.iat > lifetime(session.mode)
        )
          throw denied();
        return { session, issuedAt: payload.iat, expiresAt: payload.exp };
      } catch {
        throw denied();
      }
    },
  };
}

export type VoiceTickets = ReturnType<typeof voiceTickets>;
