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
 *   three in a form that can be read here. The Greenlandic ones are drawn there with straight lines out at sea, so
 *   they are cut along the coast of Natural Earth (public domain), and the land that no
 *   municipality has, the national park of the north-east, is added as a territory.
 *   Five municipalities being too few to play on, and nothing official splitting them, each
 *   is shared out among its towns and villages (OpenStreetMap again): a place takes the
 *   land nearest to it, and the municipalities become the regions.
 * - Sweden (Lantmäteriet, CC0), Germany (BKG, Data licence Germany 2.0; the land without a
 *   municipality is kept as territories), Belgium (NGI), the Netherlands (CBS/Kadaster 2021,
 *   CC0), Spain (IGN, CC BY 4.0) and Portugal (DGT, its 308 municipalities): Opendatasoft.
 * - Finland: Statistics Finland's municipalities and regions at 1:1,000,000, CC BY 4.0.
 * - Luxembourg (its government's communes of 2018; cantons from OpenStreetMap), Andorra,
 *   Liechtenstein, San Marino, Monaco (its quarters) and the Vatican: geoBoundaries, which
 *   republishes public domain and OpenStreetMap (ODbL) data. The microstates stay whole.
 *
 * - United States (Census Bureau counties, public domain: the fifty states, with the
 *   District of Columbia in Maryland's area; the territories are left out, and so are the
 *   few Aleutian islands past the 180th meridian, which would stretch the map round the
 *   world) and Mexico (INEGI municipalities, free use): Opendatasoft.
 * - Canada: Statistics Canada's census subdivisions. Opendatasoft has them as a handful of
 *   points each, too rough to share borders, so the shapes are those of geoBoundaries (2016),
 *   which has lost their codes and mangled their names: those, and the province, are put
 *   back from Opendatasoft's list (2021) by the point it gives inside each.
 *
 * - Eastern Europe, from geoBoundaries, which republishes official, OpenStreetMap (ODbL) and
 *   public domain data of different years: Estonia, Latvia (parishes, in their
 *   municipalities), Lithuania (elderships), Belarus and Ukraine (districts), Moldova,
 *   Czechia, Slovakia, Hungary, Romania, Bulgaria, Slovenia, Croatia, Bosnia and Herzegovina,
 *   Serbia, Montenegro, Kosovo, North Macedonia and Albania. Those it has no regions for
 *   stay whole. Greece, Russia (its districts, without the tip of Chukotka past the 180th
 *   meridian), Turkey (districts in provinces), Cyprus and Malta come from it too. For Czechia, Slovakia and Hungary, whose names it has spoilt, the names
 *   are Eurostat's (GISCO, local administrative units 2024).
 *
 * Where a source does not say the region of a municipality, it is the region whose
 * outline most of the municipality falls in.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Delaunay } from "d3-delaunay";
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

/**
 * The German city states are one or two municipalities: each goes with the state
 * around it, and both states are named.
 */
const GERMAN_CITY_STATES: Record<string, string> = {
  Berlin: "Berlin und Brandenburg",
  Brandenburg: "Berlin und Brandenburg",
  Bremen: "Niedersachsen und Bremen",
  Niedersachsen: "Niedersachsen und Bremen",
  Hamburg: "Schleswig-Holstein und Hamburg",
  "Schleswig-Holstein": "Schleswig-Holstein und Hamburg",
};
const POLISH_VOIVODESHIPS: Record<string, string> = {
  "Greater Poland Voivodeship": "Wielkopolskie",
  "Kuyavian-Pomeranian Voivodeship": "Kujawsko-pomorskie",
  "Lesser Poland Voivodeship": "Małopolskie",
  "Lower Silesian Voivodeship": "Dolnośląskie",
  "Lublin Voivodeship": "Lubelskie",
  "Lubusz Voivodeship": "Lubuskie",
  "Masovian Voivodeship": "Mazowieckie",
  "Opole Voivodeship": "Opolskie",
  "Podlaskie Voivodeship": "Podlaskie",
  "Pomeranian Voivodeship": "Pomorskie",
  "Silesian Voivodeship": "Śląskie",
  "Subcarpathian Voivodeship": "Podkarpackie",
  "Warmian-Masurian Voivodeship": "Warmińsko-mazurskie",
  "West Pomeranian Voivodeship": "Zachodniopomorskie",
  "Łódź Voivodeship": "Łódzkie",
  "Świętokrzyskie Voivodeship": "Świętokrzyskie",
};
const STAT_FI =
  "https://geo.stat.fi/geoserver/tilastointialueet/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&typeName=tilastointialueet";
const GEOBOUNDARIES = "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen";
/** A unit of geoBoundaries, which names it and numbers it the same way for every country. */
const boundaryUnit =
  (region: string) =>
  ({ properties: p, geometry }: Feature): Unit => ({
    name: text(p.shapeName),
    code: text(p.shapeID),
    region,
    within: text(p.shapeID),
    geometry,
  });

/** A name written all in capitals, with only its initials so. */
const unshouted = (name: string) =>
  // One of the two Slovenian regions comes without the name of the country.
  name === "Vzhodna"
    ? "Vzhodna Slovenija"
    : name === name.toUpperCase()
      ? name.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase())
      : name;

/**
 * A country of geoBoundaries: its municipalities at one level and, when it has them,
 * its regions at another, as shapes. Without regions it stays whole, under its name.
 */
function boundaries(iso: string, level: number, regionLevel: number | null, whole = ""): Source {
  const file = (of: number) =>
    `${GEOBOUNDARIES}/${iso}/ADM${String(of)}/geoBoundaries-${iso}-ADM${String(of)}.geojson`;
  return {
    url: file(level),
    decimals: 4,
    ...(regionLevel === null
      ? {}
      : {
          regions: {
            url: file(regionLevel),
            // A long name comes cut short, with a star where it was cut.
            name: (p) => unshouted(text(p.shapeName).replace(/\s*\*$/, "")),
          },
        }),
    unit: (feature) => {
      const unit = boundaryUnit(whole)(feature);
      // Without the words that only say it is a municipality, and not shouted.
      const bare = unit.name
        .replace(/^(Općina|Grad|Municipality of)\s+/i, "")
        .replace(/\s+(Municipality|City)$/i, "");
      unit.name = unshouted(bare);
      return unit;
    },
  };
}

const EUROSTAT_LAU =
  "https://gisco-services.ec.europa.eu/distribution/v2/lau/geojson/LAU_RG_01M_2024_4326.geojson";
let eurostat: Promise<Feature[]> | null = null;

/**
 * Names and codes from Eurostat's local administrative units of 2024, for a country
 * whose shapes come from a source that has spoilt them. Only the names are taken (its
 * shapes may not be reused freely): each unit of Eurostat gives its name to the shape
 * that holds most of a few points taken inside it.
 */
function namedByEurostat(country: string) {
  return async (units: Unit[]): Promise<void> => {
    eurostat ??= fromUrl(EUROSTAT_LAU);
    const listed = (await eurostat).filter((feature) => feature.properties.CNTR_CODE === country);
    const boxed = units.map((unit) => {
      const rings = (polygons(unit.geometry) as Position[][][]).map((polygon) => polygon[0] ?? []);
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of rings.flat()) {
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
      return { unit, rings, box, known: false };
    });
    for (const feature of listed) {
      const ring = (polygons(feature.geometry) as Position[][][])
        .map((polygon) => polygon[0] ?? [])
        .sort((a, b) => b.length - a.length)[0];
      if (!ring || ring.length === 0) continue;
      const middle: Position = [
        ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
        ring.reduce((sum, point) => sum + point[1], 0) / ring.length,
      ];
      // The middle, and points between it and the border all round.
      const step = Math.max(1, Math.floor(ring.length / 8));
      const points = [
        middle,
        ...ring
          .filter((_, index) => index % step === 0)
          .map((point): Position => [(point[0] + middle[0]) / 2, (point[1] + middle[1]) / 2]),
      ];
      const votes = new Map<(typeof boxed)[number], number>();
      for (const [x, y] of points) {
        const holder = boxed.find(
          ({ rings, box, known }) =>
            !known &&
            x >= box[0] &&
            y >= box[1] &&
            x <= box[2] &&
            y <= box[3] &&
            rings.some((outer) => inside([x, y], outer)),
        );
        if (holder) votes.set(holder, (votes.get(holder) ?? 0) + 1);
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!best) continue;
      best.known = true;
      best.unit.name = text(feature.properties.LAU_NAME);
      best.unit.code = text(feature.properties.GISCO_ID) || best.unit.code;
    }
    const spoilt = boxed.filter(({ known }) => !known);
    console.log(`  ${String(spoilt.length)} of ${String(units.length)} keep a spoilt name`);
    // What no name was found for is told apart from the rest.
    for (const { unit } of spoilt) unit.name = `? ${unit.name}`;
  };
}

interface Source {
  /** A GeoJSON to download, */
  url?: string;
  /** or what to ask Overpass: relations, given back with their geometry. */
  overpass?: string;
  /**
   * The land of the country, for municipalities drawn out at sea: they are cut along it,
   * and its largest part that none of them has becomes a territory called `rest`.
   */
  land?: {
    url: string;
    is: (properties: Record<string, unknown>) => boolean;
    rest: string;
    restRegion?: string;
  };
  /**
   * What to ask Overpass for the inhabited places of the country (nodes): each unit
   * becomes a region, split among the places inside it, each with the land nearest to it.
   */
  settlements?: string;
  /**
   * The regions as shapes, for a source that does not name the region of a municipality:
   * each goes to the one most of it falls in.
   */
  regions?: {
    url?: string;
    overpass?: string;
    name: (properties: Record<string, unknown>) => string;
  };
  /** Decimals kept in the coordinates: five (a metre) unless the source is far heavier than needed. */
  decimals?: number;
  /** Gives the units the names, codes and regions their source does not have. */
  named?: (units: Unit[]) => Promise<void>;
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
    regions: {
      overpass: `area["ISO3166-1"="FO"][admin_level=2]->.a;relation(area.a)[boundary=administrative][admin_level=6];`,
      name: (p) => text(p.name),
    },
    unit: osmUnit("Føroyar"),
  },
  iceland: {
    overpass: `area["ISO3166-1"="IS"][admin_level=2]->.a;relation(area.a)[boundary=administrative][admin_level=6];`,
    regions: {
      overpass: `area["ISO3166-1"="IS"][admin_level=2]->.a;relation(area.a)[boundary=administrative][admin_level=5];`,
      name: (p) => text(p.name),
    },
    unit: osmUnit("Ísland"),
  },
  greenland: {
    overpass: `relation["ISO3166-2"~"^GL-"][boundary=administrative];`,
    land: {
      url: NATURAL_EARTH,
      is: (properties) => properties.ADM0_A3 === "GRL",
      rest: "Kalaallit Nunaanni nuna eqqissisimatitaq",
      // The park has no municipality: it goes with the one it shares most of its border with.
      restRegion: "Sermersooq",
    },
    // Five municipalities are too few to play on, and nothing official splits them: each
    // is shared out among its towns and villages, every place taking the land nearest to it.
    settlements: `area["ISO3166-1"="GL"][admin_level~"^(2|3)$"]->.a;node(area.a)[place~"^(city|town|village)$"][name];`,
    unit: osmUnit("Kalaallit Nunaat"),
  },
  sweden: {
    url: `${ODS}/georef-sweden-kommun/exports/geojson`,
    unit: ({ properties: p, geometry }) => ({
      name: text(p.kom_name),
      code: text(p.kom_code),
      region: text(p.lan_name),
      within: text(p.lan_name),
      geometry,
    }),
  },
  finland: {
    url: `${STAT_FI}:kunta1000k`,
    regions: { url: `${STAT_FI}:maakunta1000k`, name: (p) => text(p.nimi) },
    unit: ({ properties: p, geometry }) => ({
      name: text(p.nimi),
      code: text(p.kunta),
      region: "",
      within: text(p.kunta),
      geometry,
    }),
  },
  germany: {
    url: `${ODS}/georef-germany-gemeinde/exports/geojson`,
    unit: ({ properties: p, geometry }) => ({
      name: text(p.gem_name_short) || text(p.gem_name),
      code: text(p.gem_code),
      region: GERMAN_CITY_STATES[text(p.lan_name)] ?? text(p.lan_name),
      within: text(p.krs_name),
      geometry,
    }),
  },
  belgium: {
    url: `${ODS}/georef-belgium-municipality/exports/geojson`,
    unit: ({ properties: p, geometry }) => {
      // Each municipality and region under the name of its own language.
      const dutch = text(p.reg_code) === "02000";
      const own = dutch ? "nl" : text(p.mun_off_language) === "DE" ? "de" : "fr";
      return {
        name: text(p[`mun_name_${own}`]),
        code: text(p.mun_code),
        region: text(p[dutch ? "reg_name_nl" : "reg_name_fr"]),
        within: text(p[dutch ? "prov_name_nl" : "prov_name_fr"]),
        geometry,
      };
    },
  },
  netherlands: {
    url: `${ODS}/georef-netherlands-gemeente/exports/geojson`,
    unit: ({ properties: p, geometry }) => ({
      name: text(p.gem_name),
      code: text(p.gem_code),
      region: text(p.prov_name),
      within: text(p.prov_name),
      geometry,
    }),
  },
  spain: {
    url: `${ODS}/georef-spain-municipio/exports/geojson`,
    unit: ({ properties: p, geometry }) => {
      const community = text(p.acom_name);
      // The rocks off Africa and the pastures shared with France belong to no community.
      if (community.startsWith("Territorio no asociado")) return null;
      return {
        name: text(p.mun_name),
        code: text(p.mun_code),
        // The two cities in Africa are one municipality each: one area for both.
        region: community.startsWith("Ciudad Autónoma") ? "Ceuta y Melilla" : community,
        within: text(p.prov_name),
        geometry,
      };
    },
  },
  portugal: {
    url: `${ODS}/georef-portugal-concelho/exports/geojson`,
    unit: ({ properties: p, geometry }) => ({
      name: text(p.con_name),
      code: text(p.con_code),
      region: text(p.dis_name),
      within: text(p.dis_name),
      geometry,
    }),
  },
  luxembourg: {
    url: `${GEOBOUNDARIES}/LUX/ADM3/geoBoundaries-LUX-ADM3.geojson`,
    regions: {
      url: `${GEOBOUNDARIES}/LUX/ADM1/geoBoundaries-LUX-ADM1.geojson`,
      name: (p) => text(p.shapeName),
    },
    unit: boundaryUnit(""),
  },
  austria: {
    url: `${GEOBOUNDARIES}/AUT/ADM3/geoBoundaries-AUT-ADM3.geojson`,
    decimals: 4,
    regions: {
      url: `${GEOBOUNDARIES}/AUT/ADM1/geoBoundaries-AUT-ADM1.geojson`,
      // Vienna is one municipality: it goes with the state around it.
      name: (p) =>
        ["Wien", "Niederösterreich"].includes(text(p.shapeName))
          ? "Wien und Niederösterreich"
          : text(p.shapeName),
    },
    unit: boundaryUnit(""),
  },
  ireland: {
    url: `${GEOBOUNDARIES}/IRL/ADM2/geoBoundaries-IRL-ADM2.geojson`,
    regions: {
      url: `${GEOBOUNDARIES}/IRL/ADM1/geoBoundaries-IRL-ADM1.geojson`,
      name: (p) => text(p.shapeName),
    },
    // The local electoral areas come shouted and numbered: "RATOATH LEA-7" is Ratoath.
    unit: (feature) => {
      const unit = boundaryUnit("")(feature);
      const plain = unit.name.replace(/\s*LEA\s*-\s*\d+\s*$/i, "").replace(/\s*-\s*/g, "-");
      unit.name = plain.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase());
      return unit;
    },
  },
  poland: {
    url: `${GEOBOUNDARIES}/POL/ADM3/geoBoundaries-POL-ADM3.geojson`,
    decimals: 4,
    regions: {
      url: `${GEOBOUNDARIES}/POL/ADM1/geoBoundaries-POL-ADM1.geojson`,
      // The source names the voivodeships in English.
      name: (p) => POLISH_VOIVODESHIPS[text(p.shapeName)] ?? text(p.shapeName),
    },
    unit: (feature) => {
      const unit = boundaryUnit("")(feature);
      unit.name = unit.name.replace(/^gmina\s+/i, "");
      return unit;
    },
  },
  "united-states": {
    url: `${ODS}/georef-united-states-of-america-county/exports/geojson`,
    unit: ({ properties: p, geometry }) => {
      const state = text(p.ste_name);
      // The states are numbered to 56; what comes after are the territories.
      if (Number(text(p.ste_code)) > 56) return null;
      const east = (polygons(geometry) as Position[][][]).filter(
        (polygon) => (polygon[0]?.[0]?.[0] ?? 0) < 0,
      );
      return {
        name: text(p.coty_name),
        code: text(p.coty_code),
        region: ["District of Columbia", "Maryland"].includes(state)
          ? "Maryland and District of Columbia"
          : state,
        within: state,
        geometry: { type: "MultiPolygon", coordinates: east },
      };
    },
  },
  canada: {
    url: `${GEOBOUNDARIES}/CAN/ADM3/geoBoundaries-CAN-ADM3.geojson`,
    unit: boundaryUnit(""),
    named: canadianNames,
  },
  mexico: {
    url: `${ODS}/georef-mexico-municipality/exports/geojson`,
    unit: ({ properties: p, geometry }) => ({
      name: text(p.mun_name),
      code: text(p.mun_code),
      region: text(p.sta_name),
      within: text(p.sta_name),
      geometry,
    }),
  },
  estonia: boundaries("EST", 2, 1),
  // Latvia's municipalities would be forty regions, some of one parish: it stays whole.
  latvia: boundaries("LVA", 2, null, "Latvija"),
  lithuania: boundaries("LTU", 3, 1),
  belarus: boundaries("BLR", 2, 1),
  ukraine: boundaries("UKR", 2, 1),
  moldova: boundaries("MDA", 1, null, "Moldova"),
  // geoBoundaries has the names of these three mangled past mending: Eurostat's are used.
  czechia: { ...boundaries("CZE", 3, 1), named: namedByEurostat("CZ") },
  slovakia: { ...boundaries("SVK", 3, 1), named: namedByEurostat("SK") },
  hungary: { ...boundaries("HUN", 3, 1), named: namedByEurostat("HU") },
  romania: boundaries("ROU", 2, 1),
  bulgaria: boundaries("BGR", 2, 1),
  slovenia: boundaries("SVN", 2, 1),
  croatia: boundaries("HRV", 2, 1),
  "bosnia-and-herzegovina": {
    ...boundaries("BIH", 3, 1),
    url: "https://github.com/wmgeolab/geoBoundaries/raw/f549eab/releaseData/gbOpen/BIH/ADM3/geoBoundaries-BIH-ADM3.geojson",
    regions: {
      url: "https://github.com/wmgeolab/geoBoundaries/raw/90a1d52/releaseData/gbOpen/BIH/ADM1/geoBoundaries-BIH-ADM1.geojson",
      name: (p) => text(p.shapeName),
    },
  },
  serbia: boundaries("SRB", 2, 1),
  montenegro: boundaries("MNE", 1, null, "Crna Gora"),
  kosovo: boundaries("XKX", 2, null, "Kosovo"),
  "north-macedonia": boundaries("MKD", 2, 1),
  albania: boundaries("ALB", 3, 1),
  greece: boundaries("GRC", 3, 2),
  russia: {
    ...boundaries("RUS", 2, 1),
    // The tip of Chukotka lies past the 180th meridian: left out, like the Aleutians, so
    // that the country does not stretch round the world.
    unit: (feature) => {
      const unit = boundaries("RUS", 2, 1).unit(feature);
      if (!unit) return null;
      const east = (polygons(unit.geometry) as Position[][][]).filter(
        (polygon) => (polygon[0]?.[0]?.[0] ?? 0) > 0,
      );
      return east.length > 0
        ? { ...unit, geometry: { type: "MultiPolygon", coordinates: east } }
        : null;
    },
  },
  turkey: boundaries("TUR", 2, 1),
  cyprus: boundaries("CYP", 2, 1),
  malta: boundaries("MLT", 1, null, "Malta"),
  andorra: {
    url: `${GEOBOUNDARIES}/AND/ADM1/geoBoundaries-AND-ADM1.geojson`,
    unit: boundaryUnit("Andorra"),
  },
  liechtenstein: {
    url: `${GEOBOUNDARIES}/LIE/ADM1/geoBoundaries-LIE-ADM1.geojson`,
    unit: boundaryUnit("Liechtenstein"),
  },
  "san-marino": {
    url: `${GEOBOUNDARIES}/SMR/ADM1/geoBoundaries-SMR-ADM1.geojson`,
    unit: boundaryUnit("San Marino"),
  },
  monaco: {
    url: `${GEOBOUNDARIES}/MCO/ADM2/geoBoundaries-MCO-ADM2.geojson`,
    unit: boundaryUnit("Monaco"),
  },
  vatican: {
    url: `${GEOBOUNDARIES}/VAT/ADM0/geoBoundaries-VAT-ADM0.geojson`,
    unit: boundaryUnit("Città del Vaticano"),
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

/**
 * The servers that answer Overpass queries: the next is tried when one is busy. Only
 * those that keep up with OpenStreetMap: one that lagged gave four municipalities fewer.
 */
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/**
 * The Canadian census subdivisions as Opendatasoft lists them, each with a point inside
 * it: the subdivision of geoBoundaries that holds the point takes its name, code and
 * province. One that holds none (the two lists are five years apart) keeps its own name,
 * mended, and takes the province of the nearest point.
 */
async function canadianNames(units: Unit[]): Promise<void> {
  const response = await fetch(
    `${ODS}/georef-canada-census-subdivision/exports/json?select=csd_code,csd_name_en,prov_name_en,geo_point_2d`,
  );
  const listed = (await response.json()) as {
    csd_code: unknown;
    csd_name_en: unknown;
    prov_name_en: unknown;
    geo_point_2d: { lon: number; lat: number };
  }[];
  const boxed = units.map((unit) => {
    const rings = (polygons(unit.geometry) as Position[][][]).map((polygon) => polygon[0] ?? []);
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of rings.flat()) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
    return { unit, rings, box, known: false };
  });
  // Accents read as two letters each, and long names cut short with a star.
  const mended = (name: string) =>
    (name.includes("Ã") ? Buffer.from(name, "latin1").toString("utf8") : name).replace(
      /[-\s]*\*$/,
      "",
    );
  const plain = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();
  const far = (row: (typeof listed)[number], box: number[]) =>
    Math.hypot(
      row.geo_point_2d.lon - ((box[0] ?? 0) + (box[2] ?? 0)) / 2,
      row.geo_point_2d.lat - ((box[1] ?? 0) + (box[3] ?? 0)) / 2,
    );
  const take = (holder: (typeof boxed)[number], row: (typeof listed)[number]) => {
    holder.known = true;
    holder.unit.name = text(row.csd_name_en);
    holder.unit.code = text(row.csd_code);
    holder.unit.region = text(row.prov_name_en);
    holder.unit.within = holder.unit.region;
  };
  // First by name, the nearest of those so called and not far: the point of a small
  // place may fall just outside it, in the wide land around.
  const byName = new Map<string, (typeof boxed)[number][]>();
  for (const entry of boxed) {
    const key = plain(mended(entry.unit.name)).slice(0, 24);
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  const unplaced: typeof listed = [];
  for (const row of listed) {
    const same = (byName.get(plain(text(row.csd_name_en)).slice(0, 24)) ?? [])
      .filter((entry) => !entry.known && far(row, entry.box) < 0.5)
      .sort((a, b) => far(row, a.box) - far(row, b.box))[0];
    if (same) take(same, row);
    else unplaced.push(row);
  }
  // Then by the point: the subdivision that holds it, if it has no name yet.
  for (const row of unplaced) {
    const point: Position = [row.geo_point_2d.lon, row.geo_point_2d.lat];
    const holder = boxed.find(
      ({ rings, box, known }) =>
        !known &&
        point[0] >= box[0] &&
        point[1] >= box[1] &&
        point[0] <= box[2] &&
        point[1] <= box[3] &&
        rings.some((ring) => inside(point, ring)),
    );
    if (holder) take(holder, row);
  }
  for (const { unit, box, known } of boxed) {
    if (known) continue;
    const nearest = listed.reduce((best, row) => (far(row, box) < far(best, box) ? row : best));
    unit.name = mended(unit.name);
    unit.region = text(nearest.prov_name_en);
    unit.within = unit.region;
  }
  const older = boxed.filter(({ known }) => !known).length;
  console.log(`  ${String(older)} keep the name of the older list`);
}

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

/**
 * A plane laid on the globe at a point, on which distances and directions from that
 * point are true (azimuthal equidistant): there and back, in metres.
 */
function azimuthal([lon0, lat0]: Position) {
  const radians = Math.PI / 180;
  const earth = 6_371_000;
  const [l0, p0] = [lon0 * radians, lat0 * radians];
  return {
    to: ([lon, lat]: Position): Position => {
      const [l, p] = [lon * radians, lat * radians];
      const cosine = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0);
      const angle = Math.acos(Math.min(1, Math.max(-1, cosine)));
      const k = angle === 0 ? 1 : angle / Math.sin(angle);
      return [
        earth * k * Math.cos(p) * Math.sin(l - l0),
        earth * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l - l0)),
      ];
    },
    from: ([x, y]: Position): Position => {
      const distance = Math.hypot(x, y);
      if (distance === 0) return [lon0, lat0];
      const angle = distance / earth;
      const p = Math.asin(
        Math.cos(angle) * Math.sin(p0) + (y * Math.sin(angle) * Math.cos(p0)) / distance,
      );
      const l =
        l0 +
        Math.atan2(
          x * Math.sin(angle),
          distance * Math.cos(p0) * Math.cos(angle) - y * Math.sin(p0) * Math.sin(angle),
        );
      return [l / radians, p / radians];
    },
  };
}

/** The public servers are often busy: each is tried in turn, a few times round. */
async function fromOverpass(query: string): Promise<Feature[]> {
  const relations = await overpass<OsmRelation>(`${query}out geom;`);
  return relations.map(osmFeature);
}

/** Asks Overpass, and gives back the elements of its answer. */
async function overpass<Element>(query: string): Promise<Element[]> {
  for (let round = 0; round < 8; round++) {
    for (const server of OVERPASS) {
      const response = await fetch(server, {
        method: "POST",
        headers: { "user-agent": "looters-geodata/1.0 (areas fetch script)" },
        body: new URLSearchParams({ data: `[out:json][timeout:180];${query}` }),
        signal: AbortSignal.timeout(240_000),
      }).catch(() => null);
      const answer = response?.ok ? await response.text() : "";
      if (answer.startsWith("{")) {
        return (JSON.parse(answer) as { elements: Element[] }).elements;
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

/**
 * The polygons of a geometry with their coordinates rounded: the points that fall on
 * the one before are dropped, and so are the rings left with no surface. A border two
 * municipalities share stays shared, each point being rounded the same way in both.
 */
function rounded(geometry: Feature["geometry"], decimals: number): Position[][][] {
  const unit = 10 ** decimals;
  return (polygons(geometry) as Position[][][])
    .map((polygon) =>
      polygon
        .map((ring) =>
          ring
            .map(([x, y]): Position => [Math.round(x * unit) / unit, Math.round(y * unit) / unit])
            .filter((point, index, all) => {
              const before = all[index - 1];
              return !before || before[0] !== point[0] || before[1] !== point[1];
            }),
        )
        .filter((ring) => ring.length >= 4),
    )
    .filter((polygon) => polygon.length > 0 && (polygon[0]?.length ?? 0) >= 4);
}

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
  const units = [...byCode.values()];
  if (source.regions) {
    const shapes = source.regions.overpass
      ? await fromOverpass(source.regions.overpass)
      : await fromUrl(source.regions.url ?? "");
    // Each outer ring with its box: most rings are ruled out without being walked.
    const named = shapes.map((shape) => ({
      name: source.regions?.name(shape.properties) ?? "",
      outers: polygons(shape.geometry).map((polygon) => {
        const ring = (polygon as Position[][])[0] ?? [];
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of ring) {
          box[0] = Math.min(box[0] ?? x, x);
          box[1] = Math.min(box[1] ?? y, y);
          box[2] = Math.max(box[2] ?? x, x);
          box[3] = Math.max(box[3] ?? y, y);
        }
        return { ring, box };
      }),
    }));
    const holds = (region: (typeof named)[number], [x, y]: Position) =>
      region.outers.some(
        ({ ring, box }) =>
          x >= (box[0] ?? 0) &&
          y >= (box[1] ?? 0) &&
          x <= (box[2] ?? 0) &&
          y <= (box[3] ?? 0) &&
          inside([x, y], ring),
      );
    for (const unit of units) {
      // Some points of its border, spread along it: the region that holds most of them.
      const border = polygons(unit.geometry)
        .map((polygon) => (polygon as Position[][])[0] ?? [])
        .sort((a, b) => b.length - a.length)[0];
      const step = Math.max(1, Math.floor((border?.length ?? 0) / 15));
      const sample = (border ?? []).filter((_, index) => index % step === 0);
      const votes = named.map((region) => sample.filter((point) => holds(region, point)).length);
      const best = votes.indexOf(Math.max(...votes));
      unit.region = (votes[best] ?? 0) > 0 ? (named[best]?.name ?? "") : "";
      // Two of the same name are told apart by their region.
      if (unit.region) unit.within = unit.region;
    }
    const lost = units.filter((unit) => !unit.region);
    if (lost.length > 0) {
      // Left out: alone in the country, outside every region, it would be an area by itself.
      console.log(`  in no region, left out: ${lost.map((unit) => unit.name).join(", ")}`);
      for (const unit of lost) units.splice(units.indexOf(unit), 1);
    }
  }
  await source.named?.(units);
  units.push(...((await source.more?.()) ?? []));
  // As drawn by the source, before the coast cuts them: a place on the shore may fall
  // just off the coast, but not off the municipality it belongs to.
  const drawn = new Map(units.map((unit) => [unit, polygons(unit.geometry) as Position[][][]]));
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
    const region = source.land.restRegion ?? units[0]?.region ?? country;
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
  if (source.settlements) {
    const places = await overpass<{
      id: number;
      lon: number;
      lat: number;
      tags: Record<string, string>;
    }>(`${source.settlements}out;`);
    const whole = [...units];
    units.length = 0;
    const placed = new Set<number>();
    for (const unit of whole) {
      const outline = drawn.get(unit);
      // What no place lies in (the park) stays one territory, in the region it was given.
      // A place drawn twice under one name counts once.
      const names = new Set<string>();
      const inhabited = (
        outline
          ? places.filter((place) =>
              outline.some((polygon) => inside([place.lon, place.lat], polygon[0] ?? [])),
            )
          : []
      ).filter((place) => {
        placed.add(place.id);
        const name = place.tags.name ?? "";
        return !names.has(name) && names.add(name);
      });
      if (inhabited.length === 0) {
        units.push(unit);
        continue;
      }
      // Nearest on the ground, not on the grid of the degrees: the plane the cells are
      // drawn on keeps distances from the middle of the unit true.
      const middle: Position = [
        inhabited.reduce((sum, place) => sum + place.lon, 0) / inhabited.length,
        inhabited.reduce((sum, place) => sum + place.lat, 0) / inhabited.length,
      ];
      const plane = azimuthal(middle);
      const points = inhabited.map((place) => plane.to([place.lon, place.lat]));
      const voronoi = Delaunay.from(points).voronoi([-4e6, -4e6, 4e6, 4e6]);
      const landOfUnit = polygons(unit.geometry) as MultiPolygon;
      inhabited.forEach((place, index) => {
        const cell = voronoi.cellPolygon(index) as Position[] | null;
        if (!cell) return;
        // The sides of a cell are long: more points along them, so that they stay the
        // same line once back on the globe.
        const ring = cell.flatMap((point, at) => {
          const next = cell[(at + 1) % cell.length] ?? point;
          return Array.from({ length: 16 }, (_, part) =>
            plane.from([
              point[0] + ((next[0] - point[0]) * part) / 16,
              point[1] + ((next[1] - point[1]) * part) / 16,
            ]),
          );
        });
        const first = ring[0];
        if (!first) return;
        const coordinates = polygonClipping.intersection(landOfUnit, [[[...ring, first]]]);
        if (coordinates.length === 0) return;
        units.push({
          name: place.tags.name ?? "",
          code: `osm-node-${String(place.id)}`,
          region: unit.name,
          within: unit.name,
          geometry: { type: "MultiPolygon", coordinates },
        });
      });
    }
    const astray = places.filter((place) => !placed.has(place.id));
    if (astray.length > 0) {
      console.log(`  in no unit: ${astray.map((place) => place.tags.name ?? "").join(", ")}`);
    }
  }

  // Names that come more than once say where they are: "Abbey (Lincoln)".
  const times = new Map<string, number>();
  for (const unit of units) times.set(unit.name, (times.get(unit.name) ?? 0) + 1);
  const regions: Record<string, string[]> = {};
  const features = units.map((unit) => {
    if (unit.region) (regions[unit.region] ??= []).push(unit.code);
    const name = (times.get(unit.name) ?? 0) > 1 ? `${unit.name} (${unit.within})` : unit.name;
    return {
      type: "Feature",
      properties: { name, code: unit.code },
      geometry: { type: "MultiPolygon", coordinates: rounded(unit.geometry, source.decimals ?? 5) },
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
