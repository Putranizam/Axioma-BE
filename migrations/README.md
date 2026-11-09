# Panduan Migrasi Database Supabase Axioma

Direktori ini berisi seluruh skrip SQL migrasi berurutan untuk inisialisasi basis data PostgreSQL Supabase dari nol (*fresh install*) untuk proyek Axioma.

---

## Urutan Eksekusi Migrasi

Jalankan skrip SQL berikut secara berurutan di **Supabase Dashboard > SQL Editor**:

1. **`001_initial_schema.sql`**
   - Membuat tabel percakapan (`chats`), pesan (`messages`), dan masukan kualitas (`message_feedback`).
   - Menyertakan indeks performa untuk pencarian berdasarkan `user_id`, `chat_id`, dan waktu pembuatan.

2. **`002_gemini_daily_usage.sql`**
   - Membuat tabel pelacakan kuota harian panggilan Gemini AI (`gemini_daily_usage`).
   - Membuat fungsi PostgreSQL atomik `increment_gemini_daily_usage(DATE)` dengan `SECURITY DEFINER`.

3. **`003_turnstile_verifications.sql`**
   - Membuat tabel `user_turnstile_verifications` untuk menyimpan status lolos verifikasi Cloudflare Turnstile selama masa aktif (30 menit).

4. **`004_message_attachments.sql`**
   - Membuat tabel metadata lampiran pesan multimodal (`message_attachments`).
   - Relasi ke `chats` dan `messages` dibuat opsional (`NULLABLE`) saat upload awal, dan dikaitkan secara atomik saat pesan dikirim.
   - Menambahkan constraint batas ukuran file (maks. 10 MB) dan halaman PDF (maks. 30 halaman).
   - Menambahkan indeks pembersihan berkas yatim (`idx_message_attachments_orphan`).

5. **`005_rls_lockdown.sql`**
   - Mengaktifkan Row Level Security (RLS) pada ke-6 tabel.
   - Mencabut (*REVOKE*) semua izin akses dari role `anon` dan `authenticated`.
   - Memberikan (*GRANT*) izin penuh secara eksklusif hanya untuk role `service_role` (Backend Axioma).
   - Menghapus tabel percakapan dari publikasi `supabase_realtime` untuk mencegah penyadapan data via WebSocket client.

---

## Konfigurasi Supabase Storage (Bucket Lampiran)

Selain skrip tabel SQL di atas, bucket penyimpanan privat wajib dibuat untuk fitur lampiran multimodal:

1. Buka **Supabase Dashboard > Storage > New Bucket**.
2. Beri nama bucket: **`attachments`**.
3. **Public bucket**: Matikan toggle (**Private Bucket / OFF**).
4. **File size limit**: Masukkan `10485760` (10 MB).
5. **Allowed MIME types**: Masukkan daftar MIME berikut:
   ```text
   image/jpeg, image/png, image/webp, image/heic, image/heif, application/pdf
   ```
6. Simpan bucket.

---

## Verifikasi Pengaturan Lingkungan (Environment Variables)

Pada server backend (`.env`):
- `SUPABASE_URL`: URL project Supabase Anda (misal: `https://xyz.supabase.co`).
- `SUPABASE_SERVICE_ROLE_KEY`: Service Role Key Supabase (`sb_secret_...` / secret key). **JANGAN PERNAH** menggunakan public/anon key untuk backend.

---

## Verifikasi Keberhasilan Migrasi

Setelah seluruh file SQL dijalankan, Anda dapat memverifikasi integritas database dengan menjalankan script verifikasi di backend:
```bash
npm run test:auth
```
Script tersebut akan memverifikasi bahwa isolasi sesi, RLS, dan kepemilikan data pengguna berfungsi 100% tanpa celah kebocoran.

