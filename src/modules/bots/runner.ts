import type { BotService } from "./service.js";

/** Kinds of change after which the bots of a match have something to do. */
const TURN_BEGINS = new Set(["turn.closed", "match.started"]);

/**
 * Decides when bots act. They play when a turn begins and answer when
 * somebody attacks, after a short pause, one match at a time: never inside
 * the request that caused it.
 */
export class BotRunner {
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly bots: BotService,
    private readonly delayMs: () => number = () => 1500 + Math.random() * 3000,
  ) {}

  /** To be told of every change of a match. */
  matchChanged(matchId: string, kind: string): void {
    if (TURN_BEGINS.has(kind)) this.schedule(`turn:${matchId}`, matchId, "playTurn");
    else if (kind === "battles") this.schedule(`answer:${matchId}`, matchId, "answerAttacks");
  }

  private schedule(key: string, matchId: string, task: "playTurn" | "answerAttacks"): void {
    if (this.stopped || this.pending.has(key)) return;
    const timer = setTimeout(() => {
      this.pending.delete(key);
      // One thing at a time for a match: the next waits for the one in progress.
      const previous = this.running.get(matchId) ?? Promise.resolve();
      const next = previous.then(() => this.bots[task](matchId)).catch(() => undefined);
      this.running.set(matchId, next);
      void next.then(() => {
        if (this.running.get(matchId) === next) this.running.delete(matchId);
      });
    }, this.delayMs());
    timer.unref();
    this.pending.set(key, timer);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
