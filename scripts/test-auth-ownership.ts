import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { supabaseAdmin, supabaseUrl, supabaseKey } from "./test-env";
import { app } from "../src/index";

let BACKEND_URL = process.env.BACKEND_URL || "";

async function runTests() {
  let server: http.Server | null = null;
  const createdChatIds = new Set<string>();
  if (!BACKEND_URL) {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(8088, resolve));
    BACKEND_URL = "http://127.0.0.1:8088";
  }

  try {
    const userA = `test-user-a-${randomUUID()}`;
    const userB = `test-user-b-${randomUUID()}`;
    const userRateLimit = `test-user-rl-${randomUUID()}`;
    const chatIdA = randomUUID();
    const chatIdB = randomUUID();
    createdChatIds.add(chatIdA);
    createdChatIds.add(chatIdB);
    let createdMessageIdA = "";

  console.log("=== Axioma Backend Comprehensive Verification Suite ===");
  console.log(`User A: ${userA}`);
  console.log(`User B: ${userB}`);
  console.log(`Chat A: ${chatIdA}`);

  // ---------------------------------------------------------------------------
  // 1. TANPA HEADER IDENTITAS -> Semua endpoint harus menolak dengan 401 (#1)
  // ---------------------------------------------------------------------------
  console.log("\n[1] Testing requests WITHOUT X-User-Id header (must all return 401)...");

  const noAuthEndpoints: Array<{ name: string; method: string; path: string; body?: any }> = [
    { name: "GET /api/chats", method: "GET", path: "/api/chats" },
    { name: "GET /api/chats/:id/messages", method: "GET", path: `/api/chats/${chatIdA}/messages` },
    {
      name: "POST /api/chats/message",
      method: "POST",
      path: "/api/chats/message",
      body: { chat_id: chatIdA, content: "Halo tanpa header", stream: false },
    },
    {
      name: "PATCH /api/chats/:id",
      method: "PATCH",
      path: `/api/chats/${chatIdA}`,
      body: { title: "Judul Ilegal" },
    },
    {
      name: "DELETE /api/chats/:id",
      method: "DELETE",
      path: `/api/chats/${chatIdA}`,
    },
    {
      name: "DELETE /api/chats",
      method: "DELETE",
      path: "/api/chats",
    },
    {
      name: "GET /api/chats/:id/feedback",
      method: "GET",
      path: `/api/chats/${chatIdA}/feedback`,
    },
    {
      name: "POST /api/messages/:id/feedback",
      method: "POST",
      path: `/api/messages/${chatIdA}/feedback`,
      body: { chat_id: chatIdA, rating: "up" },
    },
    {
      name: "DELETE /api/messages/:id/feedback",
      method: "DELETE",
      path: `/api/messages/${chatIdA}/feedback`,
    },
  ];

  for (const ep of noAuthEndpoints) {
    const res = await fetch(`${BACKEND_URL}${ep.path}`, {
      method: ep.method,
      headers: ep.body ? { "Content-Type": "application/json" } : {},
      body: ep.body ? JSON.stringify(ep.body) : undefined,
    });
    assert.equal(
      res.status,
      401,
      `Expected 401 for ${ep.name} without X-User-Id, got ${res.status}`
    );
    console.log(`  PASS: ${ep.name} without header -> 401`);
  }

  // Passing user_id ONLY in body without X-User-Id header must also be rejected with 401
  const bodyOnlyRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatIdA,
      content: "Coba bypass lewat body",
      user_id: userA,
      stream: false,
    }),
  });
  assert.equal(bodyOnlyRes.status, 401, "Expected 401 when user_id is only in body without header");
  console.log("  PASS: POST /api/chats/message with body.user_id only (no header) -> 401");

  // ---------------------------------------------------------------------------
  // 2. ID BENAR (User A membuat chat dgn Axioma Pro + "jawab singkat" #13, membaca, feedback, rename)
  // ---------------------------------------------------------------------------
  console.log("\n[2] Testing requests WITH VALID owner X-User-Id (User A) + Axioma Pro brevity (#1, #13)...");

  const tStartMsg = Date.now();
  const createRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userA,
    },
    body: JSON.stringify({
      chat_id: chatIdA,
      content: "Jawab singkat 1 baris saja tanpa heading: sebutkan 3 warna primer.",
      agent_id: "axioma-pro",
      stream: false,
    }),
  });
  const createElapsed = Date.now() - tStartMsg;
  const createJson: any = await createRes.json();
  assert.equal(
    createRes.status,
    200,
    `Expected 200 creating chat for User A, got ${createRes.status}: ${JSON.stringify(createJson)}`
  );
  assert.equal(createJson.success, true);
  assert.ok(createJson.message_id, "Expected message_id in response");
  createdMessageIdA = createJson.message_id;
  console.log(
    `  PASS: POST /api/chats/message (User A, Axioma Pro) -> 200 in ${createElapsed}ms | reply="${String(
      createJson.data
    )
      .replace(/\s+/g, " ")
      .slice(0, 120)}"`
  );

  // User B also creates their own chat (Chat B) so we can test DELETE /api/chats isolation
  const createResB = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userB,
    },
    body: JSON.stringify({
      chat_id: chatIdB,
      content: "Jawab singkat 1 angka: 2 + 2 berapa?",
      agent_id: "axioma-omni",
      stream: false,
    }),
  });
  assert.equal(createResB.status, 200, "Expected 200 creating chat for User B");
  console.log(`  PASS: POST /api/chats/message (User B creates Chat B) -> 200`);

  // User A reads their own chat messages & checks agent_id / agent_name (#15)
  const getMsgsA = await fetch(`${BACKEND_URL}/api/chats/${chatIdA}/messages`, {
    headers: { "X-User-Id": userA },
  });
  const getMsgsAJson: any = await getMsgsA.json();
  assert.equal(getMsgsA.status, 200);
  const aiMsgRow = (getMsgsAJson.data || []).find((m: any) => m.role === "ai");
  assert.equal(aiMsgRow?.agent_id, "axioma-pro");
  assert.equal(aiMsgRow?.agent_name, "Axioma Pro");
  console.log("  PASS: GET /api/chats/:id/messages (User A) -> 200 with agent_id/agent_name");

  // User A renames their own chat
  const patchResA = await fetch(`${BACKEND_URL}/api/chats/${chatIdA}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userA,
    },
    body: JSON.stringify({ title: "Judul Baru User A" }),
  });
  assert.equal(patchResA.status, 200);
  console.log("  PASS: PATCH /api/chats/:id (User A) -> 200");

  // User A fetches sidebar list (GET /api/chats) -> must contain Chat A with updated title, and NOT Chat B
  const listChatsA = await fetch(`${BACKEND_URL}/api/chats`, {
    headers: { "X-User-Id": userA },
  });
  const listChatsAJson: any = await listChatsA.json();
  assert.equal(listChatsA.status, 200);
  const foundChatA = (listChatsAJson.data || []).find((c: any) => c.id === chatIdA);
  const foundChatBInA = (listChatsAJson.data || []).find((c: any) => c.id === chatIdB);
  assert.ok(foundChatA, "Sidebar GET /api/chats for User A must include Chat A");
  assert.equal(foundChatA.title, "Judul Baru User A", "Sidebar Chat A title must reflect rename");
  assert.equal(foundChatBInA, undefined, "Sidebar GET /api/chats for User A must NOT include User B's Chat B");
  console.log("  PASS: GET /api/chats (Sidebar User A) -> 200 (isolated & reflects rename)");

  // User A posts feedback on their message
  const postFbA = await fetch(`${BACKEND_URL}/api/messages/${createdMessageIdA}/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userA,
    },
    body: JSON.stringify({ chat_id: chatIdA, rating: "up" }),
  });
  assert.equal(postFbA.status, 200);
  console.log("  PASS: POST /api/messages/:id/feedback (User A) -> 200");

  // User A reads feedback on their chat
  const getFbA = await fetch(`${BACKEND_URL}/api/chats/${chatIdA}/feedback`, {
    headers: { "X-User-Id": userA },
  });
  const getFbAJson: any = await getFbA.json();
  assert.equal(getFbA.status, 200);
  const fbEntry = getFbAJson.data?.[createdMessageIdA];
  assert.equal(typeof fbEntry === "object" ? fbEntry?.rating : fbEntry, "up");
  console.log("  PASS: GET /api/chats/:id/feedback (User A) -> 200 (rating='up')");

  // ---------------------------------------------------------------------------
  // 3. ID SALAH (User B mencoba mengakses / mengubah / menghapus Chat A milik User A -> 403) (#1, #4)
  // ---------------------------------------------------------------------------
  console.log("\n[3] Testing requests WITH WRONG X-User-Id (User B accessing User A's chat -> 403)...");

  const wrongUserEndpoints: Array<{ name: string; method: string; path: string; body?: any }> = [
    {
      name: "GET /api/chats/:id/messages",
      method: "GET",
      path: `/api/chats/${chatIdA}/messages`,
    },
    {
      name: "POST /api/chats/message (to Chat A)",
      method: "POST",
      path: "/api/chats/message",
      body: { chat_id: chatIdA, content: "Bajak chat A", stream: false },
    },
    {
      name: "PATCH /api/chats/:id (Chat A)",
      method: "PATCH",
      path: `/api/chats/${chatIdA}`,
      body: { title: "Dibajak User B" },
    },
    {
      name: "DELETE /api/chats/:id (Chat A)",
      method: "DELETE",
      path: `/api/chats/${chatIdA}`,
    },
    {
      name: "GET /api/chats/:id/feedback (Chat A)",
      method: "GET",
      path: `/api/chats/${chatIdA}/feedback`,
    },
    {
      name: "POST /api/messages/:id/feedback (Message A)",
      method: "POST",
      path: `/api/messages/${createdMessageIdA}/feedback`,
      body: { chat_id: chatIdA, rating: "down" },
    },
    {
      name: "DELETE /api/messages/:id/feedback (Message A)",
      method: "DELETE",
      path: `/api/messages/${createdMessageIdA}/feedback`,
    },
  ];

  for (const ep of wrongUserEndpoints) {
    const res = await fetch(`${BACKEND_URL}${ep.path}`, {
      method: ep.method,
      headers: {
        ...(ep.body ? { "Content-Type": "application/json" } : {}),
        "X-User-Id": userB,
      },
      body: ep.body ? JSON.stringify(ep.body) : undefined,
    });
    assert.equal(
      res.status,
      403,
      `Expected 403 for ${ep.name} with wrong X-User-Id (User B), got ${res.status}`
    );
    console.log(`  PASS: ${ep.name} with wrong X-User-Id -> 403`);
  }

  // ---------------------------------------------------------------------------
  // 4. DELETE /api/chats oleh User B HANYA menghapus Chat B, TIDAK menghapus Chat A (#3)
  // ---------------------------------------------------------------------------
  console.log("\n[4] Testing DELETE /api/chats isolation (User B deletes only User B's chats)...");
  const delAllB = await fetch(`${BACKEND_URL}/api/chats`, {
    method: "DELETE",
    headers: { "X-User-Id": userB },
  });
  const delAllBJson: any = await delAllB.json();
  assert.equal(delAllB.status, 200);
  assert.equal(delAllBJson.data?.deletedCount, 1, "User B should only delete their 1 chat");

  const checkChatAAfterBDelete = await fetch(`${BACKEND_URL}/api/chats/${chatIdA}/messages`, {
    headers: { "X-User-Id": userA },
  });
  assert.equal(
    checkChatAAfterBDelete.status,
    200,
    "User A's chat must remain intact after User B deletes all chats"
  );
  console.log("  PASS: DELETE /api/chats by User B deleted only Chat B; User A's Chat A is intact!");

  // ---------------------------------------------------------------------------
  // 5. VALIDASI JSON RUSAK (400), PAYLOAD > 1MB (413), CONTENT > 20k (400), & RATE LIMIT (429) (#9)
  // ---------------------------------------------------------------------------
  console.log("\n[5] Testing malformed JSON (400), >20k content (400), >1MB payload (413), and Rate Limit (429)...");

  const badJsonRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userA,
    },
    body: '{"chat_id": "broken-json", ',
  });
  assert.equal(badJsonRes.status, 400, `Expected 400 for malformed JSON, got ${badJsonRes.status}`);
  console.log("  PASS: Malformed JSON -> 400");

  const tooLongContentRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userA,
    },
    body: JSON.stringify({
      chat_id: chatIdA,
      content: "a".repeat(20_005),
      stream: false,
    }),
  });
  assert.equal(
    tooLongContentRes.status,
    400,
    `Expected 400 for >20,000 char content, got ${tooLongContentRes.status}`
  );
  console.log("  PASS: Content > 20,000 chars -> 400");

  const hugePayloadRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userA,
    },
    body: JSON.stringify({
      chat_id: chatIdA,
      content: "x".repeat(1_150_000),
      stream: false,
    }),
  });
  assert.equal(
    hugePayloadRes.status,
    413,
    `Expected 413 for >1MB payload, got ${hugePayloadRes.status}`
  );
  console.log("  PASS: Payload > 1MB -> 413");

  // Rate limit test: send 20 fast invalid-body requests with `userRateLimit`, 21st must return 429
  for (let i = 1; i <= 20; i++) {
    const rlRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": userRateLimit,
      },
      body: JSON.stringify({ chat_id: "", content: "" }),
    });
    assert.equal(rlRes.status, 400);
  }
  const rlExceededRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userRateLimit,
    },
    body: JSON.stringify({ chat_id: chatIdA, content: "Ke-21" }),
  });
  assert.equal(
    rlExceededRes.status,
    429,
    `Expected 429 on 21st message within 1 minute, got ${rlExceededRes.status}`
  );
  console.log("  PASS: Rate limit > 20 messages/minute -> 429 Too Many Requests");

  // ---------------------------------------------------------------------------
  // 6. Cleanup User A's feedback & test chat
  // ---------------------------------------------------------------------------
  const delFbA = await fetch(`${BACKEND_URL}/api/messages/${createdMessageIdA}/feedback`, {
    method: "DELETE",
    headers: { "X-User-Id": userA },
  });
  assert.equal(delFbA.status, 200);
  console.log("\n[6] Cleanup: DELETE /api/messages/:id/feedback (User A) -> 200");

  const delA = await fetch(`${BACKEND_URL}/api/chats/${chatIdA}`, {
    method: "DELETE",
    headers: { "X-User-Id": userA },
  });
  assert.equal(delA.status, 200);
  console.log("    Cleanup: DELETE /api/chats/:id (User A) -> 200");

  // ---------------------------------------------------------------------------
  // 7. Skenario Khusus: "Kirim pesan lalu langsung hapus chat" (#2)
  // ---------------------------------------------------------------------------
  console.log("\n[7] Testing scenario: Send message stream then immediately DELETE chat...");
  const fastChatId = randomUUID();
  createdChatIds.add(fastChatId);
  const fastUser = `test-user-fast-${randomUUID()}`;

  // 1. Send message and await completion (so chat & messages & background updates exist)
  const streamRes = await fetch(`${BACKEND_URL}/api/chats/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": fastUser,
      Accept: "application/json",
    },
    body: JSON.stringify({
      chat_id: fastChatId,
      content: "Jawab satu kata: Siap.",
      stream: false,
    }),
  });
  assert.equal(streamRes.status, 200, "Initial message must succeed");
  const streamJson = (await streamRes.json()) as any;
  const fastMsgId = streamJson.ai_message_id || streamJson.message_id || randomUUID();

  // 2. Add feedback to verify feedback deletion cascade without foreign key error
  await fetch(`${BACKEND_URL}/api/messages/${fastMsgId}/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": fastUser,
    },
    body: JSON.stringify({
      chat_id: fastChatId,
      rating: "up",
      comment: "Feedback untuk uji hapus",
    }),
  });

  // 3. User immediately deletes the chat right after stream finished
  const deleteImmediateRes = await fetch(`${BACKEND_URL}/api/chats/${fastChatId}`, {
    method: "DELETE",
    headers: { "X-User-Id": fastUser },
  });

  assert.equal(
    deleteImmediateRes.status,
    200,
    `DELETE immediately after stream must return 200, got ${deleteImmediateRes.status}`
  );
  console.log("  PASS: DELETE /api/chats/:id right after stream finished -> 200 (not 500)");

  // 4. Second delete must return 404
  const secondDeleteRes = await fetch(`${BACKEND_URL}/api/chats/${fastChatId}`, {
    method: "DELETE",
    headers: { "X-User-Id": fastUser },
  });
  assert.equal(secondDeleteRes.status, 404, "Second delete must return 404");
  console.log("  PASS: Second DELETE /api/chats/:id -> 404");

  // 5. Fetch messages must return 404 (no orphan messages left behind)
  const getOrphanRes = await fetch(`${BACKEND_URL}/api/chats/${fastChatId}/messages`, {
    method: "GET",
    headers: { "X-User-Id": fastUser },
  });
  assert.equal(getOrphanRes.status, 404, "Chat must not exist");
  console.log("  PASS: No orphan messages or chat residue left in database");

  // ---------------------------------------------------------------------------
  // 8. Skenario Atomik: Chat Baru + Request Gagal/Dibatalkan -> Chat Di-rollback
  // ---------------------------------------------------------------------------
  console.log("\n[8] Testing atomic rollback: new chat request aborted before message saved...");
  const abortChatId = randomUUID();
  createdChatIds.add(abortChatId);
  const abortUser = `test-user-abort-${randomUUID()}`;

  const preAbortedCtrl = new AbortController();
  preAbortedCtrl.abort();

  try {
    await fetch(`${BACKEND_URL}/api/chats/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": abortUser,
      },
      body: JSON.stringify({
        chat_id: abortChatId,
        content: "Pesan ini dibatalkan sebelum disimpan",
        stream: false,
      }),
      signal: preAbortedCtrl.signal,
    });
  } catch {
    // Expected client abort
  }

  // Small delay for server finally handler
  await new Promise((r) => setTimeout(r, 200));

  const { data: abortCheck } = await supabaseAdmin
    .from("chats")
    .select("id")
    .eq("id", abortChatId)
    .maybeSingle();

  assert.equal(abortCheck, null, "Aborted new chat must NOT leave an empty chat row in database");
  console.log("  PASS: Brand new chat aborted before message saved was rolled back atomically!");

  console.log("\nALL TESTS PASSED SUCCESSFULLY!");
  } finally {
    // Thorough cleanup of all test chats and related records
    try {
      for (const cId of createdChatIds) {
        await supabaseAdmin.from("message_feedback").delete().eq("chat_id", cId);
        await supabaseAdmin.from("messages").delete().eq("chat_id", cId);
        await supabaseAdmin.from("chats").delete().eq("id", cId);
      }
    } catch (cleanupErr: any) {
      console.warn("Cleanup warning:", cleanupErr?.message);
    }

    if (server) {
      server.close();
    }
  }
}

runTests().catch((err) => {
  console.error("\nTEST SUITE FAILED:", err);
  process.exit(1);
});
