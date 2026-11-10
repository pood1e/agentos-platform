/** Visits every page; a repeated token means the upstream cursor is broken. */
export async function eachPage<T>(
  fetchPage: (token: string) => Promise<{ items: T[]; token: string }>,
  visit: (items: T[]) => void,
): Promise<void> {
  const seen = new Set<string>();
  let token = "";
  do {
    if (seen.has(token)) throw new Error("Upstream pagination repeated a page token");
    seen.add(token);
    const page = await fetchPage(token);
    visit(page.items);
    token = page.token;
  } while (token);
}

/** Runs at most `size` calls at once and rethrows the first failure after all settle. */
export async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
