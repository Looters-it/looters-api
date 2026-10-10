/**
 * Duel load test: many matches at the same time, each with two players who do nothing
 * but fight. One attacks, the other defends, the battle goes through the queue to
 * `jobs` and comes back resolved; then again. It measures how the stack holds many
 * battles in parallel across matches: the time of every call, by route, how long a
 * battle takes from the answer of the defender to its result, and how many duels are
 * closed each second. See docs/LOAD.md for how to run it.
 *
 * Players are created straight in the database with a session each, and each match is
 * prepared there for fighting at once (no protection on the capitals, resources enough
 * for many attacks). Everything else goes through the public HTTP interface.
 */
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import { generateSessionToken, hashSessionToken } from "../src/auth/tokens.js";
import { EMPIRE_COLORS, EMPIRE_EMBLEMS } from "../src/rules/catalogue.js";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const BASE = env("DUEL_BASE_URL", "http://localhost:8080");
const MATCHES = Number(env("DUEL_MATCHES", "50"));
const DURATION_SEC = Number(env("DUEL_DURATION_SEC", "60"));
/** How often the attacker reads the state while waiting for the result of a battle. */
const POLL_MS = Number(env("DUEL_POLL_MS", "100"));
/** The run fails when the 95th percentile of any route is above this. */
const P95_LIMIT_MS = Number(env("DUEL_P95_LIMIT_MS", "1000"));
/** The run fails when the 95th percentile of the time to resolve a battle is above this. */
const RESOLVE_P95_LIMIT_MS = Number(env("DUEL_RESOLVE_P95_LIMIT_MS", "3000"));
/** A battle not resolved after this long is counted as lost by the stack. */
const RESOLVE_TIMEOUT_MS = Number(env("DUEL_RESOLVE_TIMEOUT_MS", "20000"));
/** How long the matches may take to open and start before the fighting. */
const OPEN_TIMEOUT_SEC = Number(env("DUEL_OPEN_TIMEOUT_SEC", "300"));
const KEEP = env("DUEL_KEEP", "") !== "";
const PREFIX = "duel_";
/**
 * The attacker is by far the weaker of the two, so it nearly always loses and the match
 * goes on. Both pay a share of what they hold at every battle: they are supplied again
 * every few duels, before the attacker has nothing left to attack with.
 */
const ATTACKER_RESOURCES = 1_000_000;
const DEFENDER_RESOURCES = 2_000_000_000;
const SUPPLY_EVERY = 12;
/** Opening a match is a rush the script makes on purpose: reported, judged on errors only. */
const ENTRY_ROUTES = ["POST match", "POST join", "GET state (waiting to start)"];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required (the database of the stack under test)");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

// ---------- measuring ----------

interface Sample {
  ms: number;
  status: number;
}
const samples = new Map<string, Sample[]>();
const failures: string[] = [];
const resolveTimes: number[] = [];
/** Why a pair stopped fighting in a match and opened another one. */
const rematches = new Map<string, number>();
let matchesPlayed = 0;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the shape the caller reads
async function call<T>(
  player: Player,
  label: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null }> {
  const started = performance.now();
  let status = 0;
  let data: T | null = null;
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        cookie: `sid=${player.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    status = response.status;
    const text = Buffer.from(await response.arrayBuffer()).toString();
    if (response.headers.get("content-type")?.includes("json")) data = JSON.parse(text) as T;
    if (status >= 500) failures.push(`${label}: ${String(status)} ${text.slice(0, 200)}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = samples.get(label) ?? [];
  list.push({ ms: performance.now() - started, status });
  samples.set(label, list);
  return { status, data };
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- the shapes the script reads ----------

interface Player {
  token: string;
}
interface Pair {
  index: number;
  attacker: Player;
  defender: Player;
}
interface Fight {
  matchId: string;
  /** The territory the attacker attacks from. */
  from: string;
  turn: number;
  duels: number;
}
interface State {
  match: { status: string; currentTurn: number };
  me: { empireId: string; status: string } | null;
  territories: { id: string; ownerEmpireId: string }[];
  battles: { id: string; status: string; role: string | null }[];
}
interface Failure {
  error?: { code?: string };
}

// ---------- setup ----------

async function createPairs(): Promise<Pair[]> {
  await cleanUp();
  const pairs: Pair[] = [];
  for (let index = 0; index < MATCHES; index++) {
    const players: Player[] = [];
    for (const side of ["a", "b"]) {
      const username = `${PREFIX}${String(index).padStart(4, "0")}${side}`;
      const token = generateSessionToken();
      await prisma.user.create({
        data: {
          username,
          email: `${username}@example.test`,
          // Nobody logs in as these users: the hash matches no password.
          passwordHash: "load-test-no-login",
          sessions: {
            create: {
              tokenHash: hashSessionToken(token),
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          },
        },
      });
      players.push({ token });
    }
    const [attacker, defender] = players;
    if (attacker && defender) pairs.push({ index, attacker, defender });
  }
  return pairs;
}

/** Removes the users and the matches of this and of earlier runs. */
async function cleanUp(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: PREFIX } },
    select: { id: true },
  });
  if (users.length === 0) return;
  const ids = users.map((user) => user.id);
  await prisma.match.updateMany({ where: { ownerId: { in: ids } }, data: { status: "FINISHED" } });
  await prisma.match.deleteMany({ where: { ownerId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

/** Ready to fight: no protection on the capitals, and resources for many attacks. */
const supply = (fight: Pick<Fight, "matchId" | "from">) => prisma.$executeRaw`
  UPDATE "Territory" SET "protectedUntilTurn" = NULL,
    resources = CASE WHEN id = ${fight.from} THEN ${ATTACKER_RESOURCES}::int ELSE ${DEFENDER_RESOURCES}::int END
  WHERE "matchId" = ${fight.matchId} AND "ownerEmpireId" IS NOT NULL`;

/**
 * Opens a match for the pair on two municipalities that share a border, waits for it
 * to start, then makes it ready for fighting. Returns the match and the territory the
 * attacker attacks from, or null when the match could not be opened.
 */
async function openMatch(
  pair: Pair,
  areaId: string,
  units: [number, number],
  deadline: number,
): Promise<Fight | null> {
  const created = await call<{ id: string }>(pair.attacker, "POST match", "POST", "/api/matches", {
    name: `Duello ${String(pair.index)} ${Date.now().toString(36)}`,
    areaIds: [areaId],
    maxPlayers: 2,
    // Long turns: the test is about the battles, not about the closing of the turns.
    turnHours: 2,
    config: { minPlayersToStart: 2 },
  });
  const matchId = created.data?.id;
  if (!matchId) {
    failures.push(`POST match: refused with ${String(created.status)}`);
    return null;
  }
  for (const [side, player] of [pair.attacker, pair.defender].entries()) {
    const joined = await call(player, "POST join", "POST", `/api/matches/${matchId}/join`, {
      geoUnitId: units[side],
      empire: {
        name: `Duellante ${String(pair.index)}${side === 0 ? "a" : "b"}`,
        color: EMPIRE_COLORS[(pair.index * 2 + side) % EMPIRE_COLORS.length],
        emblem: EMPIRE_EMBLEMS[(pair.index + side) % EMPIRE_EMBLEMS.length],
        motto: null,
      },
    });
    if (joined.status >= 300) {
      failures.push(`POST join: refused with ${String(joined.status)}`);
      return null;
    }
  }
  for (;;) {
    const { data } = await call<State>(
      pair.attacker,
      "GET state (waiting to start)",
      "GET",
      `/api/matches/${matchId}/state`,
    );
    if (data?.match.status === "ONGOING" && data.me) {
      const mine = data.territories.find((t) => t.ownerEmpireId === data.me?.empireId);
      if (!mine) return null;
      const fight = { matchId, from: mine.id, turn: data.match.currentTurn, duels: 0 };
      await supply(fight);
      return fight;
    }
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

// ---------- one duel ----------

/** One attack, its answer and its result. False when the pair cannot go on in this match. */
async function duel(pair: Pair, match: Fight, target: number): Promise<boolean> {
  const base = `/api/matches/${match.matchId}`;
  const stop = (reason: string) => {
    rematches.set(reason, (rematches.get(reason) ?? 0) + 1);
    return false;
  };
  if (match.duels > 0 && match.duels % SUPPLY_EVERY === 0) await supply(match);
  match.duels += 1;
  const attack = await call<Failure>(pair.attacker, "POST attack", "POST", `${base}/attacks`, {
    targetGeoUnitId: target,
    fromTerritoryIds: [match.from],
    turn: match.turn,
  });
  if (attack.status >= 300)
    return stop(attack.data?.error?.code ?? `HTTP ${String(attack.status)}`);

  // The defender sees the attack as the interface would: in the state.
  const seen = await call<State>(pair.defender, "GET state (defender)", "GET", `${base}/state`);
  const battle = seen.data?.battles.find((b) => b.status === "OPEN" && b.role === "defender");
  if (!battle) return stop("attack not seen by the defender");
  const answer = await call<Failure>(
    pair.defender,
    "POST respond",
    "POST",
    `${base}/battles/${battle.id}/respond`,
    { action: "DEFEND" },
  );
  if (answer.status >= 300)
    return stop(answer.data?.error?.code ?? `HTTP ${String(answer.status)}`);

  // From here the battle is with `jobs`: the attacker waits for the result.
  const answered = performance.now();
  for (;;) {
    const { data } = await call<State>(
      pair.attacker,
      "GET state (attacker)",
      "GET",
      `${base}/state`,
    );
    if (data && !data.battles.some((b) => b.id === battle.id && b.status === "OPEN")) {
      resolveTimes.push(performance.now() - answered);
      match.turn = data.match.currentTurn;
      if (data.match.status !== "ONGOING" || data.me?.status !== "ACTIVE") {
        return stop("the match ended");
      }
      return true;
    }
    if (performance.now() - answered > RESOLVE_TIMEOUT_MS) {
      failures.push(`battle ${battle.id} not resolved after ${String(RESOLVE_TIMEOUT_MS)} ms`);
      return stop("battle not resolved");
    }
    await sleep(POLL_MS);
  }
}

// ---------- the run ----------

async function main(): Promise<void> {
  const area = await prisma.geoArea.findFirst({ orderBy: { units: { _count: "desc" } } });
  if (!area) throw new Error("no geographic area loaded: load the municipalities first");
  const border = await prisma.$queryRaw<{ a: number; b: number }[]>`
    SELECT adj."aId" AS a, adj."bId" AS b FROM "GeoAdjacency" adj
    JOIN "GeoUnit" ua ON ua.id = adj."aId" AND ua."areaId" = ${area.id}
    JOIN "GeoUnit" ub ON ub.id = adj."bId" AND ub."areaId" = ${area.id}
    LIMIT 1`;
  const first = border[0];
  if (!first) throw new Error("no two municipalities share a border in this area");
  const units: [number, number] = [first.a, first.b];
  console.log(
    `area "${area.name}"; ${String(MATCHES)} matches of two players, fighting for ${String(DURATION_SEC)} seconds`,
  );

  const pairs = await createPairs();

  // First every match is opened, then they all fight together: the two are measured apart.
  const opening = Date.now();
  const openBy = opening + OPEN_TIMEOUT_SEC * 1000;
  const fights = await Promise.all(pairs.map((pair) => openMatch(pair, area.id, units, openBy)));
  matchesPlayed = fights.filter(Boolean).length;
  console.log(
    `${String(matchesPlayed)}/${String(MATCHES)} matches open after ${((Date.now() - opening) / 1000).toFixed(1)} seconds`,
  );

  const started = Date.now();
  const deadline = started + DURATION_SEC * 1000;
  await Promise.all(
    pairs.map(async (pair, index) => {
      let fight = fights[index] ?? null;
      while (fight && Date.now() < deadline) {
        if (await duel(pair, fight, units[1])) continue;
        // The attacker won against the odds, and the match is over: another one.
        fight = await openMatch(pair, area.id, units, deadline);
        if (fight) matchesPlayed += 1;
      }
    }),
  );
  const fightingSec = Math.max(1, (Date.now() - started) / 1000);

  // ---------- report ----------
  const slowRoutes: string[] = [];
  let total = 0;
  const rows = [...samples.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => {
      const times = list.map((sample) => sample.ms).sort((a, b) => a - b);
      const p95 = percentile(times, 95);
      if (!ENTRY_ROUTES.includes(label) && p95 > P95_LIMIT_MS) slowRoutes.push(label);
      total += list.length;
      return {
        route: label,
        calls: list.length,
        "p50 ms": Math.round(percentile(times, 50)),
        "p95 ms": Math.round(p95),
        "p99 ms": Math.round(percentile(times, 99)),
        "max ms": Math.round(times.at(-1) ?? 0),
        "2xx": list.filter((s) => s.status >= 200 && s.status < 300).length,
        "4xx": list.filter((s) => s.status >= 400 && s.status < 500).length,
        "5xx/failed": list.filter((s) => s.status >= 500 || s.status === 0).length,
      };
    });
  console.table(rows);
  const fought = [...samples.entries()]
    .filter(([label]) => !ENTRY_ROUTES.includes(label))
    .reduce((sum, [, list]) => sum + list.length, 0);
  const resolved = [...resolveTimes].sort((a, b) => a - b);
  const resolveP95 = percentile(resolved, 95);
  console.log(
    `requests: ${String(total)} (${(fought / fightingSec).toFixed(0)} per second while fighting)`,
  );
  console.log(
    `duels: ${String(resolved.length)} resolved in ${String(matchesPlayed)} matches, ${(resolved.length / fightingSec).toFixed(1)} per second (${(resolved.length / fightingSec / MATCHES).toFixed(2)} per match per second)`,
  );
  console.log(
    `battle, from the answer of the defender to the result: p50 ${String(Math.round(percentile(resolved, 50)))} ms, p95 ${String(Math.round(resolveP95))} ms, max ${String(Math.round(resolved.at(-1) ?? 0))} ms (read every ${String(POLL_MS)} ms)`,
  );
  if (rematches.size > 0) {
    console.log(`matches left: ${JSON.stringify(Object.fromEntries(rematches))}`);
  }
  if (failures.length > 0) {
    console.log(`failures (${String(failures.length)}):`);
    for (const failure of [...new Set(failures)].slice(0, 10)) console.log(`  ${failure}`);
  }

  if (!KEEP) await cleanUp();
  await prisma.$disconnect();

  const verdict =
    failures.length > 0
      ? "FAILED: errors"
      : resolved.length === 0
        ? "FAILED: no duel was resolved"
        : slowRoutes.length > 0
          ? `FAILED: a route is slower than ${String(P95_LIMIT_MS)} ms at the 95th percentile`
          : resolveP95 > RESOLVE_P95_LIMIT_MS
            ? `FAILED: battles take ${String(Math.round(resolveP95))} ms to resolve at the 95th percentile`
            : "PASSED";
  console.log(verdict);
  process.exit(verdict === "PASSED" ? 0 : 1);
}

await main();
