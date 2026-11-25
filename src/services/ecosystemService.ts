import {
  resolveLanguageCode,
  SUPPORTED_LANGUAGES,
  LanguageCode,
} from "../utils/promptBuilder";

// ---------------------------------------------------------------------------
// 1. BEDAH PDF PINTAR (Smart PDF Analysis)
// ---------------------------------------------------------------------------
export type PdfAnalysisMode = "summary" | "glossary" | "critical_questions" | "ask";

export const SUPPORTED_PDF_MODES: readonly PdfAnalysisMode[] = [
  "summary",
  "glossary",
  "critical_questions",
  "ask",
] as const;

export const MAX_PDF_BASE64_BYTES = 8 * 1024 * 1024; // 8MB decoded PDF limit

const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  auto: "Gunakan Bahasa Indonesia yang jelas dan natural (atau ikuti bahasa utama permintaan pengguna).",
  id: "Gunakan Bahasa Indonesia yang jelas, rapi, dan natural.",
  "jv-ngoko": "Gunakan Bahasa Jawa Ngoko yang natural dan mudah dipahami.",
  "jv-krama": "Gunakan Bahasa Jawa Krama Alus yang sopan dan jelas.",
  su: "Gunakan Bahasa Sunda yang natural dan sopan.",
  en: "Respond strictly in clear, natural English.",
  ja: "Respond in clear, natural Japanese.",
  ar: "Respond in clear, natural Arabic.",
};

function describeLanguage(rawLanguage?: string): string {
  const trimmed = typeof rawLanguage === "string" ? rawLanguage.trim() : "";
  if (!trimmed) return LANGUAGE_LABELS.auto;
  const lowered = trimmed.toLowerCase();
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lowered)) {
    return LANGUAGE_LABELS[resolveLanguageCode(lowered)];
  }
  return `Gunakan bahasa "${trimmed.slice(0, 60)}" secara natural.`;
}

export function isValidPdfAnalysisMode(raw: unknown): raw is PdfAnalysisMode {
  return (
    typeof raw === "string" &&
    (SUPPORTED_PDF_MODES as readonly string[]).includes(raw.trim().toLowerCase())
  );
}

/**
 * Validates and cleans a base64 PDF payload (accepts raw base64 or data URL).
 * Verifies decoded byte size <= 8MB and PDF magic header (`%PDF-`).
 */
export function validatePdfBase64Payload(raw: unknown): {
  valid: boolean;
  cleanBase64?: string;
  byteLength?: number;
  code?: string;
  error?: string;
} {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      valid: false,
      code: "pdf_required",
      error: "Field 'pdfBase64' wajib diisi.",
    };
  }

  const trimmed = raw.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,/i);
  if (dataUrlMatch) {
    const declaredMime = dataUrlMatch[1].trim().toLowerCase();
    if (declaredMime !== "application/pdf") {
      return {
        valid: false,
        code: "invalid_pdf_mime",
        error: "Tipe file harus berupa dokumen PDF (application/pdf).",
      };
    }
  }

  const cleanBase64 = trimmed
    .replace(/^data:application\/pdf;base64,/i, "")
    .replace(/\s+/g, "");

  if (!cleanBase64) {
    return {
      valid: false,
      code: "pdf_empty",
      error: "Data PDF kosong.",
    };
  }

  const estimatedBytes = Math.floor((cleanBase64.length * 3) / 4);
  if (estimatedBytes > MAX_PDF_BASE64_BYTES) {
    return {
      valid: false,
      code: "pdf_too_large",
      error: "Ukuran dokumen PDF maksimal 8 MB.",
    };
  }

  // Verify %PDF- header from the first few bytes
  try {
    const headerSlice = Buffer.from(cleanBase64.slice(0, 16), "base64").toString("ascii");
    if (!headerSlice.startsWith("%PDF-")) {
      return {
        valid: false,
        code: "invalid_pdf_format",
        error: "File yang diunggah bukan dokumen PDF yang valid.",
      };
    }
  } catch {
    return {
      valid: false,
      code: "invalid_base64",
      error: "Format base64 dokumen PDF tidak valid.",
    };
  }

  return {
    valid: true,
    cleanBase64,
    byteLength: estimatedBytes,
  };
}

export function buildPdfAnalysisPrompt(params: {
  mode: PdfAnalysisMode;
  fileName?: string;
  question?: string;
  language?: string;
}): string {
  const langRule = describeLanguage(params.language);
  const docLabel = params.fileName ? `Dokumen: "${params.fileName.trim().slice(0, 140)}"` : "Dokumen PDF terlampir";

  const modeDirectives: Record<PdfAnalysisMode, string> = {
    summary: [
      "Buat **Ringkasan Eksekutif** yang tajam dan terstruktur dari dokumen PDF ini:",
      "1. **Inti Dokumen** (2–3 kalimat padat).",
      "2. **Poin Kunci** (daftar bullet terurut).",
      "3. **Angka, Tanggal, atau Fakta Penting** (jika ada dalam dokumen).",
      "4. **Rekomendasi / Tindak Lanjut** (ringkas & konkret berdasarkan isi dokumen).",
    ].join("\n"),
    glossary: [
      "Ekstrak daftar **Istilah Kunci & Konsep Penting** dari dokumen PDF ini.",
      "Format setiap item secara rapi (**Istilah**: penjelasan ringkas dan akurat berbasis konteks dokumen).",
      "Prioritaskan 8–15 istilah/konsep paling esensial tanpa mengarang definisi di luar dokumen.",
    ].join("\n"),
    critical_questions: [
      "Susun **5–7 Prediksi Pertanyaan Kritis** (gaya dosen penguji, reviewer, atau klien kritis) berdasarkan celah, metodologi, argumen, atau klaim penting dalam dokumen PDF ini.",
      "Untuk setiap pertanyaan, sertakan **Poin Jawaban / Pembelaan Singkat** yang bersumber langsung dari isi dokumen (atau sebutkan jika dokumen belum menjelaskannya).",
    ].join("\n"),
    ask: [
      `Jawab pertanyaan spesifik pengguna berikut dengan berpegang KETAT pada isi dokumen PDF terlampir:`,
      `PERTANYAAN PENGGUNA: "${(params.question || "").trim().slice(0, 1000)}"`,
      "ATURAN: Jika informasi tidak ditemukan secara eksplisit di dalam dokumen, nyatakan dengan jujur bahwa dokumen tidak memuat informasi tersebut — JANGAN mengarang.",
    ].join("\n"),
  };

  return [
    "Kamu adalah Axioma Document Analyst, asisten bedah dokumen PDF yang presisi dan jujur.",
    docLabel,
    "",
    modeDirectives[params.mode],
    "",
    langRule,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 2. SIMULASI ROLEPLAY & RAPOR EVALUASI
// ---------------------------------------------------------------------------
export type RoleplayPersona = "hrd" | "dosen_sidang" | "pembeli_umkm" | "klien_kritis";

export const SUPPORTED_ROLEPLAY_PERSONAS: readonly RoleplayPersona[] = [
  "hrd",
  "dosen_sidang",
  "pembeli_umkm",
  "klien_kritis",
] as const;

export interface RoleplayHistoryItem {
  role: "user" | "model";
  text: string;
}

export interface RoleplayReportResult {
  overallScore: number;
  grade: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  actionableTips: string[];
}

const PERSONA_PROMPTS: Record<RoleplayPersona, string> = {
  hrd: "Kamu berperan sebagai HRD / Recruiter senior perusahaan di Indonesia. Gaya bicaramu profesional, tajam namun tetap ramah, suka menggali studi kasus nyata, konsistensi CV/pengalaman, kelemahan kandidat, motivasi kerja, dan ekspektasi gaji secara realistis.",
  dosen_sidang:
    "Kamu berperan sebagai Dosen Penguji sidang skripsi/tesis/proyek di universitas Indonesia. Gaya bicaramu kritis, akademis, runtut, suka menguji latar belakang masalah, ketajaman metodologi, validitas data, serta celah argumen mahasiswa secara realistis.",
  pembeli_umkm:
    "Kamu berperan sebagai calon pembeli/pelanggan UMKM Indonesia yang cermat dan hemat. Gaya bicaramu natural seperti chat/tatap muka sehari-hari, suka menawar harga, menanyakan kualitas/garansi/ongkir, serta membandingkan produk dengan kompetitor.",
  klien_kritis:
    "Kamu berperan sebagai Klien bisnis / Pengambil Keputusan yang kritis dan berorientasi hasil. Gaya bicaramu lugas, fokus pada ROI, kejelasan timeline/tenggat waktu, risiko implementasi, serta transparansi biaya.",
};

export function resolveRoleplayPersona(raw: unknown): RoleplayPersona {
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if ((SUPPORTED_ROLEPLAY_PERSONAS as readonly string[]).includes(normalized)) {
      return normalized as RoleplayPersona;
    }
  }
  return "hrd";
}

export function sanitizeRoleplayHistory(raw: unknown): RoleplayHistoryItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => {
      const rawRole = String(item.role || "").toLowerCase();
      const role: "user" | "model" =
        rawRole === "model" || rawRole === "assistant" || rawRole === "ai" ? "model" : "user";
      const text = typeof item.text === "string" ? item.text.trim().slice(0, 1500) : "";
      return { role, text };
    })
    .filter((item) => Boolean(item.text))
    .slice(-16);
}

export function buildRoleplayTurnSystemInstruction(params: {
  persona: RoleplayPersona;
  scenario: string;
  language?: string;
}): string {
  const langRule = describeLanguage(params.language);
  return [
    "MODUS SIMULASI ROLEPLAY AXIOMA (IN-CHARACTER 100%).",
    PERSONA_PROMPTS[params.persona],
    "",
    `SKENARIO LATIHAN: ${params.scenario.trim().slice(0, 1000)}`,
    "",
    "ATURAN KETAT:",
    "1. JANGAN PERNAH keluar dari karakter atau menyebut dirimu AI.",
    "2. JANGAN memberi skor, nilai, atau evaluasi selama simulasi masih berlangsung.",
    "3. Tanggapi pernyataan terbaru pengguna secara realistis dan ajukan maksimal 1–2 pertanyaan lanjutan yang menantang & relevan agar percakapan terasa hidup (maksimal 2–4 kalimat singkat).",
    `4. ${langRule}`,
  ].join("\n");
}

export function buildRoleplayReportPrompt(params: {
  persona: string;
  scenario: string;
  history: RoleplayHistoryItem[];
  language?: string;
}): string {
  const langRule = describeLanguage(params.language);
  const transcript = params.history
    .map((turn) => `${turn.role === "user" ? "Peserta" : "Lawan Roleplay"}: ${turn.text}`)
    .join("\n");

  return [
    "Kamu adalah Coach Komunikasi & Evaluator Profesional di Axioma.",
    "Evaluasi performa 'Peserta' berdasarkan transkrip simulasi roleplay berikut secara objektif, jujur, konstruktif, dan spesifik.",
    "",
    `PERSONA LAWAN: ${params.persona}`,
    `SKENARIO: ${params.scenario.trim().slice(0, 1000)}`,
    "",
    "TRANSKRIP SIMULASI:",
    transcript || "(Belum ada percakapan panjang)",
    "",
    "ATURAN KETAT:",
    "1. Kembalikan HANYA JSON valid tanpa markdown code fence dan tanpa teks tambahan.",
    "2. `overallScore` berupa angka bulat 0–100 yang realistis sesuai kualitas jawaban peserta.",
    "3. `grade` mengikuti skor (misal A, A-, B+, B, C+, C, D).",
    "4. `strengths`, `weaknesses`, dan `actionableTips` masing-masing berisi 2–3 poin konkret yang merujuk pada isi percakapan.",
    `5. ${langRule}`,
    "",
    "FORMAT JSON WAJIB:",
    "{",
    '  "overallScore": 82,',
    '  "grade": "B+",',
    '  "summary": "Ringkasan 2 kalimat performa keseluruhan",',
    '  "strengths": ["Kelebihan konkret 1", "Kelebihan konkret 2"],',
    '  "weaknesses": ["Celah/kelemahan konkret 1", "Celah/kelemahan konkret 2"],',
    '  "actionableTips": ["Saran perbaikan langsung untuk latihan berikutnya 1", "Saran 2"]',
    "}",
  ].join("\n");
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
    // Fallback below
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

function computeGradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B+";
  if (score >= 74) return "B";
  if (score >= 68) return "B-";
  if (score >= 60) return "C+";
  if (score >= 50) return "C";
  return "D";
}

function cleanStringList(raw: unknown, maxItems = 4, maxLen = 280): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
    .map((v) => v.trim().slice(0, maxLen))
    .slice(0, maxItems);
}

export function parseRoleplayReportJson(rawText: string): RoleplayReportResult {
  const parsed = safeExtractJsonObject(rawText);
  if (!parsed) {
    return {
      overallScore: 75,
      grade: "B",
      summary: "Sesi simulasi selesai dievaluasi. Terus latih kejelasan argumen dan contoh konkret.",
      strengths: ["Responsif mengikuti alur simulasi"],
      weaknesses: ["Perlu lebih banyak data/contoh spesifik untuk memperkuat argumen"],
      actionableTips: ["Siapkan struktur jawaban 3 poin (inti, bukti, kesimpulan) di latihan berikutnya"],
    };
  }

  const rawScore = Number(parsed.overallScore);
  const overallScore = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(100, Math.round(rawScore)))
    : 75;
  const grade =
    typeof parsed.grade === "string" && parsed.grade.trim()
      ? parsed.grade.trim().slice(0, 6)
      : computeGradeFromScore(overallScore);
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 500)
      : "Sesi simulasi selesai dievaluasi.";

  return {
    overallScore,
    grade,
    summary,
    strengths: cleanStringList(parsed.strengths, 4, 280),
    weaknesses: cleanStringList(parsed.weaknesses, 4, 280),
    actionableTips: cleanStringList(parsed.actionableTips, 4, 280),
  };
}
