const express = require("express");
const rateLimit = require("express-rate-limit");
const { nanoid } = require("nanoid");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();

const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin || "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key, x-admin-key"
  );
  res.header("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEYS = (process.env.API_KEYS || "")
  .split(",")
  .map(k => k.trim())
  .filter(Boolean);
// Render sets RENDER_EXTERNAL_URL (https://<service>.onrender.com). Fall back
// to localhost only when no external URL is advertised.
const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

const keyStats = new Map(API_KEYS.map(key => [
  key,
  { enabled: true, requests: 0, lastUsedAt: null }
]));
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || "./storage");
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB || 100) * 1024 * 1024;
const JOB_TTL = Number(process.env.JOB_TTL_SECONDS || 3600) * 1000;

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const jobs = new Map();

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  limit: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: "draft-8",
  legacyHeaders: false
});

app.use("/api/", limiter);

function auth(req, res, next) {
  // If no API_KEYS are configured, the API runs in open mode (no key
  // required). When keys are configured, only valid enabled keys pass.
  if (!API_KEYS.length) {
    req.apiKey = null;
    return next();
  }

  const supplied = req.get("x-api-key") || "";
  if (!/^Nexora_[A-Za-z0-9_-]{12,}$/.test(supplied)) {
    return res.status(401).json({ success: false, error: "Invalid API key" });
  }

  const stats = keyStats.get(supplied);
  if (!stats || !stats.enabled) {
    return res.status(401).json({ success: false, error: "Invalid or disabled API key" });
  }

  stats.requests += 1;
  stats.lastUsedAt = new Date().toISOString();
  req.apiKey = supplied;
  next();
}

const PLATFORMS = {
  youtube: {
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]
  },
  tiktok: {
    hosts: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "www.tiktok.com", "m.tiktok.com"]
  },
  facebook: {
    hosts: ["facebook.com", "www.facebook.com", "fb.watch", "m.facebook.com", "web.facebook.com"]
  },
  instagram: {
    hosts: ["instagram.com", "www.instagram.com", "m.instagram.com"]
  }
};

const PLATFORM_ORDER = ["youtube", "tiktok", "facebook", "instagram"];

function detectPlatform(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    for (const [name, cfg] of Object.entries(PLATFORMS)) {
      if (cfg.hosts.some(h => u.hostname.toLowerCase() === h || u.hostname.toLowerCase().endsWith("." + h))) {
        return name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function validUrl(value) {
  return detectPlatform(value) !== null;
}

// Lightweight rotating proxy support: when YTDLP_PROXY is not set, the API
// can try a short list of free HTTPS proxies so a single datacenter IP ban
// does not block every download. Each proxy is verified once, cached, and
// rotated in order; failures fall back to direct (no-proxy) access.
const FREE_PROXY_LIST_URL = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=all";
let cachedProxies = { list: [], at: 0, fetchedAt: 0 };

async function getProxyList() {
  if (cachedProxies.list.length && Date.now() - cachedProxies.fetchedAt < 10 * 60_000) return cachedProxies.list;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(FREE_PROXY_LIST_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const text = await res.text();
    const list = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => /^\d+\.\d+\.\d+\.\d+:\d{2,5}$/.test(l))
      .slice(0, 25);
    cachedProxies = { list, at: 0, fetchedAt: Date.now() };
    return list;
  } catch {
    return cachedProxies.list;
  }
}

function probeProxy(proxyUrl) {
  // TCP-level probe: open a socket through the proxy to any host. If the
  // CONNECT handshake completes, the proxy is alive (regardless of whether
  // the target eventually 403s).
  return new Promise(resolve => {
    try {
      const u = new URL(proxyUrl);
      const net = require("net");
      const sock = net.connect(Number(u.port), u.hostname, () => {
        sock.write(
          `CONNECT ${u.hostname}:${u.port} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\n\r\n`
        );
      });
      let buf = "";
      sock.on("data", data => {
        buf += data.toString();
        if (/HTTP\/1\.\d 2\d\d/.test(buf)) {
          sock.destroy();
          resolve(true);
        } else if (/HTTP\/1\.\d (?!2\d\d)/.test(buf) || buf.length > 200) {
          sock.destroy();
          resolve(false);
        }
      });
      sock.on("error", () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 8000);
    } catch {
      resolve(false);
    }
  });
}

// Cache of proxies that were actually tested end-to-end (CONNECT + HTTP GET
// through the proxy). A proxy that connects but returns 403/5xx for the
// target gets marked bad for 15 minutes so it is not retried repeatedly.
const badProxies = new Map();
const PROXY_BAD_TTL = 15 * 60_000;

async function verifyProxyFunctionally(proxyUrl) {
  // Functional check: route an actual HTTPS GET to the target platform
  // through the proxy. If the proxy itself works but the target 403s, that
  // tells us the proxy's IP is also bad — skip it and try the next.
  // Raw CONNECT over a plain TCP socket (https.request would incorrectly
  // perform a TLS handshake against the proxy itself), then TLS + HTTP GET
  // through the tunnel to confirm the target responds.
  return new Promise(resolve => {
    try {
      const net = require("net");
      const tls = require("tls");
      const u = new URL(proxyUrl);
      const sock = net.connect(Number(u.port), u.hostname, () => {
        sock.write(
          `CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n`
        );
      });
      let buf = "";
      sock.on("data", data => {
        buf += data.toString();
        if (/HTTP\/1\.\d 2\d\d/.test(buf)) {
          const tlsSock = tls.connect(
            { host: "www.youtube.com", servername: "www.youtube.com", socket: sock },
            () => {
              tlsSock.write(
                "GET / HTTP/1.1\r\nHost: www.youtube.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
              );
              let tbuf = "";
              tlsSock.on("data", d => {
                tbuf += d.toString();
                const match = tbuf.match(/HTTP\/1\.\d (\d+)/);
                if (match) {
                  tlsSock.destroy();
                  // 403 from the target means this proxy's IP is banned too.
                  resolve(match[1] === "403" ? "banned" : true);
                }
                if (tbuf.length > 2000) { tlsSock.destroy(); resolve(true); }
              });
              tlsSock.on("error", () => resolve(false));
              setTimeout(() => { tlsSock.destroy(); resolve(false); }, 8000);
            }
          );
          tlsSock.on("error", () => resolve(false));
          setTimeout(() => { tlsSock.destroy(); resolve(false); }, 12000);
          sock.removeAllListeners("data");
        } else if (/HTTP\/1\.\d (?!2\d\d)/.test(buf) || buf.length > 200) {
          sock.destroy();
          resolve(false);
        }
      });
      sock.on("error", () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 15000);
    } catch {
      resolve(false);
    }
  });
}

async function pickWorkingProxy() {
  const env = process.env.YTDLP_PROXY || "";
  if (env) return env;
  const list = await getProxyList();
  if (!list.length) return "";
  const now = Date.now();
  // Try up to N proxies: first require TCP-CONNECT to succeed, then require
  // the target to respond without banning that proxy's IP either.
  for (let n = 0; n < Math.min(6, list.length); n++) {
    const candidate = list[cachedProxies.at % list.length];
    cachedProxies.at += 1;
    const bad = badProxies.get(candidate);
    if (bad && now - bad < PROXY_BAD_TTL) continue;
    const connectOk = await probeProxy(`http://${candidate}`);
    if (!connectOk) continue;
    const check = await verifyProxyFunctionally(`http://${candidate}`);
    if (check === "banned") {
      badProxies.set(candidate, now);
      continue;
    }
    if (check) return `http://${candidate}`;
  }
  return "";
}

function safeName(name) {
  return String(name || "video").replace(/[^\w.\- ]+/g, "_").slice(0, 150);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `Process exited with code ${code}`));
    });
  });
}

async function mediaInfo(url, type) {
  // Requires yt-dlp installed on the server. Works for YouTube, TikTok,
  // Facebook, and Instagram (yt-dlp is the common extractor behind them).
  const platform = detectPlatform(url);
  const clientFallbacks = pf => {
    if (pf === "youtube") return ["android,web_embedded", "tv,web_safari", "web_embedded", null];
    if (pf === "tiktok") return ["tiktok", "tiktok_embedded", null];
    return [null];
  };
  let lastErr = null;
  for (const client of clientFallbacks(platform)) {
    const args = [
      "--dump-single-json",
      "--no-playlist",
      "--skip-download",
      "--no-warnings",
      "--extractor-retries", "5",
      "--socket-timeout", "20",
      "--sleep-interval", "1",
      "--max-sleep-interval", "4",
    ];
  let proxy = process.env.YTDLP_PROXY || "";
  if (!proxy) proxy = await pickWorkingProxy().catch(() => "");
  if (proxy) args.push("--proxy", proxy);
  args.push("--extractor-args", "youtube:player_skip=webpage,config,js");
  // player_client is YouTube-only; other platforms have no such argument.
  if (client && platform === "youtube") {
    args.push("--extractor-args", `youtube:player_client=${client}`);
  }
  args.push(url);
    try {
      const { stdout } = await runCommand("yt-dlp", args);
      return JSON.parse(stdout);
    } catch (err) {
      lastErr = err;
      const msg = err.message || "";
      if (/(sign in|not a bot|reloaded|timed out|blocked|403|429)/i.test(msg)) {
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function downloadAuthorized(url, job, type, quality) {
  const id = job.id;
  const output = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);

  job.status = "processing";
  job.progress = 0;

    const isAudio = type === "audio";
  // Compound selectors fall back gracefully when a platform only
  // exposes muxed formats (e.g. TikTok, Instagram, Facebook).
  const qualityNum = Number(quality) || 720;
  const format =
    isAudio
      ? "bestaudio/best"
      : quality === "best"
        ? "bv*+ba/b"
        : `bv*[height<=${qualityNum}]+ba/b`;
  // For audio extraction we pass only the audio selector to yt-dlp and
  // let it re-encode the single stream; --merge-output-format is skipped
  // because "mp3" is not a valid container for merging.
  const clientFallbacks = platform => {
    if (platform === "youtube") return ["android,web_embedded", "web_embedded", "tv,web_safari"];
    if (platform === "tiktok") return ["tiktok", "tiktok_embedded"];
    return [null];
  };
  // YouTube web clients get "Sign in to confirm you're not a bot" checks;
  // the android client is far more reliable from datacenter IPs.
  const clients = clientFallbacks(job.platform);
  const baseArgs = () => {
    const a = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "-f", format,
      "-o", output,
      "--extractor-retries", "5",
      "--socket-timeout", "20",
      "--retries", "5",
      "--fragment-retries", "5",
      "--sleep-interval", "2",
      "--max-sleep-interval", "8",
      "--extractor-args", "youtube:player_skip=webpage,config,js",
      url
    ];
    if (!isAudio) {
      a.push("--merge-output-format", "mp4");
    } else {
      a.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    }
    return a;
  };
  const runOnce = args =>
    new Promise((resolve, reject) => {
      const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stdout.on("data", data => {
        const text = data.toString();
        const match = text.match(/(\d+(?:\.\d+)?)%/);
        if (match) job.progress = Math.min(99, Number(match[1]));
      });
      child.stderr.on("data", data => {
        stderr += data.toString();
        process.stdout.write("[yt-dlp] " + data.toString().trim().slice(0, 200) + "\n");
      });
      child.on("error", reject);
      child.on("close", code => {
        if (code !== 0) return reject(new Error(stderr || `yt-dlp exited with ${code}`));
        resolve(stderr);
      });
    });
  const outputExists = () =>
    fs
      .readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith(`${id}.`))
      .map(f => path.join(DOWNLOAD_DIR, f));
  return new Promise((resolve, reject) => {
    const tryClients = async attempts => {
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        const client = clients[i % clients.length];
        const args = baseArgs();
        let proxy = process.env.YTDLP_PROXY || "";
        if (!proxy && i > 0) proxy = await pickWorkingProxy().catch(() => "");
        if (proxy) args.push("--proxy", proxy);
        // player_client is YouTube-only; other platforms have no such argument.
        if (client && job.platform === "youtube") {
          args.push("--extractor-args", `youtube:player_client=${client}`);
        }
        try {
          const stderr = await runOnce(args);
          const files = outputExists();
          if (files.length) {
            const file = files[0];
            const stat = fs.statSync(file);
            if (stat.size > MAX_FILE_SIZE) {
              fs.unlinkSync(file);
              reject(new Error("File exceeds MAX_FILE_SIZE_MB"));
              return;
            }
            job.status = "completed";
            job.progress = 100;
            job.file = file;
            job.size = stat.size;
            job.expiresAt = Date.now() + JOB_TTL;
            resolve();
            return;
          }
        } catch (err) {
          lastErr = err;
          const msg = err.message || "";
          // Bot check or transient failure → try the next client after a pause.
          if (/(sign in|not a bot|reloaded|timed out|blocked|403|429|rehydration|connection aborted|remote end closed)/i.test(msg) && i < attempts - 1) {
            console.log("[download] retry with next client after bot-check/transient error");
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
            continue;
          }
        }
        if (i < attempts - 1) {
          console.log("[download] attempt failed, sleeping before retry");
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        }
      }
      reject(lastErr || new Error("Download failed after all attempts"));
    };
    // YouTube: try several player clients in order (android first — it
    // survives the "Sign in to confirm you're not a bot" check that the web
    // client triggers from datacenter IPs). Other platforms use the default
    // client. Each transient/bot-check failure retries with the next client.
    tryClients(3).catch(err => {
      // Surface the real yt-dlp error text so it shows in the queue.
      const last = (err.message || "").trim();
      job.error = last.slice(0, 500);
      reject(err);
    });
  });
}

app.get("/api/admin/keys", (req, res) => {
  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey || (req.get("x-admin-key") || "") !== adminKey) {
    return res.status(401).json({ success: false, error: "Invalid admin key" });
  }

  res.json({
    success: true,
    keys: API_KEYS.map(key => ({
      key: key.slice(0, 10) + "…",
      enabled: keyStats.get(key)?.enabled ?? false,
      requests: keyStats.get(key)?.requests ?? 0,
      lastUsedAt: keyStats.get(key)?.lastUsedAt ?? null
    }))
  });
});

app.post("/api/admin/keys/:key/disable", (req, res) => {
  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey || (req.get("x-admin-key") || "") !== adminKey) {
    return res.status(401).json({ success: false, error: "Invalid admin key" });
  }

  const key = req.params.key;
  const stats = keyStats.get(key);
  if (!stats) return res.status(404).json({ success: false, error: "Key not found" });

  stats.enabled = false;
  res.json({ success: true, message: "Key disabled" });
});

app.post("/api/admin/keys/:key/enable", (req, res) => {
  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey || (req.get("x-admin-key") || "") !== adminKey) {
    return res.status(401).json({ success: false, error: "Invalid admin key" });
  }

  const key = req.params.key;
  const stats = keyStats.get(key);
  if (!stats) return res.status(404).json({ success: false, error: "Key not found" });

  stats.enabled = true;
  res.json({ success: true, message: "Key enabled" });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "video-download-api",
    platforms: PLATFORM_ORDER,
    time: new Date().toISOString()
  });
});

// Non-sensitive diagnostics: whether a static proxy is configured, the
// current commit-friendly build marker, and how many free proxies are
// cached. Helps confirm a redeploy happened and whether proxy rotation is
// armed.
app.get("/api/debug/proxy", (req, res) => {
  const env = process.env.YTDLP_PROXY || "";
  res.json({
    success: true,
    envProxySet: env.length > 0,
    envProxyValue: env ? env.replace(/@/, "@***").replace(/\/\/[A-Za-z0-9_.:-]+@/, "//***@") : "",
    cachedProxyCount: cachedProxies.list.length,
    proxyListFresh: Date.now() - cachedProxies.fetchedAt < 10 * 60_000,
    nodeVersion: process.versions.node,
    ytDlpVersion: require("child_process")
      .execSync("yt-dlp --version", { encoding: "utf8" })
      .trim(),
    gitCommit: require("child_process")
      .execSync("git rev-parse --short HEAD 2>/dev/null || echo unknown", { encoding: "utf8" })
      .trim()
  });
});

function extractMediaInfo(info, platform) {
  return {
    id: info.id,
    platform,
    title: info.title,
    uploader: info.uploader || info.channel || info.uploader_id,
    duration: info.duration,
    thumbnail: info.thumbnail,
    webpageUrl: info.webpage_url,
    isLive: Boolean(info.is_live)
  };
}

app.post("/api/media/info", auth, async (req, res) => {
  const { url } = req.body || {};
  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      success: false,
      error: "A supported URL is required (YouTube, TikTok, Facebook, or Instagram)"
    });
  }

  try {
    const info = await mediaInfo(url, "video");
    res.json({ success: true, ...extractMediaInfo(info, platform) });
  } catch (error) {
    console.error("[info]", error.message);
    res.status(422).json({ success: false, error: "Unable to retrieve video information" });
  }
});

// Legacy alias kept for YouTube-only callers
app.post("/api/youtube/info", auth, async (req, res) => {
  const { url } = req.body || {};
  if (!detectPlatform(url) || detectPlatform(url) !== "youtube") {
    return res.status(400).json({ success: false, error: "A valid YouTube URL is required" });
  }

  try {
    const info = await mediaInfo(url, "video");
    res.json({ success: true, ...extractMediaInfo(info, "youtube") });
  } catch (error) {
    res.status(422).json({ success: false, error: "Unable to retrieve video information" });
  }
});

app.post("/api/media/download", auth, async (req, res) => {
  const { url, type = "video", quality = "720p" } = req.body || {};

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      success: false,
      error: "A supported URL is required (YouTube, TikTok, Facebook, or Instagram)"
    });
  }
  if (!["video", "audio"].includes(type)) {
    return res.status(400).json({ success: false, error: "type must be video or audio" });
  }

  const id = nanoid(14);
  const job = {
    id,
    url,
    platform,
    type,
    quality,
    status: "queued",
    progress: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + JOB_TTL
  };
  jobs.set(id, job);

  // Only use this endpoint for content you own or are authorized to download.
  mediaInfo(url, type)
    .then(info => { job.title = info.title || ""; })
    .catch(err => console.error("[info] title fetch failed:", err.message));

  downloadAuthorized(url, job, type, quality)
    .catch(err => {
      const msg = (err && (err.message || String(err))) || "Unknown error";
      console.log("[download failed]", msg);
      job.status = "failed";
      job.error = msg;
      job.expiresAt = Date.now() + JOB_TTL;
    });

  res.status(202).json({
    success: true,
    jobId: id,
    status: job.status,
    statusUrl: `${BASE_URL}/api/status/${id}`
  });
});

// Legacy alias kept for YouTube-only callers
app.post("/api/youtube/download", auth, async (req, res) => {
  const { url, type = "video", quality = "720p" } = req.body || {};

  if (detectPlatform(url) !== "youtube") {
    return res.status(400).json({ success: false, error: "A valid YouTube URL is required" });
  }
  if (!["video", "audio"].includes(type)) {
    return res.status(400).json({ success: false, error: "type must be video or audio" });
  }

  const id = nanoid(14);
  const job = {
    id,
    url,
    platform: "youtube",
    type,
    quality,
    status: "queued",
    progress: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + JOB_TTL
  };
  jobs.set(id, job);

  // Only use this endpoint for videos you own or are authorized to download.
  mediaInfo(url, type)
    .then(info => { job.title = info.title || ""; })
    .catch(err => console.error("[info] title fetch failed:", err.message));

  downloadAuthorized(url, job, type, quality)
    .catch(err => {
      const msg = (err && (err.message || String(err))) || "Unknown error";
      console.log("[download failed]", msg);
      job.status = "failed";
      job.error = msg;
      job.expiresAt = Date.now() + JOB_TTL;
    });

  res.status(202).json({
    success: true,
    jobId: id,
    status: job.status,
    statusUrl: `${BASE_URL}/api/status/${id}`
  });
});

app.get("/api/status/:id", auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "Job not found" });

  const result = {
    success: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress
  };

  if (job.status === "completed") {
    result.title = job.title;
    result.size = job.size;
    result.downloadUrl = `${BASE_URL}/api/download/${job.id}`;
    result.expiresAt = new Date(job.expiresAt).toISOString();
  }

  if (job.status === "failed")
    result.error = job.error || "The download job failed";

  res.json(result);
});

app.get("/api/download/:id", auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "completed" || !job.file) {
    return res.status(404).json({ success: false, error: "File is not available" });
  }

  if (Date.now() > job.expiresAt || !fs.existsSync(job.file)) {
    return res.status(410).json({ success: false, error: "File has expired" });
  }

  const ext = path.extname(job.file).toLowerCase();
  const contentType = ext === ".mp3" ? "audio/mpeg" : "video/mp4";
  const filename = `${safeName(job.title || "media")}${ext}`;

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", fs.statSync(job.file).size);
  res.sendFile(job.file);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt && now > job.expiresAt) {
      if (job.file && fs.existsSync(job.file)) {
        try { fs.unlinkSync(job.file); } catch {}
      }
      jobs.delete(id);
    }
  }
}, 60_000);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`YouTube API listening on ${BASE_URL}`);
});

process.on("unhandledRejection", err => {
  console.log("[unhandledRejection]", err && err.message);
});

process.on("uncaughtException", err => {
  console.log("[uncaughtException]", err && err.message);
});
