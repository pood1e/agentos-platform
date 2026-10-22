import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { decodeJwt } from "jose";
import { LRUCache } from "lru-cache";
import {
  ExecutionBindingSchema,
  type ExecutionIdentity,
} from "../../gen/agentos/execution/v1/identity_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { intersectCapabilities } from "../../shared/permissions.js";
import { type KagentClients, pool } from "../kagent/clients.js";
import type { jwtIdentity } from "./oidc.js";
import { conflict, type ExecutionStore } from "./store.js";

const denied = () => new ConnectError("Execution access denied", Code.PermissionDenied);

export function executions(
  store: ExecutionStore,
  verify?: ReturnType<typeof jwtIdentity>,
  adopt?: (session: Session, messageIds: string[]) => Promise<ExecutionIdentity | undefined>,
) {
  const remembered = new LRUCache<string, ExecutionIdentity>({ max: 512, ttl: 60_000 });
  const narrowed = (identity: ExecutionIdentity, ceiling: ExecutionIdentity) => ({
    ...identity,
    write: identity.write && ceiling.write,
    capabilities: intersectCapabilities(identity.capabilities, ceiling.capabilities),
  });

  async function remember(identity: ExecutionIdentity, force = false) {
    if (!identity.subject || !identity.credential.case) throw denied();
    const value = identity.credential;
    const cached = remembered.get(identity.subject);
    if (!force && cached?.credential.value === value.value) return narrowed(identity, cached);
    for (let retry = 0; retry < 4; retry++) {
      const previous = await store.identity(identity.subject);
      if (
        previous?.value.credential.case === value.case &&
        previous.value.credential.value === value.value &&
        previous.value.write === identity.write &&
        JSON.stringify(previous.value.capabilities) === JSON.stringify(identity.capabilities)
      )
        return identity;
      if (previous?.value.credential.case === "accessToken" && value.case === "accessToken") {
        const oldTime = decodeJwt(previous.value.credential.value).iat ?? 0;
        const newTime = decodeJwt(value.value).iat ?? 0;
        if (oldTime > newTime) return narrowed(identity, previous.value);
        if (oldTime === newTime) identity = narrowed(identity, previous.value);
      }
      try {
        await store.saveIdentity(identity, previous?.version);
        if (value.case === "accessToken") remembered.set(identity.subject, identity);
        return identity;
      } catch (error) {
        if (!conflict(error) || retry === 3) throw error;
      }
    }
    throw denied();
  }

  async function record(session: Session, allowRevoked = false, messageIds: string[] = []) {
    let stored = await store.binding(session.id);
    if (!stored && adopt) {
      const identity = await adopt(session, messageIds);
      if (identity) {
        await bind(session, identity);
        stored = await store.binding(session.id);
      }
    }
    const binding = stored?.value;
    if (
      !binding ||
      (!allowRevoked && binding.revoked) ||
      binding.agent?.namespace !== session.agent?.namespace ||
      binding.agent?.name !== session.agent?.name
    )
      throw denied();
    let ancestor = binding,
      write = binding.write,
      capabilities = binding.capabilities;
    const seen = new Set<string>();
    for (;;) {
      if (
        (!allowRevoked && ancestor.revoked) ||
        ancestor.subject !== binding.subject ||
        ancestor.rootSessionId !== binding.rootSessionId ||
        seen.has(ancestor.sessionId) ||
        seen.size >= 32
      )
        throw denied();
      seen.add(ancestor.sessionId);
      write &&= ancestor.write;
      capabilities = intersectCapabilities(capabilities, ancestor.capabilities);
      if (ancestor.sessionId === binding.rootSessionId) break;
      const parent = (await store.binding(ancestor.parentSessionId))?.value;
      if (!parent) throw denied();
      ancestor = parent;
    }
    return { binding, write, capabilities };
  }

  async function resolve(session: Session) {
    const { binding, write, capabilities } = await record(session);
    const saved = (await store.identity(binding.subject))?.value;
    if (!saved) throw denied();
    const identity =
      saved.credential.case === "accessToken"
        ? await verify?.(new Headers({ authorization: `Bearer ${saved.credential.value}` }))
        : saved.credential.case === "service" &&
            saved.credential.value &&
            !(verify && saved.subject === "console")
          ? saved
          : undefined;
    if (!identity || identity.subject !== binding.subject) throw denied();
    return {
      binding,
      identity,
      write: identity.write && saved.write && write,
      capabilities: intersectCapabilities(identity.capabilities, saved.capabilities, capabilities),
    };
  }

  async function own(session: Session, identity: ExecutionIdentity) {
    const result = await resolve(session);
    if (result.binding.subject !== identity.subject) throw denied();
    return result;
  }

  async function bind(session: Session, identity: ExecutionIdentity, parent?: Session) {
    if (!session.id || !session.agent) throw denied();
    identity = await remember(identity, true);
    const ancestor = parent ? await resolve(parent) : undefined;
    if (ancestor && ancestor.binding.subject !== identity.subject) throw denied();
    const binding = create(ExecutionBindingSchema, {
      sessionId: session.id,
      agent: session.agent,
      subject: identity.subject,
      rootSessionId: ancestor?.binding.rootSessionId ?? session.id,
      parentSessionId: parent?.id ?? "",
      write: identity.write && (ancestor?.write ?? true),
      capabilities: intersectCapabilities(
        identity.capabilities,
        ancestor?.capabilities ?? identity.capabilities,
      ),
    });
    try {
      await store.saveBinding(binding);
    } catch (error) {
      if (!conflict(error)) throw error;
      const previous = await record(session, true);
      if (
        previous.binding.subject !== binding.subject ||
        previous.binding.rootSessionId !== binding.rootSessionId ||
        previous.binding.parentSessionId !== binding.parentSessionId
      )
        throw denied();
    }
  }

  async function delegate(parent: Session, child: Session, allowRevoked = false) {
    const source = await (allowRevoked ? record(parent, true) : resolve(parent)),
      target = await (allowRevoked ? record(child, true) : resolve(child));
    if (
      source.binding.rootSessionId !== target.binding.rootSessionId ||
      source.binding.subject !== target.binding.subject
    )
      throw denied();
  }

  async function revoke(session: Session, identity: ExecutionIdentity) {
    const current = await record(session, true);
    if (current.binding.subject !== identity.subject) throw denied();
    if (current.binding.revoked) return;
    const stored = await store.binding(session.id);
    if (!stored) throw denied();
    const binding = clone(ExecutionBindingSchema, stored.value);
    binding.revoked = true;
    await store.saveBinding(binding, stored.version);
  }

  const history = async (subject: string, contexts: string[], origins: Session[] = []) => {
    if (!subject) return [];
    let bindings = await store.bindings(contexts);
    const known = new Set(bindings.map((binding) => binding.sessionId));
    const missing = origins.filter((session) => !known.has(session.id));
    if (missing.length) {
      await pool(missing, 4, async (session) => {
        await record(session, true).catch(() => {});
      });
      bindings = await store.bindings(contexts);
    }
    return bindings.filter(
      (binding) => binding.subject === subject || binding.subject.startsWith("service:"),
    );
  };

  return { remember, record, resolve, own, bind, delegate, revoke, history };
}

export type Executions = ReturnType<typeof executions>;

export async function relatedExecutions(
  registry: Executions,
  sessions: KagentClients["sessions"],
  parent: Session,
  contexts: string[],
  allowRevoked = false,
) {
  if (allowRevoked) await registry.record(parent, true);
  else await registry.resolve(parent);
  for (const sessionId of new Set(contexts)) {
    const { session } = await sessions.getSession({ sessionId }, { timeoutMs: 5_000 });
    if (!session) throw denied();
    await registry.delegate(parent, session, allowRevoked);
  }
}
