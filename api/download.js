// Vercel serverless function: ambil resolusi penuh + metadata sebuah pin.
// Route: /api/download?url=<pin_url>
// Memanggil /download/pinterest milik zelora-api dari sisi server (anti-CORS).
import { handlePreflight, isPinterestUrl, timeout } from "./_shared.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const url = String(req.query.url || "").slice(0, 500);
  if (!url) return res.status(400).json({ status: false, message: "parameter url wajib diisi" });
  if (!isPinterestUrl(url)) {
    return res.status(400).json({ status: false, message: "url harus berupa tautan Pinterest" });
  }

  const target = "https://zelora-api.vercel.app/download/pinterest?url=" + encodeURIComponent(url);

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DihPinterest/2.0)", Accept: "application/json" },
      signal: timeout(15000),
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 5000) }; }
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.status(upstream.status).json(json);
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    res.status(aborted ? 504 : 502).json({
      status: false,
      message: aborted ? "upstream timeout" : "upstream error: " + e.message,
    });
  }
}
