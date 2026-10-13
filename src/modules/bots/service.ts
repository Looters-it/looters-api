import { preliminaryEndsAt } from "../../rules/phases.js";
import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/sessions.js";
import { AppError } from "../../http/errors.js";
import { EMPIRE_COLORS, EMPIRE_EMBLEMS } from "../../rules/catalogue.js";
import type { AllianceService } from "../game/alliances.js";
import type { BattleService } from "../game/battles.js";
import type { GameService } from "../game/service.js";
import type { StructureService } from "../game/structures.js";
import { rulesOf, type MatchService } from "../matches/service.js";

/** A number in [0, 1): `Math.random` in the game, fixed in tests. */
export type Random = () => number;

/** Between two bots founded at the start of a match. */
const BIRTH_PAUSE_MS = 700;
/** The pause between two moves: within these bounds, and within this share of the turn. */
const STEP_MIN_MS = 300;
const STEP_MAX_MS = 2500;
const TURN_SHARE = 0.6;
/** Waited past the end of the preliminary part, so that the first move is not early. */
const PHASE_MARGIN_MS = 250;

const TITLES = ["Signoria", "Contea", "Marca", "Ducato", "Lega", "Repubblica", "Principato"];

/** A bot plays through the same services as a player: it is given no session, only a name. */
const viewerOf = (user: { id: string; username: string }): AuthContext => ({
  sessionId: `bot:${user.id}`,
  expiresAt: new Date(8.64e15),
  user: { id: user.id, username: user.username, role: "USER" },
});

/**
 * Empires played by the server (decided with the owner of the project: one
 * human is enough for a match, the others can be bots).
 *
 * A bot is an ordinary empire of an ordinary user that nobody can log in as.
 * It acts through the very services a player's requests reach, so every rule,
 * lock and limit applies to it as it is, and it knows only what a player in
 * its place would be shown: it never reads another empire's resources.
 */
/** How often a bot that can build a port, or an airport, does; and widens one it has. */
const BOT_PORT_CHANCE = 0.25;
const BOT_AIRPORT_CHANCE = 0.1;
const BOT_UPGRADE_CHANCE = 0.1;
/** How many far targets a bot tries in a turn before it gives up. */
const FAR_TRIES = 3;

export class BotService {
  /** Failures that are not the game saying no: for the log. */
  onError: (error: unknown, context: { matchId: string; empireId?: string }) => void = () =>
    undefined;

  /**
   * Waits between one move of a bot and the next. Where the game runs it is a real
   * pause, so that the map changes a move at a time and the board is not flooded;
   * in tests it is no wait at all.
   */
  pause: (ms: number) => Promise<void> = () => Promise.resolve();
  /** The pause in use for the turn being played. */
  private stepMs = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly matches: MatchService,
    private readonly game: GameService,
    private readonly battles: BattleService,
    private readonly structures: StructureService,
    private readonly alliances: AllianceService,
    private readonly random: Random = Math.random,
  ) {}

  private pick<T>(items: readonly T[]): T | undefined {
    return items[Math.floor(this.random() * items.length)];
  }
  private shuffled<T>(items: readonly T[]): T[] {
    return items
      .map((item) => ({ item, key: this.random() }))
      .sort((a, b) => a.key - b.key)
      .map(({ item }) => item);
  }

  /** Runs an action of the game; a refusal by the rules is a normal outcome and is ignored. */
  private async attempt<T>(action: () => Promise<T>): Promise<T | null> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AppError && error.status < 500) return null;
      throw error;
    }
  }

  private async runningWithBots(matchId: string) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    // A paused match waits: the bots play the turn again when it is resumed.
    if (match?.status !== "ONGOING" || match.pausedAt) return null;
    const rules = rulesOf(match);
    return rules.botsEnabled ? { match, rules } : null;
  }

  private bots(matchId: string) {
    return this.prisma.empire.findMany({
      where: { matchId, status: "ACTIVE", user: { isBot: true } },
      orderBy: { joinedAt: "asc" },
      select: {
        id: true,
        capitalTerritoryId: true,
        user: { select: { id: true, username: true } },
      },
    });
  }

  /**
   * What happens when a turn of a match begins: perhaps a new bot founds an
   * empire on a free municipality, then every bot plays its turn. The bots that
   * a match has from its start are founded on its first turn, or on the first one
   * the server is there for.
   *
   * Nothing happens all at once: the moves are spread over the first part of the
   * turn, one after the other with a pause between them.
   */
  async playTurn(matchId: string): Promise<void> {
    const running = await this.runningWithBots(matchId);
    if (!running) return;
    const { match, rules } = running;
    const turn = match.currentTurn;
    try {
      // Every bot ever founded counts, fallen ones too: the bots of the start are owed
      // once, on the first turn that is played, which is not the first of the match if
      // the server was down then.
      const there = await this.prisma.empire.count({
        where: { matchId, user: { isBot: true } },
      });
      if (there < rules.botsAtStart) {
        for (let missing = rules.botsAtStart - there; missing > 0; missing--) {
          if (!(await this.maybeSpawn(matchId, true))) break;
          await this.pause(BIRTH_PAUSE_MS);
        }
      } else {
        await this.maybeSpawn(matchId);
      }
    } catch (error) {
      this.onError(error, { matchId });
    }
    const bots = this.shuffled(await this.bots(matchId));
    // The preliminary part of the turn is for putting the empire in order; what the
    // bots do to the others waits for it to end, as it does for the players.
    const preliminaryEnd = preliminaryEndsAt(match);
    if (preliminaryEnd && preliminaryEnd.getTime() > Date.now()) {
      for (const bot of bots) {
        try {
          await this.prepare(matchId, bot, turn);
        } catch (error) {
          this.onError(error, { matchId, empireId: bot.id });
        }
      }
      await this.pause(Math.max(0, preliminaryEnd.getTime() - Date.now()) + PHASE_MARGIN_MS);
    }
    // As many pauses as moves can be expected, within the part of the turn that is
    // theirs: the rest is left to the players, and to the answers to the attacks.
    const left = match.turnEndsAt ? match.turnEndsAt.getTime() - Date.now() : 0;
    const moves = Math.max(1, bots.length * (rules.annexPerTurn + 1));
    this.stepMs = Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, (left * TURN_SHARE) / moves));
    for (const bot of bots) {
      // The turn went by while the others were moving: the rest belongs to the next.
      const now = await this.prisma.match.findUnique({
        where: { id: matchId },
        select: { currentTurn: true, status: true, pausedAt: true },
      });
      if (now?.status !== "ONGOING" || now.currentTurn !== turn || now.pausedAt) return;
      try {
        await this.act(matchId, bot);
      } catch (error) {
        this.onError(error, { matchId, empireId: bot.id });
      }
    }
  }

  /** Bots under attack answer, like a player who sees the alert. */
  async answerAttacks(matchId: string): Promise<void> {
    if (!(await this.runningWithBots(matchId))) return;
    for (const bot of await this.bots(matchId)) {
      try {
        await this.answer(matchId, bot);
      } catch (error) {
        this.onError(error, { matchId, empireId: bot.id });
      }
    }
  }

  /**
   * Founds a bot empire on a free municipality, with the chance the match
   * sets and while there is room. Returns the empire, or null when none was
   * founded.
   */
  async maybeSpawn(matchId: string, force = false): Promise<{ empireId: string } | null> {
    const running = await this.runningWithBots(matchId);
    if (!running) return null;
    const { match, rules } = running;
    const empires = await this.prisma.empire.findMany({
      where: { matchId },
      select: { name: true, color: true, user: { select: { isBot: true } } },
    });
    const botCount = empires.filter((empire) => empire.user.isBot).length;
    if (botCount >= rules.botsMax || empires.length >= match.maxPlayers) return null;
    if (!force && this.random() * 100 >= rules.botSpawnChancePct) return null;

    // Away from the players, who need room to grow before they meet anyone, but not
    // nowhere: on the ring of free municipalities exactly four steps from what
    // a player holds, and touching no empire. On a map of thousands of municipalities,
    // anywhere at random would be nowhere.
    const candidates = (tier: Prisma.Sql) => this.prisma.$queryRaw<
      { geoUnitId: number; name: string }[]
    >`
      WITH edges AS (
        SELECT "aId" AS x, "bId" AS y FROM "GeoAdjacency"
        UNION ALL SELECT "bId", "aId" FROM "GeoAdjacency"
      ), units AS (
        SELECT tu."geoUnitId" AS id, t."ownerEmpireId" AS owner
        FROM "TerritoryUnit" tu JOIN "Territory" t ON t.id = tu."territoryId"
        WHERE tu."matchId" = ${matchId}
      ), owned AS (SELECT id FROM units WHERE owner IS NOT NULL),
      beside AS (SELECT DISTINCT e.y AS id FROM edges e JOIN owned o ON o.id = e.x),
      d0 AS (
        SELECT u.id FROM units u
        JOIN "Empire" e ON e.id = u.owner JOIN "User" p ON p.id = e."userId"
        WHERE NOT p."isBot"
      ),
      d1 AS (SELECT DISTINCT e.y AS id FROM edges e JOIN d0 ON d0.id = e.x),
      d2 AS (SELECT DISTINCT e.y AS id FROM edges e JOIN d1 ON d1.id = e.x),
      d3 AS (SELECT DISTINCT e.y AS id FROM edges e JOIN d2 ON d2.id = e.x),
      d4 AS (SELECT DISTINCT e.y AS id FROM edges e JOIN d3 ON d3.id = e.x),
      close AS (
        SELECT id FROM d0 UNION SELECT id FROM d1 UNION SELECT id FROM d2 UNION SELECT id FROM d3
      )
      SELECT u.id AS "geoUnitId", g.name
      FROM units u JOIN "GeoUnit" g ON g.id = u.id
      WHERE u.owner IS NULL AND EXISTS (SELECT 1 FROM edges e WHERE e.x = u.id) AND ${tier}
      ORDER BY random() LIMIT 50`;
    // Then anywhere at least as far, even beside another bot; and on a map too small
    // for that, any free municipality that borders something: an island would strand it.
    let free = await candidates(Prisma.sql`
      u.id IN (SELECT id FROM d4) AND u.id NOT IN (SELECT id FROM close)
      AND u.id NOT IN (SELECT id FROM beside)`);
    if (free.length === 0) free = await candidates(Prisma.sql`u.id NOT IN (SELECT id FROM close)`);
    if (free.length === 0) free = await candidates(Prisma.sql`true`);
    const start = this.pick(free);
    const color = EMPIRE_COLORS.find((candidate) => !empires.some((e) => e.color === candidate));
    if (!start || !color) return null;

    const taken = new Set(empires.map((empire) => empire.name));
    const base = `${this.pick(TITLES) ?? TITLES[0]} di ${start.name}`.slice(0, 36);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${String(n)}`;

    const user = await this.prisma.user.create({
      data: {
        username: `bot_${randomBytes(6).toString("hex")}`,
        email: "bot@looters.invalid",
        // Matches no password: nobody logs in as a bot.
        passwordHash: "!",
        isBot: true,
      },
    });
    const joined = await this.attempt(() =>
      this.matches.join(
        matchId,
        {
          geoUnitId: start.geoUnitId,
          empire: { name, color, emblem: this.pick(EMPIRE_EMBLEMS) ?? "torre", motto: null },
        },
        viewerOf(user),
        { asBot: true },
      ),
    );
    if (!joined?.me) {
      // Somebody took the municipality meanwhile: no empire, no user.
      await this.prisma.user.delete({ where: { id: user.id } });
      return null;
    }
    return { empireId: joined.me.empireId };
  }

  private async answer(matchId: string, bot: { user: { id: string; username: string } }) {
    const viewer = viewerOf(bot.user);
    const state = await this.matches.state(matchId, viewer);
    for (const battle of state.battles) {
      if (battle.status !== "OPEN" || battle.role !== "defender" || battle.response) continue;
      // A siege waits for the next turn once this turn's round is fought.
      if (battle.foughtThisTurn) continue;
      // It gives up a territory now and then, never its capital.
      const capital = state.empires.find((e) => e.id === state.me?.empireId)?.capitalTerritoryId;
      const surrender = battle.targetTerritoryId !== capital && this.random() < 0.2;
      await this.attempt(() =>
        this.battles.respond(
          matchId,
          battle.id,
          { action: surrender ? "SURRENDER" : "DEFEND" },
          viewer,
        ),
      );
    }
  }

  /**
   * What a bot does in the preliminary part of a turn: once in a while a block on its
   * capital, a port or an airport where one can be built, and a wider range for one it has.
   */
  private async prepare(
    matchId: string,
    bot: { id: string; capitalTerritoryId: string | null; user: { id: string; username: string } },
    turn: number,
  ) {
    const viewer = viewerOf(bot.user);
    const capital = bot.capitalTerritoryId;
    if (capital && this.random() < 0.1) {
      await this.attempt(() =>
        this.structures.build(matchId, { type: "BLOCK", territoryId: capital, turn }, viewer),
      );
    }

    // What reaches far: one of each kind is enough for a bot, the port first.
    const catalogue = (await this.attempt(() => this.structures.catalogue(matchId, viewer))) ?? [];
    const state = await this.attempt(() => this.matches.state(matchId, viewer));
    const mine = state?.structures.filter((s) => s.empireId === bot.id) ?? [];
    for (const [effect, chance] of [
      ["SEA_REACH", BOT_PORT_CHANCE],
      ["AIR_REACH", BOT_AIRPORT_CHANCE],
    ] as const) {
      if (mine.some((structure) => structure.effects.includes(effect))) continue;
      const entry = catalogue.find((candidate) => candidate.effects.includes(effect));
      // Where it holds the most: the place is paid for by the territory it stands on.
      const site = entry?.sites
        .filter((candidate) => candidate.blocked === null)
        .sort((a, b) => b.resources - a.resources)[0];
      if (!entry || !site || this.random() >= chance) continue;
      await this.attempt(() =>
        this.structures.build(
          matchId,
          { type: entry.type, territoryId: site.territoryId, turn },
          viewer,
        ),
      );
    }
    for (const structure of mine) {
      if (!structure.upgrade || this.random() >= BOT_UPGRADE_CHANCE) continue;
      await this.attempt(() => this.structures.upgrade(matchId, structure.id, { turn }, viewer));
    }
  }

  /** One bot's turn: answer what waits for an answer, grow, and sometimes strike. */
  private async act(matchId: string, bot: { user: { id: string; username: string } }) {
    const viewer = viewerOf(bot.user);
    await this.answer(matchId, bot);

    let state = await this.matches.state(matchId, viewer);
    if (!state.me || state.me.status !== "ACTIVE") return;
    const mineId = state.me.empireId;
    const turn = state.match.currentTurn;

    // Proposals of alliance: taken half of the times.
    for (const invite of state.invites.filter((i) => i.toEmpireId === mineId)) {
      const action = this.random() < 0.5 ? "accept" : "decline";
      await this.attempt(() => this.alliances.answer(matchId, invite.id, action, viewer));
    }

    const own = () => this.shuffled(state.territories.filter((t) => t.ownerEmpireId === mineId));
    const cardOf = (geoUnitId: number) =>
      this.attempt(() => this.game.unit(matchId, geoUnitId, viewer));

    // Annex free neighbours while the turn allows it.
    for (let tries = 0; tries < 4 && state.me && state.me.annexLeft > 0; tries++) {
      let annexed = false;
      for (const territory of own()) {
        const card = await cardOf(territory.geoUnitIds[0] ?? 0);
        const target = this.pick(card?.neighbours.filter((n) => n.ownerEmpireId === null) ?? []);
        if (!target) continue;
        const payer = (await cardOf(target.geoUnitId))?.annex?.payFrom.find((p) => p.usable);
        if (!payer) continue;
        const next = await this.attempt(() =>
          this.game.annex(
            matchId,
            { geoUnitId: target.geoUnitId, payFromTerritoryId: payer.territoryId, turn },
            viewer,
          ),
        );
        if (next) {
          state = next;
          annexed = true;
          await this.pause(this.stepMs);
          break;
        }
      }
      if (!annexed) break;
    }

    // What its borders do not touch, and a port or an airport reaches: the map tells a
    // bot what it tells a player.
    const far = await this.attempt(() => this.game.targets(matchId, viewer));
    for (const geoUnitId of this.shuffled(far?.annexUnitIds ?? []).slice(0, FAR_TRIES)) {
      if (!state.me || state.me.annexLeft <= 0) break;
      const payer = (await cardOf(geoUnitId))?.annex?.payFrom.find((p) => p.usable);
      if (!payer) continue;
      const next = await this.attempt(() =>
        this.game.annex(
          matchId,
          { geoUnitId, payFromTerritoryId: payer.territoryId, turn },
          viewer,
        ),
      );
      if (next) {
        state = next;
        await this.pause(this.stepMs);
      }
    }

    // Attack a neighbour, about every other turn.
    if (this.random() < 0.5) {
      let struck = false;
      for (const territory of own()) {
        const card = await cardOf(territory.geoUnitIds[0] ?? 0);
        const enemy = this.pick(
          card?.neighbours.filter((n) => n.ownerEmpireId !== null && n.ownerEmpireId !== mineId) ??
            [],
        );
        if (!enemy) continue;
        // What a player sees on the enemy's card: whether it can be attacked, and from where.
        const attack = (await cardOf(enemy.geoUnitId))?.attack;
        const sources = attack?.from.filter((s) => s.usable).map((s) => s.territoryId) ?? [];
        if (!attack || attack.blocked !== null || sources.length === 0) continue;
        const declared = await this.attempt(() =>
          this.battles.declare(
            matchId,
            { targetGeoUnitId: enemy.geoUnitId, fromTerritoryIds: sources, turn },
            viewer,
          ),
        );
        if (declared) {
          struck = true;
          await this.pause(this.stepMs);
          break;
        }
      }
      // No neighbour to strike: across the sea or by air, where it reaches.
      for (const territoryId of struck
        ? []
        : this.shuffled(far?.territoryIds ?? []).slice(0, FAR_TRIES)) {
        const geoUnitId = state.territories.find((t) => t.id === territoryId)?.geoUnitIds[0];
        if (geoUnitId === undefined) continue;
        const attack = (await cardOf(geoUnitId))?.attack;
        // From one place only, the one that holds the most: every territory that joins
        // an attack makes all of them pay a larger share.
        const sources =
          attack?.from
            .filter((s) => s.usable)
            .slice(0, 1)
            .map((s) => s.territoryId) ?? [];
        if (!attack || attack.blocked !== null || sources.length === 0) continue;
        const declared = await this.attempt(() =>
          this.battles.declare(
            matchId,
            { targetGeoUnitId: geoUnitId, fromTerritoryIds: sources, turn },
            viewer,
          ),
        );
        if (declared) {
          await this.pause(this.stepMs);
          break;
        }
      }
    }
  }
}
