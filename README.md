# Axioma Backend - Voice Endpoints & Development Testing Guide

Lihat panduan lengkap pengujian dan keamanan di [../README.md](../README.md).

### Ringkasan Pengujian Dev Bypass
Header `X-Dev-Bypass: true` aktif hanya saat `NODE_ENV !== "production"`.

```bash
# STT Transcribe Test
curl -X POST http://localhost:5000/api/voice/transcribe \
  -H "X-Dev-Bypass: true" \
  -F "file=@audio.webm;type=audio/webm"

# TTS Speak Test
curl -X POST http://localhost:5000/api/voice/speak \
  -H "Content-Type: application/json" \
  -H "X-Dev-Bypass: true" \
  -d '{"text": "Halo Axioma"}' \
  --output test.mp3
```

