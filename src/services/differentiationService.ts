import {
  resolveLanguageCode,
  SUPPORTED_LANGUAGES,
  LanguageCode,
} from "../utils/promptBuilder";

export interface AxiomaLensResult {
  topic: string;
  pros: string[];
  cons: string[];
  blindspots: string[];
  axioma: string;
}

export type EditSelectionAction =
  | "shorten"
  | "soften"
  | "formal"
  | "assertive"
  | "translate_en"
  | "translate_id";

export const SUPPORTED_EDIT_ACTIONS: readonly EditSelectionAction[] = [
  "shorten",
  "soften",
  "formal",
  "assertive",
  "translate_en",
  "translate_id",
] as const;

export type ReplySenderRole = "dosen" | "atasan" | "klien" | "orang_tua" | "teman";

export const SUPPORTED_SENDER_ROLES: readonly ReplySenderRole[] = [
  "dosen",
  "atasan",
  "klien",
  "orang_tua",
  "teman",
] as const;

export interface ReplyOption {
  label: string;
  text: string;
}

export interface ReplyAssistantResult {
  detectedTone: string;
  replies: ReplyOption[];
}

const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  auto: "Sesuai bahasa masukan pengguna (default Bahasa Indonesia natural)",
  id: "Bahasa Indonesia yang natural",
  "jv-ngoko": "Bahasa Jawa Ngoko yang natural dan akrab",
  "jv-krama": "Bahasa Jawa Krama Alus / Krama Inggil yang sopan",
  su: "Bahasa Sunda yang natural dan sopan",
  en: "Natural English",
  ja: "Bahasa Jepang yang natural",
  ar: "Bahasa Arab yang natural",
};

const EDIT_ACTION_INSTRUCTIONS: Record<EditSelectionAction, string> = {
  shorten: "Perpendek teks menjadi jauh lebih padat, ringkas, dan langsung ke inti tanpa kehilangan makna utamanya.",
  soften: "Perhalus nada kalimat agar lebih sopan, hangat, empatik, dan tidak terkesan menyerang.",
  formal: "Ubah menjadi bahasa profesional, baku, rapi, dan siap dipakai untuk konteks kerja atau akademik.",
  assertive: "Buat kalimat lebih tegas, jelas, percaya diri, dan meyakinkan tanpa menjadi kasar.",
  translate_en: "Terjemahkan teks ke dalam Bahasa Inggris yang natural, idiomatis, dan akurat.",
  translate_id: "Terjemahkan teks ke dalam Bahasa Indonesia yang natural, mengalir, dan akurat.",
};

const SENDER_ROLE_DESCRIPTIONS: Record<ReplySenderRole, string> = {
  dosen: "Dosen / Pembimbing Akademik (jaga kesopanan akademik, salam sopan, jelas, tidak bertele-tele).",
  atasan: "Atasan / Pimpinan Kerja (profesional, menghormati hierarki, solutif, ringkas).",
  klien: "Klien / Mitra Bisnis (ramah, profesional, persuasif, membangun kepercayaan).",
  orang_tua: "Orang Tua / Keluarga Lebih Tua (hangat, sangat santun, penuh hormat; bila Jawa gunakan Krama Alus, bila Sunda gunakan basa lemes).",
  teman: "Teman Sebaya (santai, akrab, natural, tidak kaku).",
};

function cleanString(raw: unknown, maxLen = 600, fallback = ""): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen).trim() : trimmed;
}

function cleanStringArray(raw: unknown, maxItems = 5, maxItemLen = 280): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => cleanString(item, maxItemLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function describeLanguage(rawLanguage?: string): string {
  const trimmed = typeof rawLanguage === "string" ? rawLanguage.trim() : "";
  if (!trimmed) return LANGUAGE_LABELS.auto;
  const lowered = trimmed.toLowerCase();
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lowered)) {
    return LANGUAGE_LABELS[resolveLanguageCode(lowered)];
  }
  return `Gunakan bahasa "${trimmed.slice(0, 60)}" secara natural`;
}

export function isValidEditSelectionAction(raw: unknown): raw is EditSelectionAction {
  return (
    typeof raw === "string" &&
    (SUPPORTED_EDIT_ACTIONS as readonly string[]).includes(raw.trim().toLowerCase())
  );
}

export function resolveSenderRole(raw: unknown): ReplySenderRole {
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if ((SUPPORTED_SENDER_ROLES as readonly string[]).includes(normalized)) {
      return normalized as ReplySenderRole;
    }
  }
  return "teman";
}

function safeExtractJsonObject(rawText: string): Record<string, unknown> | null {
  if (typeof rawText !== "string" || !rawText.trim()) return null;

  let cleaned = rawText
    .trim()
    .replace(/^```(?:json|JSON)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fallback to outermost braces
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 1. AXIOMA LENS (2-Sided Critical Analysis)
// ---------------------------------------------------------------------------
export function buildLensPrompt(params: {
  topic: string;
  contextSummary?: string;
  language?: string;
}): string {
  const langDirective = describeLanguage(params.language);
  const lines = [
    "Kamu adalah Axioma Lens, analis objektif 2 sisi yang tajam, jernih, dan tidak asal setuju.",
    "Analisis topik/ide/dilema berikut secara seimbang untuk membantu pengguna mengambil keputusan matang.",
    `BAHASA KELUARAN: ${langDirective}.`,
    "",
    `TOPIK / DILEMA: ${params.topic.trim()}`,
  ];

  if (params.contextSummary && params.contextSummary.trim()) {
    lines.push(`KONTEKS TAMBAHAN: ${params.contextSummary.trim().slice(0, 800)}`);
  }

  lines.push(
    "",
    "ATURAN KETAT:",
    "1. Kembalikan HANYA JSON valid tanpa markdown code fence dan tanpa teks tambahan.",
    "2. Sajikan 3 poin `pros` (peluang/kelebihan), 3 poin `cons` (celah/risiko/kelemahan), 1-2 `blindspots` (asumsi tersembunyi yang perlu diuji), dan 1 kalimat `axioma` (kesimpulan objektif yang tegas dan jernih).",
    "3. Setiap poin harus padat, konkret, dan langsung ke inti.",
    "",
    "FORMAT JSON WAJIB:",
    "{",
    '  "topic": "Ringkasan topik singkat",',
    '  "pros": ["Poin peluang/kelebihan 1", "Poin peluang/kelebihan 2", "Poin peluang/kelebihan 3"],',
    '  "cons": ["Poin celah/risiko/kelemahan 1", "Poin celah/risiko/kelemahan 2", "Poin celah/risiko/kelemahan 3"],',
    '  "blindspots": ["Asumsi tersembunyi 1", "Asumsi tersembunyi 2"],',
    '  "axioma": "1 kalimat kesimpulan objektif yang tegas dan jernih"',
    "}"
  );

  return lines.join("\n");
}

export function parseLensJson(rawText: string, fallbackTopic: string): AxiomaLensResult {
  const parsed = safeExtractJsonObject(rawText);
  if (!parsed) {
    return {
      topic: cleanString(fallbackTopic, 140, "Analisis Topik"),
      pros: [],
      cons: [],
      blindspots: [],
      axioma: cleanString(rawText.replace(/```(?:json)?/gi, ""), 350, ""),
    };
  }

  return {
    topic: cleanString(parsed.topic, 180, cleanString(fallbackTopic, 140, "Analisis Topik")),
    pros: cleanStringArray(parsed.pros, 5, 280),
    cons: cleanStringArray(parsed.cons, 5, 280),
    blindspots: cleanStringArray(parsed.blindspots, 3, 280),
    axioma: cleanString(parsed.axioma, 400, ""),
  };
}

// ---------------------------------------------------------------------------
// 2. HIGHLIGHT-TO-EDIT (Partial Text Revision)
// ---------------------------------------------------------------------------
export function buildEditSelectionPrompt(params: {
  selectedText: string;
  action: EditSelectionAction;
  fullContext?: string;
}): string {
  const lines = [
    "Kamu adalah editor teks presisi di Axioma.",
    "Revisi HANYA potongan teks target (`selectedText`) sesuai aksi yang diminta.",
    `AKSI REVISI: ${EDIT_ACTION_INSTRUCTIONS[params.action]}`,
    "",
  ];

  if (params.fullContext && params.fullContext.trim()) {
    lines.push(
      `KONTEKS PARAGRAF/PESAN PENUH (hanya referensi agar selaras, JANGAN tulis ulang seluruhnya):`,
      params.fullContext.trim().slice(0, 1200),
      ""
    );
  }

  lines.push(
    "TEKS TARGET YANG HARUS DIREVISI:",
    params.selectedText.trim(),
    "",
    "ATURAN KETAT:",
    "1. Kembalikan HANYA hasil revisi dari TEKS TARGET tanpa penjelasan, tanpa tanda kutip berlebih, dan tanpa markdown code fence.",
    '2. Format JSON wajib: { "revisedText": "..." }'
  );

  return lines.join("\n");
}

export function parseEditSelectionJson(
  rawText: string,
  fallbackText: string
): { revisedText: string } {
  const parsed = safeExtractJsonObject(rawText);
  if (parsed && typeof parsed.revisedText === "string" && parsed.revisedText.trim()) {
    return { revisedText: parsed.revisedText.trim() };
  }

  const cleaned = (rawText || "")
    .trim()
    .replace(/^```(?:json|JSON)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .replace(/^"|"$/g, "")
    .trim();

  return { revisedText: cleaned || fallbackText.trim() };
}

// ---------------------------------------------------------------------------
// 3. REPLY ASSISTANT (WhatsApp-Ready Multi-Option Replies)
// ---------------------------------------------------------------------------
export function buildReplyAssistantPrompt(params: {
  incomingMessage: string;
  senderRole: ReplySenderRole;
  userIntent?: string;
  language?: string;
}): string {
  const langDirective = describeLanguage(params.language);
  const roleDesc = SENDER_ROLE_DESCRIPTIONS[params.senderRole];

  const lines = [
    "Kamu adalah Axioma Reply Assistant, ahli komunikasi & unggah-ungguh chat WhatsApp Indonesia.",
    "Baca pesan masuk berikut, deteksi nada/maksudnya dalam 1 kalimat, lalu siapkan TEPAT 3 opsi balasan siap tempel ke WhatsApp (tanpa markdown rumit, natural, langsung pakai).",
    "",
    `PENGIRIM PESAN (LAWAN BICARA): ${roleDesc}`,
    `BAHASA BALASAN: ${langDirective}.`,
    `PESAN MASUK:\n${params.incomingMessage.trim()}`,
  ];

  if (params.userIntent && params.userIntent.trim()) {
    lines.push(`MAKSUD / ARAH BALASAN YANG DIINGINKAN PENGGUNA: ${params.userIntent.trim().slice(0, 500)}`);
  }

  lines.push(
    "",
    "ATURAN KETAT:",
    "1. Kembalikan HANYA JSON valid tanpa markdown code fence dan tanpa teks tambahan.",
    '2. Array `replies` harus berisi tepat 3 opsi dengan label: "Sangat Sopan", "Seimbang & Natural", dan "Singkat & Tegas".',
    "3. Setiap teks balasan harus siap langsung di-copy dan tempel ke WhatsApp tanpa placeholder kaku bila tidak diperlukan.",
    "",
    "FORMAT JSON WAJIB:",
    "{",
    '  "detectedTone": "Ringkasan 1 kalimat nada/maksud pesan masuk",',
    '  "replies": [',
    '    { "label": "Sangat Sopan", "text": "Isi balasan siap tempel WA" },',
    '    { "label": "Seimbang & Natural", "text": "Isi balasan siap tempel WA" },',
    '    { "label": "Singkat & Tegas", "text": "Isi balasan siap tempel WA" }',
    "  ]",
    "}"
  );

  return lines.join("\n");
}

export function parseReplyAssistantJson(rawText: string): ReplyAssistantResult {
  const defaultLabels = ["Sangat Sopan", "Seimbang & Natural", "Singkat & Tegas"];
  const parsed = safeExtractJsonObject(rawText);

  if (!parsed) {
    return {
      detectedTone: "Pesan masuk berhasil dibaca.",
      replies: [],
    };
  }

  const detectedTone = cleanString(
    parsed.detectedTone,
    300,
    "Pesan masuk berhasil dianalisis."
  );

  const rawReplies = Array.isArray(parsed.replies) ? parsed.replies : [];
  const replies: ReplyOption[] = rawReplies
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .slice(0, 3)
    .map((item, idx) => ({
      label: cleanString(item.label, 60, defaultLabels[idx] || `Opsi ${idx + 1}`),
      text: cleanString(item.text, 1200, ""),
    }))
    .filter((item) => Boolean(item.text));

  return {
    detectedTone,
    replies,
  };
}
