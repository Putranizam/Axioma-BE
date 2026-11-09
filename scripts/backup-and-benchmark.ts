import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const supabase = createClient(
  (process.env.SUPABASE_URL || "").trim(),
  (process.env.SUPABASE_SERVICE_KEY || "").trim(),
  { auth: { persistSession: false } }
);

const genAI = new GoogleGenerativeAI((process.env.GEMINI_API_KEY || "").trim());

async function main() {
  // 1. Backup chats and messages
  const t0 = Date.now();
  const { data: chats, error: ce } = await supabase
    .from("chats")
    .select("*")
    .order("created_at", { ascending: true });
  const tChats = Date.now() - t0;

  const t1 = Date.now();
  const { data: messages, error: me } = await supabase
    .from("messages")
    .select("*")
    .order("created_at", { ascending: true });
  const tMsgs = Date.now() - t1;

  if (ce) console.error("Chats backup error:", ce);
  if (me) console.error("Messages backup error:", me);

  const scriptsDir = path.join(__dirname);
  fs.writeFileSync(
    path.join(scriptsDir, "chats-backup.json"),
    JSON.stringify(
      { backed_up_at: new Date().toISOString(), count: (chats || []).length, rows: chats || [] },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(scriptsDir, "messages-backup.json"),
    JSON.stringify(
      {
        backed_up_at: new Date().toISOString(),
        count: (messages || []).length,
        rows: messages || [],
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    `[BACKUP] chats=${(chats || []).length} rows (${tChats}ms), messages=${
      (messages || []).length
    } rows (${tMsgs}ms)`
  );

  // Check consecutive user messages in DB
  const byChat = new Map<string, any[]>();
  for (const m of messages || []) {
    const arr = byChat.get(m.chat_id) || [];
    arr.push(m);
    byChat.set(m.chat_id, arr);
  }
  let consecutiveCount = 0;
  for (const [, arr] of byChat.entries()) {
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].role === "user" && arr[i - 1].role === "user") {
        consecutiveCount++;
      }
    }
  }
  console.log(`[DB AUDIT] Consecutive user->user message pairs across chats: ${consecutiveCount}`);

  // 2. Benchmark each Gemini model
  const models = [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
  ];

  for (const m of models) {
    const start = Date.now();
    let ttfb: number | null = null;
    let chunks = 0;
    let chars = 0;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 16000);
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const res = await model.generateContentStream(
        "Jawab dalam 1 kalimat singkat: apa fungsi utama TypeScript?",
        { signal: ctrl.signal }
      );
      res.response.catch(() => {});
      for await (const chunk of res.stream) {
        const txt = chunk.text();
        if (txt) {
          if (ttfb === null) ttfb = Date.now() - start;
          chunks++;
          chars += txt.length;
        }
      }
      console.log(
        `[BENCHMARK] ${m} => OK | TTFB=${ttfb}ms | Total=${
          Date.now() - start
        }ms | chunks=${chunks} | chars=${chars}`
      );
    } catch (e: any) {
      console.log(
        `[BENCHMARK] ${m} => FAIL after ${Date.now() - start}ms | TTFB=${ttfb} | status=${
          e?.status ?? "n/a"
        } | msg=${String(e?.message || e).slice(0, 140)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

