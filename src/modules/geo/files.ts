import { createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { GeoFormat } from "@prisma/client";

const EXTENSIONS: Record<string, GeoFormat> = {
  ".kml": "KML",
  ".json": "GEOJSON",
  ".geojson": "GEOJSON",
};

/** The format announced by the file name, or null when it is not accepted. */
export function formatFromFilename(filename: string): GeoFormat | null {
  return EXTENSIONS[path.extname(filename).toLowerCase()] ?? null;
}

/**
 * Whether the first bytes look like the announced format: XML for KML, a
 * JSON object for GeoJSON. A cheap check that stops a renamed file early;
 * `jobs` does the real validation.
 */
export function contentMatchesFormat(head: Buffer, format: GeoFormat): boolean {
  // Skip a UTF-8 byte order mark and leading whitespace.
  const decoded = head.toString("utf8");
  const text = (decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded).trimStart();
  return format === "KML" ? text.startsWith("<") : text.startsWith("{");
}

/** Where uploaded geo files live; the directory is shared with `jobs`. */
export class UploadStore {
  constructor(private readonly dir: string) {}

  /** Name stored in `GeoUpload.storagePath`: relative, so both services resolve it. */
  static storageName(uploadId: string, format: GeoFormat): string {
    return `${uploadId}.${format === "KML" ? "kml" : "geojson"}`;
  }

  private resolve(name: string): string {
    return path.join(this.dir, path.basename(name));
  }

  /** Streams the file to disk and returns its size. */
  async save(name: string, source: Readable): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const target = createWriteStream(this.resolve(name));
    await pipeline(source, target);
    return target.bytesWritten;
  }

  /** The first bytes of a stored file. */
  async head(name: string, length = 512): Promise<Buffer> {
    const file = await open(this.resolve(name), "r");
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  async remove(name: string): Promise<void> {
    await rm(this.resolve(name), { force: true });
  }
}
