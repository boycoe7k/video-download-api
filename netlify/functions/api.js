const MAX_RESPONSE_BYTES = 4_500_000;
const STRIP_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding"]);

exports.handler = async (event) => {
  const origin = (process.env.API_ORIGIN || "").replace(/\/+$/, "");
  if (!origin) return json(503, { success: false, error: "API_ORIGIN is not configured. Set it to the URL of your Docker backend." });

  let backend;
  try {
    backend = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname);
    if (backend.protocol !== "https:" && !loopback) throw new Error("HTTPS required");
  } catch {
    return json(500, { success: false, error: "API_ORIGIN must be a valid HTTPS backend URL." });
  }

  const prefix = "/.netlify/functions/api";
  const functionPath = (event.path || "").startsWith(prefix) ? (event.path || "").slice(prefix.length) : "";
  const requestPath = functionPath ? `/api${functionPath}` : "/api";
  const target = new URL(requestPath, backend);
  const rawQuery = event.rawQueryString || event.rawQuery || "";
  if (rawQuery) target.search = rawQuery;

  const headers = {};
  for (const [name, value] of Object.entries(event.headers || {})) {
    if (!STRIP_HEADERS.has(name.toLowerCase()) && value != null) headers[name] = value;
  }
  const options = { method: event.httpMethod || "GET", headers, signal: AbortSignal.timeout(25_000) };
  if (!["GET", "HEAD"].includes(options.method) && event.body != null) {
    options.body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  }

  try {
    const upstream = await fetch(target, options);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") || "application/json";
    const responseHeaders = {
      "content-type": contentType,
      "cache-control": upstream.headers.get("cache-control") || "no-store",
      "access-control-allow-origin": "*"
    };
    const location = upstream.headers.get("location");
    if (location) responseHeaders.location = location;
    if (bytes.length > MAX_RESPONSE_BYTES) {
      return json(413, { success: false, error: "The response is too large for the Netlify gateway. Use the backend downloadUrl directly for files." });
    }
    const binary = !/(json|text|xml|javascript|urlencoded)/i.test(contentType);
    return {
      statusCode: upstream.status,
      headers: responseHeaders,
      body: binary ? bytes.toString("base64") : bytes.toString("utf8"),
      isBase64Encoded: binary
    };
  } catch (error) {
    console.error("API gateway error:", error.message);
    return json(502, { success: false, error: "Backend unavailable. Check API_ORIGIN and the backend health endpoint." });
  }
};

function json(statusCode, value) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(value) };
}
