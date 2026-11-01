# Netfy API Platform on Netlify

This repository now contains a static developer console at `site/`, a Netlify Functions gateway at `netlify/functions/api.js`, and the long-running Express/yt-dlp backend. Netlify hosts the console and forwards JSON/API requests to a separately hosted Docker backend. The downloader worker is not run inside Netlify Functions: it needs yt-dlp, FFmpeg, local temporary storage and asynchronous jobs.

## Deploy the console

1. In Netlify, import the private GitHub repository `boycoe7k/video-download-api`.
2. Set the production branch to the branch containing this platform update (or merge it into your chosen production branch after review).
3. Netlify detects `netlify.toml`; the publish directory is `site` and functions are in `netlify/functions`.
4. Add the Netlify environment variable `API_ORIGIN` with the public HTTPS origin of the Docker backend, for example `https://api.example.com`. Do not include `/api` at the end.
5. Deploy. The console will show backend connection status. The Netlify proxy handles API responses up to about 4.5 MB; media download links should point directly to the backend, not be streamed through a serverless function.

Netlify Functions are not a replacement for the persistent media worker. Do not put yt-dlp/FFmpeg download jobs or large file storage into the Netlify function. Keep the existing Docker deployment for that backend.

## New API routes

`GET /api/platform/catalog` returns the catalog and configured readiness flags. `GET /api/ip/:address` looks up IPv4/IPv6 information. `GET /api/github/:owner/:repo` and `GET /api/github/:owner/:repo/releases/latest` use GitHub's public REST API and return official repository/release links. `GET /api/weather?lat=...&lon=...` and `GET /api/currency?from=USD&to=EUR` use public data providers. Existing media jobs and YouTube search remain available.

Credential-gated routes are implemented for screenshot generation (`POST /api/screenshot`), authorized Google Drive reads (`GET /api/drive/files/:id`), allowlisted Telegram messages (`POST /api/telegram/send`), allowlisted Twilio SMS (`POST /api/sms/send`), OpenAI image generation (`POST /api/ai/image`) and text-to-speech (`POST /api/ai/speech`), and Unsplash wallpaper search (`GET /api/wallpapers?q=...`). These routes return `503 INTEGRATION_NOT_CONFIGURED` until their provider credentials are added to the backend host's secret store. SMS recipients and Telegram chat IDs must be explicitly allowlisted.

The console lists 26 modules. Modules marked planned or provider-limited are clearly identified and are not falsely presented as implemented. Google Play app downloads are not provided; the catalog is limited to authorized listing/metadata workflows. X/Twitter, MediaFire and music downloads must use provider-authorized or licensed access. Do not use these APIs to bypass paywalls, DRM, login requirements, platform rate limits or access controls. The existing media downloader is for content the caller owns or is authorized to download.

## No API keys for callers

Public API routes do not use consumer API keys, account keys, or admin-key headers. Clients call endpoints directly and are rate-limited by IP (30 requests per minute by default). The Netlify gateway strips legacy `x-api-key` and `x-admin-key` headers instead of forwarding them.

Some upstream providers require credentials owned by the platform operator. These are optional server-side integration credentials, stored only in the backend host's secret store—not API keys that callers create or send. Add `GITHUB_TOKEN`, `SCREENSHOTONE_ACCESS_KEY`, `GOOGLE_DRIVE_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, Twilio credentials plus `SMS_ALLOWED_TO`, `AI_PROVIDER_API_KEY`, and/or `UNSPLASH_ACCESS_KEY` only when enabling each provider integration. Never commit these values or place them in browser code.

The Google Drive endpoint uses a backend-provided OAuth access token and only returns data that token is permitted to read. For a multi-user production product, replace this single-service-token setup with a full per-user OAuth consent and token-refresh flow before exposing the Drive integration to customers.
