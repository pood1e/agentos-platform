import { AsyncLocalStorage } from "node:async_hooks";
import type { Interceptor } from "@connectrpc/connect";

/** Verified request credentials stay in request scope, including deferred streams. */
export const nativeHeaders = new AsyncLocalStorage<Headers>();
export const nativeSignal = new AsyncLocalStorage<AbortSignal>();

export function credentialHeaders(input: Headers) {
  const headers = new Headers();
  for (const name of ["authorization", "x-substrate-actor-token"]) {
    const value = input.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export const nativeCredentials: Interceptor = (next) => (request) => {
  const headers = nativeHeaders.getStore();
  if (headers)
    for (const [name, value] of credentialHeaders(headers)) request.header.set(name, value);
  const signal = nativeSignal.getStore();
  return next(signal ? { ...request, signal: AbortSignal.any([request.signal, signal]) } : request);
};

export function nativeStream<T>(source: AsyncIterable<T>, headers: Headers): AsyncIterable<T> {
  const iterator = nativeHeaders.run(headers, () => source[Symbol.asyncIterator]());
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => nativeHeaders.run(headers, () => iterator.next()),
        return: () =>
          nativeHeaders.run(
            headers,
            async () => iterator.return?.() ?? { done: true as const, value: undefined },
          ),
        throw: (error: unknown) =>
          nativeHeaders.run(headers, async () => {
            if (iterator.throw) return iterator.throw(error);
            throw error;
          }),
      };
    },
  };
}
