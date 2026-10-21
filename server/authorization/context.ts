import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import type { sessionTools } from "../team-sessions/tools.js";
import type { Executions } from "./executions.js";

export interface CollaborationExecution {
  parentSessionId: string;
  created: (session: Session) => Promise<void>;
  invoke: (session: Session) => Promise<void>;
}

export const collaborationExecution = new AsyncLocalStorage<CollaborationExecution>();

export function scopedCollaboration(
  handler: ReturnType<typeof sessionTools>,
  parent: Session,
  registry: Executions,
): ReturnType<typeof sessionTools> {
  return {
    ...handler,
    fetch: (...args) =>
      collaborationExecution.run(
        {
          parentSessionId: parent.id,
          created: async (session) =>
            registry.bind(session, (await registry.resolve(parent)).identity, parent),
          invoke: (session) => registry.delegate(parent, session),
        },
        () => handler.fetch(...args),
      ),
  };
}
