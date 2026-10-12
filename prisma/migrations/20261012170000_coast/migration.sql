-- The coastline of the world, in pieces: what tells a municipality on the sea from one inland.
CREATE TABLE "GeoCoast" (
  "id" SERIAL PRIMARY KEY,
  "geom" geometry(LineString, 4326) NOT NULL
);
CREATE INDEX "GeoCoast_geom_idx" ON "GeoCoast" USING GIST ("geom");

-- Whether a municipality has access to the sea: an island, or land the coast runs along.
ALTER TABLE "GeoUnit" ADD COLUMN "coastal" BOOLEAN NOT NULL DEFAULT false;
