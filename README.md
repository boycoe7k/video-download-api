# Netfy API Platform

A growing public API platform built on the existing Node.js/Express media API. The platform console is hosted on Netlify, while the Docker-compatible backend handles API routes and long-running media jobs.

## No caller API keys

API consumers do **not** need to create, receive, or send an API key. Call public endpoints directly. The backend applies per-IP rate limits (`RATE_LIMIT_MAX`, default 30 requests per minute). Do not publish it as unlimited or use it to spam providers. Messaging endpoints additionally restrict destinations to backend-configured allowlists.

Some third-party providers require credentials belonging to the platform owner. Those optional provider credentials stay in the backend host's secret store; they are not caller keys and are never sent by API consumers. No real credentials belong in this repository.

## Existing media API

Supported media sites are YouTube, TikTok, Facebook, and Instagram. Use the downloader only for content you own or are authorized to access.

### Get metadata

```http
POST /api/media/info
Content-Type: application/json

{"url":"https://www.youtube.com/watch?v=VIDEO_ID"}
```

### Start a media job

```http
POST /api/media/download
Content-Type: application/json

{"url":"https://www.tiktok.com/@user/video/123","type":"video","quality":"720p"}
```

The response includes a `jobId`; poll `GET /api/status/:jobId`. On completion, fetch `GET /api/download/:jobId`. Files expire after `JOB_TTL_SECONDS`.

Legacy YouTube routes remain available: `POST /api/youtube/info` and `POST /api/youtube/download`. The search endpoint is `GET /api/search?q=...` or `POST /api/search` with `{"q":"..."}`.

## Platform APIs

`GET /api/platform/catalog` lists 26 modules and their real readiness status. Working modules include GitHub repository details/releases, IP information, weather and currency rates. Optional provider-backed modules include screenshot generation, permission-scoped Google Drive reads, Telegram messages, allowlisted SMS, AI image generation, text-to-speech and wallpaper search. Their provider integrations return `503 INTEGRATION_NOT_CONFIGURED` until their backend credentials are supplied.

Modules shown as planned or provider-limited are not falsely advertised as working. X/Twitter, MediaFire, Play Store APK and music downloads must use authorized/licensed sources; this project does not bypass logins, DRM, paywalls or platform controls.

## Run the backend

Requirements: Node.js 20+, `yt-dlp`, and FFmpeg for media merging/audio conversion.

```bash
cp .env.example .env
npm install
npm start
```

For a Docker deployment:

```bash
docker compose up -d --build
```

Health check: `GET /api/health`. API responses and provider integrations are rate-limited. If exposed publicly, use HTTPS and configure appropriate per-IP limits and monitoring.

## Netlify console

Netlify serves the static console from `site/` and routes `/api/*` through `netlify/functions/api.js`. Set Netlify's `API_ORIGIN` environment variable to the HTTPS origin of the Docker backend (no `/api` suffix). The gateway handles small API responses; media files should be downloaded directly from the backend. Netlify Functions do not host the yt-dlp/FFmpeg worker.

See [`NETLIFY_PLATFORM.md`](NETLIFY_PLATFORM.md) for deployment and provider configuration. Provider credentials should be added only to the backend host's secret manager. Never put provider secrets in browser JavaScript, Git, or a public response.

## Testing

Run `./test_api.sh` with the backend running. The smoke checks call endpoints without any caller key and do not start downloads.
