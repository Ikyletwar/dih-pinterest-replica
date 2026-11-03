/*
 * Dih Pinterest — app.js
 * Replika & viewer Pinterest yang berjalan 100% statis (GitHub Pages).
 * Urutan fallback pencarian:
 *   1) /api/search        (proxy Vercel milik sendiri, jika di-deploy ke Vercel)
 *   2) zelora-api langsung
 *   3) corsproxy.io / allorigins (proxy publik terakhir)
 */
"use strict";

/* ===== Konstanta ===== */
const SEARCH_API   = "https://zelora-api.vercel.app/search/pinterest?q=";
const DL_API       = "https://zelora-api.vercel.app/download/pinterest?url=";
const PROXIES      = [u => "https://corsproxy.io/?" + encodeURIComponent(u),
                      u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u)];
const LIMIT        = 50;
const BATCH        = 16;               // progressive render per batch
const HISTORY_KEY  = "dih_history";
const SAVED_KEY    = "dih_saved";
const THEME_KEY    = "dih_theme";
const COOKIE_NAMA  = "dih_nama";

const SUGGESTED = ["kucing lucu", "aesthetic wallpaper", "anime art", "motivasi", "resep", "travel", "outfit konser", "desain logo"];

/* ===== State ===== */
const state = {
  nama: null,
  lastMedia: [],      // hasil mentah dari API (setelah parse)
  view: [],           // list yang sedang dirender (sudah difilter)
  filter: "all",
  rendered: 0,        // jumlah kartu yang sudah dirender dari state.view
  query: "",
  ownProxy: null,     // null = belum diketahui, true/false setelah percobaan
  lbIndex: -1,        // index media di state.view yang sedang terbuka di lightbox
};

/* ===== Shortcut DOM ===== */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const els = {
  gate: $("#gate"), gateForm: $("#gate-form"), gateSkip: $("#gate-skip"),
  namaInput: $("#nama-input"), app: $("#app"),
  displayNama: $("#display-nama"), userBadge: $("#user-badge"),
  themeToggle: $("#theme-toggle"),
  query: $("#query"), queryClear: $("#query-clear"),
  searchBtn: $("#search-btn"), loader: $("#loader"), results: $("#results"),
  filterBar: $("#filter-bar"), statusLine: $("#status-line"),
  sentinel: $("#sentinel"), loadHint: $("#load-hint"),
  lightbox: $("#lightbox"), lbContent: $("#lb-content"),
  toast: $("#toast"), suggest: $("#suggest"),
  historyPop: $("#history-pop"),
};

/* ===== Util ===== */
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 864e5);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}
function getCookie(name) {
  const m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
  return m ? decodeURIComponent(m.pop()) : null;
}
function storageGet(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function sanitizeFilename(name) {
  return String(name || "dih-pinterest").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "dih-pinterest";
}
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function isPinimg(url) { return /^https?:\/\/i\.pinimg\.com\//i.test(url || ""); }
/** i.pinimg.com menyimpan resolusi penuh di /originals/ — upgrade otomatis. */
function fullResUrl(url) {
  if (!isPinimg(url)) return url;
  return url.replace(/\/(236x|474x|736x|1200x)\//, "/originals/");
}
function isVideoUrl(url) {
  const l = (url || "").toLowerCase();
  return l.includes(".mp4") || l.includes(".webm") || l.includes(".mov") || l.includes("/videos/");
}
function mediaType(url) {
  const l = (url || "").toLowerCase();
  if (isVideoUrl(l)) return "video";
  if (l.includes(".gif")) return "gif";
  return "foto";
}
function itemType(item) { return item.type === "video" ? "video" : mediaType(item.url); }
function icon(id, cls) { return `<svg class="${cls || ""}" aria-hidden="true"><use href="#${id}"/></svg>`; }

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

/* ===== Tema gelap/terang ===== */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  storageSet(THEME_KEY, theme);
}
function initTheme() {
  const saved = storageGet(THEME_KEY, null);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}
els.themeToggle.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "light" ? "dark" : "light");
});

/* ===== IP visitor (opsional, untuk logging /api/log) ===== */
async function getIP() {
  for (const url of ["https://api.ipify.org?format=json", "https://api64.ipify.org?format=json"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      if (j && j.ip) return j.ip;
    } catch { /* coba endpoint berikutnya */ }
  }
  return "unknown";
}

/** Fire-and-forget; hanya dikirim bila proxy sendiri (/api/*) tersedia. */
function logEvent(event, params) {
  if (state.ownProxy === false) return;
  const qs = new URLSearchParams({ event, nama: state.nama || "anon", ...params });
  try { fetch("/api/log?" + qs.toString(), { method: "POST", keepalive: true }).catch(() => {}); } catch { /* abaikan */ }
}

/* ===== Gate nama ===== */
function enterApp(name) {
  state.nama = name;
  els.displayNama.textContent = name;
  els.gate.hidden = true;
  els.app.hidden = false;
}
function openGate(prefill) {
  els.gate.hidden = false;
  els.app.hidden = true;
  if (prefill) els.namaInput.value = prefill;
  els.namaInput.focus();
}
els.gateForm.addEventListener("submit", async e => {
  e.preventDefault();
  const nama = els.namaInput.value.trim();
  if (nama.length < 2) { els.namaInput.focus(); showToast("Nama minimal 2 karakter."); return; }
  setCookie(COOKIE_NAMA, nama, 365);
  enterApp(nama);
  const ip = await getIP();
  logEvent("join", { ip });
});
els.gateSkip.addEventListener("click", () => {
  setCookie(COOKIE_NAMA, "Tamu", 30);
  enterApp("Tamu");
});
els.userBadge.addEventListener("click", () => openGate(state.nama === "Tamu" ? "" : state.nama));

/* ===== Riwayat pencarian ===== */
function getHistory() { return storageGet(HISTORY_KEY, []); }
function pushHistory(q) {
  if (!q) return;
  const list = getHistory().filter(x => x.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  storageSet(HISTORY_KEY, list.slice(0, 10));
}
function renderHistoryPop() {
  const list = getHistory();
  if (!list.length) { els.historyPop.hidden = true; els.query.setAttribute("aria-expanded", "false"); return; }
  els.historyPop.innerHTML =
    `<div class="history-head"><span>Riwayat</span><button class="history-clear" id="history-clear">${icon("i-trash")} Hapus</button></div>` +
    list.map(h => `<button class="history-item" data-q="${escapeAttr(h)}">${icon("i-clock")}<span>${escapeHtml(h)}</span></button>`).join("");
  els.historyPop.hidden = false;
  els.query.setAttribute("aria-expanded", "true");
  $("#history-clear").addEventListener("click", () => { storageSet(HISTORY_KEY, []); renderHistoryPop(); showToast("Riwayat dihapus."); });
  $$(".history-item", els.historyPop).forEach(btn =>
    btn.addEventListener("click", () => { els.query.value = btn.dataset.q; els.historyPop.hidden = true; doSearch(); }));
}
els.query.addEventListener("focus", renderHistoryPop);
els.query.addEventListener("input", () => { els.queryClear.hidden = !els.query.value; if (document.activeElement === els.query && els.query.value === "") renderHistoryPop(); });
els.queryClear.addEventListener("click", () => { els.query.value = ""; els.queryClear.hidden = true; els.query.focus(); });
document.addEventListener("click", e => { if (!els.historyPop.contains(e.target) && e.target !== els.query) { els.historyPop.hidden = true; els.query.setAttribute("aria-expanded", "false"); } });

/* ===== Kata kunci populer ===== */
function renderSuggest() {
  els.suggest.innerHTML = `<span class="suggest-label">Populer:</span>` +
    SUGGESTED.map(s => `<button class="suggest-chip" data-q="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join("");
  $$(".suggest-chip", els.suggest).forEach(chip =>
    chip.addEventListener("click", () => { els.query.value = chip.dataset.q; els.queryClear.hidden = false; doSearch(); }));
}

/* ===== Tersimpan (favorites) ===== */
function getSaved() { return storageGet(SAVED_KEY, []); }
function setSaved(list) { storageSet(SAVED_KEY, list); updateSavedCount(); }
function isSaved(url) { return getSaved().some(i => i.url === url); }
function toggleSave(item) {
  const list = getSaved();
  const idx = list.findIndex(i => i.url === item.url);
  if (idx >= 0) { list.splice(idx, 1); setSaved(list); showToast("Dihapus dari Tersimpan."); return false; }
  list.unshift({ url: item.url, title: item.title || "", source: item.source || "", type: item.type || "image", savedAt: Date.now() });
  setSaved(list); showToast("Tersimpan di perangkat ini."); return true;
}
function updateSavedCount() {
  const el = $("#count-saved"); if (el) el.textContent = getSaved().length;
}

/* ===== Fetch dengan timeout ===== */
async function fetchJSON(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 12000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* ===== Pencarian: 3 lapis fallback ===== */
async function fetchSearch(q) {
  // 1) proxy sendiri (Vercel)
  if (state.ownProxy !== false) {
    try {
      const data = await fetchJSON(`/api/search?q=${encodeURIComponent(q)}&limit=${LIMIT}`);
      state.ownProxy = true;
      return { data, via: "proxy-sendiri" };
    } catch { state.ownProxy = false; }
  }
  // 2) zelora-api langsung
  try {
    return { data: await fetchJSON(SEARCH_API + encodeURIComponent(q) + `&limit=${LIMIT}`), via: "zelora-api" };
  } catch { /* lanjut ke proxy publik */ }
  // 3) proxy publik
  for (const mk of PROXIES) {
    try {
      return { data: await fetchJSON(mk(SEARCH_API + encodeURIComponent(q) + `&limit=${LIMIT}`)), via: "proxy-publik" };
    } catch { /* coba proxy berikutnya */ }
  }
  throw new Error("Semua jalur pencarian gagal.");
}

/* ===== Parsing hasil API ===== */
const isMediaUrl = (s) => {
  if (typeof s !== "string") return false;
  const l = s.toLowerCase();
  return l.startsWith("http") && (
    /\.(jpe?g|png|gif|webp|mp4|webm|mov)(\?|#|$)/.test(l) ||
    l.includes("pinimg") || l.includes("media") || l.includes("cdn") ||
    l.includes("imgur") || l.includes("giphy") || l.includes("tenor") || l.includes("video")
  );
};

function normalizePin(p) {
  if (!p || typeof p !== "object") return null;
  const url = p.image || p.thumbnail || p.url || p.src || p.media || null;
  if (!url || !isMediaUrl(url)) return null;
  return {
    url,
    title: p.title || p.caption || p.description || p.alt || "",
    source: p.source || p.link || p.url_pin || "",
    username: p.username || "",
    board: p.board || "",
    type: p.video || p.mp4 || p.video_url ? "video" : (isVideoUrl(url) ? "video" : "image"),
    videoUrl: p.video || p.mp4 || p.video_url || null,
  };
}

/** Parser terstruktur (zelora /search/pinterest) + fallback walker generik. */
function parseResults(data) {
  const items = [];
  const seen = new Set();
  const push = (it) => { if (it && !seen.has(it.url)) { seen.add(it.url); items.push(it); } };

  const roots = [data && data.result, data && data.data, data && data.results, data && data.pins, data];
  for (const root of roots) {
    if (Array.isArray(root)) { root.map(normalizePin).forEach(push); if (items.length) return items; }
  }
  // Fallback: walker generik untuk shape JSON yang tidak dikenal
  const walk = (node, depth) => {
    if (!node || depth > 6) return;
    if (typeof node === "string") { if (isMediaUrl(node)) push({ url: node, title: "", source: "", type: isVideoUrl(node) ? "video" : "image" }); return; }
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    if (typeof node === "object") {
      push(normalizePin(node));
      ["result","data","results","images","media","pins","items","videos"].forEach(k => node[k] && walk(node[k], depth + 1));
    }
  };
  walk(data, 0);
  return items;
}

/* ===== Filter & counts ===== */
function applyFilterTo(list) {
  if (state.filter === "all") return list;
  if (state.filter === "saved") return list; // saved sudah difilter di getSaved()
  return list.filter(it => itemType(it) === state.filter);
}
function updateCounts() {
  const c = { all: state.lastMedia.length, foto: 0, video: 0, gif: 0 };
  for (const it of state.lastMedia) c[itemType(it)]++;
  $("#count-all").textContent = c.all;
  $("#count-foto").textContent = c.foto;
  $("#count-video").textContent = c.video;
  $("#count-gif").textContent = c.gif;
  updateSavedCount();
}
function setFilter(f) {
  state.filter = f;
  $$("#filter-bar .chip").forEach(c => c.classList.toggle("active", c.dataset.filter === f));
  renderFromState();
}

/* ===== Rendering progressive ===== */
function cardHTML(item, i) {
  const isVid = item.type === "video" || isVideoUrl(item.url);
  const src = isVid ? (item.videoUrl || item.url) : item.url;
  const title = escapeHtml(item.title || "Tanpa judul");
  const saved = isSaved(item.url);
  const media = isVid
    ? `<video src="${escapeAttr(src)}" muted loop playsinline preload="metadata" aria-label="${title}"></video><span class="badge-video">${icon("i-play")} VIDEO</span>`
    : `<img src="${escapeAttr(item.url)}" alt="${title}" loading="lazy" referrerpolicy="no-referrer">`;
  return `<figure class="card" data-url="${escapeAttr(item.url)}" style="animation-delay:${(i % BATCH) * 0.03}s">
    <div class="media-wrap loading" role="button" tabindex="0" aria-label="Perbesar media">${media}
      <div class="card-overlay">
        <p class="card-title">${title}</p>
        <div class="overlay-actions">
          <button class="overlay-btn view" type="button">${icon("i-expand")} Full</button>
          <button class="overlay-btn dl" type="button">${icon("i-download")} DL</button>
          <button class="overlay-btn save${saved ? " active" : ""}" type="button" aria-pressed="${saved}" aria-label="Simpan pin">${icon("i-heart")}</button>
        </div>
      </div>
    </div>
  </figure>`;
}

function bindCard(card, item) {
  const wrap = $(".media-wrap", card);
  const img = $("img", card);
  if (img) {
    img.addEventListener("load", () => wrap.classList.remove("loading"));
    img.addEventListener("error", () => { card.remove(); });
  } else {
    wrap.classList.remove("loading");
    const vid = $("video", card);
    wrap.addEventListener("mouseenter", () => vid.play().catch(() => {}));
    wrap.addEventListener("mouseleave", () => { vid.pause(); });
  }
  const open = () => openLightbox(state.view.indexOf(item));
  wrap.addEventListener("click", e => { if (!e.target.closest(".overlay-btn")) open(); });
  wrap.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  $(".view", card).addEventListener("click", open);
  $(".dl", card).addEventListener("click", () => downloadMedia(item));
  $(".save", card).addEventListener("click", e => {
    const nowSaved = toggleSave(item);
    e.currentTarget.classList.toggle("active", nowSaved);
    e.currentTarget.setAttribute("aria-pressed", String(nowSaved));
    if (state.filter === "saved") renderFromState();
  });
}

function renderFromState() {
  els.results.innerHTML = "";
  state.rendered = 0;
  els.loadHint.hidden = true;

  const base = state.filter === "saved" ? getSaved() : state.lastMedia;
  state.view = applyFilterTo(base);

  if (!state.view.length) {
    const msg = state.filter === "saved"
      ? "Belum ada pin tersimpan.<small>Tekan ikon hati pada kartu untuk menyimpan.</small>"
      : (state.query ? `Tidak ada hasil ${state.filter === "all" ? "" : state.filter + " "}untuk “${escapeHtml(state.query)}”.<small>Coba kata kunci lain.</small>` : "Kosong nih, coba keyword lain.");
    els.results.innerHTML = `<div class="empty-state">${icon("i-ghost")}${msg}</div>`;
    return;
  }
  renderNextBatch();
}

function renderNextBatch() {
  const end = Math.min(state.rendered + BATCH, state.view.length);
  const frag = document.createDocumentFragment();
  for (let i = state.rendered; i < end; i++) {
    const item = state.view[i];
    const html = cardHTML(item, i);
    const tmp = document.createElement("template");
    tmp.innerHTML = html.trim();
    const card = tmp.content.firstElementChild;
    bindCard(card, item);
    frag.appendChild(card);
  }
  els.results.appendChild(frag);
  state.rendered = end;
  els.loadHint.hidden = state.rendered < state.view.length;
}

const sentinelObserver = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && state.rendered < state.view.length) renderNextBatch();
}, { rootMargin: "600px 0px" });
sentinelObserver.observe(els.sentinel);

/* ===== Download media ===== */
async function downloadMedia(item) {
  // Resolusi penuh (khusus pinimg) lebih berguna daripada thumbnail 474px
  const url = fullResUrl(item.videoUrl || item.url);
  const ext = isVideoUrl(url) ? "mp4" : (/\.png(\?|$)/i.test(url) ? "png" : /\.gif(\?|$)/i.test(url) ? "gif" : /\.webp(\?|$)/i.test(url) ? "webp" : "jpg");
  const filename = sanitizeFilename(item.title) + "." + ext;

  // 1) proxy sendiri (Vercel)
  try {
    const res = await fetch("/api/dl?url=" + encodeURIComponent(url));
    if (!res.ok) throw new Error("HTTP " + res.status);
    triggerBlobDownload(await res.blob(), filename);
    return;
  } catch { /* fallback */ }

  // 2) fetch langsung (beberapa CDN mengizinkan CORS untuk gambar)
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    triggerBlobDownload(await res.blob(), filename);
    return;
  } catch { /* fallback terakhir */ }

  // 3) buka di tab baru — user simpan manual
  window.open(url, "_blank", "noopener");
  showToast("Dibuka di tab baru; gunakan “Simpan gambar sebagai…”.");
}
function triggerBlobDownload(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  showToast("Download dimulai.");
}

/* ===== Lightbox ===== */
function openLightbox(index) {
  if (index < 0 || index >= state.view.length) return;
  state.lbIndex = index;
  renderLightbox();
  els.lightbox.classList.add("open");
  els.lightbox.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeLightbox() {
  els.lightbox.classList.remove("open");
  els.lightbox.setAttribute("aria-hidden", "true");
  els.lbContent.innerHTML = "";
  document.body.style.overflow = "";
  state.lbIndex = -1;
}
function renderLightbox() {
  const item = state.view[state.lbIndex];
  const isVid = item.type === "video" || isVideoUrl(item.url);
  const full = fullResUrl(item.videoUrl || item.url);
  const title = escapeHtml(item.title || "Tanpa judul");
  const counter = `${state.lbIndex + 1} / ${state.view.length}`;
  const media = isVid
    ? `<video src="${escapeAttr(item.videoUrl || item.url)}" controls autoplay playsinline></video>`
    : `<img src="${escapeAttr(full)}" alt="${title}" referrerpolicy="no-referrer">`;
  const sourceLink = item.source ? `<a class="lb-btn secondary" href="${escapeAttr(item.source)}" target="_blank" rel="noopener noreferrer">${icon("i-external")} Buka di Pinterest</a>` : "";
  els.lbContent.innerHTML = `
    <div class="lb-stage">
      <button class="lb-close" type="button" aria-label="Tutup">${icon("i-x")}</button>
      <button class="lb-nav lb-prev${state.lbIndex === 0 ? " lb-nav-disabled" : ""}" type="button" aria-label="Sebelumnya">${icon("i-arrow-left")}</button>
      ${media}
      <button class="lb-nav lb-next${state.lbIndex === state.view.length - 1 ? " lb-nav-disabled" : ""}" type="button" aria-label="Berikutnya">${icon("i-arrow-right")}</button>
    </div>
    <div class="lb-meta"><p class="lb-title" title="${title}">${title}</p><span class="lb-counter">${counter}</span></div>
    <div class="lb-actions">
      <button class="lb-btn" id="lb-download" type="button">${icon("i-download")} Download asli</button>
      ${sourceLink}
      <button class="lb-btn secondary" id="lb-close-2" type="button">${icon("i-x")} Tutup</button>
    </div>`;
  // Fallback: jika /originals/ gagal dimuat, kembali ke URL asli (thumbnail)
  const lbImg = $(".lb-stage img", els.lbContent);
  if (lbImg) lbImg.addEventListener("error", () => { if (lbImg.src !== item.url) lbImg.src = item.url; });
  $(".lb-close", els.lbContent).addEventListener("click", closeLightbox);
  $("#lb-close-2", els.lbContent).addEventListener("click", closeLightbox);
  $(".lb-prev", els.lbContent).addEventListener("click", () => stepLightbox(-1));
  $(".lb-next", els.lbContent).addEventListener("click", () => stepLightbox(1));
  $("#lb-download", els.lbContent).addEventListener("click", () => downloadMedia(item));
}
function stepLightbox(dir) {
  const next = state.lbIndex + dir;
  if (next < 0 || next >= state.view.length) return;
  state.lbIndex = next;
  renderLightbox();
}
els.lightbox.addEventListener("click", e => { if (e.target === els.lightbox) closeLightbox(); });
document.addEventListener("keydown", e => {
  if (!els.lightbox.classList.contains("open")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") stepLightbox(-1);
  else if (e.key === "ArrowRight") stepLightbox(1);
});

/* ===== Alur pencarian ===== */
function setLoading(on) {
  els.loader.hidden = !on;
  els.searchBtn.disabled = on;
}
function setStatus(html) { els.statusLine.innerHTML = html; }

async function doSearch() {
  const q = els.query.value.trim();
  if (!q) { els.query.focus(); return; }
  state.query = q;
  els.historyPop.hidden = true;
  setLoading(true);
  els.results.innerHTML = "";
  els.filterBar.hidden = true;
  setStatus("");
  pushHistory(q);
  try {
    const { data, via } = await fetchSearch(q);
    state.lastMedia = parseResults(data);
    updateCounts();
    els.filterBar.hidden = false;
    setFilter("all");
    setStatus(`Menampilkan <strong>${state.lastMedia.length}</strong> hasil untuk “${escapeHtml(q)}” <span title="sumber data">(${via})</span>`);
    logEvent("search", { ip: await getIP(), query: q });
  } catch (err) {
    state.lastMedia = [];
    els.results.innerHTML = `<div class="error-msg">${icon("i-warning")}Gagal mencari. Periksa koneksi lalu coba lagi.<br><button class="btn btn-primary btn-retry" id="btn-retry">${icon("i-search")} Coba Lagi</button></div>`;
    $("#btn-retry").addEventListener("click", doSearch);
    setStatus("Pencarian gagal.");
  } finally {
    setLoading(false);
  }
}

els.searchBtn.addEventListener("click", doSearch);
els.query.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
$("#filter-bar").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (chip) setFilter(chip.dataset.filter);
});

/* ===== Init ===== */
initTheme();
renderSuggest();
updateSavedCount();

/* Deeplink: ?nama=Tamu&q=kucing  -> auto masuk & auto cari (bisa dibagikan) */
const params = new URLSearchParams(location.search);
const urlNama = (params.get("nama") || "").slice(0, 40).trim();
const urlQuery = (params.get("q") || "").slice(0, 120).trim();
const urlTheme = params.get("theme");
if (urlTheme === "dark" || urlTheme === "light") applyTheme(urlTheme);
const savedNama = getCookie(COOKIE_NAMA) || urlNama;

if (savedNama) {
  if (urlNama) setCookie(COOKIE_NAMA, urlNama, 365);
  enterApp(savedNama);
  getIP().then(ip => logEvent("join", { ip }));
  if (urlQuery) { els.query.value = urlQuery; els.queryClear.hidden = false; doSearch(); }
} else {
  openGate();
}
