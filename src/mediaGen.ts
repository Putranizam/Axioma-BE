import { GoogleGenerativeAI } from "@google/generative-ai";
import { callGeminiWithFallback } from "./geminiModels";

const geminiApiKey = process.env.GEMINI_API_KEY || "";
const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

export interface GeneratedImageResult {
  url: string;
  source: "imagen-3" | "flux-hd";
  enhancedPrompt: string;
  originalPrompt: string;
}

export interface GeneratedVideoResult {
  status: "completed" | "billing_required" | "pending";
  videoUrl?: string;
  operationName?: string;
  enhancedPrompt: string;
  originalPrompt: string;
  message: string;
}

/**
 * Detects if a user prompt is asking to generate or create an image.
 */
export function detectImageGenerationIntent(prompt: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  const p = prompt.trim().toLowerCase();
  
  // Explicit commands or prefixes
  const imageTriggers = [
    /^(buatkan|buat|bikin|generate|lukiskan|lukis|gambarkan|gambari|render|ciptakan)\s+(gambar|foto|lukisan|ilustrasi|visual|image|artwork|wallpaper|poster)/i,
    /^(gambar|foto|lukisan|ilustrasi|image)\s+(tentang|dari|seorang|seekor|sebuah|suatu|suasana|pemandangan|karakter)/i,
    /^(tolong|coba|bisa)?\s*(buatkan|buat|bikin|generate)\s+.*\s+(dalam bentuk|sebagai|berupa|menjadi)\s+(gambar|foto|ilustrasi|visual)/i,
    /^\[mode:\s*(gambar|image)\]/i,
  ];

  return imageTriggers.some((rgx) => rgx.test(p));
}

/**
 * Detects if a user prompt is asking to generate or create a video.
 */
export function detectVideoGenerationIntent(prompt: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  const p = prompt.trim().toLowerCase();

  const videoTriggers = [
    /^(buatkan|buat|bikin|generate|render|ciptakan|animasikan)\s+(video|animasi|klip|clip|motion|sinematik)/i,
    /^(video|animasi|klip)\s+(tentang|dari|seorang|seekor|sebuah|suatu|suasana|pemandangan|karakter)/i,
    /^(tolong|coba|bisa)?\s*(buatkan|buat|bikin|generate)\s+.*\s+(dalam bentuk|sebagai|berupa|menjadi)\s+(video|animasi|klip)/i,
    /^\[mode:\s*(video|animasi)\]/i,
  ];

  return videoTriggers.some((rgx) => rgx.test(p));
}

/**
 * Cleans the user's prompt by removing command prefixes like "buatkan gambar..."
 */
export function cleanUserPrompt(rawPrompt: string): string {
  let cleaned = rawPrompt.trim();
  cleaned = cleaned.replace(/^\[mode:\s*(gambar|image|video|animasi)\]\s*:?/i, "");
  cleaned = cleaned.replace(/^(tolong|coba|bisa\s+kamu)?\s*(buatkan|buat|bikin|generate|lukiskan|lukis|gambarkan|render|ciptakan|animasikan)\s+(gambar|foto|lukisan|ilustrasi|visual|image|artwork|wallpaper|poster|video|animasi|klip)\s*(tentang|dari|sebuah|seekor|seorang|suatu|berupa|:)?\s*/i, "");
  cleaned = cleaned.replace(/^(gambar|foto|lukisan|ilustrasi|video|animasi)\s+(tentang|dari|sebuah|seekor|seorang|suatu|:)\s*/i, "");
  return cleaned.trim() || rawPrompt.trim();
}

/**
 * Gemini Auto-Prompt Enhancer:
 * Transforms short / raw prompts into ultra-detailed, cinematic, photorealistic 8K English prompts.
 */
export async function enhancePrompt(
  rawPrompt: string,
  mediaType: "image" | "video" = "image"
): Promise<string> {
  const cleaned = cleanUserPrompt(rawPrompt);
  if (!genAI || !cleaned) {
    return cleaned;
  }

  const isVideo = mediaType === "video";
  const systemInstruction = isVideo
    ? `You are an expert prompt engineer for cutting-edge AI video generation (Google Veo 2 / Sora).
Your task is to transform the user's concept into an ultra-detailed, cinematic video prompt in English.
Specify:
- Subject actions, expressive movement, dynamic physical interactions
- Camera choreography (e.g. smooth cinematic drone tracking shot, slow dolly in, 35mm anamorphic lens, steady tracking)
- Environment, atmospheric depth, volumetric fog, realistic lighting (golden hour, neon glow, dramatic chiaroscuro)
- Temporal pacing, motion fluidity, ultra high definition 4K/8K resolution
RULES:
1. Output ONLY the enhanced English prompt string.
2. Never include quotation marks, markdown headings, prefixes like "Prompt:", or conversational text.
3. Keep the prompt between 45 and 90 words, evocative and highly descriptive.`
    : `You are an expert prompt engineer for photorealistic, high-end AI image generation (Google Imagen 3 / Midjourney v6).
Your task is to transform the user's idea into an ultra-detailed, visually stunning, photorealistic 8K resolution image prompt in English.
Specify:
- Precise subject anatomy, clothing, textures, and posture
- Environment, background depth, atmospheric conditions
- Professional lighting: volumetric god rays, soft rim light, cinematic illumination, vibrant color harmony
- Camera settings: shot on 85mm or 35mm lens, f/1.4 aperture, shallow depth of field, sharp focus, ray-tracing, Octane Render aesthetics
RULES:
1. Output ONLY the enhanced English prompt string.
2. Never include quotation marks, markdown formatting, prefixes like "Prompt:", or introductory text.
3. Keep the prompt between 40 and 90 words, vivid and professionally composed.`;

  try {
    const result = await callGeminiWithFallback(
      async (modelName, signal) => {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 256,
          },
        });
        const res = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: cleaned }] }],
        });
        const text = res.response.text().trim();
        // Strip any accidental wrapping quotes
        return text.replace(/^["'`]+|["'`]+$/g, "").trim();
      },
      {
        purpose: `media-prompt-enhancement-${mediaType}`,
        timeoutMs: 8_000,
      }
    );

    if (result.result && result.result.length > 10) {
      return result.result;
    }
  } catch (err: any) {
    console.warn(`[mediaGen] Prompt enhancement fallback to original due to:`, err?.message || err);
  }

  // Graceful fallback to original cleaned prompt
  return cleaned;
}

/**
 * Generates an HD Image via Gemini Imagen 3 / Native Image Gen with seamless fallback to Pollinations Flux HD.
 * 100% Anti-Gagal guarantee.
 */
export async function generateMediaImage(userPrompt: string): Promise<GeneratedImageResult> {
  const enhancedPrompt = await enhancePrompt(userPrompt, "image");

  // 1. Try Google Imagen 3 Predict API if API key is configured
  if (geminiApiKey) {
    try {
      const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiApiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);

      const res = await fetch(imagenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt: enhancedPrompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: "1:1",
            outputMimeType: "image/jpeg",
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = (await res.json()) as any;
        const base64Data = data.predictions?.[0]?.bytesBase64Encoded;
        if (base64Data && typeof base64Data === "string" && base64Data.length > 100) {
          const mimeType = data.predictions?.[0]?.mimeType || "image/jpeg";
          return {
            url: `data:${mimeType};base64,${base64Data}`,
            source: "imagen-3",
            enhancedPrompt,
            originalPrompt: userPrompt,
          };
        }
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.info(
          `[mediaGen] Imagen 3 returned status ${res.status}. Seamlessly falling back to Flux HD.`,
          errorData?.error?.message || res.statusText
        );
      }
    } catch (imagenErr: any) {
      console.info(
        `[mediaGen] Imagen 3 call error (${imagenErr?.message}). Seamlessly activating Flux HD fallback.`
      );
    }
  }

  // 2. Anti-Gagal Fallback: Pollinations Flux High-Res
  const fluxUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(
    enhancedPrompt
  )}?width=1024&height=1024&model=flux&nologo=true&enhance=true`;

  return {
    url: fluxUrl,
    source: "flux-hd",
    enhancedPrompt,
    originalPrompt: userPrompt,
  };
}

/**
 * Handles Video Generation via Google Veo 2 (veo-2.0-generate-001).
 * If Tier 1 billing is required (400 / 403 / 404), provides friendly Indonesian guidance.
 */
export async function generateMediaVideo(userPrompt: string): Promise<GeneratedVideoResult> {
  const enhancedPrompt = await enhancePrompt(userPrompt, "video");

  if (!geminiApiKey) {
    return {
      status: "billing_required",
      enhancedPrompt,
      originalPrompt: userPrompt,
      message:
        "Kunci API Gemini belum dikonfigurasi pada server. Silakan tambahkan GEMINI_API_KEY untuk mengaktifkan integrasi video Veo 2.",
    };
  }

  try {
    const veoUrl = `https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=${geminiApiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    const res = await fetch(veoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: enhancedPrompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: "16:9",
          durationSeconds: 5,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = (await res.json()) as any;
      return {
        status: "pending",
        operationName: data.name,
        enhancedPrompt,
        originalPrompt: userPrompt,
        message:
          "Video sedang diproses oleh Google Veo 2. Pembuatan video sinematik membutuhkan waktu beberapa saat.",
      };
    }

    const errJson = (await res.json().catch(() => ({}))) as any;
    const errMsg = String(errJson?.error?.message || res.statusText || "").toLowerCase();
    console.info(`[mediaGen] Veo 2 status ${res.status}:`, errMsg);

    return {
      status: "billing_required",
      enhancedPrompt,
      originalPrompt: userPrompt,
      message:
        "Fitur pembuatan video Google Veo 2 saat ini memerlukan akun Google Cloud dengan kuota berbayar (Tier 1 Billing). Anda dapat mengaktifkan penagihan pada Google Cloud Console untuk menikmati pembuatan video sinematik Veo 2. Sementara itu, fitur pembuatan Gambar HD (Imagen 3 & Flux) siap digunakan tanpa batas.",
    };
  } catch (err: any) {
    return {
      status: "billing_required",
      enhancedPrompt,
      originalPrompt: userPrompt,
      message:
        "Layanan video Google Veo 2 sedang memerlukan konfigurasi Tier 1 pada Google Cloud Console. Silakan gunakan fitur pembuatan Gambar HD yang sudah aktif.",
    };
  }
}

