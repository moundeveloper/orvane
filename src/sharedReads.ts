// Only in-flight work is shared: explicit refresh always reaches the source.
// Cancellation belongs to a subscriber, never to the shared transport.
const pending = new Map<string, Promise<unknown>>();

export function invalidateReads(prefix: string) {
  for (const key of pending.keys())
    if (key.startsWith(prefix)) pending.delete(key);
}

export async function sharedRead<T>(
  key: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  let request = pending.get(key) as Promise<T> | undefined;
  if (!request) {
    request = Promise.resolve().then(run);
    pending.set(key, request);
    const cleanup = () => {
      if (pending.get(key) === request) pending.delete(key);
    };
    void request.then(cleanup, cleanup);
  }
  let abort: (() => void) | undefined;
  try {
    const value = signal
      ? await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            abort = () =>
              reject(
                signal.reason ?? new DOMException("Aborted", "AbortError"),
              );
            signal.addEventListener("abort", abort, { once: true });
          }),
        ])
      : await request;
    return structuredClone(value);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
