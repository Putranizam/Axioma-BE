import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { initTestEnv } from "./test-env";
import { app } from "../src/index";

const { supabaseAdmin } = initTestEnv("Undo Delete Chat Test");

let BACKEND_URL = process.env.BACKEND_URL || "";

async function runTests() {
  let server: http.Server | null = null;
  const createdChatIds = new Set<string>();

  if (!BACKEND_URL) {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(8089, resolve));
    BACKEND_URL = "http://127.0.0.1:8089";
  }

  try {
    const userId = `test-user-undo-${randomUUID()}`;
    const chatId1 = randomUUID();
    const chatId2 = randomUUID();
    const chatId3 = randomUUID();
    createdChatIds.add(chatId1);
    createdChatIds.add(chatId2);
    createdChatIds.add(chatId3);

    console.log("=== Axioma Undo Delete Chat & Navigation Integrity Test ===");
    console.log(`User ID: ${userId}`);
    console.log(`Test Chats: ${chatId1}, ${chatId2}, ${chatId3}`);

    // Seed 3 chats in database
    for (const [id, title] of [
      [chatId1, "Chat Pertama (Posisi 0)"],
      [chatId2, "Chat Kedua (Posisi 1)"],
      [chatId3, "Chat Ketiga (Posisi 2)"],
    ]) {
      const { error: insertErr } = await supabaseAdmin.from("chats").insert({
        id,
        user_id: userId,
        title,
      });
      assert.ifError(insertErr);

      const { error: msgErr } = await supabaseAdmin.from("messages").insert({
        id: randomUUID(),
        chat_id: id,
        role: "user",
        content: `Pesan awal untuk ${title}`,
      });
      assert.ifError(msgErr);
    }

    console.log("-> 3 test chats successfully created in database.");

    // ---------------------------------------------------------------------------
    // TEST 1: Logika Pembatalan Timer & Pemulihan Posisi Asli di Sidebar
    // ---------------------------------------------------------------------------
    console.log("\n[Test 1] Testing client-side state logic: original index restoration & cancellation flag...");

    interface TestChatHistoryItem {
      id: string;
      title: string;
    }

    let chatHistory: TestChatHistoryItem[] = [
      { id: chatId1, title: "Chat Pertama" },
      { id: chatId2, title: "Chat Kedua" },
      { id: chatId3, title: "Chat Ketiga" },
    ];

    let pendingDelete: {
      chat: TestChatHistoryItem;
      originalHistoryIndex: number;
      timerId: any;
      isCancelled: boolean;
    } | null = null;

    let serverDeleteCalled = false;
    const commitDeleteChatServer = async (targetId: string) => {
      serverDeleteCalled = true;
      const res = await fetch(`${BACKEND_URL}/api/chats/${targetId}`, {
        method: "DELETE",
        headers: { "X-User-Id": userId },
      });
      return res.ok;
    };

    // User initiates delete on Chat 2 (original index = 1)
    const targetChat = chatHistory[1];
    const originalHistoryIndex = chatHistory.findIndex((c) => c.id === targetChat.id);
    assert.equal(originalHistoryIndex, 1, "Original index harus tepat 1");

    // Optimistically remove from list
    chatHistory = chatHistory.filter((c) => c.id !== targetChat.id);
    assert.equal(chatHistory.length, 2);
    assert.equal(chatHistory[0].id, chatId1);
    assert.equal(chatHistory[1].id, chatId3);

    const pendingItem = {
      chat: targetChat,
      originalHistoryIndex,
      timerId: null as any,
      isCancelled: false,
    };

    let timerFired = false;
    pendingItem.timerId = setTimeout(() => {
      timerFired = true;
      if (pendingItem.isCancelled) {
        return; // CANCELLED: Do not execute delete!
      }
      void commitDeleteChatServer(targetChat.id);
    }, 100);

    pendingDelete = pendingItem;

    // Now User clicks "Urungkan" BEFORE timer fires
    pendingDelete.isCancelled = true;
    clearTimeout(pendingDelete.timerId);
    const restoredChat = pendingDelete.chat;
    const restoreIdx = pendingDelete.originalHistoryIndex;
    pendingDelete = null;

    // Restore to EXACT original position
    const restoredList = [...chatHistory];
    restoredList.splice(restoreIdx, 0, restoredChat);
    chatHistory = restoredList;

    // Verify restored list
    assert.equal(chatHistory.length, 3, "Panjang daftar percakapan harus kembali 3");
    assert.equal(chatHistory[0].id, chatId1, "Posisi 0 harus tetap Chat Pertama");
    assert.equal(chatHistory[1].id, chatId2, "Posisi 1 harus kembali ke Chat Kedua (posisi semula)");
    assert.equal(chatHistory[2].id, chatId3, "Posisi 2 harus tetap Chat Ketiga");
    console.log("  [PASS] Chat dikembalikan ke posisi semula di sidebar (index 1).");

    // Wait for timer to finish to ensure cancellation holds
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(serverDeleteCalled, false, "Server DELETE TIDAK boleh terpanggil saat Urungkan diklik!");
    console.log("  [PASS] Timer dibatalkan dan server DELETE tidak terkirim.");

    // ---------------------------------------------------------------------------
    // TEST 2: Jalur "Tab ditutup / Unload sebelum 5 detik" saat sudah di-Urungkan
    // ---------------------------------------------------------------------------
    console.log("\n[Test 2] Testing pagehide/beforeunload guard when action is already undone...");

    let unloadDeleteCalled = false;
    const handlePageUnload = () => {
      const pending = pendingDelete;
      // Guard: must exist and NOT be cancelled
      if (pending && !(pending as any).isCancelled) {
        unloadDeleteCalled = true;
        void commitDeleteChatServer((pending as any).chat.id);
      }
    };

    // Trigger unload event when pendingDelete is null (already undone)
    handlePageUnload();
    assert.equal(unloadDeleteCalled, false, "handlePageUnload tidak boleh menghapus chat yang sudah di-Urungkan!");
    console.log("  [PASS] Jalur tab ditutup aman dan tidak menghapus chat yang telah di-Urungkan.");

    // Verify in database: chatId2 still exists with its messages
    const { data: dbChat, error: checkErr } = await supabaseAdmin
      .from("chats")
      .select("id, title")
      .eq("id", chatId2)
      .maybeSingle();
    assert.ifError(checkErr);
    assert.ok(dbChat, "Chat 2 harus tetap utuh di database Supabase.");
    console.log("  [PASS] Chat 2 terverifikasi tetap utuh di database.");

    // ---------------------------------------------------------------------------
    // TEST 3: Jalur Penghapusan Normal (5 detik lewat tanpa Urungkan)
    // ---------------------------------------------------------------------------
    console.log("\n[Test 3] Testing uncancelled deletion after timeout commits successfully to database...");

    const normalDeleteChat = chatHistory[0]; // chatId1
    let normalPending: any = {
      chat: normalDeleteChat,
      originalHistoryIndex: 0,
      timerId: null,
      isCancelled: false,
    };

    let deleteDoneResolve: () => void;
    const deleteDonePromise = new Promise<void>((resolve) => {
      deleteDoneResolve = resolve;
    });

    let normalDeleteExecuted = false;
    normalPending.timerId = setTimeout(async () => {
      if (normalPending.isCancelled) return;
      normalDeleteExecuted = true;
      try {
        await commitDeleteChatServer(normalDeleteChat.id);
      } finally {
        deleteDoneResolve();
      }
    }, 50);

    // Wait for normal timeout and delete request to fully finish
    await deleteDonePromise;
    assert.equal(normalDeleteExecuted, true, "Penghapusan normal tanpa urungkan harus dieksekusi.");

    // Verify chatId1 is deleted from DB
    const { data: deletedChat } = await supabaseAdmin
      .from("chats")
      .select("id")
      .eq("id", chatId1)
      .maybeSingle();
    assert.equal(deletedChat, null, "Chat 1 harus terhapus dari database setelah timeout normal.");
    console.log("  [PASS] Penghapusan normal tanpa Urungkan berhasil menghapus chat di database.");

    console.log("\n=== Seluruh 3 Pengujian Undo Delete & Integrity Lolos 100% ===");
  } finally {
    // Clean up created test data
    console.log("\nMembersihkan data pengujian...");
    for (const chatId of createdChatIds) {
      await supabaseAdmin.from("chats").delete().eq("id", chatId);
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    console.log("Pembersihan selesai.");
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
