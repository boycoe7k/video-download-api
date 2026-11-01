const API = "/api";
const fallbackCatalog = [
  ["media-download","Video & audio download","Media","ready","POST","/api/media/download","Existing job-based API for supported platforms; use only content you own or may download."],
  ["media-info","Video metadata","Media","ready","POST","/api/media/info","Metadata for supported platforms."],
  ["youtube-search","YouTube search","Media","ready","GET","/api/search?q=...","Search endpoint."],
  ["web-screenshot","Webpage screenshot","Web","setup_required","POST","/api/screenshot","Needs an approved screenshot provider and server-side key."],
  ["drive-files","Google Drive file access","Files","setup_required","GET","/api/drive/files/:id","Google OAuth; only files the user is permitted to access."],
  ["mediafire","MediaFire links","Files","provider_limited","—","—","Provider-authorized links only; no access-control bypass."],
  ["github-repo","GitHub repository info","Developer","ready","GET","/api/github/:owner/:repo","Public GitHub repository metadata."],
  ["github-release","GitHub latest release","Developer","ready","GET","/api/github/:owner/:repo/releases/latest","Release metadata and official asset URLs."],
  ["ip-info","IP information","Network","ready","GET","/api/ip/:address","Public IP lookup; provider rate limits apply."],
  ["x-media","X/Twitter media","Media","provider_limited","—","—","Official API access for authorized content; no scraping bypass."],
  ["play-store","Play Store app lookup","Apps","provider_limited","—","—","Listing links/metadata only; no third-party APK extraction."],
  ["telegram-send","Telegram message","Messaging","setup_required","POST","/api/telegram/send","Needs bot credentials and restricted recipients."],
  ["sms-send","SMS send","Messaging","setup_required","POST","/api/sms/send","Needs provider credentials; messages may incur charges."],
  ["ai-image","AI image generation","AI","setup_required","POST","/api/ai/image","Needs a configured image provider and budget controls."],
  ["text-to-speech","Text to speech","AI","setup_required","POST","/api/ai/speech","Needs provider configuration."],
  ["music","Licensed music search","Media","provider_limited","—","—","Licensed or user-authorized sources only."],
  ["wallpapers","Wallpaper search","Media","setup_required","GET","/api/wallpapers","Needs an approved wallpaper provider."],
  ["qr","QR code generation","Utilities","planned","—","—","Planned."],
  ["url-metadata","URL metadata preview","Web","planned","—","—","Planned; requires SSRF protections."],
  ["dns-lookup","DNS lookup","Network","planned","—","—","Planned."],
  ["weather","Weather lookup","Data","setup_required","GET","/api/weather","Needs a weather data provider."],
  ["currency","Currency conversion","Data","setup_required","GET","/api/currency","Needs an exchange-rate source."],
  ["translation","Text translation","AI","setup_required","POST","/api/translate","Needs a translation provider."],
  ["url-shortener","URL shortener","Utilities","planned","—","—","Requires persistent storage and abuse controls."],
  ["text-extract","Document text extraction","Files","planned","—","—","Requires file type and size limits."],
  ["audio-transcription","Audio transcription","AI","setup_required","POST","/api/ai/transcribe","Needs a speech-to-text provider."]
].map(([id,name,category,status,method,path,note]) => ({id,name,category,status,method,path,note}));

const labels = { ready: "READY", setup_required: "SETUP REQUIRED", provider_limited: "PROVIDER LIMITED", planned: "PLANNED" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let apis = fallbackCatalog;

async function loadCatalog() {
  try {
    const response = await fetch(`${API}/platform/catalog`);
    if (!response.ok) throw new Error("Catalog is not connected");
    const data = await response.json();
    if (Array.isArray(data.apis)) apis = data.apis;
  } catch {}
  const categories = [...new Set(apis.map(api => api.category))].sort();
  document.querySelector("#category").innerHTML = '<option value="all">All categories</option>' + categories.map(c => `<option>${esc(c)}</option>`).join("");
  document.querySelector("#api-count").textContent = apis.length;
  document.querySelector("#catalog-total").textContent = apis.length;
  document.querySelector("#ready-count").textContent = apis.filter(a => a.status === "ready").length;
  renderCards();
}

function renderCards() {
  const query = document.querySelector("#search").value.trim().toLowerCase();
  const category = document.querySelector("#category").value;
  const items = apis.filter(api => (category === "all" || api.category === category) && `${api.name} ${api.category} ${api.note} ${api.path}`.toLowerCase().includes(query));
  document.querySelector("#cards").innerHTML = items.length ? items.map(api => `
    <article class="api-card ${esc(api.status)}">
      <div class="api-card-top"><span class="category-tag">${esc(api.category)}</span><span class="status-tag ${esc(api.status)}"><i></i>${esc(labels[api.status] || api.status)}</span></div>
      <h3>${esc(api.name)}</h3><p>${esc(api.note)}</p>
      <div class="endpoint"><span class="method ${api.method === "GET" ? "get" : api.method === "POST" ? "post" : "other"}">${esc(api.method)}</span><code>${esc(api.path)}</code></div>
    </article>`).join("") : '<div class="empty-state">No APIs match those filters.</div>';
}

async function checkHealth() {
  const label = document.querySelector("#health-label");
  try {
    const response = await fetch(`${API}/health`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error("Offline");
    label.textContent = "API connected";
    document.querySelector("#health-state").textContent = "OPERATIONAL";
    document.querySelector("#health-service").textContent = data.service || "Netfy API";
    document.querySelector("#health-subtitle").textContent = `Connected · uptime ${Math.floor(data.uptimeSeconds || 0)}s`;
  } catch {
    label.textContent = "Gateway not configured";
    document.querySelector("#health-state").textContent = "PREVIEW MODE";
    document.querySelector("#health-service").textContent = "Console is ready";
    document.querySelector("#health-subtitle").textContent = "Set API_ORIGIN in Netlify to connect your backend";
  }
}

function printResult(element, data) { element.textContent = JSON.stringify(data, null, 2); }

document.querySelector("#search").addEventListener("input", renderCards);
document.querySelector("#category").addEventListener("change", renderCards);
function authHeaders() {
  const key = document.querySelector("#api-key").value.trim();
  return key ? { "x-api-key": key } : {};
}

document.querySelector("#ip-run").addEventListener("click", async () => {
  const address = document.querySelector("#ip-input").value.trim();
  const out = document.querySelector("#ip-result");
  out.textContent = "Loading…";
  try {
    const response = await fetch(`${API}/ip${address ? `/${encodeURIComponent(address)}` : ""}`, { headers: authHeaders() });
    printResult(out, await response.json());
  } catch { out.textContent = "Request failed. Connect the API backend to Netlify first."; }
});
document.querySelector("#repo-run").addEventListener("click", async () => {
  const value = document.querySelector("#repo-input").value.trim();
  const out = document.querySelector("#repo-result");
  const parts = value.split("/").map(part => part.trim());
  if (parts.length !== 2 || parts.some(part => !part)) { out.textContent = 'Enter owner/repository, for example "nodejs/node".'; return; }
  out.textContent = "Loading…";
  try {
    const response = await fetch(`${API}/github/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/releases/latest`, { headers: authHeaders() });
    printResult(out, await response.json());
  } catch { out.textContent = "Request failed. Connect the API backend to Netlify first."; }
});
document.querySelector("#copy-command").addEventListener("click", async event => {
  const text = 'curl "https://YOUR-SITE.netlify.app/api/github/nodejs/node/releases/latest" \\\n  -H "x-api-key: YOUR_API_KEY"';
  try { await navigator.clipboard.writeText(text); event.target.textContent = "COPIED"; setTimeout(() => event.target.textContent = "COPY", 1500); } catch { event.target.textContent = "SELECT TEXT"; }
});

loadCatalog();
checkHealth();
