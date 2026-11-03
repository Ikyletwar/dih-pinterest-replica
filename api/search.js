// Vercel serverless function: proxy pencarian Pinterest.
// Route: /api/search?q=...&limit=50
// Memanggil zelora-api dari sisi server, jadi browser tidak kena CORS.
import { handlePreflight, clampInt, safeText, timeout } from "./_shared.js";

const UPSTREAM = "https://zelora-api.vercel.app/search/pinterest";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const q = safeText(req.query.q, 120).trim();
  if (!q) return res.status(400).json({ status: false, message: "parameter q wajib diisi" });

  const limit = clampInt(req.query.limit, 1, 100, 50);
  const target = `${UPSTREAM}?q=${encodeURIComponent(q)}&limit=${limit}`;

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DihPinterest/2.0)", Accept: "application/json" },
      signal: timeout(12000),
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 5000) }; }
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.status(upstream.status).json(json);
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    res.status(aborted ? 504 : 502).json({
      status: false,
      message: aborted ? "upstream timeout" : "upstream error: " + e.message,
    });
  }
}
