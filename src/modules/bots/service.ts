import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
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
export class BotService {
  /** Failures that are not the game saying no: for the log. */
  onError: (error: unknown, context: { matchId: string; empireId?: string }) => void = () =>
    undefined;

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
    if (match?.status !== "RUNNING") return null;
    const rules = rulesOf(match);
    return rules.botsEnabled ? { match, rules } : null;
  }

  private bots(matchId: string) {
    return this.prisma.empire.findMany({
      where: { matchId, status: "ACTIVE", user: { isBot: true } },
      orderBy: { joinedAt: "asc" },
      select: { id: true, user: { select: { id: true, username: true } } },
    });
  }

  /**
   * What happens when a turn of a match begins: perhaps a new bot founds an
   * empire on a free municipality, then every bot plays its turn.
   */
  async playTurn(matchId: string): Promise<void> {
    const running = await this.runningWithBots(matchId);
    if (!running) return;
    try {
      await this.maybeSpawn(matchId);
    } catch (error) {
      this.onError(error, { matchId });
    }
    for (const bot of this.shuffled(await this.bots(matchId))) {
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

    // Near the empires that are there, so that it becomes a neighbour to deal with:
    // a free municipality two steps from an owned one, never touching it. On a map of
    // thousands of municipalities, anywhere at random would be nowhere.
    const near = await this.prisma.$queryRaw<{ geoUnitId: number; name: string }[]>`
      WITH edges AS (
        SELECT "aId" AS x, "bId" AS y FROM "GeoAdjacency"
        UNION ALL SELECT "bId", "aId" FROM "GeoAdjacency"
      ), units AS (
        SELECT tu."geoUnitId" AS id, t."ownerEmpireId" AS owner
        FROM "TerritoryUnit" tu JOIN "Territory" t ON t.id = tu."territoryId"
        WHERE tu."matchId" = ${matchId}
      ), owned AS (SELECT id FROM units WHERE owner IS NOT NULL),
      beside AS (SELECT DISTINCT e.y AS id FROM edges e JOIN owned o ON o.id = e.x)
      SELECT DISTINCT u.id AS "geoUnitId", g.name
      FROM beside b
      JOIN edges e ON e.x = b.id
      JOIN units u ON u.id = e.y AND u.owner IS NULL
      JOIN "GeoUnit" g ON g.id = u.id
      WHERE u.id NOT IN (SELECT id FROM beside)
      LIMIT 200`;
    // Otherwise any free municipality that borders something: an island would strand it.
    const free =
      near.length > 0
        ? near
        : await this.prisma.$queryRaw<{ geoUnitId: number; name: string }[]>`
            SELECT tu."geoUnitId", u.name
            FROM "Territory" t
            JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
            JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
            WHERE t."matchId" = ${matchId} AND t."ownerEmpireId" IS NULL
              AND EXISTS (SELECT 1 FROM "GeoAdjacency" a WHERE a."aId" = u.id OR a."bId" = u.id)
            ORDER BY random() LIMIT 20`;
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
          break;
        }
      }
      if (!annexed) break;
    }

    // A block on the capital, once in a while and when it can be afforded.
    const capital = state.empires.find((e) => e.id === mineId)?.capitalTerritoryId;
    if (capital && this.random() < 0.1) {
      await this.attempt(() =>
        this.structures.build(matchId, { type: "BLOCK", territoryId: capital, turn }, viewer),
      );
    }

    // Attack a neighbour, about every other turn.
    if (this.random() < 0.5) {
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
        if (declared) break;
      }
    }
  }
}
