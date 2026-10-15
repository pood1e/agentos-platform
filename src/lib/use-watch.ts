import { useEffect, useRef, useState } from "react";
import { connection } from "./connection.js";
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
  const [value, setValue] = useState<T>();
  const [error, setError] = useState("");
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    setValue(undefined);
    setError("");
    if (!key) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      for (let delay = 500; !signal.aborted; delay = Math.min(delay * 2, 10_000)) {
        try {
          for await (const message of latest.current(signal)) {
            setValue(message);
            setError("");
            connection.succeeded();
            delay = 500;
          }
        } catch (reason) {
          if (signal.aborted) return;
          const message = errorKey(reason, "connection.reconnecting");
          setError(message);
          if (!unreachable(reason)) return;
          connection.failed(message);
        }
        await wait(delay, signal);
      }
    })();
    return () => controller.abort();
  }, [key]);
  return { value, error };
}
