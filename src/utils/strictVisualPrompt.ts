import { GoogleGenerativeAI } from "@google/generative-ai";
import { callGeminiWithFallback, getModelChain } from "../geminiModels";
import {
  getFastGeminiModel,
  isFallbackProviderConfigured,
  callOpenAiCompatibleFallback,
} from "../services/modelRouter";

let cachedGenAI: GoogleGenerativeAI | null = null;
let cachedGeminiKey = "";

function getGeminiApiKey(): string {
  return (process.env.GEMINI_API_KEY || "").trim();
}

function getGenAI(): GoogleGenerativeAI | null {
  const key = getGeminiApiKey();
  if (!key) return null;
  if (!cachedGenAI || cachedGeminiKey !== key) {
    cachedGeminiKey = key;
    cachedGenAI = new GoogleGenerativeAI(key);
  }
  return cachedGenAI;
}

/**
 * Resolves the fast engine model via Model Router (`ENGINE_FAST` env override -> `getFastGeminiModel()`).
 */
function resolveFastEngineChain(): string[] {
  const fastModel = (process.env.ENGINE_FAST || "").trim() || getFastGeminiModel();
  const baseChain = getModelChain();
  return [fastModel, ...baseChain.filter((m) => m !== fastModel)];
}

/**
 * Removes Indonesian/English conversational command prefixes and storyboard labels
 * while keeping 100% of the visual scene details intact.
 */
export function stripVisualCommandPrefix(rawMessage: string): string {
  let cleaned = (rawMessage || "").trim();
  cleaned = cleaned.replace(/^\[mode:\s*(gambar|image|foto|visual|video|animasi|klip)\]\s*:?/i, "");
  cleaned = cleaned.replace(
    /^(?:(?:halo|hai|hi|hei)\s*,?\s*)?(?:(?:tolong|coba|boleh|bisa(?:\s+tolong)?|please|can\s+you)\s+(?:kamu\s+)?)?(?:(?:aku|saya|gue|gua)\s+(?:mau|ingin|minta)\s+(?:kamu\s+)?)?(?:buatin|buatkan|buat|bikin|bikinin|generate|create|draw|render|ciptakan|hadirkan|lukiskan|lukis|gambarkan|gambarin|gambari|fotokan|desainkan|desainin|desain|rancangkan|animasikan|videokan)\s+(?:dong\s+|saya\s+|aku\s+|gue\s+|me\s+)?(?:sebuah\s+|satu\s+|a\s+|an\s+)?(?:animasi\s+video|video\s+animasi|klip\s+video|video\s+klip|foto|gambar|ilustrasi|lukisan|visual|image|photo|picture|artwork|wallpaper|video|animasi|klip)?\s*(?:of\s+|about\s+|bertema\s+|dengan\s+tema\s+|tentang\s+|dari\s+|berupa\s+|:\s*)?/i,
    ""
  );
  cleaned = cleaned.replace(
    /^(?:gambar|foto|ilustrasi|lukisan|video|animasi\s+video)\s*(?:bertema|dengan\s+tema|tentang|dari|:)\s*/i,
    ""
  );
  cleaned = cleaned
    .replace(/\b(characters|character|camera|visual|visual\s+prompt|video\s+prompt|scene|duration|prompt)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || rawMessage.trim();
}

const REAL_PHOTO_STYLE_REGEX =
  /\b(foto|potret|photo|photograph|portrait|realistis|realistic|asli|nyata|kamera)\b/i;

const NON_PHOTO_STYLE_REGEX =
  /\b(anime|manga|kartun|cartoon|3d|pixar|ilustrasi|illustration|lukisan|painting|cat\s+air|watercolor|vektor|vector|logo|poster|flat\s+design|minimalis\s+logo|sketsa|sketch|pixel\s*art|komik|comic|chibi|karikatur)\b/i;

function wantsNaturalPhotographyStyle(userMessage: string): boolean {
  return (
    REAL_PHOTO_STYLE_REGEX.test(userMessage) &&
    !NON_PHOTO_STYLE_REGEX.test(userMessage)
  );
}

function sanitizeTranslatedPrompt(rawOutput: string): string {
  return rawOutput
    .trim()
    .replace(/^```(?:text|txt|markdown|prompt)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(?:here\s+is\s+[^:]*:|visual\s+prompt\s*:|prompt\s*:)\s*/i, "")
    .replace(/\b(characters|character|camera|visual|scene|prompt)\s*:\s*/gi, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyPhotoStyleIfRequested(prompt: string, originalMessage: string): string {
  if (!wantsNaturalPhotographyStyle(originalMessage)) {
    return prompt;
  }
  const lower = prompt.toLowerCase();
  const hasPhotoCues =
    lower.includes("photorealistic") ||
    (lower.includes("natural lighting") && lower.includes("sharp focus"));
  if (hasPhotoCues) {
    return prompt;
  }
  const cleanBase = prompt.replace(/[.,;\s]+$/, "");
  return `${cleanBase}, photorealistic, natural lighting, sharp focus`;
}

function buildTranslatorSystemInstruction(type: "image" | "video"): string {
  const mediaLabel = type === "video" ? "video" : "image";
  const videoExtra =
    type === "video"
      ? "\n- For video: preserve all requested motion, actions, and camera movement literally; strictly NO spoken dialogue, captions, or subtitles."
      : "";

  return `You are a literal, ultra-precise visual prompt translator for Axioma's ${mediaLabel} generator.
Your ONLY job is to translate the user's request into ONE single, clean English visual prompt paragraph with 100% strict fidelity.

STRICT RULES:
1. Preserve 100% of EVERY detail requested by the user: main subject(s), exact count/number of objects or people, facial expression, pose/action, clothing/accessories, exact colors, text on signs/posters if requested, setting/location/background, camera angle/framing, and requested visual style (realistic photo, anime, 3D, minimalist, oil painting, etc.).
2. FORBIDDEN: Do NOT replace or change the subject, do NOT omit any user-specified detail, do NOT change colors/counts/gender, and do NOT invent or add random objects, characters, or elements that the user did not ask for.
3. Strip all conversational filler and command words (e.g. "tolong buatin foto", "aku mau", "bikinin dong", "please generate an image of") so ONLY the pure visual scene description remains.
4. If the user asks for a real photo or portrait ("foto", "potret", "realistis", "photo", "portrait") without specifying cartoon/anime/3D/illustration/logo, include natural photography cues: "photorealistic, natural lighting, sharp focus" without changing any scene content.${videoExtra}
5. Output ONLY ONE plain English paragraph (no quotes, no markdown, no bullet points, no prefixes like "Prompt:", "Scene:", or "Characters:").`;
}

/**
 * Translates any Indonesian or English user request into a literal, high-precision
 * English visual prompt paragraph using the fast engine (`ENGINE_FAST`) via Model Router,
 * guaranteeing strict prompt adherence without altering subjects or adding unwanted details.
 */
export async function buildStrictVisualPrompt(
  userMessage: string,
  type: "image" | "video"
): Promise<string> {
  const rawInput = (userMessage || "").trim();
  const fallbackCleaned = stripVisualCommandPrefix(rawInput);

  if (!rawInput) {
    return "";
  }

  const systemInstruction = buildTranslatorSystemInstruction(type);
  const aiClient = getGenAI();

  if (aiClient) {
    try {
      const fastChain = resolveFastEngineChain();
      const { result } = await callGeminiWithFallback(
        async (modelName, signal) => {
          const model = aiClient.getGenerativeModel({
            model: modelName,
            systemInstruction,
            generationConfig: {
              temperature: 0.15,
              maxOutputTokens: 256,
            },
          });

          const response = await model.generateContent(
            {
              contents: [{ role: "user", parts: [{ text: rawInput }] }],
            },
            { signal }
          );

          return sanitizeTranslatedPrompt(response.response.text() || "");
        },
        {
          customChain: fastChain,
          purpose: `strict-visual-prompt-${type}`,
          timeoutMs: 8_000,
        }
      );

      if (result && result.length >= 6) {
        return applyPhotoStyleIfRequested(result, rawInput);
      }
    } catch (err: any) {
      console.warn(
        `[strictVisualPrompt] Fast Gemini translation failed (${type}), checking fallback:`,
        err?.message || err
      );
    }
  }

  if (isFallbackProviderConfigured()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const fb = await callOpenAiCompatibleFallback({
        systemInstruction,
        userPrompt: rawInput,
        temperature: 0.15,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const cleanedFb = sanitizeTranslatedPrompt(fb.text || "");
      if (cleanedFb && cleanedFb.length >= 6) {
        return applyPhotoStyleIfRequested(cleanedFb, rawInput);
      }
    } catch (fbErr: any) {
      console.warn(
        `[strictVisualPrompt] Fallback provider failed (${type}):`,
        fbErr?.message || fbErr
      );
    }
  }

  return applyPhotoStyleIfRequested(fallbackCleaned, rawInput);
}
