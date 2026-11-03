// Vercel serverless function (opsional): logging nama+IP+query ke database milik Anda.
// JANGAN pernah hardcode token DB di client — semua lewat env var di sisi server.
//
// Env var (contoh Turso):
//   TURSO_URL   = https://<db>-<org>.turso.io
//   TURSO_TOKEN = token turso
//
// Jika env var tidak di-set, endpoint mengembalikan 501 dan app tetap jalan penuh
// (logging hanya nonaktif). Skema tabel dibuat otomatis oleh fungsi ini.
import { handlePreflight, rateLimit, safeText, timeout } from "./_shared.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim() || "unknown";
  if (!rateLimit("log:" + ip, 60, 60_000)) {
    return res.status(429).json({ status: false, message: "terlalu banyak permintaan" });
  }

  const tursoUrl = process.env.TURSO_URL;
  const tursoToken = process.env.TURSO_TOKEN;
  if (!tursoUrl || !tursoToken) {
    return res.status(501).json({ status: false, message: "logging belum dikonfigurasi (set TURSO_URL & TURSO_TOKEN)" });
  }

  const event = safeText(req.query.event, 20);
  const nama = safeText(req.query.nama, 40) || "anon";
  const clientIp = safeText(req.query.ip, 64) || ip;
  const query = safeText(req.query.query, 200);
  const ua = safeText(req.headers["user-agent"] || "", 300);

  try {
    await ensureTables(tursoUrl, tursoToken);
    if (event === "join") {
      await run(tursoUrl, tursoToken,
        "INSERT INTO users (nama, ip, user_agent) VALUES (?, ?, ?)", [nama, clientIp, ua]);
      return res.json({ status: true, event: "join" });
    }
    if (event === "search") {
      if (!query) return res.status(400).json({ status: false, message: "parameter query wajib untuk event=search" });
      await run(tursoUrl, tursoToken,
        "INSERT INTO searches (nama, ip, query) VALUES (?, ?, ?)", [nama, clientIp, query]);
      return res.json({ status: true, event: "search" });
    }
    return res.status(400).json({ status: false, message: "event harus join|search" });
  } catch (e) {
    return res.status(502).json({ status: false, message: "log gagal: " + e.message });
  }
}

async function turso(url, token, sql, args) {
  const body = {
    requests: [{
      type: "execute",
      stmt: {
        sql,
        args: (args || []).map(a =>
          a === null || a === undefined
            ? { type: "null" }
            : { type: "text", value: String(a) }
        ),
      },
    }],
  };
  const r = await fetch(url.replace(/\/$/, "") + "/v2/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(8000),
  });
  if (!r.ok) throw new Error("turso " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

async function ensureTables(url, token) {
  await turso(url, token, "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, ip TEXT, user_agent TEXT, joined_at TEXT DEFAULT (datetime('now')))", []);
  await turso(url, token, "CREATE TABLE IF NOT EXISTS searches (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT, ip TEXT, query TEXT, created_at TEXT DEFAULT (datetime('now')))", []);
}

function run(url, token, sql, args) {
  return turso(url, token, sql, args);
}
