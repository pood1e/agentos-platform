import { create } from "@bufbuild/protobuf";
import { type Client, Code, ConnectError } from "@connectrpc/connect";
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { type Control, ResourceMetadataSchema } from "../../gen/ateapi_pb.js";
import type { Session } from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import type { KagentClients } from "../kagent/clients.js";

export const actorTokenHeader = "x-substrate-actor-token";
const denied = () => new ConnectError("Runtime identity is invalid", Code.Unauthenticated);

/** Verifies the deployed Substrate issuer's Actor claims before using any identity fields. */
export function actorVerifier(keys: JWTVerifyGetKey, issuer: string, audience: string | string[]) {
  if (!issuer || !audience) throw new Error("Actor issuer and audience are required");
  return async (token: string) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ["ES256", "RS256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "nbf", "iat", "jti"],
      }));
    } catch {
      throw denied();
    }
    const raw = payload["ate.dev"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw denied();
    const claims = raw as Record<string, unknown>;
    const { atespace, actorName, actorUID } = claims;
    if (
      typeof atespace !== "string" ||
      !atespace ||
      atespace.trim() !== atespace ||
      typeof actorName !== "string" ||
      !actorName ||
      actorName.trim() !== actorName ||
      typeof actorUID !== "string" ||
      !actorUID ||
      actorUID.trim() !== actorUID ||
      payload.sub !== `actor/${atespace}/${actorName}`
    )
      throw denied();
    return create(ResourceMetadataSchema, {
      atespace,
      name: actorName,
      uid: actorUID,
    });
  };
}

/** Resolves signed Actor identity against current native state, including replacement after restore. */
export function runtimeIdentity(
  verify: ReturnType<typeof actorVerifier>,
  substrate: Client<typeof Control>,
  sessions: KagentClients["sessions"],
  workspace: string | ReadonlySet<string>,
) {
  const workspaces = typeof workspace === "string" ? new Set([workspace]) : workspace;
  return async (token: string): Promise<Session> => {
    const identity = await verify(token);
    const id = identity.name.slice("session-".length);
    if (
      !workspaces.has(identity.atespace) ||
      !/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity.name)
    )
      throw denied();
    const [actor, { session }] = await Promise.all([
      substrate.getActor(
        { actor: { atespace: identity.atespace, name: identity.name } },
        { timeoutMs: 5_000 },
      ),
      sessions.getSession({ sessionId: id }, { timeoutMs: 5_000 }),
    ]);
    if (
      actor.metadata?.uid !== identity.uid ||
      actor.metadata.atespace !== identity.atespace ||
      actor.metadata.name !== identity.name ||
      session?.id !== id ||
      session.agent?.namespace !== identity.atespace
    )
      throw denied();
    return session;
  };
}
