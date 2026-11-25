export type DirectMediaIntentType = "image" | "video";

export interface DirectMediaIntent {
  type: DirectMediaIntentType;
}

// Slash commands or specialized non-media workflows must never be intercepted
const SLASH_COMMAND_REGEX = /^\s*\/[a-z0-9_-]+/i;

// Exclude theory, educational, tutorial, explanation, and text/prompt-only requests
const NEGATIVE_EXCLUSION_PATTERNS: readonly RegExp[] = [
  /\b(cara\s+(mem)?buat(kan)?|cara\s+bikin(in)?|cara\s+menggambar|cara\s+melukis|cara\s+(meng)?edit|cara\s+(mem)?foto|cara\s+memotret|cara\s+(me)?rekam)\b/i,
  /\b(tips|tutorial|panduan|step\s*by\s*step|langkah[\s-]langkah)\b/i,
  /\b(jelaskan|penjelasan|definisi|pengertian|sejarah|perbedaan\s+antara|apa\s+bedanya)\b/i,
  /^(apa\s+itu|apa\s+arti|apa\s+fungsi|mengapa|kenapa|bagaimana\s+cara|gimana\s+cara|rekomendasi\s+(aplikasi|software|tools?))\b/i,
  // Text-only prompt / script / storyboard / caption / concept requests
  /\b(buatkan|buatin|buat|bikin|bikinin|tulis|tuliskan|kasih|berikan|generate)\s+(dong\s+|saya\s+|aku\s+|gue\s+|me\s+)?(sebuah\s+|beberapa\s+|contoh\s+|ide\s+|teks\s+|draf\s+|draft\s+)?(prompt|skrip|script|naskah|storyboard|caption|ide\s+konten)\b/i,
  /\bprompt\s+(gambar|foto|image|video|animasi|ilustrasi|poster|logo|midjourney|dall-?e|flux|imagen|veo|sora|runway)\b/i,
  /\b(konsep|naskah|skrip|script|storyboard|ide)\s+(untuk\s+)?(video|foto|gambar|poster|ilustrasi|iklan)\b/i,
];

// Exclude figurative uses of "gambarkan" when asking for text explanations (e.g. "gambarkan konsep/alur/proses")
const ABSTRACT_GAMBARKAN_REGEX =
  /\bgambarkan\s+(secara\s+(singkat|jelas|ringkas|umum)|bagaimana|cara|konsep|proses|alur|perbedaan|hubungan|dampak|situasi\s+ekonomi|kondisi\s+pasar)\b/i;

const VIDEO_INTENT_PATTERNS: readonly RegExp[] = [
  /\b(buatin|buatkan|buat|bikin|bikinin|generate|render|ciptakan|hadirkan)\s+(dong\s+|saya\s+|aku\s+|gue\s+|me\s+)?(sebuah\s+|satu\s+|1\s+|a\s+|an\s+)?(animasi\s+video|video\s+animasi|klip\s+video|video\s+klip|video\s+sinematik|motion\s+video|video|klip|clip|animasi)\b/i,
  /\b(tolong|coba|bisa(?:\s+tolong)?)\s+(buatin|buatkan|buat|bikin|bikinin|generate|render)\s+(dong\s+|saya\s+|aku\s+|gue\s+)?(sebuah\s+|satu\s+|1\s+|a\s+|an\s+)?(animasi\s+video|video\s+animasi|klip\s+video|video|animasi|klip)\b/i,
  /\b(animasikan|videokan)\b/i,
  /^\s*\[mode:\s*(video|animasi|klip)\]/i,
  /^\s*(video|animasi\s+video)\s*:\s*\S+/i,
];

const IMAGE_INTENT_PATTERNS: readonly RegExp[] = [
  /\b(buatin|buatkan|buat|bikin|bikinin|generate|render|ciptakan|hadirkan|lukis|lukiskan|gambarin|gambari|gambarkan|fotokan|desain|desainkan|desainin|rancangkan)\s+(dong\s+|saya\s+|aku\s+|gue\s+|me\s+)?(sebuah\s+|satu\s+|1\s+|seekor\s+|seorang\s+|a\s+|an\s+)?(foto|gambar|ilustrasi|lukisan|visual|image|photo|picture|artwork|wallpaper|poster|logo|banner|thumbnail|karikatur|sketsa|potret|portrait|stiker|avatar)\b/i,
  /\b(desainkan|desainin)\s+(dong\s+|saya\s+|aku\s+|gue\s+)?(sebuah\s+|satu\s+|1\s+)?(poster|logo|banner|flyer|brosur|spanduk|thumbnail|kemasan|packaging|kaos|baju)\b/i,
  /\b(gambarkan|gambarin|gambari|lukiskan|fotokan)\s+\S+/i,
  /^\s*\[mode:\s*(gambar|image|foto|visual)\]/i,
  /^\s*(gambar|foto|ilustrasi|poster|logo)\s*:\s*\S+/i,
];

/**
 * Lightweight, zero-LLM direct media intent detector for Axioma main chat.
 *
 * - Returns `null` when `hasAttachment === true` so PDF/image uploads always go to Vision/PDF analysis.
 * - Avoids false positives on theory, tutorials, or prompt-text requests.
 * - Detects explicit Indonesian & English commands to generate an image or video directly in chat.
 */
export function detectDirectMediaIntent(
  message: string,
  hasAttachment: boolean
): DirectMediaIntent | null {
  if (hasAttachment === true) {
    return null;
  }

  if (!message || typeof message !== "string") {
    return null;
  }

  const trimmed = message.trim();
  if (!trimmed || SLASH_COMMAND_REGEX.test(trimmed)) {
    return null;
  }

  // Always block theory / tutorial / prompt-text requests to avoid false positives
  if (NEGATIVE_EXCLUSION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return null;
  }

  // Check explicit video generation intent first (handles phrases like "animasi video")
  if (VIDEO_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { type: "video" };
  }

  // Guard figurative text usage of "gambarkan" unless another explicit media verb+noun matches
  if (
    ABSTRACT_GAMBARKAN_REGEX.test(trimmed) &&
    !/\b(buatin|buatkan|bikin|bikinin|generate|desainkan|fotokan|lukiskan)\b/i.test(trimmed)
  ) {
    return null;
  }

  // Check explicit image generation intent
  if (IMAGE_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { type: "image" };
  }

  return null;
}
