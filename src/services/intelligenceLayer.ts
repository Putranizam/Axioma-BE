import {
  buildSystemInstruction,
  LanguageCode,
  ToneStyle,
  resolveLanguageCode,
  resolveToneStyle,
} from "../utils/promptBuilder";

export type AnswerStyle =
  | "ringkas"
  | "detail"
  | "profesional"
  | "akademik"
  | "santai";

export type ThinkingMode = "quick" | "deep" | "critical";

export type SocialTarget =
  | "none"
  | "dosen"
  | "atasan"
  | "orang_tua"
  | "klien"
  | "teman";

export type DetectedIntent =
  | "learning"
  | "coding"
  | "analysis"
  | "writing"
  | "summarization"
  | "guidance"
  | "general";

export interface ConversationCheckpoint {
  summary?: string;
  goal?: string;
  progress?: string;
  decisions?: string[];
  blockers?: string[];
  nextStep?: string;
}

export interface CheckpointSummaryResult {
  summary: string;
  goal: string;
  progress: string;
  decisions: string[];
  blockers: string[];
  nextStep: string;
}

export interface WorkspaceContext {
  name: string;
  instructions: string;
}

export interface DecisionJournalEntry {
  decision: string;
  reason: string;
  date: string;
}

export interface DecisionExtractionResult {
  decision: string;
  reason: string;
  alternatives: string[];
  risks: string[];
}

export interface ContextControl {
  useProject?: boolean;
  useProfile?: boolean;
  useHistory?: boolean;
}

export interface ResolvedContextControl {
  useProject: boolean;
  useProfile: boolean;
  useHistory: boolean;
}

export const DEFAULT_ANSWER_STYLE: AnswerStyle = "santai";
export const DEFAULT_THINKING_MODE: ThinkingMode = "quick";
export const DEFAULT_SOCIAL_TARGET: SocialTarget = "none";

export const SUPPORTED_ANSWER_STYLES: readonly AnswerStyle[] = [
  "ringkas",
  "detail",
  "profesional",
  "akademik",
  "santai",
] as const;

export const SUPPORTED_THINKING_MODES: readonly ThinkingMode[] = [
  "quick",
  "deep",
  "critical",
] as const;

export const SUPPORTED_SOCIAL_TARGETS: readonly SocialTarget[] = [
  "none",
  "dosen",
  "atasan",
  "orang_tua",
  "klien",
  "teman",
] as const;

export function resolveSocialTarget(raw?: unknown): SocialTarget {
  if (typeof raw !== "string") {
    return DEFAULT_SOCIAL_TARGET;
  }
  const normalized = raw.trim().toLowerCase() as SocialTarget;
  if ((SUPPORTED_SOCIAL_TARGETS as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return DEFAULT_SOCIAL_TARGET;
}

export function resolveAnswerStyle(raw?: unknown): AnswerStyle {
  if (typeof raw !== "string") {
    return DEFAULT_ANSWER_STYLE;
  }
  const normalized = raw.trim().toLowerCase() as AnswerStyle;
  if ((SUPPORTED_ANSWER_STYLES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return DEFAULT_ANSWER_STYLE;
}

export function resolveThinkingMode(raw?: unknown): ThinkingMode {
  if (typeof raw !== "string") {
    return DEFAULT_THINKING_MODE;
  }
  const normalized = raw.trim().toLowerCase() as ThinkingMode;
  if ((SUPPORTED_THINKING_MODES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return DEFAULT_THINKING_MODE;
}

const STRONG_CODING_PATTERN =
  /```|\b(error|bug|debug|stack\s*trace|exception|refactor|syntax|kode|code|function|komponen|component|endpoint|cors|sql|regex)\b/i;

const TECH_CODING_PATTERN =
  /\b(react|next\.?js|typescript|javascript|python|api|npm|docker|git|backend|frontend|css|html|json|express|supabase|postgres)\b/i;

const SUMMARIZATION_PATTERN =
  /\b(ringkas|rangkum|rangkuman|ringkasan|poin\s+penting|intinya|tl;?dr|summarize|summary|persingkat|ikhtisar)\b/i;

const ANALYSIS_PATTERN =
  /\b(bandingkan|perbandingan|pro\s*(?:dan|&|\/)?\s*kontra|kelebihan|kekurangan|evaluasi|analisis|analisa|keputusan|trade-?off|risiko|dampak|strategi|compare|vs\.?|versus|layak\s+atau\s+tidak)\b/i;

const WRITING_PATTERN =
  /\b(buatkan|tulis|tuliskan|naskah|surat|email|caption|copywriting|artikel|esai|pidato|skrip|script|chat|balasan|pesan|draft|draf|puisi|cerita|slogan|bio|proposal)\b/i;

const GUIDANCE_PATTERN =
  /\b(cara\s+mulai|cara\s+memulai|langkah|tahapan|bingung|roadmap|panduan|tutorial|bagaimana\s+cara|gimana\s+cara|step\s*by\s*step|mulai\s+dari\s+mana|arahan|bimbing)\b/i;

const LEARNING_PATTERN =
  /\b(apa\s+itu|jelaskan|pengertian|definisi|konsep|mengapa|kenapa|bagaimana\s+kerja|ajarin|ajari|pelajari|bedanya|perbedaan\s+antara|explain|how\s+does|what\s+is)\b/i;

/**
 * Lightweight 0ms heuristic intent detector (no extra LLM call).
 */
export function detectIntent(message: string): DetectedIntent {
  const text = (message || "").trim();
  if (!text) return "general";

  if (STRONG_CODING_PATTERN.test(text)) return "coding";
  if (SUMMARIZATION_PATTERN.test(text)) return "summarization";
  if (ANALYSIS_PATTERN.test(text)) return "analysis";
  if (GUIDANCE_PATTERN.test(text)) return "guidance";
  if (TECH_CODING_PATTERN.test(text)) return "coding";
  if (WRITING_PATTERN.test(text)) return "writing";
  if (LEARNING_PATTERN.test(text)) return "learning";

  return "general";
}

export function shouldActivateSelfReview(
  thinkingMode: ThinkingMode,
  intent: DetectedIntent
): boolean {
  return (
    thinkingMode === "deep" ||
    thinkingMode === "critical" ||
    intent === "coding" ||
    intent === "analysis"
  );
}

const TASK_BREAKDOWN_PATTERN =
  /\b(pecah\s+(?:tugas|proyek|project|tujuan|target|pekerjaan)|task\s*breakdown|breakdown\s+(?:tugas|proyek|project|tujuan|target)|daftar\s+tugas|to-?do\s*list|checklist|rencana\s+aksi|action\s+plan)\b/i;

export function shouldActivateTaskBreakdown(
  message: string,
  explicitMode?: boolean
): boolean {
  if (explicitMode === true) return true;
  const text = (message || "").trim();
  if (!text) return false;
  return TASK_BREAKDOWN_PATTERN.test(text);
}

function cleanShortString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen).trim()}…` : trimmed;
}

function cleanStringList(value: unknown, maxItems = 6, maxLen = 220): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .map((item) => cleanShortString(item, maxLen))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function sanitizeCheckpoint(raw?: unknown): ConversationCheckpoint | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const checkpoint: ConversationCheckpoint = {
    summary: cleanShortString(obj.summary, 1000),
    goal: cleanShortString(obj.goal, 400),
    progress: cleanShortString(obj.progress, 500),
    decisions: cleanStringList(obj.decisions, 6, 220),
    blockers: cleanStringList(obj.blockers, 6, 220),
    nextStep: cleanShortString(obj.nextStep, 300),
  };

  return hasUsableCheckpoint(checkpoint) ? checkpoint : undefined;
}

export function hasUsableCheckpoint(checkpoint?: ConversationCheckpoint | null): boolean {
  if (!checkpoint) return false;
  return Boolean(
    checkpoint.summary?.trim() ||
      checkpoint.goal?.trim() ||
      checkpoint.progress?.trim() ||
      checkpoint.nextStep?.trim() ||
      (checkpoint.decisions && checkpoint.decisions.length > 0) ||
      (checkpoint.blockers && checkpoint.blockers.length > 0)
  );
}

export function sanitizeWorkspaceContext(raw?: unknown): WorkspaceContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const name = cleanShortString(obj.name, 120);
  const instructions = cleanShortString(obj.instructions, 1500);
  if (!name && !instructions) return undefined;
  return {
    name: name || "Proyek Aktif",
    instructions: instructions || "",
  };
}

export function sanitizeDecisionHistory(raw?: unknown): DecisionJournalEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      decision: cleanShortString(item.decision, 300) || "",
      reason: cleanShortString(item.reason, 300) || "",
      date: cleanShortString(item.date, 40) || "",
    }))
    .filter((item) => Boolean(item.decision))
    .slice(-5);
}

export function sanitizeUserProfile(raw?: unknown): string | undefined {
  return cleanShortString(raw, 500);
}

export function sanitizeRequirementLock(raw?: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => cleanShortString(item, 240))
    .filter((item): item is string => Boolean(item))
    .slice(0, 5);
}

export function sanitizeContextControl(raw?: unknown): ResolvedContextControl {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      useProject: true,
      useProfile: true,
      useHistory: true,
    };
  }
  const obj = raw as Record<string, unknown>;
  return {
    useProject: obj.useProject !== false,
    useProfile: obj.useProfile !== false,
    useHistory: obj.useHistory !== false,
  };
}

const INTENT_STRATEGIES: Record<DetectedIntent, string> = {
  coding:
    "Berikan kode bersih dan siap pakai, jelaskan langkah dengan jelas, hindari basa-basi.",
  analysis:
    "Sajikan sudut pandang objektif, uraikan peluang vs risiko atau celah penting, lalu tutup dengan kesimpulan yang tegas.",
  guidance:
    "Pecah jawaban menjadi langkah-langkah terurut yang konkret dan mudah langsung dieksekusi.",
  writing:
    "Hasilkan tulisan yang natural, sesuai konteks audiens, dan siap langsung digunakan tanpa pengantar bertele-tele.",
  summarization:
    "Saring inti informasi secara akurat dalam poin-poin terstruktur tanpa menghilangkan fakta kunci.",
  learning:
    "Jelaskan konsep secara runtut dari inti ke contoh sederhana agar mudah dipahami.",
  general:
    "Jawab secara langsung, relevan, dan tepat sasaran sesuai konteks pertanyaan pengguna.",
};

const ANSWER_STYLE_INSTRUCTIONS: Record<AnswerStyle, string> = {
  ringkas: "Padat, langsung ke inti, gunakan bullet bila perlu.",
  detail: "Menyeluruh dengan penjelasan lengkap dan contoh konkret.",
  profesional: "Terstruktur, lugas, dan siap pakai untuk kebutuhan kerja.",
  akademik: "Objektif, sistematis, dan menggunakan bahasa baku.",
  santai: "Luwes, hangat, dan mudah dicerna.",
};

const THINKING_MODE_INSTRUCTIONS: Record<ThinkingMode, string> = {
  quick: "Langsung jawab secara efisien tanpa berputar-putar.",
  deep: "Lakukan analisis mendalam, terstruktur, dan pertimbangkan faktor-faktor penting.",
  critical:
    "Bertindak kritis: uji asumsi pengguna, soroti celah atau risiko tersembunyi, dan hindari asal setuju.",
};

const KNOWLEDGE_GAP_INSTRUCTION =
  "Jika informasi penting dari pengguna belum lengkap sehingga berisiko salah asumsi, tetap berikan jawaban awal yang berguna lalu ajukan MAKSIMAL 1 pertanyaan klarifikasi yang spesifik.";

const SELF_REVIEW_INSTRUCTION =
  "Sebelum menulis jawaban akhir, pastikan seluruh syarat pertanyaan terpenuhi, tidak kontradiktif dengan konteks berjalan, dan tidak ada langkah/kode yang terpotong.";

const ANSWER_CONFIDENCE_INSTRUCTION =
  "Bedakan secara natural antara fakta/informasi yang jelas, kesimpulan dari konteks, dan perkiraan/asumsi. Jika ada hal yang belum pasti atau data tidak tersedia, nyatakan dengan jujur tanpa mengarang dan JANGAN gunakan angka persentase keyakinan palsu.";

const SOCIAL_TARGET_INSTRUCTIONS: Record<Exclude<SocialTarget, "none">, string> = {
  dosen:
    "Target lawan bicara: Dosen. Gunakan bahasa yang sopan, akademis, ringkas, dan sertakan salam/perkenalan sopan tanpa bertele-tele.",
  atasan:
    "Target lawan bicara: Atasan/Pimpinan. Gunakan bahasa yang profesional, lugas, menghormati hierarki, dan fokus pada kejelasan atau solusi.",
  orang_tua:
    "Target lawan bicara: Orang Tua/Keluarga lebih tua. Gunakan bahasa yang hangat, sangat santun, dan penuh hormat (jika Bahasa Jawa dipilih, gunakan Krama Alus yang natural; jika Bahasa Sunda dipilih, gunakan basa lemes).",
  klien:
    "Target lawan bicara: Klien/Mitra Bisnis. Gunakan bahasa yang ramah, persuasif, profesional, dan membangun kepercayaan.",
  teman:
    "Target lawan bicara: Teman. Gunakan bahasa yang santai, akrab, natural, dan tidak kaku.",
};

const TASK_BREAKDOWN_INSTRUCTION =
  "Pecah tujuan atau proyek pengguna menjadi daftar langkah kecil berurutan menggunakan format checklist Markdown (`- [ ] Langkah 1: ...`) maksimal 5-7 langkah paling berdampak. Setiap langkah harus konkret, bisa langsung dikerjakan, dan disertai estimasi fokus/prioritas singkat tanpa basa-basi panjang.";

const FOLLOW_UP_INSTRUCTION =
  "Untuk jawaban yang kompleks atau multi-langkah, akhiri dengan 1 saran langkah berikutnya yang konkret (singkat, 1 kalimat, tidak memaksa).";

const ADAPTIVE_DEPTH_INSTRUCTION =
  "Sesuaikan kedalaman jawaban otomatis berdasarkan kompleksitas pertanyaan: jawab singkat dan langsung ke inti untuk pertanyaan sederhana, atau jelaskan bertahap untuk masalah kompleks.";

const REALITY_CHECK_INSTRUCTION =
  "Saat menjawab topik berbasis analisis, prediksi, atau data tak pasti, bedakan dengan jujur mana fakta pasti, mana asumsi, dan mana yang perlu diverifikasi pengguna — jangan mengarang kepastian.";

const BUREAUCRACY_LEGAL_INSTRUCTION =
  "Jika pengguna menempel teks kontrak, syarat & ketentuan, atau surat edaran resmi, otomatis rangkum dalam bahasa sehari-hari dengan poin jelas: **Hak**, **Kewajiban**, dan **Poin yang Perlu Diwaspadai**.";

const REGIONAL_NUANCE_INSTRUCTION =
  "Jika pengguna menanyakan istilah atau bahasa daerah (Jawa, Sunda, Betawi, Minang, dll.), otomatis jelaskan tingkat kesopanan serta situasi sosial yang tepat untuk menggunakannya.";

const LIVE_PREVIEW_INSTRUCTION =
  "Jika pengguna meminta dibuatkan game, aplikasi web mini, kalkulator interaktif, simulasi, visualisasi, atau prototipe UI, WAJIB tuliskan seluruh kode dalam SATU blok kode ```html yang mandiri (self-contained, diawali `<!DOCTYPE html>`, seluruh CSS di dalam `<style>` dan JavaScript di dalam `<script>` tanpa ketergantungan file eksternal lokal). Pastikan tampilan rapi dan responsif di desktop maupun mobile; jika berupa game, sertakan tombol kontrol sentuh (touch) di layar agar dapat dimainkan di HP selain keyboard.";

export interface IntelligenceInstructionParams {
  message: string;
  language?: LanguageCode | string;
  tone?: ToneStyle | string;
  answerStyle?: AnswerStyle | string;
  thinkingMode?: ThinkingMode | string;
  detectedIntent?: DetectedIntent;
  contextSummary?: string;
  checkpoint?: ConversationCheckpoint;
  contextCorrection?: string;
  socialTarget?: SocialTarget | string;
  taskBreakdownMode?: boolean;
  workspaceContext?: WorkspaceContext;
  decisionHistory?: DecisionJournalEntry[];
  userProfile?: string;
  contextControl?: ContextControl;
  requirementLock?: string[];
}

/**
 * Composes a single unified, token-efficient systemInstruction combining:
 * - Axioma identity + strict Auto-Language Mirroring & tone (promptBuilder)
 * - Smart Response Strategy (from DetectedIntent)
 * - Answer Style & Thinking Mode
 * - Context & Checkpoint Injection (when provided)
 * - Context Correction with top priority (when provided)
 * - Social Calibration & Cultural Rewriter (when socialTarget !== 'none')
 * - Task Breakdown Mode (when taskBreakdownMode is active)
 * - Selective Self-Review (deep/critical or coding/analysis)
 * - Answer Confidence & Knowledge Gap Detection & Follow-Up Intelligence
 */
export function buildIntelligenceInstruction(
  params: IntelligenceInstructionParams
): string {
  // Always default safely when `language` is omitted or `"auto"`; enforce Auto-Language Mirroring
  const _ignoredManualLanguage = resolveLanguageCode(params.language);
  void _ignoredManualLanguage;
  const safeTone = resolveToneStyle(params.tone);
  const safeAnswerStyle = resolveAnswerStyle(params.answerStyle);
  const safeThinkingMode = resolveThinkingMode(params.thinkingMode);
  const safeSocialTarget = resolveSocialTarget(params.socialTarget);
  const taskBreakdownActive = shouldActivateTaskBreakdown(
    params.message,
    params.taskBreakdownMode
  );
  const intent = params.detectedIntent ?? detectIntent(params.message);
  const cleanSummary = cleanShortString(params.contextSummary, 1500);
  const cleanCheckpoint = sanitizeCheckpoint(params.checkpoint);
  const cleanCorrection = cleanShortString(params.contextCorrection, 1000);
  const cleanWorkspace = sanitizeWorkspaceContext(params.workspaceContext);
  const cleanDecisions = sanitizeDecisionHistory(params.decisionHistory);
  const cleanUserProfile = sanitizeUserProfile(params.userProfile);
  const resolvedControl = sanitizeContextControl(params.contextControl);
  const cleanRequirementLock = sanitizeRequirementLock(params.requirementLock);
  const selfReviewActive = shouldActivateSelfReview(safeThinkingMode, intent);

  const baseInstruction = buildSystemInstruction("auto", safeTone);

  const blocks: string[] = [
    baseInstruction,
    `STRATEGI RESPONS (${intent.toUpperCase()}): ${INTENT_STRATEGIES[intent]}`,
    `GAYA JAWABAN (${safeAnswerStyle}): ${ANSWER_STYLE_INSTRUCTIONS[safeAnswerStyle]}`,
    `MODE BERPIKIR (${safeThinkingMode}): ${THINKING_MODE_INSTRUCTIONS[safeThinkingMode]}`,
  ];

  // 00. Axioma Requirement Lock (Strict pinned rules — highest operational constraint)
  if (cleanRequirementLock.length > 0) {
    const lockedLines = cleanRequirementLock
      .map((rule, idx) => `${idx + 1}. ${rule}`)
      .join("\n");
    blocks.push(
      `KETENTUAN TERKUNCI (WAJIB DIPATUHI):\n${lockedLines}\nJadikan seluruh ketentuan terkunci di atas sebagai acuan mutlak selama menjawab dan periksa kepatuhan penuh terhadap setiap poin sebelum menyusun jawaban akhir.`
    );
  }

  // 0. Axioma Adaptive Depth (automatic unless user explicitly forces 'ringkas' or 'detail')
  if (safeAnswerStyle !== "ringkas" && safeAnswerStyle !== "detail") {
    blocks.push(`KEDALAMAN ADAPTIF: ${ADAPTIVE_DEPTH_INSTRUCTION}`);
  }

  // 0a. Transparent Short User Profile ("Tentang Saya", only when contextControl.useProfile !== false)
  if (resolvedControl.useProfile && cleanUserProfile) {
    blocks.push(`PROFIL PENGGUNA: ${cleanUserProfile}`);
  }

  // 0b. Workspace / Project Space Context (only when contextControl.useProject !== false)
  if (resolvedControl.useProject && cleanWorkspace && cleanWorkspace.instructions) {
    blocks.push(
      `KONTEKS RUANG PROYEK (${cleanWorkspace.name}): ${cleanWorkspace.instructions} Pastikan seluruh jawaban di percakapan ini konsisten dengan aturan proyek tersebut.`
    );
  } else if (resolvedControl.useProject && cleanWorkspace && cleanWorkspace.name) {
    blocks.push(
      `KONTEKS RUANG PROYEK (${cleanWorkspace.name}): Pertahankan konsistensi konteks dan fokus untuk proyek "${cleanWorkspace.name}".`
    );
  }

  // 0c. Decision Journal Awareness & Contradiction Check (only when decisions exist & useHistory !== false)
  if (resolvedControl.useHistory && cleanDecisions.length > 0) {
    const decisionLines = cleanDecisions
      .map(
        (d, idx) =>
          `${idx + 1}. ${d.date ? `[${d.date}] ` : ""}${d.decision}${
            d.reason ? ` (Alasan: ${d.reason})` : ""
          }`
      )
      .join("\n");
    blocks.push(
      `CATATAN KEPUTUSAN SEBELUMNYA (Hormati keputusan yang sudah tercatat. Jika usulan baru bertentangan dengan keputusan sebelumnya, ingatkan pengguna secara singkat — Contradiction Check):\n${decisionLines}`
    );
  }

  // 1. Context & Checkpoint Injection (only when available & useHistory !== false)
  const contextLines: string[] = [];
  if (resolvedControl.useHistory) {
    const effectiveSummary = cleanSummary || cleanCheckpoint?.summary;
    if (effectiveSummary) {
      contextLines.push(`- Ringkasan: ${effectiveSummary}`);
    }
    if (cleanCheckpoint?.goal) {
      contextLines.push(`- Tujuan: ${cleanCheckpoint.goal}`);
    }
    if (cleanCheckpoint?.progress) {
      contextLines.push(`- Progres: ${cleanCheckpoint.progress}`);
    }
    if (cleanCheckpoint?.decisions && cleanCheckpoint.decisions.length > 0) {
      contextLines.push(`- Keputusan: ${cleanCheckpoint.decisions.join("; ")}`);
    }
    if (cleanCheckpoint?.blockers && cleanCheckpoint.blockers.length > 0) {
      contextLines.push(`- Kendala/Risiko: ${cleanCheckpoint.blockers.join("; ")}`);
    }
    if (cleanCheckpoint?.nextStep) {
      contextLines.push(`- Langkah Berikutnya: ${cleanCheckpoint.nextStep}`);
    }
  }

  if (contextLines.length > 0) {
    blocks.push(
      `KONTEKS BERJALAN (lanjutkan secara konsisten tanpa mengulang dari nol):\n${contextLines.join("\n")}`
    );
  }

  // 2. Context Correction (Highest Priority override when provided)
  if (cleanCorrection) {
    blocks.push(
      `KOREKSI KONTEKS PENGGUNA (WAJIB IKUTI & TIMPA ASUMSI SEBELUMNYA): ${cleanCorrection}`
    );
  }

  // 3. Social Calibration & Cultural Rewriter (only when socialTarget !== 'none')
  if (safeSocialTarget !== "none") {
    blocks.push(
      `KALIBRASI SOSIAL & CULTURAL REWRITER: ${SOCIAL_TARGET_INSTRUCTIONS[safeSocialTarget]} Susun ulang atau tuliskan pesan sesuai etika dan unggah-ungguh budaya Indonesia. Format keluaran wajib ringkas & siap pakai dengan tepat 3 variasi singkat berlabel jelas: 1) **Sangat Sopan / Halus**, 2) **Seimbang / Natural**, 3) **Singkat / Langsung ke Inti**. Akhiri dengan 1 baris catatan etika singkat hanya jika ada hal sensitif yang perlu diperhatikan.`
    );
  }

  // 4. Task Breakdown Mode (only when explicitly enabled or project breakdown detected)
  if (taskBreakdownActive) {
    blocks.push(`TASK BREAKDOWN: ${TASK_BREAKDOWN_INSTRUCTION}`);
  }

  // 5. Selective Self-Review
  if (selfReviewActive) {
    blocks.push(`SELF-REVIEW: ${SELF_REVIEW_INSTRUCTION}`);
  }

  // 6. Answer Confidence, Knowledge Gap Detection, Follow-Up & Stage 10B Built-in Intelligence
  blocks.push(`TRANSPARANSI KEYAKINAN: ${ANSWER_CONFIDENCE_INSTRUCTION}`);
  blocks.push(`REALITY CHECK: ${REALITY_CHECK_INSTRUCTION}`);
  blocks.push(`BIROKRASI & LEGAL RI: ${BUREAUCRACY_LEGAL_INSTRUCTION}`);
  blocks.push(`NUANSA & ETIKA DAERAH: ${REGIONAL_NUANCE_INSTRUCTION}`);
  blocks.push(`MODE LIVE PREVIEW / INTERAKTIF: ${LIVE_PREVIEW_INSTRUCTION}`);
  blocks.push(`DETEKSI KEKURANGAN INFO: ${KNOWLEDGE_GAP_INSTRUCTION}`);
  blocks.push(`TINDAK LANJUT: ${FOLLOW_UP_INSTRUCTION}`);

  return blocks.join("\n");
}

/**
 * Builds a compact prompt to generate a structured Conversation Checkpoint JSON
 * from the latest <= 12 messages.
 */
export function buildCheckpointPrompt(
  messages: Array<{ role: string; content: string }>
): string {
  const recent = messages.slice(-12);
  const transcript = recent
    .map((m) => {
      const speaker =
        m.role === "assistant" || m.role === "ai" || m.role === "model"
          ? "Axioma"
          : "Pengguna";
      const text = String(m.content || "").trim().slice(0, 1200);
      return `${speaker}: ${text}`;
    })
    .filter((line) => line.length > 10)
    .join("\n");

  return [
    "Ringkas percakapan berikut menjadi objek JSON valid (tanpa teks tambahan, tanpa markdown fence).",
    "Gunakan Bahasa Indonesia yang ringkas, faktual, dan langsung ke inti.",
    "Format JSON wajib persis seperti ini:",
    JSON.stringify(
      {
        summary: "Ringkasan padat 2-3 kalimat konteks percakapan saat ini",
        goal: "Tujuan utama pengguna",
        progress: "Progres yang sudah dicapai",
        decisions: ["Keputusan penting yang sudah diambil"],
        blockers: ["Kendala/risiko yang masih terbuka"],
        nextStep: "1 langkah konkret berikutnya",
      },
      null,
      2
    ),
    "",
    "PERCAKAPAN:",
    transcript,
  ].join("\n");
}

/**
 * Safely parses Gemini checkpoint JSON output, stripping markdown code fences
 * or surrounding prose so the checkpoint endpoint never crashes.
 */
export function parseCheckpointJson(rawText: string): CheckpointSummaryResult {
  const fallback: CheckpointSummaryResult = {
    summary: "",
    goal: "",
    progress: "",
    decisions: [],
    blockers: [],
    nextStep: "",
  };

  if (!rawText || typeof rawText !== "string") {
    return fallback;
  }

  // Strip ```json ... ``` or ``` ... ``` fences
  let cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Extract first JSON object block if wrapped by extra commentary
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      summary: cleanShortString(parsed.summary, 1000) || "",
      goal: cleanShortString(parsed.goal, 400) || "",
      progress: cleanShortString(parsed.progress, 500) || "",
      decisions: cleanStringList(parsed.decisions, 6, 220) || [],
      blockers: cleanStringList(parsed.blockers, 6, 220) || [],
      nextStep: cleanShortString(parsed.nextStep, 300) || "",
    };
  } catch {
    return {
      ...fallback,
      summary: cleanShortString(rawText.replace(/```(?:json)?/gi, ""), 600) || "",
    };
  }
}

/**
 * Builds a compact prompt to extract the latest key decision from <= 8 messages.
 */
export function buildDecisionExtractionPrompt(
  messages: Array<{ role: string; content: string }>
): string {
  const recent = messages.slice(-8);
  const transcript = recent
    .map((m) => {
      const speaker =
        m.role === "assistant" || m.role === "ai" || m.role === "model"
          ? "Axioma"
          : "Pengguna";
      const text = String(m.content || "").trim().slice(0, 1200);
      return `${speaker}: ${text}`;
    })
    .filter((line) => line.length > 10)
    .join("\n");

  return [
    "Ekstrak 1 keputusan penting terbaru dari diskusi berikut ke dalam objek JSON valid (tanpa teks tambahan, tanpa markdown fence).",
    "Gunakan Bahasa Indonesia yang ringkas, objektif, dan jelas.",
    "Format JSON wajib persis seperti ini:",
    JSON.stringify(
      {
        decision: "Keputusan utama yang diambil",
        reason: "Alasan singkat di balik keputusan tersebut",
        alternatives: ["Alternatif lain yang sempat dipertimbangkan"],
        risks: ["Risiko utama yang perlu diwaspadai"],
      },
      null,
      2
    ),
    "",
    "DISKUSI:",
    transcript,
  ].join("\n");
}

/**
 * Safely parses Gemini Decision Journal JSON output (strips markdown fences safely).
 */
export function parseDecisionJson(rawText: string): DecisionExtractionResult {
  const fallback: DecisionExtractionResult = {
    decision: "",
    reason: "",
    alternatives: [],
    risks: [],
  };

  if (!rawText || typeof rawText !== "string") {
    return fallback;
  }

  let cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      decision: cleanShortString(parsed.decision, 400) || "",
      reason: cleanShortString(parsed.reason, 500) || "",
      alternatives: cleanStringList(parsed.alternatives, 5, 220) || [],
      risks: cleanStringList(parsed.risks, 5, 220) || [],
    };
  } catch {
    return {
      ...fallback,
      decision: cleanShortString(rawText.replace(/```(?:json)?/gi, ""), 350) || "",
    };
  }
}

/**
 * Builds a concise prompt to refine a rough user draft into a clear, specific, ready-to-send prompt.
 */
export function buildPromptEnhancementPrompt(
  draft: string,
  language?: LanguageCode | string
): string {
  const safeLanguage = resolveLanguageCode(language);
  const langRule =
    safeLanguage === "auto"
      ? "Gunakan bahasa serta gaya/tingkat tutur yang sama persis dengan draf asli pengguna."
      : `Gunakan kode bahasa target: ${safeLanguage} (natural dan sesuai draf pengguna).`;

  return [
    "Kamu adalah editor prompt ahli untuk Axioma.",
    "Rapikan draf pertanyaan pengguna yang masih singkat atau acak menjadi 1 prompt yang jelas, spesifik, terstruktur, dan langsung siap dikirim ke asisten AI.",
    "ATURAN KETAT:",
    "1. JANGAN mengubah maksud asli pengguna dan JANGAN menambahkan asumsi fakta yang tidak ada di draf.",
    "2. JANGAN menjawab pertanyaan pengguna — cukup perbaiki perumusan pertanyaannya.",
    "3. JANGAN tambahkan kata pengantar, penjelasan, atau basa-basi.",
    `4. ${langRule}`,
    '5. Kembalikan HANYA JSON valid tanpa markdown fence dengan format tepat: { "enhancedPrompt": "..." }',
    "",
    "DRAF PENGGUNA:",
    draft.trim(),
  ].join("\n");
}

/**
 * Safely parses Gemini JSON output for Prompt Enhancement (never crashes).
 */
export function parseEnhancedPromptJson(
  rawText: string,
  fallbackDraft: string
): { enhancedPrompt: string } {
  const cleanFallback = fallbackDraft.trim();
  if (!rawText || typeof rawText !== "string") {
    return { enhancedPrompt: cleanFallback };
  }

  let cleaned = rawText
    .trim()
    .replace(/^```(?:json|JSON)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Record<
        string,
        unknown
      >;
      if (typeof parsed.enhancedPrompt === "string" && parsed.enhancedPrompt.trim()) {
        return { enhancedPrompt: parsed.enhancedPrompt.trim() };
      }
    } catch {
      // Fallback below
    }
  }

  // If Gemini returned plain text instead of JSON, use the cleaned text safely
  const plain = cleaned.replace(/^"|"$/g, "").trim();
  return { enhancedPrompt: plain || cleanFallback };
}
