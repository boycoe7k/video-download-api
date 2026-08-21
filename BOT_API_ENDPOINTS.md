# Nexa VDL API — Endpoint Reference for the WhatsApp Bot

**Base URL:** `https://video-download-api-l5m6.onrender.com`

All requests include the header `X-API-KEY: <key>` when the server is running in API-key mode. In open mode (your current setup), no key is needed.

## 1. Get media info (metadata / thumbnail / quality options)

```
POST /api/media/info
Content-Type: application/json

{ "url": "https://www.youtube.com/watch?v=..." }
```

Returns video title, platform, duration, thumbnail, and available qualities. Use this before downloading so the bot can show the user what it found.

## 2. Start a download job

```
POST /api/media/download
Content-Type: application/json

{ "url": "...", "type": "video" | "audio", "quality": "360p" | "720p" | "1080p" | "best" }
```

Responds immediately with `HTTP 202`:

```json
{ "success": true, "jobId": "xxxxxxxxxx", "status": "queued" }
```

The download then runs in the background. Supported platforms are auto-detected from the URL: YouTube, TikTok, Facebook, Instagram.

## 3. Poll job status

```
GET /api/status/:jobId
```

```json
{ "success": true, "status": "processing", "progress": 45 }
```

Status values: `queued` → `processing` → `completed` (includes `title`, `size`, `downloadUrl`) → `failed` (includes `error`).

## 4. Get the finished file

```
GET /api/download/:jobId
```

Returns the actual MP4/MP3 file (`Content-Disposition: attachment`). Files expire **1 hour** after completion. Returns `410 Gone` once expired.

## 5. Health check

```
GET /api/health
```

## Typical bot flow

1. User sends `.yt <url>` → bot calls **POST /api/media/info** → replies with title + platform.
2. Bot calls **POST /api/media/download** → stores `jobId`.
3. Poll **GET /api/status/:jobId** every 3 seconds until `completed` or `failed`.
4. On completion, fetch **GET /api/download/:jobId** and send the file bytes as media to the user.
