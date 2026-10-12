/**
 * Fetches the municipalities of other countries from their open sources and writes
 * them as the admin's upload takes them: for each country a GeoJSON with `name` and
 * `code` on every feature, and a file that says which region each code is in.
 *
 *   pnpm areas:fetch                 # every country, into ./geodata
 *   pnpm areas:fetch france          # one of them
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
};

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
  const units = collection.features.flatMap((feature) => {
    const unit = feature.geometry ? source.unit(feature) : null;
    return unit && unit.name && unit.code ? [unit] : [];
  });

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
    `${country}: ${String(features.length)} municipalities in ${String(Object.keys(regions).length)} regions`,
  );
}
