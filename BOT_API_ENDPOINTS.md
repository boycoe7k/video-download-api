# Netfy API — Endpoint Reference for the WhatsApp Bot

**Base URL:** Set `API_URL` in `bot.js` to the backend origin. Requests do not need an API-key header.

## Get media information

```http
POST /api/media/info
Content-Type: application/json

{"url":"https://www.youtube.com/watch?v=..."}
```

Returns title, platform, duration, thumbnail and related metadata.

## Start a download job

```http
POST /api/media/download
Content-Type: application/json

{"url":"...","type":"video","quality":"720p"}
```

Returns `HTTP 202` with a `jobId`. Supported platform URLs are detected automatically: YouTube, TikTok, Facebook and Instagram. Use only content the requester owns or is allowed to download.

## Poll job status and retrieve the file

```http
GET /api/status/:jobId
GET /api/download/:jobId
```

The status moves from `queued` to `processing`, then `completed` or `failed`. Completed responses include a `downloadUrl`; media files expire after one hour by default.

## Health check

```http
GET /api/health
```

The API is rate-limited by client IP. Bot developers do not need to configure or send API keys.
