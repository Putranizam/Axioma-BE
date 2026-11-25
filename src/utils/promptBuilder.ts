export type LanguageCode =
  | "auto"
  | "id"
  | "jv-ngoko"
  | "jv-krama"
  | "su"
  | "en"
  | "ja"
  | "ar";

export type ToneStyle = "santai" | "formal" | "kreatif";

export const DEFAULT_LANGUAGE: LanguageCode = "auto";
export const DEFAULT_TONE: ToneStyle = "santai";

export const SUPPORTED_LANGUAGES: readonly LanguageCode[] = [
  "auto",
  "id",
  "jv-ngoko",
  "jv-krama",
  "su",
  "en",
  "ja",
  "ar",
] as const;

export const SUPPORTED_TONES: readonly ToneStyle[] = [
  "santai",
  "formal",
  "kreatif",
] as const;

const BASE_IDENTITY =
  "Kamu adalah Axioma, asisten AI cerdas buatan Indonesia yang membantu, akurat, dan natural.";

export const AUTO_LANGUAGE_MIRRORING_INSTRUCTION =
  "AUTO-LANGUAGE MIRRORING: Deteksi otomatis bahasa pada pesan terbaru pengguna (Indonesia, Inggris, Jawa Ngoko, Jawa Krama, Sunda, Jepang, Arab, atau bahasa apa pun). WAJIB membalas dalam bahasa serta gaya/tingkat tutur dan kesopanan yang SAMA PERSIS dengan prompt pengguna (misalnya: jika pengguna bertanya memakai Jawa Krama, balas memakai Jawa Krama; jika memakai Jawa Ngoko, balas memakai Jawa Ngoko; jika memakai Bahasa Inggris, balas memakai Bahasa Inggris), KECUALI pengguna secara eksplisit meminta terjemahan atau bahasa lain.";

const LANGUAGE_INSTRUCTIONS: Record<LanguageCode, string> = {
  auto: AUTO_LANGUAGE_MIRRORING_INSTRUCTION,
  id: "Jawab sepenuhnya dalam Bahasa Indonesia.",
  "jv-ngoko":
    "Jawab menggunakan Bahasa Jawa Ngoko yang natural dan akrab untuk percakapan sehari-hari.",
  "jv-krama":
    "Jawab menggunakan Bahasa Jawa Krama Inggil / Krama Alus yang sopan dan santun.",
  su: "Jawab menggunakan Bahasa Sunda yang natural dan sopan.",
  en: "Answer strictly in natural English.",
  ja: "Jawab menggunakan Bahasa Jepang yang natural.",
  ar: "Jawab menggunakan Bahasa Arab yang natural.",
};

const TONE_INSTRUCTIONS: Record<ToneStyle, string> = {
  santai:
    "Gunakan gaya bahasa yang akrab, luwes, hangat, dan tidak kaku seperti teman ngobrol.",
  formal:
    "Gunakan gaya bahasa yang profesional, terstruktur, jelas, dan sopan.",
  kreatif:
    "Gunakan gaya bahasa yang ekspresif, kaya imajinasi, dan cocok untuk penulisan cerita atau brainstorming.",
};

export function resolveLanguageCode(raw?: unknown): LanguageCode {
  if (typeof raw !== "string") {
    return DEFAULT_LANGUAGE;
  }
  const normalized = raw.trim().toLowerCase() as LanguageCode;
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return DEFAULT_LANGUAGE;
}

export function resolveToneStyle(raw?: unknown): ToneStyle {
  if (typeof raw !== "string") {
    return DEFAULT_TONE;
  }
  const normalized = raw.trim().toLowerCase() as ToneStyle;
  if ((SUPPORTED_TONES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return DEFAULT_TONE;
}

export function buildSystemInstruction(
  language: LanguageCode = DEFAULT_LANGUAGE,
  tone: ToneStyle = DEFAULT_TONE
): string {
  const safeLanguage = resolveLanguageCode(language);
  const safeTone = resolveToneStyle(tone);

  return [
    BASE_IDENTITY,
    `ATURAN BAHASA (WAJIB DIPATUHI): ${LANGUAGE_INSTRUCTIONS[safeLanguage]}`,
    `ATURAN GAYA BICARA (TONE): ${TONE_INSTRUCTIONS[safeTone]}`,
  ].join("\n");
}
