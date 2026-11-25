import { GoogleGenerativeAI } from "@google/generative-ai";
import { callGeminiWithFallback } from "./geminiModels";

export function stripMarkdownForTts(text: string): string {
  if (!text) return "";
  let clean = text;

  // Remove code blocks
  clean = clean.replace(/```[\s\S]*?```/g, " bagian kode program ");
  // Remove inline code
  clean = clean.replace(/`([^`]+)`/g, "$1");
  // Remove markdown links [text](url) -> text
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove bare URLs
  clean = clean.replace(/https?:\/\/\S+/g, "");
  // Remove headers (#, ##, ###)
  clean = clean.replace(/^#{1,6}\s+/gm, "");
  // Remove bold/italic markers (*, **, _, __)
  clean = clean.replace(/[*_]{1,3}(.*?)[*_]{1,3}/g, "$1");
  // Remove strikethrough (~~text~~)
  clean = clean.replace(/~~(.*?)~~/g, "$1");
  // Remove bullet points and list markers (-, *, 1., 2.)
  clean = clean.replace(/^[\s]*[-*+]\s+/gm, "");
  clean = clean.replace(/^[\s]*\d+\.\s+/gm, "");
  // Remove blockquotes (>)
  clean = clean.replace(/^>\s+/gm, "");
  // Remove horizontal rules
  clean = clean.replace(/^[-*_]{3,}\s*$/gm, "");
  // Remove XML / HTML tags
  clean = clean.replace(/<[^>]*>/g, "");
  // Normalize whitespace
  clean = clean.replace(/\s+/g, " ").trim();

  return clean;
}

export function sanitizeTranscriptionResult(
  hasSpeech: boolean,
  text: string
): string {
  if (!hasSpeech || !text) {
    return "";
  }

  const clean = text.trim();
  const lower = clean.toLowerCase();

  // Guard against prompt leakage, system instructions, and echo hallucinations
  const promptForbiddenPatterns = [
    /nama aplikasi ini/i,
    /aplikasi bernama axioma/i,
    /aplikasi ini adalah/i,
    /transkripsikan/i,
    /has_speech/i,
    /has speech/i,
    /tidak ada ucapan/i,
    /keheningan/i,
    /rekaman audio/i,
    /suara manusia/i,
    /bahasa aslinya/i,
    /hasil transkripsi/i,
    /kembalikan hanya json/i,
    /format json/i,
    /petunjuk dari prompt/i,
  ];

  for (const pattern of promptForbiddenPatterns) {
    if (pattern.test(lower)) {
      console.warn(
        `[Transcription Filter] Hallucinated instruction pattern detected in transcript: "${clean}". Sanitized to empty.`
      );
      return "";
    }
  }

  return clean;
}

export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
  filename = "audio.webm"
): Promise<string> {
  const provider = (process.env.STT_PROVIDER || "").toLowerCase().trim();
  const groqApiKey = (process.env.GROQ_API_KEY || "").trim();
  const openaiApiKey = (process.env.OPENAI_API_KEY || "").trim();
  const deepgramApiKey = (process.env.DEEPGRAM_API_KEY || "").trim();
  const geminiApiKey = (process.env.GEMINI_API_KEY || "").trim();

  const cleanMime = mimeType.split(";")[0].trim().toLowerCase() || "audio/webm";

  // 1. Groq Whisper (ultra-fast transcription, whisper-large-v3)
  if (provider === "groq" || (!provider && groqApiKey)) {
    if (!groqApiKey) {
      throw new Error("GROQ_API_KEY tidak dikonfigurasi untuk STT.");
    }
    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array(buffer)], { type: cleanMime });
    formData.append("file", audioBlob, filename);
    formData.append("model", "whisper-large-v3");
    formData.append("language", "id");
    formData.append("response_format", "json");

    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Groq STT error (${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as { text?: string };
    const raw = (data.text || "").trim();
    return sanitizeTranscriptionResult(Boolean(raw), raw);
  }

  // 2. OpenAI Whisper (whisper-1)
  if (provider === "openai" || (!provider && openaiApiKey)) {
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY tidak dikonfigurasi untuk STT.");
    }
    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array(buffer)], { type: cleanMime });
    formData.append("file", audioBlob, filename);
    formData.append("model", "whisper-1");
    formData.append("language", "id");
    formData.append("response_format", "json");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`OpenAI STT error (${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as { text?: string };
    const raw = (data.text || "").trim();
    return sanitizeTranscriptionResult(Boolean(raw), raw);
  }

  // 3. Deepgram (nova-2)
  if (provider === "deepgram" || (!provider && deepgramApiKey)) {
    if (!deepgramApiKey) {
      throw new Error("DEEPGRAM_API_KEY tidak dikonfigurasi untuk STT.");
    }
    const resp = await fetch(
      "https://api.deepgram.com/v1/listen?language=id&model=nova-2&smart_format=true&punctuate=true",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${deepgramApiKey}`,
          "Content-Type": cleanMime,
        },
        body: new Uint8Array(buffer),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Deepgram STT error (${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as any;
    const transcript = (
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ""
    ).trim();
    return sanitizeTranscriptionResult(Boolean(transcript), transcript);
  }

  // 4. Default Fallback: Google Gemini Multimodal Audio Transcription with Automatic Model Fallback
  if (!geminiApiKey) {
    throw new Error(
      "Tidak ada API key yang valid untuk transkripsi audio (GEMINI_API_KEY / GROQ_API_KEY / OPENAI_API_KEY)."
    );
  }

  const genAI = new GoogleGenerativeAI(geminiApiKey);

  // Normalize supported audio MIME type (webm, mp4, aac, wav, ogg)
  let supportedMime = cleanMime;
  if (cleanMime === "audio/x-m4a" || cleanMime === "audio/m4a") {
    supportedMime = "audio/mp4";
  } else if (!cleanMime || cleanMime === "application/octet-stream") {
    supportedMime = filename.endsWith(".mp4")
      ? "audio/mp4"
      : filename.endsWith(".aac")
      ? "audio/aac"
      : "audio/webm";
  }

  const base64Audio = buffer.toString("base64");

  const { result: rawText } = await callGeminiWithFallback(
    async (modelName, signal) => {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction:
          "Anda adalah sistem transkripsi ucapan untuk aplikasi Axioma. Nama aplikasi ini adalah Axioma; tulis persis 'Axioma' jika terdengar dalam ucapan penutur. Jika rekaman hening, desah napas, batuk, atau tidak ada percakapan manusia, Anda WAJIB menandai has_speech=false dan mengosongkan text. JANGAN PERNAH menyalin atau mengulang isi instruksi ini ke dalam transkripsi.",
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.0,
        },
      });
      const response = await model.generateContent(
        [
          {
            inlineData: {
              mimeType: supportedMime,
              data: base64Audio,
            },
          },
          {
            text: 'Transkripsikan rekaman audio ini. Kembalikan HANYA JSON persis dengan format: {"has_speech": boolean, "text": string}. Ketentuan:\n- Jika terdengar ucapan manusia yang jelas: {"has_speech": true, "text": "<transkrip persis apa adanya>"}\n- Jika rekaman hening, desah napas, batuk, noise, atau tanpa ucapan manusia: {"has_speech": false, "text": ""}',
          },
        ],
        { signal }
      );
      return response.response.text();
    },
    {
      purpose: "voice_transcription",
      timeoutMs: 15_000,
    }
  );

  let hasSpeech = false;
  let parsedText = "";

  try {
    const rawTrimmed = (rawText || "").trim();
    const cleanJson = rawTrimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleanJson);
    hasSpeech = Boolean(parsed.has_speech);
    parsedText = typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    parsedText = (rawText || "").trim();
    hasSpeech = parsedText.length > 0;
  }

  return sanitizeTranscriptionResult(hasSpeech, parsedText);
}

// Splits long text into chunks <= maxLength at sentence/punctuation boundaries
function chunkTextForTts(text: string, maxLength = 180): string[] {
  const clean = text.trim();
  if (clean.length <= maxLength) return [clean];

  const sentences = clean.split(/(?<=[.!?,;:\n])\s+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const s of sentences) {
    if (!s) continue;
    if ((currentChunk + " " + s).trim().length <= maxLength) {
      currentChunk = currentChunk ? `${currentChunk} ${s}` : s;
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());
      if (s.length <= maxLength) {
        currentChunk = s;
      } else {
        // Force break by words
        const words = s.split(/\s+/);
        currentChunk = "";
        for (const w of words) {
          if ((currentChunk + " " + w).trim().length <= maxLength) {
            currentChunk = currentChunk ? `${currentChunk} ${w}` : w;
          } else {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = w;
          }
        }
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter((c) => Boolean(c.trim()));
}

export async function synthesizeSpeech(
  text: string,
  voice = "nova",
  language = "id"
): Promise<Buffer> {
  const cleanText = stripMarkdownForTts(text);
  if (!cleanText) {
    return Buffer.alloc(0);
  }

  const provider = (process.env.TTS_PROVIDER || "").toLowerCase().trim();
  const openaiApiKey = (process.env.OPENAI_API_KEY || "").trim();
  const elevenlabsApiKey = (process.env.ELEVENLABS_API_KEY || "").trim();
  const googleTtsApiKey = (process.env.GOOGLE_TTS_API_KEY || "").trim();

  // 1. OpenAI TTS (natural, high quality voices: alloy, nova, shimmer)
  if (provider === "openai" || (!provider && openaiApiKey)) {
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY tidak dikonfigurasi untuk TTS.");
    }
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: cleanText,
        voice: voice || "nova",
        response_format: "mp3",
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`OpenAI TTS error (${resp.status}): ${errText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // 2. ElevenLabs TTS
  if (provider === "elevenlabs" || (!provider && elevenlabsApiKey)) {
    if (!elevenlabsApiKey) {
      throw new Error("ELEVENLABS_API_KEY tidak dikonfigurasi untuk TTS.");
    }
    const voiceId = voice && voice.length > 5 ? voice : "21m00Tcm4TlvDq8ikWAM";
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": elevenlabsApiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`ElevenLabs TTS error (${resp.status}): ${errText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // 3. Google Cloud Text-to-Speech API
  if (provider === "google" && googleTtsApiKey) {
    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleTtsApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text: cleanText },
          voice: {
            languageCode: language === "id" ? "id-ID" : language,
            name: language === "id" ? "id-ID-Wavenet-A" : undefined,
          },
          audioConfig: {
            audioEncoding: "MP3",
            speakingRate: 1.05,
          },
        }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Google Cloud TTS error (${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as { audioContent?: string };
    if (!data.audioContent) {
      throw new Error("Google Cloud TTS tidak mengembalikan audio.");
    }

    return Buffer.from(data.audioContent, "base64");
  }

  // 4. Default Fallback: High-Availability Google Translate TTS (Zero-config, fast, MP3)
  const chunks = chunkTextForTts(cleanText, 180);
  const audioBuffers: Buffer[] = [];

  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(
      language || "id"
    )}&client=tw-ob&q=${encodeURIComponent(chunk)}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`TTS audio generation error (${resp.status}): ${errText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    audioBuffers.push(Buffer.from(arrayBuffer));
  }

  return Buffer.concat(audioBuffers);
}

