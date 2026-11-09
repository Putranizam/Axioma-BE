import { detectMagicMimeType, countPdfPages, extractImageDimensions, sanitizeFilename } from "../src/attachments";
import { PDFDocument } from "pdf-lib";

async function run() {
  console.log("1. Testing Magic Bytes...");
  const jpeg = detectMagicMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));
  console.log("  JPEG:", jpeg);
  if (jpeg?.mime !== "image/jpeg") throw new Error("JPEG failed");

  const png = detectMagicMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  console.log("  PNG:", png);
  if (png?.mime !== "image/png") throw new Error("PNG failed");

  const pdf = detectMagicMimeType(Buffer.from("%PDF-1.4\n1 0 obj..."));
  console.log("  PDF:", pdf);
  if (pdf?.mime !== "application/pdf") throw new Error("PDF failed");

  const fake = detectMagicMimeType(Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00"));
  console.log("  Fake EXE disguised as jpg:", fake);
  if (fake !== null) throw new Error("Fake EXE was not blocked!");

  console.log("2. Testing PDF Page Counter...");
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  const pdfBytes = await doc.save();
  const pageCount = await countPdfPages(Buffer.from(pdfBytes));
  console.log("  Created 2-page PDF, detected pages:", pageCount);
  if (pageCount !== 2) throw new Error("PDF count failed");

  console.log("3. Testing Filename Sanitization...");
  const sanitized = sanitizeFilename("../../../etc/passwd; rm -rf /*.jpg");
  console.log("  Sanitized:", sanitized);
  if (sanitized.includes("/") || sanitized.includes("\\") || sanitized.includes(";")) {
    throw new Error("Sanitization failed");
  }

  console.log("ALL BASIC ATTACHMENT UNIT TESTS PASSED!");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

