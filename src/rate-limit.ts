export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const start = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > start);
    if (this.hits.size > 10_000) {
      for (const [id, stamps] of this.hits) {
        const last = stamps[stamps.length - 1];
        if (last === undefined || last < start) this.hits.delete(id);
      }
    }
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
