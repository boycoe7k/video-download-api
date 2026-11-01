/*
 * Nexa VDL WhatsApp Bot
 * ---------------------
 * Multi-platform video downloader bot built on the Render video-download API.
 *
 * Commands:
 *   .yt   <url>             Download a YouTube video by URL
 *   .yt   <url> mp3         Download YouTube audio (MP3)
 *   .yt   <url> 1080p       Download YouTube video at a specific quality
 *   .song <query>           Search YouTube for a song and pick #1 result
 *   .tt   <url>             Download a TikTok video
 *   .ig   <url>             Download an Instagram reel/video
 *   .fb   <url>             Download a Facebook video
 *   .help                   Show help text
 *
 * Setup:
 *   1. npm install whatsapp-web.js qrcode-terminal
 *   2. Fill in API_URL and API_KEY below
 *   3. node bot.js  (scan the QR code once)
 *
 * WhatsApp Web is automated with whatsapp-web.js (the most common free option).
 * If you use a different library (Baileys, venom, etc.) the API logic in the
 * `downloadFromApi` / `searchAndDownload` functions is the same — just adapt the
 * send/reply helpers.
 */

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// ---------------------------------------------------------------------------
// CONFIG — fill these in
// ---------------------------------------------------------------------------
const API_URL = "https://video-download-api-l5m6.onrender.com";
const API_KEY = process.env.API_KEY || ""; // set X-API-KEY header (leave "" if open mode)

const POLL_INTERVAL_MS = 3000; // how often to check job status
const MAX_POLL_ATTEMPTS = 120; // give up after ~6 min
const MAX_SEARCH_RESULTS = 5;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
const headers = {
  "Content-Type": "application/json",
  ...(API_KEY ? { "X-API-KEY": API_KEY } : {}),
};

async function apiInfo(url) {
  const res = await fetch(`${API_URL}/api/media/info`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "info fetch failed");
  return data;
}

async function apiDownload(url, type = "video", quality = "720p") {
  const res = await fetch(`${API_URL}/api/media/download`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, type, quality }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "download request failed");
  return data.jobId;
}

async function apiStatus(jobId) {
  const res = await fetch(`${API_URL}/api/status/${jobId}`, { headers });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "status fetch failed");
  return data;
}

/** Search YouTube for songs via the public YouTube search page (no API key). */
async function searchYouTube(query) {
  const results = [];
  try {
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
        query + " site:youtube.com"
      )}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const html = await res.text();
    // Pull video URLs from result links
    const re = /watch\?v=([A-Za-z0-9_-]{11})/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) && results.length < MAX_SEARCH_RESULTS) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        results.push(`https://www.youtube.com/watch?v=${m[1]}`);
      }
    }
  } catch (err) {
    console.error("[search] fallback failed:", err.message);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Core: start a download and wait for it, then reply with the file
// ---------------------------------------------------------------------------
async function downloadFromApi(msg, url, opts = {}) {
  const { type = "video", quality = "720p", searchLabel } = opts;

  await msg.reply(`⏳ Starting… getting ${searchLabel || url} info…`);

  let info;
  try {
    info = await apiInfo(url);
  } catch (err) {
    return msg.reply(`❌ ${err.message}`);
  }

  const label = (info.title || searchLabel || url).slice(0, 60);
  await msg.reply(
    `🎬 *${label}*\n` +
      `📌 ${info.platform || ""} · ${type === "audio" ? "MP3" : quality}\n` +
      `⏱ Preparing file… this can take a minute.`
  );

  let jobId;
  try {
    jobId = await apiDownload(url, type, quality);
  } catch (err) {
    return msg.reply(`❌ ${err.message}`);
  }

  // Poll until completed or failed
  let status;
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      status = await apiStatus(jobId);
    } catch (err) {
      return msg.reply(`❌ ${err.message}`);
    }

    if (status.status === "completed") break;
    if (status.status === "failed") {
      return msg.reply(`❌ Download failed: ${status.error || "unknown error"}\n\nTry again or check the link.`);
    }
    // progress ping every 30 seconds
    if (attempts % 10 === 0 && status.progress > 0) {
      await msg.reply(`⏳ Progress: ${status.progress}%…`);
    }
  }

  if (!status || status.status !== "completed") {
    return msg.reply("❌ The download took too long — try again in a moment.");
  }

  // Fetch the finished file and send it as media
  const fileRes = await fetch(`${API_URL}/api/download/${jobId}`, { headers });
  if (!fileRes.ok) return msg.reply("❌ The file expired — try again (files last 1 hour).");

  const contentType = fileRes.headers.get("content-type") || "";
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const mimeType = contentType.startsWith("audio/") ? "audio/mpeg" : "video/mp4";
  const filename = (status.title || "media").slice(0, 40);
  const media = new MessageMedia(mimeType, buffer.toString("base64"), filename);

  await msg.reply(media, undefined, {
    caption: `✅ *${label}*`,
  });
}

/** .song: search YouTube, pick best result, download as MP3 */
async function searchAndDownload(msg, query) {
  await msg.reply(`🔎 Searching for "${query}"…`);
  const results = await searchYouTube(query);
  if (results.length === 0) {
    return msg.reply(`❌ No results found for "${query}". Try a different search.`);
  }

  const url = results[0];
  await msg.reply(`🎵 Found: ${url}\n⏳ Downloading audio…`);
  await downloadFromApi(msg, url, { type: "audio", quality: "best", searchLabel: query });
}

// ---------------------------------------------------------------------------
// URL extractors — grab the first URL in a message
// ---------------------------------------------------------------------------
function extractUrl(text) {
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Bot client
// ---------------------------------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("Scan this QR code with WhatsApp:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => console.log("✅ Bot is ready!"));

client.on("message", async (msg) => {
  if (!msg.body) return;
  const text = msg.body.trim();

  if (!text.startsWith(".")) return;

  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");
  const url = extractUrl(args);

  switch (cmd) {
    case "yt": {
      if (!url) return msg.reply("📎 Usage: *.yt* <youtube-url> [mp3|360p|720p|1080p]\nExample: .yt https://youtu.be/dQw4w9WgXcQ mp3");
      const second = (args.replace(url, "") || "").trim().toLowerCase();
      const type = second === "mp3" ? "audio" : "video";
      const quality = type === "audio" ? "best" : (second && !second.startsWith("mp3") ? second : "720p");
      return downloadFromApi(msg, url, { type, quality });
    }

    case "song": {
      if (!args.trim()) return msg.reply("🎵 Usage: *.song* <song name>\nExample: .song blinding lights the weeknd");
      return searchAndDownload(msg, args.trim());
    }

    case "tt": {
      if (!url) return msg.reply("📎 Usage: *.tt* <tiktok-url>\nExample: .tt https://vm.tiktok.com/xxxxxx");
      return downloadFromApi(msg, url);
    }

    case "ig": {
      if (!url) return msg.reply("📎 Usage: *.ig* <instagram-url>\nExample: .ig https://www.instagram.com/reel/xxxxxx");
      return downloadFromApi(msg, url);
    }

    case "fb": {
      if (!url) return msg.reply("📎 Usage: *.fb* <facebook-url>\nExample: .fb https://www.facebook.com/watch/?v=xxxxxx");
      return downloadFromApi(msg, url);
    }

    case "help":
      return msg.reply(
        "*Nexa VDL Bot* 🎬\n\n" +
          "`.yt <url> [mp3|quality]` — YouTube video/audio\n" +
          "`.song <name>` — Search & download a song (MP3)\n" +
          "`.tt <url>` — TikTok video\n" +
          "`.ig <url>` — Instagram reel/video\n" +
          "`.fb <url>` — Facebook video\n\n" +
          "Power: " + API_URL
      );

    default:
      // ignore unknown commands
      return;
  }
});

client.on("disconnected", (reason) => {
  console.log("⚠️ Disconnected:", reason);
  process.exit(1);
});

client.initialize();
