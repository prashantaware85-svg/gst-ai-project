// Minimal concurrency pool: runs `worker` over all `items`, limiting the number
// of in-flight promises to `limit`. Deterministic and dependency-free; used to
// batch the per-invoice AI suggestion calls during reconciliation so we never
// fan out one request per invoice at the same instant.

export async function runPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  limit = 5,
): Promise<void> {
  if (!items.length) return;
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const queue = [...items];
  const workers = Array.from({ length: safeLimit }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await worker(item);
    }
  });
  await Promise.all(workers);
}