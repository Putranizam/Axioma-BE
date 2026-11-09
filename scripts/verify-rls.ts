import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../frontend/.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../frontend/.env") });

if (process.env.NODE_ENV === "production") {
  console.error("[SECURITY ERROR] verify-rls menolak dijalankan saat NODE_ENV=production!");
  process.exit(1);
}

const prodUrl = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ""
).trim();
const testUrl = (process.env.SUPABASE_URL_TEST || "").trim();
const testKey = (
  process.env.SUPABASE_SERVICE_KEY_TEST ||
  process.env.SUPABASE_SERVICE_ROLE_KEY_TEST ||
  ""
).trim();

if (testUrl && prodUrl) {
  const normalize = (u: string) => u.toLowerCase().replace(/\/+$/, "");
  if (normalize(testUrl) === normalize(prodUrl)) {
    console.error(
      `[SECURITY ERROR] verify-rls ditolak: SUPABASE_URL_TEST sama dengan SUPABASE_URL (${prodUrl})! Gunakan URL proyek test yang berbeda.`
    );
    process.exit(1);
  }
}

const supabaseUrl = testUrl || prodUrl;
const serviceKey = testKey || (process.env.SUPABASE_SERVICE_KEY || "").trim();
const anonKey = (
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4aHhxbWZzbWt3cGtlY2lybmdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMjg0MDYsImV4cCI6MjEwODgwNDQwNn0.EAcNVc1Wt17Yu1KJe64ZFRc7-EwFFAcMgoe9h0goRP4"
).trim();

if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment.");
  process.exit(1);
}

const isNewSecretKeyFormat = serviceKey.startsWith("sb_secret_");

const anonClient = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const adminClient = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface CheckResult {
  table: string;
  op: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  blocked: boolean;
  detail: string;
}

async function verifyTableAnonAccess(
  table: "chats" | "messages" | "message_feedback",
  probeId: string,
  insertPayload: Record<string, unknown>,
  updatePayload: Record<string, unknown>,
  idColumn: string = "id"
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. SELECT
  const sel = await anonClient.from(table).select("*");
  const selectBlocked = Boolean(sel.error) || (Array.isArray(sel.data) && sel.data.length === 0);
  results.push({
    table,
    op: "SELECT",
    blocked: selectBlocked,
    detail: sel.error
      ? `Error [${sel.error.code}]: ${sel.error.message}`
      : `Returned ${sel.data?.length ?? 0} rows`,
  });

  // 2. INSERT (Assign deterministic UUID and ALWAYS clean up in finally block using adminClient)
  const anonInsertId =
    typeof insertPayload[idColumn] === "string" && insertPayload[idColumn]
      ? String(insertPayload[idColumn])
      : randomUUID();
  const payloadWithId = { ...insertPayload, [idColumn]: anonInsertId };

  try {
    const ins = await anonClient.from(table).insert([payloadWithId]);
    const insertBlocked = Boolean(ins.error);
    results.push({
      table,
      op: "INSERT",
      blocked: insertBlocked,
      detail: ins.error
        ? `Error [${ins.error.code}]: ${ins.error.message}`
        : "Inserted 1 row (cleaned up immediately by adminClient)",
    });
  } finally {
    // Unconditionally remove the anon-inserted row by deterministic ID so zero test data is ever left behind
    await adminClient.from(table).delete().eq(idColumn, anonInsertId);
  }

  // 3. UPDATE (against temporary probe row only)
  const upd = await anonClient.from(table).update(updatePayload).eq(idColumn, probeId).select();
  const updateBlocked = Boolean(upd.error) || !upd.data || upd.data.length === 0;
  results.push({
    table,
    op: "UPDATE",
    blocked: updateBlocked,
    detail: upd.error
      ? `Error [${upd.error.code}]: ${upd.error.message}`
      : `Updated ${upd.data?.length ?? 0} rows`,
  });

  // 4. DELETE (against temporary probe row only)
  const del = await anonClient.from(table).delete().eq(idColumn, probeId).select();
  const deleteBlocked = Boolean(del.error) || !del.data || del.data.length === 0;
  results.push({
    table,
    op: "DELETE",
    blocked: deleteBlocked,
    detail: del.error
      ? `Error [${del.error.code}]: ${del.error.message}`
      : `Deleted ${del.data?.length ?? 0} rows`,
  });

  return results;
}

async function main() {
  console.log("=== 0. Checking Backend Secret Key Format ===");
  console.log(
    isNewSecretKeyFormat
      ? `✅ Backend SUPABASE_SERVICE_KEY uses new format (${serviceKey.slice(0, 10)}..., length=${serviceKey.length}). Legacy anon JWT can be safely disabled after RLS is enabled.`
      : `⚠️ Backend SUPABASE_SERVICE_KEY does not start with 'sb_secret_'.`
  );

  console.log("\n=== 1. Checking Schema & Backfilling Existing Data (Service Role) ===");
  let schemaReady = true;

  const chatsCheck = await adminClient.from("chats").select("id, title, user_id").limit(100);
  if (chatsCheck.error) {
    schemaReady = false;
    console.log("❌ chats.user_id schema check failed:", chatsCheck.error.message);
  } else {
    console.log(`✅ chats.user_id column exists! Found ${chatsCheck.data?.length ?? 0} chats.`);
    const ownersPath = path.resolve(__dirname, "chat-owners.json");
    let ownersMap: Record<string, string> = {};
    if (fs.existsSync(ownersPath)) {
      try {
        ownersMap = JSON.parse(fs.readFileSync(ownersPath, "utf8"));
      } catch {
        // ignore
      }
    }
    const defaultOwner = "2bd9c62b-6793-40e7-b0ca-77b03c625a37";
    for (const chat of chatsCheck.data || []) {
      const targetOwner = ownersMap[chat.id] || defaultOwner;
      if (!chat.user_id && targetOwner) {
        const { error: upErr } = await adminClient
          .from("chats")
          .update({ user_id: targetOwner })
          .eq("id", chat.id);
        if (!upErr) {
          console.log(`   -> Backfilled user_id for chat ${chat.id} (${targetOwner})`);
        }
      }
    }
  }

  const msgsCheck = await adminClient
    .from("messages")
    .select("id, chat_id, role, agent_id, agent_name")
    .limit(200);
  if (msgsCheck.error) {
    schemaReady = false;
    console.log("❌ messages.agent_id/agent_name schema check failed:", msgsCheck.error.message);
  } else {
    console.log(
      `✅ messages.agent_id & agent_name columns exist! Found ${msgsCheck.data?.length ?? 0} messages.`
    );
    const agentsPath = path.resolve(__dirname, "message-agents.json");
    let agentsMap: Record<string, { agent_id?: string; agent_name?: string; agentId?: string; agentName?: string }> = {};
    if (fs.existsSync(agentsPath)) {
      try {
        agentsMap = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
      } catch {
        // ignore
      }
    }
    for (const msg of msgsCheck.data || []) {
      if ((msg.role === "assistant" || msg.role === "ai") && (!msg.agent_id || !msg.agent_name)) {
        const rawMeta = agentsMap[msg.id];
        const agentId = rawMeta?.agent_id || rawMeta?.agentId || "axioma-pro";
        const agentName = rawMeta?.agent_name || rawMeta?.agentName || "Axioma Pro";
        const { error: upErr } = await adminClient
          .from("messages")
          .update({ agent_id: agentId, agent_name: agentName })
          .eq("id", msg.id);
        if (!upErr) {
          console.log(`   -> Backfilled agent metadata for message ${msg.id} (${agentName})`);
        }
      }
    }
  }

  const fbCheck = await adminClient
    .from("message_feedback")
    .select("message_id, chat_id, user_id, rating")
    .limit(100);
  if (fbCheck.error) {
    schemaReady = false;
    console.log("❌ message_feedback table check failed:", fbCheck.error.message);
  } else {
    console.log(
      `✅ message_feedback table exists! Found ${fbCheck.data?.length ?? 0} feedback rows.`
    );
  }

  // Create isolated temporary probe rows via adminClient so anon UPDATE/DELETE tests never touch real data
  const probeChatId = randomUUID();
  const probeMsgId = randomUUID();
  const anonProbeMsgId = randomUUID();
  const allResults: CheckResult[] = [];

  console.log("\n=== 2. Testing Anon Key RLS Lockdown ===");

  try {
    await adminClient.from("chats").insert([{ id: probeChatId, title: "RLS Probe Chat" }]);
    await adminClient
      .from("messages")
      .insert([{ id: probeMsgId, chat_id: probeChatId, role: "user", content: "RLS Probe Msg" }]);
    if (schemaReady) {
      await adminClient.from("message_feedback").insert([
        {
          message_id: probeMsgId,
          chat_id: probeChatId,
          user_id: "rls-probe-owner",
          rating: "up",
        },
      ]);
    }

    allResults.push(
      ...(await verifyTableAnonAccess(
        "chats",
        probeChatId,
        { title: "Anon Probe Insert Chat" },
        { title: "Anon Renamed" },
        "id"
      ))
    );

    allResults.push(
      ...(await verifyTableAnonAccess(
        "messages",
        probeMsgId,
        { id: anonProbeMsgId, chat_id: probeChatId, role: "user", content: "Anon Probe Insert Message" },
        { content: "Anon Modified Message" },
        "id"
      ))
    );

    allResults.push(
      ...(await verifyTableAnonAccess(
        "message_feedback",
        probeMsgId,
        {
          message_id: probeMsgId,
          chat_id: probeChatId,
          user_id: "anon-probe",
          rating: "up",
        },
        { rating: "down" },
        "message_id"
      ))
    );
  } finally {
    // Always clean up isolated temporary probe rows & any anon insert probes
    if (schemaReady) {
      await adminClient.from("message_feedback").delete().eq("message_id", probeMsgId);
    }
    await adminClient.from("messages").delete().in("id", [probeMsgId, anonProbeMsgId]);
    await adminClient.from("messages").delete().eq("chat_id", probeChatId);
    await adminClient.from("chats").delete().eq("id", probeChatId);
    await adminClient.from("messages").delete().ilike("content", "%Anon Probe%");
    await adminClient.from("chats").delete().ilike("title", "%Anon Probe%");
    await adminClient.from("chats").delete().ilike("title", "%RLS Probe%");
  }

  // Once schema migration is applied, remove legacy local JSON files so backend relies 100% on Supabase DB
  if (schemaReady) {
    for (const localFile of ["chat-owners.json", "message-agents.json", "feedback-store.json", "messages-backup.json"]) {
      const p = path.resolve(__dirname, localFile);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
          console.log(`🧹 Removed legacy local file: scripts/${localFile}`);
        } catch {
          // ignore
        }
      }
    }
  }

  let allBlocked = true;
  for (const r of allResults) {
    const status = r.blocked ? "BLOCKED (PASS)" : "ALLOWED (FAIL)";
    console.log(`[${status}] ${r.table}.${r.op} -> ${r.detail}`);
    if (!r.blocked) allBlocked = false;
  }

  if (!schemaReady) {
    console.error(
      "\n⚠️ SQL Migration (backend/scripts/migrations-and-rls.sql) has NOT been applied to Supabase yet."
    );
    process.exit(1);
  }

  if (!allBlocked) {
    console.error("\n❌ SOME ANON OPERATIONS WERE NOT BLOCKED!");
    process.exit(1);
  }

  console.log(
    "\n✅ ALL SCHEMA MIGRATIONS APPLIED & ALL 12 ANON OPERATIONS (SELECT/INSERT/UPDATE/DELETE on chats, messages, message_feedback) ARE BLOCKED!"
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
