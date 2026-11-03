// Utilitas bersama untuk serverless function (Vercel).
// File berawalan "_" tidak di-route oleh Vercel, jadi aman dipakai sebagai modul internal.

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function handlePreflight(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

/** AbortSignal.timeout dengan fallback manual untuk runtime lama. */
export function timeout(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function safeText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

/* ===== Allowlist media: cegah /api/dl jadi open proxy / SSRF ===== */
const ALLOWED_MEDIA_HOSTS = [
  "pinimg.com",
  "i.pinimg.com",
  "v1.pinimg.com",
  "v.pinimg.com",
  "media-cache-ak0.pinimg.com",
  "s-media-cache-ak0.pinimg.com",
  "giphy.com",
  "media.giphy.com",
  "media0.giphy.com",
  "media1.giphy.com",
  "media2.giphy.com",
  "media3.giphy.com",
  "media4.giphy.com",
  "c.tenor.com",
  "media.tenor.com",
  "imgur.com",
  "i.imgur.com",
  "video.twimg.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
];

const BLOCKED_HOSTS = [
  "localhost", "127.0.0.1", "0.0.0.0", "::1", "metadata.google.internal",
  "169.254.169.254",
];

/** Host privat (RFC1918 / link-local) — harus ditolak untuk mencegah SSRF. */
function isPrivateHost(host) {
  if (BLOCKED_HOSTS.includes(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

export function isAllowedMediaUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (isPrivateHost(host)) return false;
  // Tolak IP literal secara umum (hindari pivot ke host internal/eksotis)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return false;
  return ALLOWED_MEDIA_HOSTS.some(h => host === h || host.endsWith("." + h));
}

export function isPinterestUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  const host = u.hostname.toLowerCase();
  return /(^|\.)pinterest\.[a-z.]+$/.test(host) || host === "pin.it";
}

/* ===== Rate limit sederhana per instance (best-effort) ===== */
const buckets = new Map();
export function rateLimit(key, maxPerWindow, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 5000) buckets.clear();
    return true;
  }
  entry.count += 1;
  return entry.count <= maxPerWindow;
}
