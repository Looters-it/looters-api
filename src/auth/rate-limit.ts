export interface RateLimitRule {
  /** Attempts allowed inside one window. */
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window attempt counter kept in memory. It is enough while the api
 * runs as a single process; with several instances it must move to a shared store.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait before the key may try again; 0 when it is not blocked. */
  retryAfterSeconds(key: string): number {
    const bucket = this.live(key);
    if (!bucket || bucket.count < this.rule.max) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000));
  }

  /** Records one attempt against the key. */
  hit(key: string): void {
    const bucket = this.live(key);
    if (bucket) {
      bucket.count += 1;
      return;
    }
    this.sweep();
    this.buckets.set(key, { count: 1, resetAt: this.now() + this.rule.windowMs });
  }

  /** Forgets the key, for example after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private live(key: string): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= this.now()) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  /** Drops expired buckets so the map cannot grow without bound. */
  private sweep(): void {
    if (this.buckets.size < 10_000) return;
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
