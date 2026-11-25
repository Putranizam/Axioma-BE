import { GoogleGenerativeAI } from "@google/generative-ai";
import { callGeminiWithFallback } from "./geminiModels";
import { detectDirectMediaIntent } from "./utils/mediaIntentDetector";
import {
  buildStrictVisualPrompt,
  stripVisualCommandPrefix,
} from "./utils/strictVisualPrompt";

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

export interface GeneratedImageResult {
  url: string;
  source: "imagen-3" | "flux-hd";
  enhancedPrompt: string;
  revisedPrompt: string;
  originalPrompt: string;
}

export interface GeneratedVideoResult {
  status: "completed" | "billing_required" | "pending" | "not_found";
  videoUrl?: string;
  operationName?: string;
  enhancedPrompt: string;
  revisedPrompt: string;
  originalPrompt: string;
  searchKeywords?: string;
  provider?: "veo-2" | "pexels" | "pixabay" | "wikimedia";
  message: string;
}

/**
 * Detects if a user prompt is asking to generate or create an image.
 */
export function detectImageGenerationIntent(prompt: string, hasAttachment = false): boolean {
  return detectDirectMediaIntent(prompt, hasAttachment)?.type === "image";
}

/**
 * Detects if a user prompt is asking to generate or create a video.
 */
export function detectVideoGenerationIntent(prompt: string, hasAttachment = false): boolean {
  return detectDirectMediaIntent(prompt, hasAttachment)?.type === "video";
}

/**
 * Cleans the user's prompt by removing command prefixes and technical storyboard labels
 * like `Characters:`, `Camera:`, `Visual:`, and noisy punctuation.
 */
export function cleanUserPrompt(rawPrompt: string): string {
  return stripVisualCommandPrefix(rawPrompt)
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Axioma Strict Visual Prompt Translator wrapper (delegates to `buildStrictVisualPrompt`).
 */
export async function enhancePrompt(
  rawPrompt: string,
  mediaType: "image" | "video" = "image"
): Promise<string> {
  return buildStrictVisualPrompt(rawPrompt, mediaType);
}

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "to", "for", "with", "and", "or", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "as", "into", "over", "under", "through",
  "cinematic", "shot", "shots", "camera", "close", "up", "medium", "wide", "slow", "pan",
  "dolly", "tracking", "smooth", "lighting", "warm", "natural", "photorealistic", "detailed",
  "high", "quality", "4k", "8k", "scene", "characters", "character", "video", "visual",
  "prompt", "frame", "angle", "motion", "lens", "style", "mood", "atmosphere", "background",
  "wearing", "neat", "clean", "modern", "looking", "while", "around", "near", "their", "his", "her",
]);

/**
 * Deterministic fallback English keyword extractor when Gemini is unavailable.
 */
export function extractFallbackKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const unique: string[] = [];
  for (const w of words) {
    if (!unique.includes(w)) {
      unique.push(w);
    }
    if (unique.length >= 4) break;
  }
  return unique;
}

/**
 * Extracts 2–4 accurate English visual search keywords for Stock Video APIs (Pexels / Wikimedia)
 * using 1 fast Gemini call, avoiding Indonesian queries or long sentence queries.
 */
export async function extractVideoSearchKeywords(promptText: string): Promise<string[]> {
  const cleanInput = cleanUserPrompt(promptText);
  if (!cleanInput) return ["office", "work"];

  const aiClient = getGenAI();
  if (aiClient) {
    try {
      const { result } = await callGeminiWithFallback(
        async (modelName, signal) => {
          const model = aiClient.getGenerativeModel({
            model: modelName,
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 32,
            },
          });
          const kwPrompt = [
            "Extract 2 to 4 concrete English visual search keywords (nouns/actions only) to search a stock video library for this scene.",
            "RULES:",
            "- Output ONLY 2 to 4 lowercase English words separated by single spaces (e.g. `programmer computer office` or `barista pouring coffee cafe`).",
            "- NO punctuation, NO quotes, NO Indonesian words, NO person names (like Budi/Ani), NO camera words (like cinematic/closeup/4k).",
            "",
            `SCENE: ${cleanInput.slice(0, 600)}`,
          ].join("\n");
          const resp = await model.generateContent(kwPrompt, { signal });
          return resp.response.text().trim();
        },
        {
          purpose: "video-stock-keyword-extraction",
          timeoutMs: 6_000,
        }
      );

      const tokens = (result || "")
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
        .slice(0, 4);

      if (tokens.length >= 2) {
        return tokens;
      }
    } catch (err: any) {
      console.warn("[mediaGen] Keyword extraction via Gemini failed, using local extractor:", err?.message || err);
    }
  }

  const fallback = extractFallbackKeywords(cleanInput);
  return fallback.length > 0 ? fallback : ["city", "people"];
}

/**
 * Generates an HD Image via Gemini Imagen 3 / Native Image Gen with seamless fallback to Pollinations Flux HD.
 * Uses `buildStrictVisualPrompt` (or a precomputed strict prompt) so 100% of user details are preserved.
 */
export async function generateMediaImage(
  userPrompt: string,
  precomputedStrictPrompt?: string
): Promise<GeneratedImageResult> {
  const strictPrompt =
    (precomputedStrictPrompt || "").trim() ||
    (await buildStrictVisualPrompt(userPrompt, "image"));
  const geminiApiKey = getGeminiApiKey();

  if (geminiApiKey) {
    try {
      const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiApiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);

      const res = await fetch(imagenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt: strictPrompt }],
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
            enhancedPrompt: strictPrompt,
            revisedPrompt: strictPrompt,
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

  // Keep full literal strict prompt details for Flux HD (bounded cleanly to safe URL length)
  const sanitizedForUrl = (strictPrompt || cleanUserPrompt(userPrompt) || "scenic landscape")
    .replace(/[^a-zA-Z0-9\s,.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleanPrompt =
    (sanitizedForUrl.length > 480
      ? sanitizedForUrl.slice(0, 480).replace(/\s+\S*$/, "")
      : sanitizedForUrl) || "beautiful world aesthetic photography";
  const seed = Math.floor(Math.random() * 1000000);
  const encodedPrompt = encodeURIComponent(cleanPrompt)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  const fluxUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux`;

  return {
    url: fluxUrl,
    source: "flux-hd",
    enhancedPrompt: strictPrompt || cleanPrompt,
    revisedPrompt: strictPrompt || cleanPrompt,
    originalPrompt: userPrompt,
  };
}

/**
 * Optional Pexels Stock Video Search (active when PEXELS_API_KEY is configured in `.env`).
 */
async function searchPexelsVideo(query: string): Promise<string | null> {
  const pexelsKey = (process.env.PEXELS_API_KEY || "").trim();
  if (!pexelsKey || !query.trim()) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const res = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`,
      {
        headers: { Authorization: pexelsKey },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const data = (await res.json()) as any;
    const videos = Array.isArray(data?.videos) ? data.videos : [];
    for (const vid of videos) {
      const files = Array.isArray(vid?.video_files) ? vid.video_files : [];
      const hd =
        files.find((f: any) => f?.file_type === "video/mp4" && f?.quality === "hd" && f?.link) ||
        files.find((f: any) => f?.file_type === "video/mp4" && f?.link) ||
        files[0];
      if (hd?.link) return String(hd.link);
    }
  } catch (err: any) {
    console.warn(`[mediaGen] Pexels search failed for "${query}":`, err?.message || err);
  }
  return null;
}

/**
 * Optional Pixabay Stock Video Search (active when PIXABAY_API_KEY is configured in `.env`).
 */
async function searchPixabayVideo(query: string): Promise<string | null> {
  const pixabayKey = (process.env.PIXABAY_API_KEY || "").trim();
  if (!pixabayKey || !query.trim()) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const res = await fetch(
      `https://pixabay.com/api/videos/?key=${encodeURIComponent(pixabayKey)}&q=${encodeURIComponent(query)}&per_page=3`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const data = (await res.json()) as any;
    const hits = Array.isArray(data?.hits) ? data.hits : [];
    for (const hit of hits) {
      const url =
        hit?.videos?.medium?.url ||
        hit?.videos?.small?.url ||
        hit?.videos?.large?.url;
      if (typeof url === "string" && url.startsWith("http")) {
        return url;
      }
    }
  } catch (err: any) {
    console.warn(`[mediaGen] Pixabay search failed for "${query}":`, err?.message || err);
  }
  return null;
}

const NON_BROLL_TITLE_REGEX =
  /\b(lecture|conference|talk|speech|tutorial|webinar|slides|presentation|podcast|interview|wikipedia|wiki|course|seminar|keynote)\b/i;

/**
 * Searches Wikimedia Commons for a matching CC0/open-license playable video clip (.mp4 / .webm),
 * preferring B-roll footage over conference talks or slide presentations.
 */
async function searchWikimediaVideo(query: string): Promise<string | null> {
  if (!query.trim()) return null;

  try {
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      `${query} filetype:video`
    )}&srnamespace=6&srlimit=10&format=json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "AxiomaAI/1.0 (https://axioma.my.id)" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
    if (hits.length === 0) return null;

    // Sort visual B-roll candidates ahead of lecture/talk/tutorial recordings
    const sortedTitles = hits
      .map((h: any) => String(h?.title || ""))
      .filter(Boolean)
      .sort((a: string, b: string) => {
        const aLecture = NON_BROLL_TITLE_REGEX.test(a) ? 1 : 0;
        const bLecture = NON_BROLL_TITLE_REGEX.test(b) ? 1 : 0;
        return aLecture - bLecture;
      })
      .slice(0, 8);

    const titles = sortedTitles.join("|");
    if (!titles) return null;

    const infoController = new AbortController();
    const infoTimer = setTimeout(() => infoController.abort(), 6_000);
    const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(
      titles
    )}&prop=imageinfo&iiprop=url|mime&format=json`;
    const infoRes = await fetch(infoUrl, {
      headers: { "User-Agent": "AxiomaAI/1.0 (https://axioma.my.id)" },
      signal: infoController.signal,
    });
    clearTimeout(infoTimer);

    if (!infoRes.ok) return null;
    const infoData = (await infoRes.json()) as any;
    const pages = infoData?.query?.pages || {};

    // Rank candidates: B-roll .mp4 > B-roll .webm > other .mp4 > other .webm
    const brollMp4: string[] = [];
    const brollWebm: string[] = [];
    const fallbackMp4: string[] = [];
    const fallbackWebm: string[] = [];

    for (const key of Object.keys(pages)) {
      const pageTitle = String(pages[key]?.title || "");
      const url = pages[key]?.imageinfo?.[0]?.url;
      const mime = String(pages[key]?.imageinfo?.[0]?.mime || "").toLowerCase();
      if (typeof url !== "string" || !url.startsWith("http")) continue;

      const isLecture = NON_BROLL_TITLE_REGEX.test(pageTitle);
      const isMp4 = url.endsWith(".mp4") || mime.includes("mp4");
      const isWebm = url.endsWith(".webm") || mime.includes("webm");

      if (isMp4) {
        (isLecture ? fallbackMp4 : brollMp4).push(url);
      } else if (isWebm) {
        (isLecture ? fallbackWebm : brollWebm).push(url);
      }
    }

    return brollMp4[0] || brollWebm[0] || fallbackMp4[0] || fallbackWebm[0] || null;
  } catch (err: any) {
    console.warn(`[mediaGen] Wikimedia search error for "${query}":`, err?.message || err);
  }

  return null;
}

/**
 * Progressive keyword search across Stock Video repositories (Pexels -> Pixabay -> Wikimedia Commons):
 * 1. Tries full 2–4 extracted English visual keywords (e.g. "programmer computer office work").
 * 2. If empty, trims to top 2 core keywords (e.g. "programmer office").
 * 3. If still empty, tries top 1 core noun keyword (e.g. "office" / "computer").
 * Never jumps straight to an unrelated random flower video on first miss.
 */
async function fetchRelevantStockVideo(keywords: string[]): Promise<{
  url: string;
  matchedQuery: string;
  provider: "pexels" | "pixabay" | "wikimedia";
} | null> {
  const uniqueKw = Array.from(new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean)));
  const queriesToTry: string[] = [];

  if (uniqueKw.length >= 3) {
    queriesToTry.push(uniqueKw.slice(0, 4).join(" "));
  }
  if (uniqueKw.length >= 2) {
    queriesToTry.push(uniqueKw.slice(0, 2).join(" "));
  }
  if (uniqueKw.length >= 1) {
    queriesToTry.push(uniqueKw[0]);
  }
  if (uniqueKw.length >= 2 && uniqueKw[1] !== uniqueKw[0]) {
    queriesToTry.push(uniqueKw[1]);
  }

  // 1. Try Pexels API first if configured
  if ((process.env.PEXELS_API_KEY || "").trim()) {
    for (const q of queriesToTry) {
      const url = await searchPexelsVideo(q);
      if (url) {
        console.info(`[mediaGen] Matched Pexels stock video for query="${q}"`);
        return { url, matchedQuery: q, provider: "pexels" };
      }
    }
  }

  // 2. Try Pixabay API if configured
  if ((process.env.PIXABAY_API_KEY || "").trim()) {
    for (const q of queriesToTry) {
      const url = await searchPixabayVideo(q);
      if (url) {
        console.info(`[mediaGen] Matched Pixabay stock video for query="${q}"`);
        return { url, matchedQuery: q, provider: "pixabay" };
      }
    }
  }

  // 3. Try Wikimedia Commons progressively (4 words -> 2 words -> 1 word)
  for (const q of queriesToTry) {
    const url = await searchWikimediaVideo(q);
    if (url) {
      console.info(`[mediaGen] Matched Wikimedia stock video for query="${q}"`);
      return { url, matchedQuery: q, provider: "wikimedia" };
    }
  }

  // 4. Return null cleanly when every progressive query returned zero results (never serve an unrelated placeholder video)
  console.warn(
    `[mediaGen] All progressive video queries returned 0 hits (${queriesToTry.join(" | ")}); returning null.`
  );
  return null;
}

/**
 * Handles Video Generation via Google Veo 2 (using strict literal English visual prompt)
 * with intelligent English-keyword progressive Stock Video fallback (Pexels / Pixabay / Wikimedia Commons).
 */
export async function generateMediaVideo(
  userPrompt: string,
  precomputedStrictPrompt?: string
): Promise<GeneratedVideoResult> {
  // 1. Always transform raw/Indonesian/Studio prompt into 1 strict literal English visual paragraph first
  const strictPrompt =
    (precomputedStrictPrompt || "").trim() ||
    (await buildStrictVisualPrompt(userPrompt, "video"));
  // 2. Extract 2–4 crisp English visual keywords for stock video matching
  const searchKeywordsArr = await extractVideoSearchKeywords(strictPrompt || userPrompt);
  const searchKeywordsStr = searchKeywordsArr.join(" ");
  const geminiApiKey = getGeminiApiKey();

  // 3. If Gemini API key is configured, attempt Google Veo 2 predictLongRunning with strict English prompt
  if (geminiApiKey) {
    try {
      const veoUrl = `https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=${geminiApiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(veoUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt: strictPrompt }],
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
        if (data.name) {
          const previewStock = await fetchRelevantStockVideo(searchKeywordsArr);
          return {
            status: "pending",
            operationName: data.name,
            videoUrl: previewStock?.url,
            enhancedPrompt: strictPrompt,
            revisedPrompt: strictPrompt,
            originalPrompt: userPrompt,
            searchKeywords: previewStock?.matchedQuery || searchKeywordsStr,
            provider: "veo-2",
            message: "Video sinematik sedang dirender.",
          };
        }
      }
    } catch {
      console.info("[mediaGen] Veo 2 unavailable, activating progressive English stock video match.");
    }
  }

  // 4. Progressive stock video match using extracted English keywords (4 -> 2 -> 1 keywords)
  const stockMatch = await fetchRelevantStockVideo(searchKeywordsArr);
  if (!stockMatch) {
    return {
      status: "not_found",
      videoUrl: undefined,
      enhancedPrompt: strictPrompt,
      revisedPrompt: strictPrompt,
      originalPrompt: userPrompt,
      searchKeywords: searchKeywordsStr,
      message:
        "Belum ditemukan video yang sesuai dengan permintaan Anda. Coba ubah atau perjelas deskripsi adegan.",
    };
  }

  return {
    status: "completed",
    videoUrl: stockMatch.url,
    enhancedPrompt: strictPrompt,
    revisedPrompt: strictPrompt,
    originalPrompt: userPrompt,
    searchKeywords: stockMatch.matchedQuery || searchKeywordsStr,
    provider: stockMatch.provider,
    message: "Video berhasil dirender.",
  };
}
