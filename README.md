# Video Download API (YouTube, TikTok, Facebook, Instagram)

Node.js + Express API intended as a backend for a WhatsApp bot. It downloads videos and audio from **YouTube, TikTok, Facebook, and Instagram** — only when the requester owns the content or has permission to download it.

The server uses [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) as its extractor engine, which transparently supports all four platforms.

## Supported platforms

| Platform | Info | Video | Audio |
|----------|------|-------|-------|
| YouTube (`youtube.com`, `youtu.be`, `youtube-nocookie.com`) | Yes | Yes | Yes |
| TikTok (`tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com`) | Yes | Yes | Yes |
| Facebook (`facebook.com`, `fb.watch`, `m.facebook.com`) | Yes | Yes | Yes |
| Instagram (`instagram.com`, `m.instagram.com`) | Yes | Yes | Yes |

## Requirements

- Node.js 20+
- `yt-dlp` (pinned to the latest nightly in Docker)
- FFmpeg (needed for merging/conversion)

For production, Docker is easiest.

## Local setup

1. Copy `.env.example` to `.env`.
2. Set strong `API_KEYS` and `ADMIN_KEY`.
3. Install dependencies:

```bash
npm install
```

4. Install `yt-dlp` and FFmpeg on the host:

```bash
pip3 install -U yt-dlp
sudo apt-get install ffmpeg   # Ubuntu/Debian
```

5. Start:

```bash
npm start
```

Health check:

```bash
GET /api/health
```

## Docker

```bash
cp .env.example .env
docker compose up -d --build
```

## Authentication

Send:

```text
x-api-key: YOUR_API_KEY
```

on every `/api/*` endpoint except `/api/health`.

## Unified endpoints (recommended)

### Get media metadata

```http
POST /api/media/info
Content-Type: application/json
x-api-key: YOUR_API_KEY

{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

Works for any supported platform (YouTube, TikTok, Facebook, Instagram). Returns the detected `platform` alongside metadata.

### Start a download

```http
POST /api/media/download
Content-Type: application/json
x-api-key: YOUR_API_KEY

{
  "url": "https://www.tiktok.com/@user/video/123",
  "type": "video",
  "quality": "720p"
}
```

- `type`: `"video"` (default) or `"audio"` (converted to MP3).
- `quality`: `"best"`, or a height like `"720p"`, `"360p"` (default). Quality hints are applied when the platform exposes format variants; platforms with only muxed formats fall back gracefully to the closest available format.

The API returns a `jobId`. Poll the returned `statusUrl`.

For audio:

```json
{
  "url": "https://www.facebook.com/VIDEO_URL",
  "type": "audio"
}
```

### Check job status

```http
GET /api/status/:id
x-api-key: YOUR_API_KEY
```

Possible statuses: `queued`, `processing`, `completed`, `failed`. When `completed`, a `downloadUrl` is returned. Download files expire after `JOB_TTL_SECONDS`.

### Download the file

```http
GET /api/download/:id
x-api-key: YOUR_API_KEY
```

## Legacy YouTube-only endpoints

For backward compatibility, the original YouTube-specific endpoints still work and behave identically for YouTube URLs:

```http
POST /api/youtube/info
POST /api/youtube/download
```

Non-YouTube URLs sent to these endpoints return `400`.

## WhatsApp bot integration

Your bot should:

1. Detect a YouTube/TikTok/Facebook/Instagram URL.
2. Call `/api/media/info` if you want to show the title/duration first.
3. Call `/api/media/download`.
4. Poll `/api/status/:id`.
5. When `status=completed`, send the returned `downloadUrl` to your WhatsApp media-sending code.
6. Handle `failed`, `404`, and `410` responses.

Do not expose the API key inside client-side code or public WhatsApp messages.

## Multiple API keys

Set several keys in `.env`, separated by commas:

```env
API_KEYS=Nexora_7Kp9xQ4mV8zL2nR6,Nexora_B4xT8pLm2Qw7Yk9C
ADMIN_KEY=your-long-admin-secret
```

All client keys must start with `Nexora_`.

Use any enabled client key:

```http
x-api-key: Nexora_7Kp9xQ4mV8zL2nR6
```

### Admin key management

List masked keys and usage:

```http
GET /api/admin/keys
x-admin-key: YOUR_ADMIN_KEY
```

Disable a key:

```http
POST /api/admin/keys/Nexora_7Kp9xQ4mV8zL2nR6/disable
x-admin-key: YOUR_ADMIN_KEY
```

Enable it again:

```http
POST /api/admin/keys/Nexora_7Kp9xQ4mV8zL2nR6/enable
x-admin-key: YOUR_ADMIN_KEY
```

For production, store keys in a database/secret manager rather than relying on `.env`, and use HTTPS.

## Production notes

- Put the API behind HTTPS.
- Use a long random API key.
- Keep `storage/` outside the public web root.
- Add a reverse proxy such as Nginx or a managed HTTPS gateway.
- Use a persistent job queue such as Redis/BullMQ if you expect many simultaneous downloads.
- Consider object storage for large files.
- Keep the file-size limit appropriate for your WhatsApp provider.
- Review each platform's Terms of Service and the rights associated with each video before enabling downloading.

## Testing

A test script is included (`test_api.sh` in the project root of the repository, run with `./test_api.sh`). It exercises auth, validation, admin key management, and real downloads from all four platforms. Requires the server running with the keys from the example environment.

## Important implementation note

This project deliberately does not implement mechanisms intended to bypass access controls, DRM, authentication, or restrictions. It is for content you are authorized to download.
