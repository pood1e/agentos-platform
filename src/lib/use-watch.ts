import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useRef, useState } from "react";
import { errorKey, unreachable } from "./errors.js";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });

/**
 * Follows a server stream for `key`, reconnecting with backoff. The last value
 * is kept while reconnecting.
 */
export function useWatch<T>(
  key: string | undefined,
  open: (signal: AbortSignal) => AsyncIterable<T>,
) {
  const [state, setState] = useState<{ key: string; value?: T; error: string }>();
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      for (let delay = 500; !signal.aborted; delay = Math.min(delay * 2, 10_000)) {
        try {
          for await (const message of latest.current(signal)) {
            if (signal.aborted) return;
            setState({ key, value: message, error: "" });
            delay = 500;
          }
        } catch (reason) {
          if (signal.aborted) return;
          const message = errorKey(reason, "connection.reconnecting");
          const disconnected = unreachable(reason);
          const retry =
            disconnected || (reason instanceof ConnectError && reason.code === Code.Internal);
          setState((previous) => ({
            key,
            value: retry && previous?.key === key ? previous.value : undefined,
            error: message,
          }));
          if (!retry) return;
        }
        await wait(delay, signal);
      }
    })();
    return () => controller.abort();
  }, [key]);
  return {
    value: state?.key === key ? state?.value : undefined,
    error: state?.key === key ? (state?.error ?? "") : "",
  };
}
