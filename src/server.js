const express = require("express");
const rateLimit = require("express-rate-limit");
const { nanoid } = require("nanoid");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEYS = (process.env.API_KEYS || "")
  .split(",")
  .map(k => k.trim())
  .filter(Boolean);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
  if (!API_KEYS.length) {
    return res.status(500).json({ success: false, error: "API_KEYS is not configured" });
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
  const args = [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--extractor-retries", "3",
    "--socket-timeout", "15",
    url
  ];
  const { stdout } = await runCommand("yt-dlp", args);
  return JSON.parse(stdout);
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
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "-f", format,
    "-o", output,
    "--extractor-retries", "3",
    "--socket-timeout", "15",
    "--retries", "5",
    "--fragment-retries", "5",
    url
  ];

  if (!isAudio) {
    args.push("--merge-output-format", "mp4");
  } else {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  }

  return new Promise((resolve, reject) => {
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

      const candidates = fs.readdirSync(DOWNLOAD_DIR)
        .filter(f => f.startsWith(`${id}.`))
        .map(f => path.join(DOWNLOAD_DIR, f));

      if (!candidates.length) return reject(new Error("Download completed but output file was not found"));

      const file = candidates[0];
      const stat = fs.statSync(file);

      if (stat.size > MAX_FILE_SIZE) {
        fs.unlinkSync(file);
        return reject(new Error("File exceeds MAX_FILE_SIZE_MB"));
      }

      job.status = "completed";
      job.progress = 100;
      job.file = file;
      job.size = stat.size;
      job.expiresAt = Date.now() + JOB_TTL;
      resolve();
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
      console.log("[download failed]", err && err.message);
      job.status = "failed";
      job.error = err.message;
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
      console.log("[download failed]", err && err.message);
      job.status = "failed";
      job.error = err.message;
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

  if (job.status === "failed") result.error = "The download job failed";

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
}, 60_000).unref();

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
