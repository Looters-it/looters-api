import { describe, expect, it } from "vitest";
import { parseNotification } from "../src/queue/notifications.js";

describe("jobs notifications", () => {
  it("parses a valid payload", () => {
    expect(parseNotification('{"matchId":"m1","kind":"turn.closed"}')).toEqual({
      matchId: "m1",
      kind: "turn.closed",
    });
    expect(parseNotification('{"kind":"system.pong"}')).toEqual({
      matchId: null,
      kind: "system.pong",
    });
  });

  it("ignores malformed payloads", () => {
    expect(parseNotification(undefined)).toBeNull();
    expect(parseNotification("not json")).toBeNull();
    expect(parseNotification('{"matchId":"m1"}')).toBeNull();
  });
});
