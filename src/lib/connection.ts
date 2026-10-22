import { useEffect, useState, useSyncExternalStore } from "react";

type State = "connecting" | "live" | "failed";
interface Snapshot {
  state: State;
  error: string;
  since: number;
}

let snapshot: Snapshot = { state: "connecting", error: "", since: Date.now() };
const listeners = new Set<() => void>();

function publish(state: State, error: string) {
  if (snapshot.state === state && snapshot.error === error) return;
  snapshot = { state, error, since: Date.now() };
  for (const listener of listeners) listener();
}

/** Workbench connectivity follows the authenticated platform heartbeat. */
export const connection = {
  succeeded: () => publish("live", ""),
  failed: (error: string) => publish("failed", error),
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useConnection = () => useSyncExternalStore(subscribe, () => snapshot);

/** Failure message once the connection has stayed down long enough to report. */
export function useOutage(delay = 5_000): string {
  const current = useConnection();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (current.state !== "failed") return setVisible(false);
    const timer = setTimeout(
      () => setVisible(true),
      Math.max(0, current.since + delay - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [current, delay]);
  return visible ? current.error : "";
}
