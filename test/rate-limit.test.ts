import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/auth/rate-limit.js";

describe("rate limiter", () => {
  it("blocks a key after the allowed attempts and frees it when the window ends", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000 }, () => now);

    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfterSeconds("k")).toBe(0);
      limiter.hit("k");
    }
    expect(limiter.retryAfterSeconds("k")).toBe(60);
    expect(limiter.retryAfterSeconds("other")).toBe(0);

    now = 45_500;
    expect(limiter.retryAfterSeconds("k")).toBe(15);
    now = 60_000;
    expect(limiter.retryAfterSeconds("k")).toBe(0);
  });

  it("forgets a key on reset", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    limiter.hit("k");
    expect(limiter.retryAfterSeconds("k")).toBeGreaterThan(0);
    limiter.reset("k");
    expect(limiter.retryAfterSeconds("k")).toBe(0);
  });
});
