/** A shared system execution opens as a read-only view of its native session. */
export function systemRunLocation(agent: string, session: string) {
  return `/system-tasks?${new URLSearchParams({ agent, session })}`;
}
