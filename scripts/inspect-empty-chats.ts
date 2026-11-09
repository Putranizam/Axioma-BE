import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  '';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log('Inspecting Storage Bucket and Database...');

  // 1. Check all message_attachments
  const { data: atts, error: attErr } = await supabaseAdmin
    .from('message_attachments')
    .select('*');

  // 2. Check all empty chats (message_count = 0)
  const { data: allChats } = await supabaseAdmin
    .from('chats')
    .select('id, user_id, title, created_at');

  const emptyChatsWithAttachments: any[] = [];
  const emptyChatsWithoutAttachments: any[] = [];

  for (const c of allChats || []) {
    const { count } = await supabaseAdmin
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('chat_id', c.id);

    const chatAtts = (atts || []).filter((a) => a.chat_id === c.id);

    if ((count ?? 0) === 0) {
      if (chatAtts.length > 0) {
        emptyChatsWithAttachments.push({
          ...c,
          message_count: 0,
          attachments: chatAtts,
        });
      } else {
        emptyChatsWithoutAttachments.push({
          ...c,
          message_count: 0,
        });
      }
    }
  }

  // 3. Check physical file existence for attachments of empty chats
  for (const item of emptyChatsWithAttachments) {
    for (const att of item.attachments) {
      const { data: fileData, error: fileErr } = await supabaseAdmin.storage
        .from('attachments')
        .download(att.storage_path);

      att.physical_file_exists = !fileErr && !!fileData;
      att.physical_file_size = fileData ? (await fileData.arrayBuffer()).byteLength : null;
      att.physical_file_error = fileErr ? fileErr.message : null;
    }
  }

  console.log('\n======================================================');
  console.log('DAFTAR CHAT KOSONG DENGAN LAMPIRAN (TARGET BERSIHKAN):');
  console.log('======================================================');
  console.log(JSON.stringify(emptyChatsWithAttachments, null, 2));

  console.log('\n======================================================');
  console.log('CHAT KOSONG LAINNYA (TANPA LAMPIRAN):');
  console.log('======================================================');
  console.log(JSON.stringify(emptyChatsWithoutAttachments, null, 2));
}

main().catch(console.error);
