/**
 * Fetches the municipalities of other countries from their open sources and writes
 * them as the admin's upload takes them: for each country a GeoJSON with `name` and
 * `code` on every feature, and a file that says which region each code is in.
 *
 *   pnpm areas:fetch                 # every country, into ./geodata
 *   pnpm areas:fetch france norway   # some of them
 *
 * Then, for each country: create the area in the admin, upload `<country>.geojson`
 * into it, and split it with `pnpm areas:split "<area>" geodata/<country>.regions.json`.
 * Uploading the country whole and splitting it afterwards keeps the borders between
 * its regions shared: they are simplified together.
 *
 * Sources (all free to reuse, with attribution):
 * - Switzerland: swisstopo swissBOUNDARIES3D, as republished by Opendatasoft
 *   (`georef-switzerland-gemeinde`); lakes and cantonal land without a municipality are left out.
 * - France: IGN ADMIN EXPRESS as published by Etalab (`contours-administratifs`, 100 m),
 *   Licence Ouverte 2.0; the mainland and Corsica, without the overseas territories.
 * - United Kingdom: ONS Open Geography wards and electoral divisions, as republished by
 *   Opendatasoft (`georef-united-kingdom-ward-electoral-division`), Open Government Licence v3.0.
 * - Denmark: the municipalities of DAGI (Danish free public geodata, to be credited to
 *   Klimadatastyrelsen), from the copy at github.com/Neogeografen/dagi: taken in 2015, and the
 *   municipalities have not changed since 2007. The official service asks for an account.
 * - Norway: Kartverket's municipalities of 2024, CC BY 4.0, as prepared (cut along the
 *   coast) at github.com/robhop/fylker-og-kommuner. Svalbard and Jan Mayen have no
 *   municipalities: their islands are taken from Natural Earth (public domain), each of the
 *   larger ones a territory with the small ones around it.
 * - Faroe Islands, Iceland, Greenland: the municipalities as drawn in OpenStreetMap
 *   (© OpenStreetMap contributors, ODbL), asked to Overpass. No official source gives all
 *   three in a form that can be read here; the few municipalities they have are not split
 *   into regions. The Greenlandic ones are drawn there with straight lines out at sea, so
 *   they are cut along the coast of Natural Earth (public domain), and the land that no
 *   municipality has, the national park of the north-east, is added as a territory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import polygonClipping, { type MultiPolygon } from "polygon-clipping";

interface Feature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}
/** A municipality as it is written: where it is, what it is called, and its region. */
interface Unit {
  name: string;
  code: string;
  region: string;
  /** What tells it from another of the same name. */
  within: string;
  geometry: Feature["geometry"];
}

const ODS = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets";
/** The French regions of the mainland and Corsica, by INSEE code. */
const FRENCH_REGIONS: Record<string, string> = {
  "11": "Île-de-France",
  "24": "Centre-Val de Loire",
  "27": "Bourgogne-Franche-Comté",
  "28": "Normandie",
  "32": "Hauts-de-France",
  "44": "Grand Est",
  "52": "Pays de la Loire",
  "53": "Bretagne",
  "75": "Nouvelle-Aquitaine",
  "76": "Occitanie",
  "84": "Auvergne-Rhône-Alpes",
  "93": "Provence-Alpes-Côte d'Azur",
  "94": "Corse",
};

/** The Danish regions, by the codes of their municipalities (411 is Christiansø). */
const DANISH_REGIONS: Record<string, number[]> = {
  Hovedstaden: [
    101, 147, 151, 153, 155, 157, 159, 161, 163, 165, 167, 169, 173, 175, 183, 185, 187, 190, 201,
    210, 217, 219, 223, 230, 240, 250, 260, 270, 400, 411,
  ],
  Sjælland: [253, 259, 265, 269, 306, 316, 320, 326, 329, 330, 336, 340, 350, 360, 370, 376, 390],
  Syddanmark: [
    410, 420, 430, 440, 450, 461, 479, 480, 482, 492, 510, 530, 540, 550, 561, 563, 573, 575, 580,
    607, 621, 630,
  ],
  Midtjylland: [
    615, 657, 661, 665, 671, 706, 707, 710, 727, 730, 740, 741, 746, 751, 756, 760, 766, 779, 791,
  ],
  Nordjylland: [773, 787, 810, 813, 820, 825, 840, 846, 849, 851, 860],
};
const danishRegion = (code: string) =>
  Object.entries(DANISH_REGIONS).find(([, codes]) => codes.includes(Number(code)))?.[0];
/**
 * The Norwegian counties of 2024, by the first two digits of the number of a municipality.
 * Oslo (one municipality) and Vestfold (six) are too small to play on: each goes with
 * the county beside it.
 */
const NORWEGIAN_COUNTIES: Record<string, string> = {
  "03": "Oslo og Akershus",
  "11": "Rogaland",
  "15": "Møre og Romsdal",
  "18": "Nordland",
  "31": "Østfold",
  "32": "Oslo og Akershus",
  "33": "Buskerud",
  "34": "Innlandet",
  "39": "Vestfold og Telemark",
  "40": "Vestfold og Telemark",
  "42": "Agder",
  "46": "Vestland",
  "50": "Trøndelag",
  "55": "Troms",
  "56": "Finnmark",
};

/** Opendatasoft gives some values as a list of one. */
const text = (value: unknown): string => String(Array.isArray(value) ? value[0] : (value ?? ""));

/** A municipality of OpenStreetMap, under the name of its country: nothing to split it by. */
const osmUnit =
  (country: string) =>
  ({ properties: p, geometry }: Feature): Unit => ({
    name: text(p.name),
    code: `osm-${text(p.id)}`,
    region: country,
    within: text(p.id),
    geometry,
  });

const NATURAL_EARTH =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson";

interface Source {
  /** A GeoJSON to download, */
  url?: string;
  /** or what to ask Overpass: relations, given back with their geometry. */
  overpass?: string;
  /**
   * The land of the country, for municipalities drawn out at sea: they are cut along it,
   * and its largest part that none of them has becomes a territory called `rest`.
   */
  land?: { url: string; is: (properties: Record<string, unknown>) => boolean; rest: string };
  /** Territories that are not municipalities, from somewhere else. */
  more?: () => Promise<Unit[]>;
  unit: (feature: Feature) => Unit | null;
}

const COUNTRIES: Record<string, Source> = {
  switzerland: {
    url: `${ODS}/georef-switzerland-gemeinde/exports/geojson`,
    unit: ({ properties: p, geometry }) =>
      text(p.gem_type) === "Gemeindegebiet"
        ? {
            name: text(p.gem_name),
            code: text(p.gem_code),
            region: text(p.kan_name),
            within: text(p.kan_name),
            geometry,
          }
        : null,
  },
  france: {
    url: "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2024/geojson/communes-100m.geojson",
    unit: ({ properties: p, geometry }) => {
      const region = FRENCH_REGIONS[text(p.region)];
      return region
        ? { name: text(p.nom), code: text(p.code), region, within: text(p.departement), geometry }
        : null;
    },
  },
  "united-kingdom": {
    url: `${ODS}/georef-united-kingdom-ward-electoral-division/exports/geojson`,
    unit: ({ properties: p, geometry }) => ({
      name: text(p.wed_name),
      code: text(p.wed_code),
      region: text(p.rgn_name) || text(p.ctry_name),
      within: text(p.lad_name),
      geometry,
    }),
  },
  denmark: {
    url: "https://raw.githubusercontent.com/Neogeografen/dagi/master/geojson/kommuner.geojson",
    unit: ({ properties: p, geometry }) => {
      const region = danishRegion(text(p.KOMKODE));
      return region
        ? { name: text(p.KOMNAVN), code: text(p.KOMKODE), region, within: region, geometry }
        : null;
    },
  },
  norway: {
    url: "https://raw.githubusercontent.com/robhop/fylker-og-kommuner/main/Kommuner-L.geojson",
    more: arcticIslands,
    unit: ({ properties: p, geometry }) => {
      const county = NORWEGIAN_COUNTIES[text(p.kommunenummer).slice(0, 2)];
      return county
        ? {
            name: text(p.kommunenavn),
            code: text(p.kommunenummer),
            region: county,
            within: county,
            geometry,
          }
        : null;
    },
  },
  "faroe-islands": {
    overpass: `area["ISO3166-1"="FO"][admin_level=2]->.a;relation(area.a)[boundary=administrative][admin_level=7];`,
    unit: osmUnit("Føroyar"),
  },
  iceland: {
    overpass: `area["ISO3166-1"="IS"][admin_level=2]->.a;relation(area.a)[boundary=administrative][admin_level=6];`,
    unit: osmUnit("Ísland"),
  },
  greenland: {
    overpass: `relation["ISO3166-2"~"^GL-"][boundary=administrative];`,
    land: {
      url: NATURAL_EARTH,
      is: (properties) => properties.ADM0_A3 === "GRL",
      rest: "Kalaallit Nunaanni nuna eqqissisimatitaq",
    },
    unit: osmUnit("Kalaallit Nunaat"),
  },
};

/** The islands of Svalbard and Jan Mayen that are a territory each, by a point on them. */
const ARCTIC_ISLANDS: [name: string, lon: number, lat: number][] = [
  ["Spitsbergen", 16.1, 78.3],
  ["Nordaustlandet", 22.5, 79.85],
  ["Edgeøya", 22.6, 77.75],
  ["Barentsøya", 21.2, 78.4],
  ["Prins Karls Forland", 11.3, 78.55],
  ["Kvitøya", 32.6, 80.16],
  ["Kong Karls Land", 28.8, 78.9],
  ["Hopen", 25.3, 76.6],
  ["Bjørnøya", 19, 74.44],
  ["Jan Mayen", -8.5, 71],
];
const ARCTIC_REGION = "Svalbard og Jan Mayen";

/**
 * Svalbard and Jan Mayen, which Natural Earth draws as part of Norway: every island
 * north of the mainland or far out west, given to the nearest of the named ones.
 */
async function arcticIslands(): Promise<Unit[]> {
  const norway = (await fromUrl(NATURAL_EARTH)).filter(
    (feature) => feature.properties.ADM0_A3 === "NOR",
  );
  const parts = new Map<string, unknown[]>();
  for (const polygon of norway.flatMap((feature) => polygons(feature.geometry))) {
    const ring = (polygon as Position[][])[0] ?? [];
    const lons = ring.map((point) => point[0]);
    const lats = ring.map((point) => point[1]);
    const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    if (!(lat > 74 || (lat > 70.5 && lon < 0))) continue;
    // A degree of longitude is a fifth of one of latitude this far north.
    const far = ([, x, y]: (typeof ARCTIC_ISLANDS)[number]) => Math.hypot((x - lon) * 0.2, y - lat);
    const nearest = [...ARCTIC_ISLANDS].sort((a, b) => far(a) - far(b))[0];
    if (nearest) parts.set(nearest[0], [...(parts.get(nearest[0]) ?? []), polygon]);
  }
  return [...parts].map(([name, coordinates]) => ({
    name,
    code: `sj-${name.toLowerCase().replaceAll(" ", "-")}`,
    region: ARCTIC_REGION,
    within: ARCTIC_REGION,
    geometry: { type: "MultiPolygon", coordinates },
  }));
}

/** The servers that answer Overpass queries: the next is tried when one is busy. */
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

type Position = [number, number];
interface OsmRelation {
  id: number;
  tags: Record<string, string>;
  members: { type: string; role: string; geometry?: { lon: number; lat: number }[] }[];
}

/** Joins the ways of a border end to end into closed rings; what does not close is left out. */
function rings(ways: Position[][]): Position[][] {
  const left = ways.filter((way) => way.length > 1).map((way) => [...way]);
  const closed: Position[][] = [];
  const same = (a?: Position, b?: Position) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  for (let ring = left.pop(); ring; ring = left.pop()) {
    while (!same(ring[0], ring.at(-1))) {
      const end = ring.at(-1);
      const next = left.findIndex((way) => same(way[0], end) || same(way.at(-1), end));
      const way = next === -1 ? undefined : left.splice(next, 1)[0];
      if (!way) break;
      ring.push(...(same(way[0], end) ? way : way.reverse()).slice(1));
    }
    if (ring.length > 3 && same(ring[0], ring.at(-1))) closed.push(ring);
  }
  return closed;
}

/** Whether a point is inside a ring: counts the sides a line drawn from it crosses. */
function inside(point: Position | undefined, ring: Position[]): boolean {
  if (!point) return false;
  const [x, y] = point;
  let within = false;
  ring.forEach(([xi, yi], index) => {
    const [xj, yj] = ring.at(index - 1) ?? [xi, yi];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
  });
  return within;
}

/** A relation of OpenStreetMap as a feature: its outer rings, each with the holes inside it. */
function osmFeature(relation: OsmRelation): Feature {
  const ways = (role: string) =>
    relation.members
      .filter((member) => member.type === "way" && (member.role || "outer") === role)
      .map((member) => (member.geometry ?? []).map((point): Position => [point.lon, point.lat]));
  const holes = rings(ways("inner"));
  const coordinates = rings(ways("outer")).map((outer) => [
    outer,
    ...holes.filter((hole) => inside(hole[0], outer)),
  ]);
  return {
    type: "Feature",
    properties: { ...relation.tags, id: relation.id },
    geometry: coordinates.length > 0 ? { type: "MultiPolygon", coordinates } : null,
  };
}

/** The public servers are often busy: each is tried in turn, a few times round. */
async function fromOverpass(query: string): Promise<Feature[]> {
  for (let round = 0; round < 4; round++) {
    for (const server of OVERPASS) {
      const response = await fetch(server, {
        method: "POST",
        headers: { "user-agent": "looters-geodata/1.0 (areas fetch script)" },
        body: new URLSearchParams({ data: `[out:json][timeout:180];${query}out geom;` }),
      }).catch(() => null);
      const answer = response?.ok ? await response.text() : "";
      if (answer.startsWith("{")) {
        return (JSON.parse(answer) as { elements: OsmRelation[] }).elements.map(osmFeature);
      }
      console.log(`  ${server}: ${String(response?.status ?? "no answer")}, trying the next`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  throw new Error("no Overpass server answered");
}

async function fromUrl(url: string): Promise<Feature[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${String(response.status)} from ${url}`);
  return ((await response.json()) as { features: Feature[] }).features;
}

/** The polygons of a geometry, whichever of the two kinds it is. */
const polygons = (geometry: Feature["geometry"]): unknown[] =>
  geometry?.type === "MultiPolygon"
    ? (geometry.coordinates as unknown[])
    : geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : [];

/** Five decimals are a metre: more only makes the file heavier. */
const rounded = (coordinates: unknown): unknown =>
  Array.isArray(coordinates)
    ? coordinates.map(rounded)
    : Math.round((coordinates as number) * 1e5) / 1e5;

const wanted = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
const out = join(process.cwd(), "geodata");
await mkdir(out, { recursive: true });

for (const [country, source] of Object.entries(COUNTRIES)) {
  if (wanted.length > 0 && !wanted.includes(country)) continue;
  console.log(`${country}: fetching ${source.url ?? "from OpenStreetMap"}`);
  const found = source.overpass
    ? await fromOverpass(source.overpass)
    : await fromUrl(source.url ?? "");
  // A source may give a municipality a piece at a time: the pieces are put back together.
  const byCode = new Map<string, Unit>();
  let skipped = 0;
  for (const feature of found) {
    const unit = feature.geometry ? source.unit(feature) : null;
    if (!unit || !unit.name || !unit.code) {
      skipped += 1;
      continue;
    }
    const known = byCode.get(unit.code);
    if (!known) byCode.set(unit.code, unit);
    else {
      known.geometry = {
        type: "MultiPolygon",
        coordinates: [...polygons(known.geometry), ...polygons(unit.geometry)],
      };
    }
  }
  const units = [...byCode.values(), ...((await source.more?.()) ?? [])];
  if (source.land) {
    const land = (await fromUrl(source.land.url)).filter((feature) =>
      source.land?.is(feature.properties),
    );
    const coast = land.flatMap((feature) => polygons(feature.geometry)) as MultiPolygon;
    for (const unit of units) {
      unit.geometry = {
        type: "MultiPolygon",
        coordinates: polygonClipping.intersection(polygons(unit.geometry) as MultiPolygon, coast),
      };
    }
    const free = polygonClipping.difference(
      coast,
      ...units.map((unit) => polygons(unit.geometry) as MultiPolygon),
    );
    const extent = (polygon: MultiPolygon[number]) => {
      const xs = (polygon[0] ?? []).map((point) => point[0]);
      const ys = (polygon[0] ?? []).map((point) => point[1]);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    };
    const largest = free.sort((a, b) => extent(b) - extent(a))[0];
    const region = units[0]?.region ?? country;
    if (largest) {
      units.push({
        name: source.land.rest,
        code: `${country}-rest`,
        region,
        within: region,
        geometry: { type: "MultiPolygon", coordinates: [largest] },
      });
    }
  }

  // Names that come more than once say where they are: "Abbey (Lincoln)".
  const times = new Map<string, number>();
  for (const unit of units) times.set(unit.name, (times.get(unit.name) ?? 0) + 1);
  const regions: Record<string, string[]> = {};
  const features = units.map((unit) => {
    (regions[unit.region] ??= []).push(unit.code);
    const name = (times.get(unit.name) ?? 0) > 1 ? `${unit.name} (${unit.within})` : unit.name;
    return {
      type: "Feature",
      properties: { name, code: unit.code },
      geometry: { type: unit.geometry?.type, coordinates: rounded(unit.geometry?.coordinates) },
    };
  });

  await writeFile(
    join(out, `${country}.geojson`),
    JSON.stringify({ type: "FeatureCollection", features }),
  );
  await writeFile(join(out, `${country}.regions.json`), JSON.stringify(regions));
  console.log(
    `${country}: ${String(features.length)} municipalities in ${String(Object.keys(regions).length)} regions, ${String(skipped)} features left out`,
  );
}
