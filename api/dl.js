// Vercel serverless function: proxy media (browser tidak bisa blob-download
// cross-origin tanpa CORS).
// Route: /api/dl?url=<media_url>
//
// Keamanan: HANYA host media yang di-allowlist (pinimg/giphy/tenor/imgur/...),
// IP literal & host privat ditolak -> mencegah fungsi ini jadi open proxy / SSRF.
import { handlePreflight, isAllowedMediaUrl, rateLimit, timeout } from "./_shared.js";

const MAX_BYTES = 32 * 1024 * 1024; // 32 MB

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (!rateLimit("dl:" + ip, 120, 60_000)) {
    return res.status(429).json({ status: false, message: "terlalu banyak permintaan, coba lagi sebentar" });
  }

  const url = String(req.query.url || "").slice(0, 800);
  if (!url) return res.status(400).json({ status: false, message: "parameter url wajib diisi" });
  if (!isAllowedMediaUrl(url)) {
    return res.status(403).json({ status: false, message: "host media tidak diizinkan" });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://www.pinterest.com/",
        Accept: "image/avif,image/webp,image/*,video/*,*/*;q=0.8",
      },
      redirect: "follow",
      signal: timeout(20000),
    });
    if (!upstream.ok) return res.status(upstream.status).json({ status: false, message: "upstream " + upstream.status });

    const declared = parseInt(upstream.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_BYTES) {
      return res.status(413).json({ status: false, message: "ukuran media melebihi batas 32 MB" });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ status: false, message: "ukuran media melebihi batas 32 MB" });
    }

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Content-Disposition", 'attachment; filename="dih-pinterest-media"');
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.status(200).send(buf);
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    res.status(aborted ? 504 : 502).json({
      status: false,
      message: aborted ? "upstream timeout" : "media fetch error: " + e.message,
    });
  }
}
