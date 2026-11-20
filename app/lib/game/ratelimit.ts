/**
 * Basic in-memory sliding-window rate limiting (PLAN.md §7). Per server instance only; good
 * enough to stop hammering /api/answer. A shared store (Postgres/Redis) can replace it later.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 50_000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  }
  return true;
}

export function resetRateLimits(): void {
  hits.clear();
}
