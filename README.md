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

## Platform reliability notes

The API hardens downloads against each platform's anti-bot checks:

- **YouTube:** the web client is challenged with "Sign in to confirm you're not a bot" from datacenter IPs. The server first tries the `android` + `web_embedded` players, which are not challenged, and automatically retries with `web_embedded` and then `tv`/`web_safari` on transient failures. A short random pause is inserted between requests so bursts do not look scripted. No cookies are required.
- **TikTok / Facebook / Instagram:** these occasionally return "Your IP address is blocked from accessing this post" for certain videos on certain server IPs. The server retries with jitter, but this is a platform-side, IP-level block that cannot be fully eliminated server-side. If a video fails repeatedly, it usually downloads fine a few hours later, or from a different network. For stubborn Instagram/Facebook videos, upload a `cookies.txt` (exported from your own logged-in browser session) and pass it to yt-dlp via a small config override.

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

The API supports two modes, controlled by the `API_KEYS` environment variable:

**Open mode (no key needed):** if `API_KEYS` is empty or not set, all endpoints work without authentication (only `/api/admin/*` still requires `ADMIN_KEY`). This is convenient for personal or internal deployments behind a private URL.

**Keyed mode:** if `API_KEYS` is set, every `/api/*` endpoint except `/api/health` requires:

```text
x-api-key: YOUR_API_KEY
```


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

In **open mode** (no `API_KEYS` set), no client key is required and all endpoints work without authentication. Admin endpoints always require `ADMIN_KEY`.

In **keyed mode**, set several keys in `.env`, separated by commas:

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

> **Tip:** leaving `API_KEYS` empty is a deliberate convenience for personal deployments behind a private URL (e.g. an unlisted Render or Railway endpoint). If your instance is publicly reachable, set at least one key to prevent abuse, since downloads consume bandwidth.

## Proxy support (datacenter IP blocks)

YouTube, TikTok, Facebook, and Instagram routinely block cloud/datacenter IP ranges ("Your IP address is blocked from accessing this post", 403). The server mitigates this automatically: when a request is blocked, it fetches rotating public proxies, verifies each one end-to-end (connects and reaches the target platform without returning 403), and retries the download through a working proxy. Proxies whose own IPs are banned by the target are blacklisted for 15 minutes.

For production consistency, automatic proxy rotation is unreliable by nature (free proxy pools are mostly datacenter ranges that targets ban too). The recommended production setup is a private HTTP/HTTPS proxy with a **residential IP**:

```env
YTDLP_PROXY=http://user:pass@host:port
```

When `YTDLP_PROXY` is set, every yt-dlp extraction goes through it and the automatic rotation is disabled. Diagnostic endpoint `GET /api/debug/proxy` reports the current proxy configuration (safe to expose publicly: no secrets are returned).

## Production notes

- Put the API behind HTTPS.
- The server includes a small CORS middleware that echoes the request `Origin` (and handles preflight), so browsers can call the API directly from any frontend. Preflight is answered with `204`.
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
