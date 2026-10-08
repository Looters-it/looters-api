import { AppError } from "../../http/errors.js";

/** What a logo may weigh. Shown small, it needs no more. */
export const LOGO_MAX_BYTES = 200 * 1024;

const SIGNATURES: { mime: string; matches: (bytes: Buffer) => boolean }[] = [
  {
    mime: "image/png",
    matches: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/webp",
    matches: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/** The content types a logo may be sent as. */
export const LOGO_MIME_TYPES = SIGNATURES.map((signature) => signature.mime);

/**
 * Decides what an uploaded logo is from its first bytes, never from what the
 * client says: PNG, JPEG or WebP. Anything else is refused, SVG included,
 * which can carry scripts.
 */
export function readLogo(bytes: unknown): { mime: string; data: Buffer } {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new AppError(400, "UNSUPPORTED_IMAGE", "Send a PNG, JPEG or WebP image");
  }
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new AppError(
      413,
      "IMAGE_TOO_LARGE",
      `The image exceeds ${String(LOGO_MAX_BYTES / 1024)} KB`,
    );
  }
  const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
  if (!signature) throw new AppError(400, "UNSUPPORTED_IMAGE", "Send a PNG, JPEG or WebP image");
  return { mime: signature.mime, data: bytes };
}
