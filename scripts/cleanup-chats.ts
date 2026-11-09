import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_KEY || "").trim();

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_TITLE_LENGTH = 40;

function buildTitleFromMessage(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Percakapan Baru";
  if (clean.length <= MAX_TITLE_LENGTH) return clean;
  const cut = clean.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

async function main() {
  const applyChanges = process.argv.includes("--apply");
  console.log(
    applyChanges
      ? "=== MODE: APPLY (Perubahan AKAN disimpan ke Supabase) ==="
      : "=== MODE: DRY-RUN / PREVIEW (Belum mengubah database. Gunakan --apply untuk menjalankan) ==="
  );

  const { data: chats, error: chatsErr } = await supabase
    .from("chats")
    .select("id, title, created_at")
    .order("created_at", { ascending: false });

  if (chatsErr || !chats) {
    console.error("Gagal membaca tabel chats:", chatsErr?.message);
    process.exit(1);
  }

  const { data: messages, error: msgsErr } = await supabase
    .from("messages")
    .select("id, chat_id, role, content, created_at")
    .order("created_at", { ascending: true });

  if (msgsErr || !messages) {
    console.error("Gagal membaca tabel messages:", msgsErr?.message);
    process.exit(1);
  }

  const messagesByChat = new Map<string, typeof messages>();
  for (const m of messages) {
    const arr = messagesByChat.get(m.chat_id) || [];
    arr.push(m);
    messagesByChat.set(m.chat_id, arr);
  }

  const toDelete: { id: string; title: string; created_at: string }[] = [];
  const toRename: {
    id: string;
    oldTitle: string;
    newTitle: string;
    messageCount: number;
    created_at: string;
  }[] = [];

  for (const chat of chats) {
    const chatMsgs = messagesByChat.get(chat.id) || [];
    if (chatMsgs.length === 0) {
      toDelete.push(chat);
      continue;
    }

    if (!chat.title || chat.title === "New Chat") {
      const firstUserMsg = chatMsgs.find((m) => m.role === "user") || chatMsgs[0];
      const newTitle = buildTitleFromMessage(firstUserMsg?.content || "");
      toRename.push({
        id: chat.id,
        oldTitle: chat.title || "(kosong)",
        newTitle,
        messageCount: chatMsgs.length,
        created_at: chat.created_at,
      });
    }
  }

  console.log(`\nTotal chat di database : ${chats.length}`);
  console.log(`Akan diubah judulnya   : ${toRename.length}`);
  console.log(`Akan dihapus (kosong)  : ${toDelete.length}\n`);

  console.log("--- DAFTAR CHAT KOSONG YANG AKAN DIHAPUS ---");
  if (toDelete.length === 0) {
    console.log("(Tidak ada)");
  } else {
    toDelete.forEach((c, idx) => {
      console.log(`${idx + 1}. id=${c.id} | title="${c.title}" | created_at=${c.created_at}`);
    });
  }

  console.log("\n--- DAFTAR CHAT 'New Chat' YANG AKAN DIBERI JUDUL ---");
  if (toRename.length === 0) {
    console.log("(Tidak ada)");
  } else {
    toRename.forEach((c, idx) => {
      console.log(
        `${String(idx + 1).padStart(2, " ")}. id=${c.id} | "${c.oldTitle}" -> "${c.newTitle}" (${c.messageCount} pesan)`
      );
    });
  }

  if (!applyChanges) {
    console.log("\n[DRY-RUN SELESAI] Tidak ada data yang diubah.");
    return;
  }

  console.log("\nMenjalankan perubahan...");
  for (const item of toRename) {
    const { error } = await supabase
      .from("chats")
      .update({ title: item.newTitle })
      .eq("id", item.id);
    if (error) {
      console.error(`Gagal update chat ${item.id}:`, error.message);
    } else {
      console.log(`[UPDATED] ${item.id} -> "${item.newTitle}"`);
    }
  }

  for (const item of toDelete) {
    const { error } = await supabase.from("chats").delete().eq("id", item.id);
    if (error) {
      console.error(`Gagal hapus chat ${item.id}:`, error.message);
    } else {
      console.log(`[DELETED] ${item.id} ("${item.title}")`);
    }
  }

  console.log("Selesai.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

