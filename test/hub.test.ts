import { describe, expect, it, vi } from "vitest";
import { CLOSE_SESSION_ENDED, RealtimeHub, type Connection } from "../src/realtime/hub.js";

interface FakeConnection extends Connection {
  sent: unknown[];
  closedWith: number | null;
}

function connection(
  userId: string | null,
  sessionId: string | null = userId && `s-${userId}`,
  expiresAt: Date | null = null,
): FakeConnection {
  const fake: FakeConnection = {
    userId,
    sessionId,
    expiresAt,
    sent: [],
    closedWith: null,
    send: (data) => fake.sent.push(JSON.parse(data)),
    close: (code) => {
      fake.closedWith = code;
    },
  };
  return fake;
}

describe("realtime hub", () => {
  it("counts distinct users with an open socket, ignoring anonymous sockets", () => {
    const hub = new RealtimeHub();
    hub.add(connection(null));
    hub.add(connection("u1", "s1"));
    hub.add(connection("u1", "s2")); // same user, second tab
    const leave = hub.add(connection("u2"));
    expect(hub.onlineCount()).toBe(2);

    leave();
    expect(hub.onlineCount()).toBe(1);
  });

  it("tells a new socket the count and everyone when it changes", () => {
    const hub = new RealtimeHub();
    const guest = connection(null);
    hub.add(guest);
    expect(guest.sent).toEqual([{ t: "online", n: 0 }]);

    const leave = hub.add(connection("u1"));
    expect(guest.sent.at(-1)).toEqual({ t: "online", n: 1 });

    // A second tab of the same user changes nothing: no broadcast.
    const before = guest.sent.length;
    hub.add(connection("u1", "s-other"));
    expect(guest.sent).toHaveLength(before);

    leave();
    expect(guest.sent).toHaveLength(before); // still online through the other tab
  });

  it("closes only the sockets of a revoked session", () => {
    const hub = new RealtimeHub();
    const guest = connection(null);
    const revoked = connection("u1", "s1");
    const otherDevice = connection("u1", "s2");
    const other = connection("u2", "s3");
    for (const c of [guest, revoked, otherDevice, other]) hub.add(c);

    hub.closeSession("s1");

    expect(revoked.sent.at(-1)).toEqual({ t: "session.revoked" });
    expect(revoked.closedWith).toBe(CLOSE_SESSION_ENDED);
    expect(otherDevice.closedWith).toBeNull();
    expect(other.closedWith).toBeNull();
    expect(hub.isSessionConnected("s1")).toBe(false);
    expect(hub.onlineCount()).toBe(2);

    hub.closeSession("s2");
    expect(hub.onlineCount()).toBe(1);
    expect(guest.sent.at(-1)).toEqual({ t: "online", n: 1 });
  });

  it("closes the sockets of expired sessions", () => {
    const hub = new RealtimeHub();
    const expired = connection("u1", "s1", new Date("2026-01-01T00:00:00Z"));
    const valid = connection("u2", "s2", new Date("2026-01-03T00:00:00Z"));
    hub.add(expired);
    hub.add(valid);

    hub.closeExpired(new Date("2026-01-02T00:00:00Z"));

    expect(expired.closedWith).toBe(CLOSE_SESSION_ENDED);
    expect(valid.closedWith).toBeNull();
    expect(hub.onlineCount()).toBe(1);
  });
});

describe("telling a match that it changed", () => {
  function follower(hub: RealtimeHub, matchId: string) {
    const received: { t: string; kinds?: string[] }[] = [];
    const connection: Connection = {
      userId: null,
      sessionId: null,
      expiresAt: null,
      send: (data) => received.push(JSON.parse(data) as { t: string; kinds?: string[] }),
      close: () => undefined,
    };
    hub.add(connection);
    hub.subscribe(connection, matchId, false);
    return () => received.filter((message) => message.t === "match.update");
  }

  it("tells every change at once when there is no window", () => {
    const hub = new RealtimeHub();
    const updates = follower(hub, "m1");
    hub.matchChanged("m1", "annex");
    hub.matchChanged("m1", "battle");
    expect(updates().map((update) => update.kinds)).toEqual([["annex"], ["battle"]]);
  });

  it("tells the first change at once and the rest together when the window ends", () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub(1000);
      const updates = follower(hub, "m1");
      const other = follower(hub, "m2");

      hub.matchChanged("m1", "annex");
      expect(updates()).toHaveLength(1);
      for (let i = 0; i < 50; i++) hub.matchChanged("m1", i % 2 ? "battle" : "allocate");
      expect(updates()).toHaveLength(1);
      // Another match is not held back by this one.
      hub.matchChanged("m2", "annex");
      expect(other()).toHaveLength(1);

      vi.advanceTimersByTime(1000);
      expect(updates()).toHaveLength(2);
      expect(updates()[1]?.kinds?.sort()).toEqual(["allocate", "battle"]);

      // Nothing else happened: nothing more is said, and the next change is told at once.
      vi.advanceTimersByTime(5000);
      expect(updates()).toHaveLength(2);
      hub.matchChanged("m1", "turn");
      expect(updates()).toHaveLength(3);
      hub.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
