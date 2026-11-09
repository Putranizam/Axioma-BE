import { supabaseAdmin as supabase, supabaseUrl, supabaseKey } from "./test-env";
import { app } from "../src/index";
import request from "supertest";
import { PDFDocument } from "pdf-lib";
import { randomUUID } from "crypto";

const TEST_USER_A = `test-user-att-a-${randomUUID()}`;
const TEST_USER_B = `test-user-att-b-${randomUUID()}`;
const NEW_CHAT_ID = randomUUID();

async function run() {
  console.log("=== Axioma Full Attachment & Multimodal Test Suite ===");
  console.log("User A:", TEST_USER_A);
  console.log("User B:", TEST_USER_B);
  console.log("New Chat ID:", NEW_CHAT_ID);

  let uploadedStoragePath: string | null = null;
  let uploadedAttachmentId: string | null = null;

  try {
  // 1. Test fake file disguised as JPG
  console.log("\n[1] Testing spoofed executable disguised as .jpg...");
  const fakeExeBuffer = Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00FakePEHeader");
  const fakeUploadRes = await request(app)
    .post("/api/attachments/upload")
    .set("X-User-Id", TEST_USER_A)
    .attach("files", fakeExeBuffer, "photo.jpg");

  console.log("  Status:", fakeUploadRes.status, fakeUploadRes.body);
  if (fakeUploadRes.status !== 400 || fakeUploadRes.body?.code !== "unsupported_file_type") {
    throw new Error(`Expected 400 unsupported_file_type for fake jpg, got ${fakeUploadRes.status}`);
  }
  console.log("  PASS: Spoofed file rejected with unsupported_file_type");

  // 2. Test PDF with > 30 pages (should be rejected)
  console.log("\n[2] Testing PDF exceeding 30 pages limit...");
  const largePdf = await PDFDocument.create();
  for (let i = 0; i < 35; i++) {
    largePdf.addPage();
  }
  const largePdfBytes = await largePdf.save();
  const largePdfRes = await request(app)
    .post("/api/attachments/upload")
    .set("X-User-Id", TEST_USER_A)
    .attach("files", Buffer.from(largePdfBytes), "long-document.pdf");

  console.log("  Status:", largePdfRes.status, largePdfRes.body);
  if (largePdfRes.status !== 400 || largePdfRes.body?.code !== "pdf_too_many_pages") {
    throw new Error(`Expected 400 pdf_too_many_pages for 35-page PDF, got ${largePdfRes.status}`);
  }
  console.log("  PASS: 35-page PDF rejected with pdf_too_many_pages");

  // 3. Test valid upload of a 1x1 JPEG image in a NEW CHAT session (chat_id is null or not in DB yet)
  console.log("\n[3] Testing valid upload of real JPEG image before chat exists in database...");
  // 1x1 white JPEG binary
  const validJpegBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
    0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
    0x00, 0xbf, 0x80, 0xff, 0xd9
  ]);

  const uploadRes = await request(app)
    .post("/api/attachments/upload")
    .set("X-User-Id", TEST_USER_A)
    .field("chat_id", NEW_CHAT_ID)
    .attach("files", validJpegBuffer, "test-white.jpg");

  console.log("  Upload status:", uploadRes.status);
  const attachmentsList = Array.isArray(uploadRes.body?.data)
    ? uploadRes.body.data
    : uploadRes.body?.data?.attachments;
  if (uploadRes.status !== 200 || !attachmentsList?.[0]?.id) {
    throw new Error(`Upload failed: ${JSON.stringify(uploadRes.body)}`);
  }

  const uploadedAtt = attachmentsList[0];
  uploadedAttachmentId = uploadedAtt.id;
  console.log("  PASS: Upload successful. Attachment ID:", uploadedAtt.id, "Path:", uploadedAtt.storage_path || "(generated)");
  if (!uploadedAtt.signed_url) throw new Error("Expected signed_url in upload response");

  // 4. Test Signed URL endpoint & Ownership protection (User B cannot access User A's attachment signed URL)
  console.log("\n[4] Testing GET /api/attachments/:id/signed-url and ownership isolation...");
  const userBSignedRes = await request(app)
    .get(`/api/attachments/${uploadedAtt.id}/signed-url`)
    .set("X-User-Id", TEST_USER_B);
  console.log("  User B access status:", userBSignedRes.status, userBSignedRes.body);
  if (userBSignedRes.status !== 403) {
    throw new Error(`Expected 403 forbidden for User B accessing User A attachment, got ${userBSignedRes.status}`);
  }
  console.log("  PASS: User B blocked with 403 Forbidden");

  const userASignedRes = await request(app)
    .get(`/api/attachments/${uploadedAtt.id}/signed-url`)
    .set("X-User-Id", TEST_USER_A);
  console.log("  User A access status:", userASignedRes.status);
  if (userASignedRes.status !== 200 || !userASignedRes.body?.data?.signed_url) {
    throw new Error(`User A failed to get fresh signed URL: ${JSON.stringify(userASignedRes.body)}`);
  }
  console.log("  PASS: User A retrieved fresh signed URL successfully");

  // 5. CRITICAL SCENARIO: "Chat baru + kirim foto sebagai pesan pertama"
  console.log("\n[5] Testing critical scenario: New chat session + send photo as first message...");
  const msgRes = await request(app)
    .post("/api/chats/message")
    .set("X-User-Id", TEST_USER_A)
    .send({
      chat_id: NEW_CHAT_ID,
      content: "Gambar apa ini? Jawab dalam satu kata singkat.",
      agent_id: "axioma-omni",
      attachment_ids: [uploadedAtt.id],
      stream: false,
    });

  console.log("  Send message status:", msgRes.status, "agent_id:", msgRes.body?.agent_id);
  if (msgRes.status !== 200 || !msgRes.body?.success) {
    throw new Error(`Send message with attachment failed: ${JSON.stringify(msgRes.body)}`);
  }
  console.log("  AI reply:", msgRes.body?.data);
  console.log("  PASS: Message sent and AI replied successfully with multimodal input!");

  // Verify attachment was linked to chat_id and message_id in database
  const { data: dbAtt, error: dbAttErr } = await supabase
    .from("message_attachments")
    .select("*")
    .eq("id", uploadedAtt.id)
    .single();

  if (dbAttErr || !dbAtt) throw new Error(`Database check error: ${dbAttErr?.message}`);
  console.log("  Database attachment record:", {
    id: dbAtt.id,
    chat_id: dbAtt.chat_id,
    message_id: dbAtt.message_id,
    mime_type: dbAtt.mime_type,
    storage_path: dbAtt.storage_path,
  });

  if (dbAtt.chat_id !== NEW_CHAT_ID) throw new Error("chat_id was not linked properly");
  if (!dbAtt.message_id) throw new Error("message_id was not linked properly");
  console.log("  PASS: Attachment correctly linked to chat_id and message_id in DB");

  // 6. Test GET /api/chats/:id/messages returns the attachment with fresh signed URL
  console.log("\n[6] Testing GET /api/chats/:id/messages returns message with attachments...");
  const getMsgsRes = await request(app)
    .get(`/api/chats/${NEW_CHAT_ID}/messages`)
    .set("X-User-Id", TEST_USER_A);

  if (getMsgsRes.status !== 200) throw new Error(`Get messages failed: ${getMsgsRes.status}`);
  const userMsgWithAtt = getMsgsRes.body?.data?.find((m: any) => m.role === "user");
  if (!userMsgWithAtt?.attachments || userMsgWithAtt.attachments.length === 0) {
    throw new Error("Expected attachments array in user message!");
  }
  console.log("  User message attachments in response:", userMsgWithAtt.attachments);
  if (!userMsgWithAtt.attachments[0].signed_url) {
    throw new Error("Missing signed_url in messages list attachment");
  }
  console.log("  PASS: Attachments loaded and populated with fresh signed URLs");

  // 7. Test chat deletion removes physical file from Supabase Storage
  console.log("\n[7] Testing DELETE /api/chats/:id removes physical file from storage...");
  const storagePath = dbAtt.storage_path;
  uploadedStoragePath = storagePath;
  // Verify file currently exists in storage
  const { data: beforeFile, error: beforeErr } = await supabase.storage
    .from("attachments")
    .download(storagePath);
  if (beforeErr || !beforeFile) {
    throw new Error(`File was not found in storage prior to delete: ${beforeErr?.message}`);
  }
  console.log("  File verified present in bucket:", storagePath, `(${beforeFile.size} bytes)`);

  // Delete chat
  const delChatRes = await request(app)
    .delete(`/api/chats/${NEW_CHAT_ID}`)
    .set("X-User-Id", TEST_USER_A);

  if (delChatRes.status !== 200) throw new Error(`Delete chat failed: ${delChatRes.status}`);
  console.log("  Chat deleted via API.");

  // Verify file was removed from storage
  const { data: afterFile, error: afterErr } = await supabase.storage
    .from("attachments")
    .download(storagePath);

  if (!afterErr) {
    throw new Error("Expected file to be DELETED from storage, but it still exists!");
  }
  console.log("  Storage download after delete correctly failed:", afterErr.message);
  console.log("  PASS: Physical file was permanently cleaned from Supabase Storage!");

  console.log("\n=======================================================");
  console.log("ALL FULL ATTACHMENT & MULTIMODAL TESTS PASSED (100%)!");
  console.log("=======================================================");
  } finally {
    // Thorough cleanup in case test threw early
    try {
      if (uploadedStoragePath) {
        await supabase.storage.from("attachments").remove([uploadedStoragePath]);
      }
      await supabase.from("message_attachments").delete().eq("chat_id", NEW_CHAT_ID);
      if (uploadedAttachmentId) {
        await supabase.from("message_attachments").delete().eq("id", uploadedAttachmentId);
      }
      const { data: leftAtts } = await supabase
        .from("message_attachments")
        .select("id, storage_path")
        .in("user_id", [TEST_USER_A, TEST_USER_B]);
      if (leftAtts && leftAtts.length > 0) {
        await supabase.storage.from("attachments").remove(leftAtts.map((a: any) => a.storage_path));
        await supabase.from("message_attachments").delete().in("id", leftAtts.map((a: any) => a.id));
      }
      await supabase.from("messages").delete().eq("chat_id", NEW_CHAT_ID);
      await supabase.from("chats").delete().eq("id", NEW_CHAT_ID);
    } catch (cleanupErr: any) {
      console.warn("Attachment test cleanup warning:", cleanupErr?.message);
    }
  }
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
