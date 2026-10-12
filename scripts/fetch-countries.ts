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
 *   coast) at github.com/robhop/fylker-og-kommuner.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
/** The Norwegian counties of 2024, by the first two digits of the number of a municipality. */
const NORWEGIAN_COUNTIES: Record<string, string> = {
  "03": "Oslo",
  "11": "Rogaland",
  "15": "Møre og Romsdal",
  "18": "Nordland",
  "31": "Østfold",
  "32": "Akershus",
  "33": "Buskerud",
  "34": "Innlandet",
  "39": "Vestfold",
  "40": "Telemark",
  "42": "Agder",
  "46": "Vestland",
  "50": "Trøndelag",
  "55": "Troms",
  "56": "Finnmark",
};

/** Opendatasoft gives some values as a list of one. */
const text = (value: unknown): string => String(Array.isArray(value) ? value[0] : (value ?? ""));

const COUNTRIES: Record<string, { url: string; unit: (feature: Feature) => Unit | null }> = {
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
};

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
  console.log(`${country}: fetching ${source.url}`);
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`${country}: ${String(response.status)} from the source`);
  const collection = (await response.json()) as { features: Feature[] };
  // A source may give a municipality a piece at a time: the pieces are put back together.
  const byCode = new Map<string, Unit>();
  let skipped = 0;
  for (const feature of collection.features) {
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
  const units = [...byCode.values()];

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
