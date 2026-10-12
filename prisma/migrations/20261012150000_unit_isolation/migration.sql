-- Why a municipality has no border with the rest of its country: it is an island, or
-- an exclave lying in another country. Null for every municipality that has borders.
CREATE TYPE "GeoIsolation" AS ENUM ('ISLAND', 'EXCLAVE');
ALTER TABLE "GeoUnit" ADD COLUMN "isolation" "GeoIsolation";
