/**
 * Map `items` through `fn` with at most `limit` calls in flight at once.
 * Results are returned in input order. A fixed pool of workers pulls from a
 * shared cursor, so memory and socket pressure stay bounded regardless of how
 * many items there are.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  };

  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
