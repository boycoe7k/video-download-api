const net = require("node:net");

const catalog = [
  { id: "media-download", name: "Video & audio download", category: "Media", status: "ready", method: "POST", path: "/api/media/download", note: "Existing job-based API for supported platforms; use only content you own or may download." },
  { id: "media-info", name: "Video metadata", category: "Media", status: "ready", method: "POST", path: "/api/media/info", note: "Metadata for the existing supported platforms." },
  { id: "youtube-search", name: "YouTube search", category: "Media", status: "ready", method: "GET", path: "/api/search?q=...", note: "Existing search endpoint." },
  { id: "web-screenshot", name: "Webpage screenshot", category: "Web", status: "setup_required", method: "POST", path: "/api/screenshot", note: "Needs a screenshot provider and server-side API key." },
  { id: "drive-files", name: "Google Drive file access", category: "Files", status: "setup_required", method: "GET", path: "/api/drive/files/:id", note: "Must use Google OAuth and respect the signed-in user's Drive permissions." },
  { id: "mediafire", name: "MediaFire links", category: "Files", status: "provider_limited", method: "—", path: "—", note: "No unofficial access-control bypass; use provider-authorized links only." },
  { id: "github-repo", name: "GitHub repository info", category: "Developer", status: "ready", method: "GET", path: "/api/github/:owner/:repo", note: "Public GitHub repository metadata." },
  { id: "github-release", name: "GitHub latest release", category: "Developer", status: "ready", method: "GET", path: "/api/github/:owner/:repo/releases/latest", note: "Metadata and official asset URLs; downloads remain on GitHub." },
  { id: "ip-info", name: "IP information", category: "Network", status: "ready", method: "GET", path: "/api/ip/:address", note: "Public IP geolocation lookup; provider rate limits apply." },
  { id: "x-media", name: "X/Twitter media", category: "Media", status: "provider_limited", method: "—", path: "—", note: "Use official API access for authorized content; no scraping or access-control bypass." },
  { id: "play-store", name: "Play Store app lookup", category: "Apps", status: "provider_limited", method: "—", path: "—", note: "App listing links/metadata only; no third-party APK extraction." },
  { id: "telegram-send", name: "Telegram message", category: "Messaging", status: "setup_required", method: "POST", path: "/api/telegram/send", note: "Needs a bot token and restricted recipient configuration." },
  { id: "sms-send", name: "SMS send", category: "Messaging", status: "setup_required", method: "POST", path: "/api/sms/send", note: "Needs an SMS provider account; messages may incur charges." },
  { id: "ai-image", name: "AI image generation", category: "AI", status: "setup_required", method: "POST", path: "/api/ai/image", note: "Needs a configured image-generation provider and budget controls." },
  { id: "text-to-speech", name: "Text to speech", category: "AI", status: "setup_required", method: "POST", path: "/api/ai/speech", note: "Needs a configured speech provider and server-side key." },
  { id: "music", name: "Licensed music search", category: "Media", status: "provider_limited", method: "—", path: "—", note: "Only licensed or user-authorized sources; not a piracy downloader." },
  { id: "wallpapers", name: "Wallpaper search", category: "Media", status: "setup_required", method: "GET", path: "/api/wallpapers", note: "Needs an approved wallpaper provider/API key." },
  { id: "qr", name: "QR code generation", category: "Utilities", status: "planned", method: "—", path: "—", note: "Queued for the next API module." },
  { id: "url-metadata", name: "URL metadata preview", category: "Web", status: "planned", method: "—", path: "—", note: "Queued; must include private-network/SSRF protections." },
  { id: "dns-lookup", name: "DNS lookup", category: "Network", status: "planned", method: "—", path: "—", note: "Queued for the next API module." },
  { id: "weather", name: "Weather lookup", category: "Data", status: "ready", method: "GET", path: "/api/weather?lat=...&lon=...", note: "Current weather from a public provider; attribution and provider limits apply." },
  { id: "currency", name: "Currency conversion", category: "Data", status: "ready", method: "GET", path: "/api/currency?from=USD&to=EUR", note: "Latest reference rates from a public data provider." },
  { id: "translation", name: "Text translation", category: "AI", status: "setup_required", method: "POST", path: "/api/translate", note: "Needs a translation provider/API key." },
  { id: "url-shortener", name: "URL shortener", category: "Utilities", status: "planned", method: "—", path: "—", note: "Queued; requires a persistent store and abuse controls." },
  { id: "text-extract", name: "Document text extraction", category: "Files", status: "planned", method: "—", path: "—", note: "Queued; file-type and size limits required." },
  { id: "audio-transcription", name: "Audio transcription", category: "AI", status: "setup_required", method: "POST", path: "/api/ai/transcribe", note: "Needs a configured speech-to-text provider." }
];

function register(app, auth) {
  app.get("/api/platform/catalog", (_req, res) => {
    const configured = {
      "web-screenshot": Boolean(process.env.SCREENSHOTONE_ACCESS_KEY),
      "drive-files": Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN),
      "telegram-send": Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALLOWED_CHAT_IDS),
      "sms-send": Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM && process.env.SMS_ALLOWED_TO),
      "ai-image": Boolean(process.env.AI_PROVIDER_API_KEY),
      "text-to-speech": Boolean(process.env.AI_PROVIDER_API_KEY),
      wallpapers: Boolean(process.env.UNSPLASH_ACCESS_KEY)
    };
    const apis = catalog.map(api => configured[api.id] ? { ...api, status: "ready" } : api);
    res.json({ success: true, service: "Netfy API Platform", total: apis.length, apis });
  });

  app.get("/api/ip", auth, (req, res) => lookupIp(req, res, req.query.address));
  app.get("/api/ip/:address", auth, (req, res) => lookupIp(req, res, req.params.address));

  app.get("/api/github/:owner/:repo", auth, async (req, res) => {
    const { owner, repo } = req.params;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
      return res.status(400).json({ success: false, error: "Invalid GitHub owner or repository" });
    }
    try {
      const data = await githubGet(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      res.json({ success: true, repository: pickRepoFields(data) });
    } catch (err) {
      res.status(err.status || 502).json({ success: false, error: err.publicMessage || "GitHub request failed" });
    }
  });

  app.get("/api/github/:owner/:repo/releases/latest", auth, async (req, res) => {
    const { owner, repo } = req.params;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
      return res.status(400).json({ success: false, error: "Invalid GitHub owner or repository" });
    }
    try {
      const data = await githubGet(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`);
      res.json({
        success: true,
        release: {
          tag: data.tag_name,
          name: data.name,
          publishedAt: data.published_at,
          pageUrl: data.html_url,
          sourceZip: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/refs/tags/${encodeURIComponent(data.tag_name)}.zip`,
          assets: (data.assets || []).map(asset => ({ name: asset.name, size: asset.size, downloadUrl: asset.browser_download_url, contentType: asset.content_type }))
        }
      });
    } catch (err) {
      res.status(err.status || 502).json({ success: false, error: err.publicMessage || "GitHub request failed" });
    }
  });

  app.post("/api/screenshot", auth, async (req, res) => {
    const key = process.env.SCREENSHOTONE_ACCESS_KEY;
    const target = safeHttpsUrl(req.body?.url);
    if (!target) return res.status(400).json({ success: false, error: "A public HTTPS URL is required" });
    if (!key) return setupRequired(res, "Screenshot provider is not configured");
    const imageUrl = new URL("https://api.screenshotone.com/take");
    imageUrl.searchParams.set("access_key", key);
    imageUrl.searchParams.set("url", target);
    imageUrl.searchParams.set("format", "png");
    imageUrl.searchParams.set("viewport_width", String(clampInt(req.body?.width, 1280, 320, 2560)));
    imageUrl.searchParams.set("viewport_height", String(clampInt(req.body?.height, 800, 240, 1800)));
    try {
      const response = await fetch(imageUrl, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) return res.status(502).json({ success: false, error: "Screenshot provider request failed" });
      const image = Buffer.from(await response.arrayBuffer());
      if (image.length > 4 * 1024 * 1024) return res.status(413).json({ success: false, error: "Screenshot exceeds the 4 MB response limit" });
      res.setHeader("Content-Type", response.headers.get("content-type") || "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(image);
    } catch { res.status(502).json({ success: false, error: "Screenshot provider timed out or is unavailable" }); }
  });

  app.get("/api/drive/files/:id", auth, async (req, res) => {
    const token = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(req.params.id)) return res.status(400).json({ success: false, error: "Invalid Drive file ID" });
    if (!token) return setupRequired(res, "Google Drive OAuth access token is not configured");
    try {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(req.params.id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) return res.status(response.status === 404 ? 404 : 403).json({ success: false, error: response.status === 404 ? "File not found" : "Drive denied access; confirm the authorized account can read this file" });
      const data = Buffer.from(await response.arrayBuffer());
      const maxBytes = Number(process.env.GOOGLE_DRIVE_MAX_FILE_MB || 10) * 1024 * 1024;
      if (data.length > maxBytes) return res.status(413).json({ success: false, error: `File exceeds the configured ${Math.floor(maxBytes / 1048576)} MB API limit` });
      res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Content-Disposition", "attachment; filename=drive-file");
      res.send(data);
    } catch {
      res.status(502).json({ success: false, error: "Google Drive is unavailable" });
    }
  });

  app.post("/api/telegram/send", auth, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
    const chatId = String(req.body?.chatId || "");
    const text = String(req.body?.text || "");
    if (!token || !allowed.length) return setupRequired(res, "Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS before sending");
    if (!allowed.includes(chatId)) return res.status(403).json({ success: false, error: "Recipient is not on the configured allowlist" });
    if (!text || text.length > 4000) return res.status(400).json({ success: false, error: "text must contain 1–4000 characters" });
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || !data.ok) return res.status(502).json({ success: false, error: "Telegram did not accept the message" });
      res.json({ success: true, messageId: data.result.message_id, chatId });
    } catch { res.status(502).json({ success: false, error: "Telegram is unavailable" }); }
  });

  app.post("/api/sms/send", auth, async (req, res) => {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    const allowed = (process.env.SMS_ALLOWED_TO || "").split(",").map(x => x.trim()).filter(Boolean);
    const to = String(req.body?.to || "");
    const body = String(req.body?.text || "");
    if (!sid || !token || !from || !allowed.length) return setupRequired(res, "Configure Twilio credentials and SMS_ALLOWED_TO recipient allowlist");
    if (!allowed.includes(to)) return res.status(403).json({ success: false, error: "Recipient is not on the configured allowlist" });
    if (!/^\+[1-9]\d{7,14}$/.test(to) || !body || body.length > 1200) return res.status(400).json({ success: false, error: "Use an E.164 number and 1–1200 characters of text" });
    try {
      const form = new URLSearchParams({ To: to, From: from, Body: body });
      const authHeader = Buffer.from(`${sid}:${token}`).toString("base64");
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, { method: "POST", headers: { Authorization: `Basic ${authHeader}`, "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(12000) });
      if (!response.ok) return res.status(502).json({ success: false, error: "SMS provider rejected the request" });
      const data = await response.json();
      res.status(202).json({ success: true, messageId: data.sid, status: data.status });
    } catch { res.status(502).json({ success: false, error: "SMS provider is unavailable" }); }
  });

  app.post("/api/ai/image", auth, async (req, res) => {
    const key = process.env.AI_PROVIDER_API_KEY;
    const prompt = String(req.body?.prompt || "").trim();
    if (!key) return setupRequired(res, "AI_PROVIDER_API_KEY is not configured on the backend");
    if (!prompt || prompt.length > 2000) return res.status(400).json({ success: false, error: "prompt must contain 1–2000 characters" });
    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1", prompt, size: "1024x1024", n: 1 }), signal: AbortSignal.timeout(90000) });
      if (!response.ok) return res.status(502).json({ success: false, error: "Image provider request failed; check provider access and billing configuration" });
      const data = await response.json();
      res.json({ success: true, imageBase64: data.data?.[0]?.b64_json || null, revisedPrompt: data.data?.[0]?.revised_prompt || null });
    } catch { res.status(502).json({ success: false, error: "Image provider timed out or is unavailable" }); }
  });

  app.post("/api/ai/speech", auth, async (req, res) => {
    const key = process.env.AI_PROVIDER_API_KEY;
    const input = String(req.body?.text || "").trim();
    if (!key) return setupRequired(res, "AI_PROVIDER_API_KEY is not configured on the backend");
    if (!input || input.length > 4000) return res.status(400).json({ success: false, error: "text must contain 1–4000 characters" });
    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: "alloy", input, response_format: "mp3" }), signal: AbortSignal.timeout(60000) });
      if (!response.ok) return res.status(502).json({ success: false, error: "Speech provider request failed; check provider access and billing configuration" });
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length > 8 * 1024 * 1024) return res.status(413).json({ success: false, error: "Generated audio exceeds the 8 MB response limit" });
      res.json({ success: true, contentType: "audio/mpeg", audioBase64: audio.toString("base64") });
    } catch { res.status(502).json({ success: false, error: "Speech provider timed out or is unavailable" }); }
  });

  app.get("/api/wallpapers", auth, async (req, res) => {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return setupRequired(res, "UNSPLASH_ACCESS_KEY is not configured");
    const query = String(req.query.q || "wallpaper").slice(0, 80);
    try {
      const url = new URL("https://api.unsplash.com/search/photos");
      url.searchParams.set("query", query);
      url.searchParams.set("orientation", "landscape");
      url.searchParams.set("per_page", "12");
      const response = await fetch(url, { headers: { Authorization: `Client-ID ${key}` }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) return res.status(502).json({ success: false, error: "Wallpaper provider request failed" });
      const data = await response.json();
      res.json({ success: true, results: (data.results || []).map(photo => ({ id: photo.id, description: photo.alt_description, imageUrl: photo.urls?.regular, downloadUrl: photo.links?.download_location, author: photo.user?.name, authorUrl: photo.user?.links?.html })) });
    } catch { res.status(502).json({ success: false, error: "Wallpaper provider is unavailable" }); }
  });

  app.get("/api/weather", auth, async (req, res) => {
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return res.status(400).json({ success: false, error: "lat and lon must be valid coordinates" });
    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", lat);
      url.searchParams.set("longitude", lon);
      url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m");
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return res.status(502).json({ success: false, error: "Weather provider is unavailable" });
      const data = await response.json();
      res.json({ success: true, latitude: data.latitude, longitude: data.longitude, current: data.current, units: data.current_units });
    } catch { res.status(502).json({ success: false, error: "Weather provider timed out or is unavailable" }); }
  });

  app.get("/api/currency", auth, async (req, res) => {
    const from = String(req.query.from || "USD").toUpperCase();
    const to = String(req.query.to || "EUR").toUpperCase();
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return res.status(400).json({ success: false, error: "from and to must be ISO-style 3-letter currency codes" });
    try {
      const response = await fetch(`https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return res.status(422).json({ success: false, error: "Unsupported currency or exchange-rate provider unavailable" });
      const data = await response.json();
      res.json({ success: true, date: data.date, base: data.base, rates: data.rates });
    } catch { res.status(502).json({ success: false, error: "Exchange-rate provider timed out or is unavailable" }); }
  });
}

async function lookupIp(req, res, value) {
  const address = value || "";
  if (address && net.isIP(address) === 0) {
    return res.status(400).json({ success: false, error: "address must be a valid IPv4 or IPv6 address" });
  }
  const url = address ? `https://ipapi.co/${encodeURIComponent(address)}/json/` : "https://ipapi.co/json/";
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Netfy-API-Platform/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return res.status(502).json({ success: false, error: "IP information provider is unavailable" });
    const data = await response.json();
    if (data.error) return res.status(404).json({ success: false, error: data.reason || "IP lookup failed" });
    res.json({ success: true, ip: data.ip, version: net.isIP(data.ip), city: data.city, region: data.region, country: data.country_name, countryCode: data.country_code, timezone: data.timezone, org: data.org, asn: data.asn });
  } catch {
    res.status(502).json({ success: false, error: "IP information provider timed out or is unavailable" });
  }
}

async function githubGet(url) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "Netfy-API-Platform" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const err = new Error("GitHub request failed");
    err.status = response.status === 404 ? 404 : response.status === 403 ? 429 : 502;
    err.publicMessage = response.status === 404 ? "GitHub repository or release not found" : response.status === 403 ? "GitHub API rate limit reached; configure GITHUB_TOKEN" : "GitHub API is unavailable";
    throw err;
  }
  return response.json();
}

function pickRepoFields(data) {
  return { fullName: data.full_name, description: data.description, url: data.html_url, defaultBranch: data.default_branch, stars: data.stargazers_count, forks: data.forks_count, license: data.license?.spdx_id || null, updatedAt: data.updated_at, archived: data.archived };
}

function setupRequired(res, message) {
  return res.status(503).json({ success: false, error: message, code: "INTEGRATION_NOT_CONFIGURED" });
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
    const ipVersion = net.isIP(host);
    if (ipVersion === 4 && (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "0.0.0.0")) return null;
    if (ipVersion === 6 && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) return null;
    return url.toString();
  } catch { return null; }
}

module.exports = { register, catalog };
