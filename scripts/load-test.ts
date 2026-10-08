/**
 * Load test: N players on the largest area loaded (the whole of Italy), playing a match
 * with short turns against a running stack. It measures what a player feels — the time
 * of every call, by route — and what the game must keep: turns closing on time and no
 * server error. See the README of the root repository for how to run it.
 *
 * Players are created straight in the database with a session each: registering a
 * hundred users from one address is exactly what the rate limits are there to stop.
 * Everything else goes through the public HTTP and WebSocket interface.
 */
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import WebSocket from "ws";
import { generateSessionToken, hashSessionToken } from "../src/auth/tokens.js";
import { EMPIRE_COLORS, EMPIRE_EMBLEMS } from "../src/rules/catalogue.js";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const BASE = env("LOAD_BASE_URL", "http://localhost:8080");
const PLAYERS = Number(env("LOAD_PLAYERS", "100"));
const DURATION_SEC = Number(env("LOAD_DURATION_SEC", "180"));
const TURN_SEC = Number(env("LOAD_TURN_SEC", "45"));
const THINK_MS = Number(env("LOAD_THINK_MS", "1000"));
const START_IN_SEC = Number(env("LOAD_START_IN_SEC", "25"));
/** The run fails when the 95th percentile of any route is above this. */
const P95_LIMIT_MS = Number(env("LOAD_P95_LIMIT_MS", "1000"));
/** The run fails when a turn closes later than this after its deadline. */
const TURN_LAG_LIMIT_MS = Number(env("LOAD_TURN_LAG_LIMIT_MS", "5000"));
const KEEP = env("LOAD_KEEP", "") !== "";
const PREFIX = "load_";
const ENTRY_ROUTES = ["POST match", "POST open", "POST join", "GET map", "GET units", "GET tile"];

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

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the shape the caller reads
async function call<T>(
  player: Player | null,
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
        ...(player ? { cookie: `sid=${player.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    status = response.status;
    const text = await response.arrayBuffer();
    if (response.headers.get("content-type")?.includes("json")) {
      data = JSON.parse(Buffer.from(text).toString()) as T;
    }
    if (status >= 500) {
      failures.push(`${label}: ${String(status)} ${Buffer.from(text).toString().slice(0, 200)}`);
    }
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
const pick = <T>(items: readonly T[]): T | undefined =>
  items[Math.floor(Math.random() * items.length)];

// ---------- the shapes the script reads ----------

interface Player {
  index: number;
  userId: string;
  token: string;
  empireId: string | null;
  socket: WebSocket | null;
  messages: number;
  /** A state read caused by a push is in flight, and whether another push came meanwhile. */
  reading: boolean;
  stale: boolean;
}
interface State {
  match: { status: string; currentTurn: number; turnEndsAt: string | null };
  me: { empireId: string; annexLeft: number; status: string } | null;
  territories: {
    id: string;
    ownerEmpireId: string;
    geoUnitIds: number[];
    resources: number | null;
    battleId: string | null;
  }[];
  battles: { id: string; status: string; role: string | null }[];
}
interface Card {
  neighbours: { geoUnitId: number; territoryId: string; ownerEmpireId: string | null }[];
  annex: { cost: number; payFrom: { territoryId: string; usable: boolean }[] } | null;
  attack: { blocked: string | null; from: { territoryId: string; usable: boolean }[] } | null;
}

// ---------- setup ----------

async function createPlayers(): Promise<Player[]> {
  await cleanUp();
  const players: Player[] = [];
  for (let index = 0; index < PLAYERS; index++) {
    const username = `${PREFIX}${String(index).padStart(3, "0")}`;
    const token = generateSessionToken();
    const user = await prisma.user.create({
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
    players.push({
      index,
      userId: user.id,
      token,
      empireId: null,
      socket: null,
      messages: 0,
      reading: false,
      stale: false,
    });
  }
  return players;
}

/** Removes the users and the matches of earlier runs. */
async function cleanUp(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: PREFIX } },
    select: { id: true },
  });
  if (users.length === 0) return;
  const ids = users.map((user) => user.id);
  await prisma.match.deleteMany({ where: { ownerId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Starting points: pairs of municipalities two steps apart, so that after one
 * annexation the two empires touch and battles happen within the first turns.
 */
async function startingUnits(areaId: string): Promise<number[]> {
  const pairs = await prisma.$queryRaw<{ a: number; b: number }[]>`
    WITH edges AS (
      SELECT "aId" AS x, "bId" AS y FROM "GeoAdjacency"
      UNION ALL SELECT "bId", "aId" FROM "GeoAdjacency"
    )
    SELECT DISTINCT ON (e1.x) e1.x AS a, e2.y AS b
    FROM edges e1
    JOIN edges e2 ON e2.x = e1.y AND e2.y <> e1.x
    JOIN "GeoUnit" u ON u.id = e1.x AND u."areaId" = ${areaId}
    WHERE NOT EXISTS (SELECT 1 FROM edges d WHERE d.x = e1.x AND d.y = e2.y)
    ORDER BY e1.x, random()`;
  const taken = new Set<number>();
  const units: number[] = [];
  for (const pair of pairs.sort(() => Math.random() - 0.5)) {
    if (units.length >= PLAYERS) break;
    if (taken.has(pair.a) || taken.has(pair.b)) continue;
    taken.add(pair.a).add(pair.b);
    units.push(pair.a, pair.b);
  }
  return units.slice(0, PLAYERS);
}

function connect(player: Player, matchId: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`, {
      headers: { cookie: `sid=${player.token}` },
    });
    player.socket = socket;
    socket.on("open", () => {
      socket.send(JSON.stringify({ t: "sub", matchId }));
      resolve();
    });
    socket.on("message", (data: Buffer) => {
      player.messages += 1;
      // What the interface does when the match changes: it reads the state again. One
      // read at a time, and one more if something else changed meanwhile.
      if (data.toString().includes('"match.update"')) void refresh(player, matchId);
    });
    socket.on("error", (error) => {
      failures.push(`websocket: ${error.message}`);
      resolve();
    });
  });
}

/** Read through a function: the flag is set by another push while the read is awaited. */
const isStale = (player: Player) => player.stale;

async function refresh(player: Player, matchId: string): Promise<void> {
  if (player.reading) {
    player.stale = true;
    return;
  }
  player.reading = true;
  do {
    player.stale = false;
    await call(player, "GET state (pushed)", "GET", `/api/matches/${matchId}/state`);
  } while (isStale(player) && player.socket?.readyState === WebSocket.OPEN);
  player.reading = false;
}

// ---------- one player's turn at the keyboard ----------

async function act(player: Player, matchId: string): Promise<void> {
  const base = `/api/matches/${matchId}`;
  // What the interface does on every update: read the state again.
  const { data: state } = await call<State>(player, "GET state", "GET", `${base}/state`);
  if (!state?.me || state.me.status !== "ACTIVE" || state.match.status !== "RUNNING") return;
  const turn = state.match.currentTurn;
  const mine = state.territories.filter((t) => t.ownerEmpireId === state.me?.empireId);

  // An attack to answer comes first, as it would for a player.
  const incoming = state.battles.find((b) => b.status === "OPEN" && b.role === "defender");
  if (incoming) {
    await call(player, "POST respond", "POST", `${base}/battles/${incoming.id}/respond`, {
      action: Math.random() < 0.8 ? "DEFEND" : "SURRENDER",
    });
    return;
  }

  const from = pick(mine);
  if (!from) return;
  const unitId = pick(from.geoUnitIds) ?? 0;
  const { data: card } = await call<Card>(
    player,
    "GET unit card",
    "GET",
    `${base}/units/${String(unitId)}`,
  );
  if (!card) return;

  const roll = Math.random();
  const free = card.neighbours.filter((n) => n.ownerEmpireId === null);
  const enemies = card.neighbours.filter(
    (n) => n.ownerEmpireId !== null && n.ownerEmpireId !== state.me?.empireId,
  );
  const target = pick(free);
  if (target && state.me.annexLeft > 0 && roll < 0.7) {
    await call(player, "POST annex", "POST", `${base}/annex`, {
      geoUnitId: target.geoUnitId,
      payFromTerritoryId: from.id,
      turn,
    });
    return;
  }
  const enemy = pick(enemies);
  if (enemy && roll < 0.9) {
    const { data: theirs } = await call<Card>(
      player,
      "GET unit card",
      "GET",
      `${base}/units/${String(enemy.geoUnitId)}`,
    );
    const sources = theirs?.attack?.from.filter((s) => s.usable).map((s) => s.territoryId) ?? [];
    if (theirs?.attack && theirs.attack.blocked === null && sources.length > 0) {
      await call(player, "POST attack", "POST", `${base}/attacks`, {
        targetGeoUnitId: enemy.geoUnitId,
        fromTerritoryIds: sources,
        turn,
      });
      return;
    }
  }
  // Otherwise move one resource between two own territories, or look around.
  const [a, b] = mine.filter((t) => t.battleId === null && t.resources !== null);
  if (a && b && (a.resources ?? 0) > 1 && roll < 0.95) {
    await call(player, "POST allocate", "POST", `${base}/allocate`, {
      amounts: { [a.id]: (a.resources ?? 0) - 1, [b.id]: (b.resources ?? 0) + 1 },
      turn,
    });
    return;
  }
  await call(player, "GET board", "GET", `${base}/board`);
}

// ---------- the run ----------

async function main(): Promise<void> {
  const area = await prisma.geoArea.findFirst({ orderBy: { units: { _count: "desc" } } });
  if (!area) throw new Error("no geographic area loaded: load the municipalities first");
  const unitCount = await prisma.geoUnit.count({ where: { areaId: area.id } });
  console.log(
    `area "${area.name}" with ${String(unitCount)} municipalities; ${String(PLAYERS)} players`,
  );

  const players = await createPlayers();
  const owner = players[0];
  if (!owner) throw new Error("no players");
  const starts = await startingUnits(area.id);
  if (starts.length < PLAYERS) throw new Error("not enough starting points in this area");

  const created = await call<{ id: string }>(owner, "POST match", "POST", "/api/matches", {
    name: `Prova di carico ${new Date().toISOString().slice(11, 19)}`,
    areaIds: [area.id],
    startAt: new Date(Date.now() + START_IN_SEC * 1000).toISOString(),
    maxPlayers: Math.max(PLAYERS, 2),
    turnHours: Math.max(0.01, TURN_SEC / 3600),
  });
  const matchId = created.data?.id;
  if (!matchId) throw new Error(`could not create the match: ${String(created.status)}`);
  await call(owner, "POST open", "POST", `/api/matches/${matchId}/open`);

  // Everybody registers at once: the rush when registrations open.
  const joined = await Promise.all(
    players.map((player, index) =>
      call<State>(player, "POST join", "POST", `/api/matches/${matchId}/join`, {
        geoUnitId: starts[index],
        empire: {
          name: `Impero di carico ${String(index)}`,
          color: EMPIRE_COLORS[index % EMPIRE_COLORS.length],
          emblem: EMPIRE_EMBLEMS[index % EMPIRE_EMBLEMS.length],
          motto: null,
        },
      }),
    ),
  );
  const refused = joined.filter((result) => result.status >= 300).length;
  console.log(`joined: ${String(PLAYERS - refused)}/${String(PLAYERS)}`);

  await Promise.all(players.map((player) => connect(player, matchId)));
  // The map everybody loads on entering.
  await Promise.all(
    players.map(async (player) => {
      await call(player, "GET map", "GET", `/api/matches/${matchId}/map`);
      await call(player, "GET units", "GET", `/api/matches/${matchId}/units`);
      for (const [z, x, y] of [
        [5, 16, 11],
        [6, 33, 23],
        [7, 67, 46],
      ] as const) {
        await call(
          player,
          "GET tile",
          "GET",
          `/api/matches/${matchId}/tiles/${String(z)}/${String(x)}/${String(y)}.mvt`,
        );
      }
    }),
  );

  console.log("waiting for the match to start…");
  for (;;) {
    const { data } = await call<State>(owner, "GET state", "GET", `/api/matches/${matchId}/state`);
    if (data?.match.status === "RUNNING") break;
    if (data?.match.status === "FINISHED") throw new Error("the match ended before starting");
    await sleep(500);
  }

  // Turn closes, as seen from outside: how long after its deadline a turn gives way to the next.
  const turnLags: number[] = [];
  let watching = true;
  const watcher = (async () => {
    let turn = 0;
    let endsAt = 0;
    while (watching) {
      const response = await fetch(`${BASE}/api/matches/${matchId}`).catch(() => null);
      const match = response?.ok
        ? ((await response.json()) as {
            currentTurn: number;
            turnEndsAt: string | null;
            status: string;
          })
        : null;
      if (match) {
        if (turn !== 0 && match.currentTurn > turn) turnLags.push(Date.now() - endsAt);
        if (match.currentTurn !== turn) {
          turn = match.currentTurn;
          endsAt = match.turnEndsAt ? Date.parse(match.turnEndsAt) : 0;
        }
        if (match.status === "FINISHED") watching = false;
      }
      await sleep(200);
    }
  })();

  console.log(`playing for ${String(DURATION_SEC)} seconds, turns of ${String(TURN_SEC)} seconds…`);
  const playStarted = Date.now();
  const deadline = playStarted + DURATION_SEC * 1000;
  await Promise.all(
    players.map(async (player) => {
      await sleep(Math.random() * THINK_MS);
      while (Date.now() < deadline && watching) {
        await act(player, matchId);
        await sleep(THINK_MS * (0.5 + Math.random()));
      }
    }),
  );
  watching = false;
  await watcher;
  const playedSec = (Date.now() - playStarted) / 1000;

  // ---------- report ----------
  const final = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  const [battles, territories, empires] = await Promise.all([
    prisma.battle.groupBy({ by: ["status"], where: { matchId }, _count: true }),
    prisma.territory.count({ where: { matchId, ownerEmpireId: { not: null } } }),
    prisma.empire.groupBy({ by: ["status"], where: { matchId }, _count: true }),
  ]);

  const slowRoutes: string[] = [];
  let total = 0;
  const rows = [...samples.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => {
      const times = list.map((sample) => sample.ms).sort((a, b) => a - b);
      const p95 = percentile(times, 95);
      // Entering the match is a rush the script makes on purpose (everybody at the same
      // instant, on a cold cache): those calls are reported and judged on errors only.
      // The limit is for playing.
      const judged = !ENTRY_ROUTES.includes(label);
      if (judged && p95 > P95_LIMIT_MS) slowRoutes.push(label);
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
  const messages = players.reduce((sum, player) => sum + player.messages, 0);
  const worstLag = Math.max(0, ...turnLags);
  console.log(
    `requests: ${String(total)} (${(total / playedSec).toFixed(0)} per second while playing)`,
  );
  console.log(
    `websocket: ${String(players.filter((p) => p.socket?.readyState === WebSocket.OPEN).length)}/${String(PLAYERS)} still connected, ${String(messages)} messages received`,
  );
  console.log(
    `turns: reached turn ${String(final.currentTurn)}; closes observed ${String(turnLags.length)}, lag after the deadline: ${turnLags.map((lag) => `${String(Math.round(lag))} ms`).join(", ") || "none"}`,
  );
  console.log(
    `game: ${String(territories)} municipalities owned; battles ${JSON.stringify(Object.fromEntries(battles.map((b) => [b.status, b._count])))}; empires ${JSON.stringify(Object.fromEntries(empires.map((e) => [e.status, e._count])))}`,
  );
  if (failures.length > 0) {
    console.log(`failures (${String(failures.length)}):`);
    for (const failure of [...new Set(failures)].slice(0, 10)) console.log(`  ${failure}`);
  }

  for (const player of players) player.socket?.close();
  if (!KEEP) {
    await prisma.match.update({ where: { id: matchId }, data: { status: "FINISHED" } });
    await cleanUp();
  }
  await prisma.$disconnect();

  const verdict =
    failures.length > 0
      ? "FAILED: server errors"
      : slowRoutes.length > 0
        ? `FAILED: a route is slower than ${String(P95_LIMIT_MS)} ms at the 95th percentile`
        : worstLag > TURN_LAG_LIMIT_MS
          ? `FAILED: a turn closed ${String(Math.round(worstLag))} ms late`
          : "PASSED";
  console.log(verdict);
  process.exit(verdict === "PASSED" ? 0 : 1);
}

await main();
