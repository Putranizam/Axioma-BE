import { PDFDocument } from "pdf-lib";
import { SupabaseClient } from "@supabase/supabase-js";

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_FILES_PER_MESSAGE = 4;
export const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB total payload for Gemini
export const MAX_PDF_PAGES = 30;
export const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes

/**
 * Validates the file buffer against known magic byte signatures.
 * Never trusts client-reported MIME types or file extensions.
 */
export function detectMagicMimeType(buffer: Buffer): { mime: AllowedMimeType; ext: string } | null {
  if (!buffer || buffer.length < 12) return null;

  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }

  // 3. WebP: 'RIFF' .... 'WEBP'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  // 4. PDF: '%PDF-'
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mime: "application/pdf", ext: "pdf" };
  }

  // 5. HEIC / HEIF (ISO Base Media File Format box 'ftyp' at offset 4)
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    const compatibleBrands = buffer.subarray(16, Math.min(buffer.length, 64)).toString("ascii").toLowerCase();
    const isHeic =
      ["heic", "heix", "heim", "heis"].includes(brand) ||
      compatibleBrands.includes("heic") ||
      compatibleBrands.includes("heix");
    const isHeif =
      ["mif1", "msf1", "heif"].includes(brand) ||
      compatibleBrands.includes("mif1") ||
      compatibleBrands.includes("heif");

    if (isHeic) return { mime: "image/heic", ext: "heic" };
    if (isHeif) return { mime: "image/heif", ext: "heif" };
  }

  return null;
}

/**
 * Extracts basic image dimensions (width/height) from PNG, JPEG, and WebP buffers.
 */
export function extractImageDimensions(
  buffer: Buffer,
  mime: AllowedMimeType
): { width?: number; height?: number } {
  try {
    if (mime === "image/png" && buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }

    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          if (width > 0 && height > 0) return { width, height };
          break;
        }
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }

    if (mime === "image/webp" && buffer.length >= 30) {
      const format = buffer.subarray(12, 16).toString("ascii");
      if (format === "VP8 " && buffer.length >= 30) {
        const width = (buffer.readUInt16LE(26) & 0x3fff);
        const height = (buffer.readUInt16LE(28) & 0x3fff);
        if (width > 0 && height > 0) return { width, height };
      } else if (format === "VP8L" && buffer.length >= 25) {
        const b0 = buffer[21];
        const b1 = buffer[22];
        const b2 = buffer[23];
        const b3 = buffer[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        if (width > 0 && height > 0) return { width, height };
      } else if (format === "VP8X" && buffer.length >= 30) {
        const width = 1 + buffer.readUIntLE(24, 3);
        const height = 1 + buffer.readUIntLE(27, 3);
        if (width > 0 && height > 0) return { width, height };
      }
    }
  } catch {
    // Non-fatal if dimensions can't be parsed
  }
  return {};
}

/**
 * Counts PDF pages safely using pdf-lib.
 */
export async function countPdfPages(buffer: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Dokumen PDF tidak dapat dibaca atau rusak: ${msg}`);
  }
}

/**
 * Sanitizes a client-provided file name to prevent directory traversal or control characters.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw
    .trim()
    .replace(/[/\\]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 100);
  return base || "unnamed_file";
}

/**
 * Concurrency Limiter: Ensures no more than `maxConcurrent` uploads are processed simultaneously.
 */
export class UploadConcurrencyLimiter {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrent = 3) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.active--;
          this.next();
        }
      };
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.active--;
            this.next();
          }
        });
      });
    });
  }

  private next() {
    if (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const nextFn = this.queue.shift();
      nextFn?.();
    }
  }
}

export const globalUploadLimiter = new UploadConcurrencyLimiter(3);

/**
 * Counts user uploads in the past 24 hours to enforce daily limits.
 */
export async function getDailyUserUploadCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("message_attachments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", oneDayAgo);

  if (error) {
    // Non-fatal, assume 0 if query fails
    return 0;
  }
  return count || 0;
}

