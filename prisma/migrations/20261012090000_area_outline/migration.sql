-- The outline of a folder's own municipalities, as GeoJSON, and what it was drawn from.
ALTER TABLE "GeoArea" ADD COLUMN "outline" TEXT;
ALTER TABLE "GeoArea" ADD COLUMN "outlineOf" TEXT;
