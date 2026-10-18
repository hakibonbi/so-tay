// Máy chủ chung cho "Sổ tay học tập" (một hàm duy nhất, đường dẫn /api/*), lưu bằng Netlify Blobs.
//   /api/presence  tín hiệu hoạt động + danh sách cho quản trị viên
//   /api/match     ghép trận, phòng riêng, chuyển nước đi cho game đối kháng
//   /api/board     bảng xếp hạng ELO
//   /api/feed      bảng tin (bài đăng, cảm xúc, bình luận, báo cáo)
//   /api/media     ảnh và video ngắn của bảng tin
// Biến môi trường: ADMIN_KEY (mật khẩu quản trị) dùng cho các thao tác quản trị.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomBytes, createHmac } from "node:crypto";

const ONLINE_MS = 90 * 1000, KEEP_MS = 30 * 24 * 3600 * 1000;
const WAIT_MS = 25 * 1000, ROOM_KEEP = 24 * 3600 * 1000;
const J = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(1e9, Math.round(+v))) : 0);
const tsn = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(4e12, Math.round(+v))) : 0);
const idOf = (v) => str(v, 48).replace(/[^\w-]/g, "");
const rid = (n = 10) => randomBytes(n).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, n);
function isAdmin(req) {
  const key = process.env.ADMIN_KEY || "", got = req.headers.get("x-admin-key") || "";
  if (!key || key.length < 8) return false;
  const a = Buffer.from(key), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(req, max = 20000) {
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error("too_large"), { code: 413 });
  try { return JSON.parse(t); } catch { throw Object.assign(new Error("bad_json"), { code: 400 }); }
}
const MAXMOVES = 600;
const GAMES = /^[a-z0-9]{2,16}$/;

export default async (req, ctx, deps) => {
  const S = (n) => (deps && deps.store ? deps.store(n) : getStore({ name: n, consistency: "strong" }));
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").split("/");
  const route = path[0];
  try {
    if (route === "ping") return J({ ok: true, now: Date.now() });
    if (route === "presence") return await presence(req, S, url);
    if (route === "match") return await match(req, S);
    if (route === "board") return await board(req, S, url);
    if (route === "feed") return await feed(req, S, url);
    if (route === "media") return await media(req, S, url, path[1]);
    if (route === "music") return await music(req, S, url, path.slice(1));
    if (route === "chat") return await chat(req, S, url);
    if (route === "tea") return await tea(req, S, url);
    if (route === "admin") return await admin(req, S, url);
    if (route === "config") return await pubConfig(req, S);
    return J({ error: "not_found" }, 404);
  } catch (e) {
    if (e && e.code) return J({ error: e.message }, e.code);
    console.error(e);
    return J({ error: "server" }, 500);
  }
};
export const config = { path: "/api/*" };

async function isBanned(S, id) {
  if (!id) return null;
  const x = await S("admin").get("ban:" + id, { type: "json" }).catch(() => null);
  return x && (!x.until || x.until > Date.now()) ? x : null;
}
const BAN = (x) => J({ error: "banned", reason: x.reason || "", until: x.until || 0 }, 403);
/* ---------------- presence ---------------- */
async function presence(req, S, url) {
  const store = S("presence");
  if (req.method === "POST") {
    const b = await body(req, 4000);
    const id = idOf(b.id);
    if (id.length < 6) return J({ error: "bad_id" }, 400);
    await store.setJSON(id, {
      id, name: str(b.name, 30) || "Khách", av: str(b.av, 8), guest: !!b.guest, reg: tsn(b.reg),
      act: str(b.act, 80), view: str(b.view, 20), tool: str(b.tool, 30), subj: str(b.subj, 60),
      lvl: num(b.lvl), xp: num(b.xp), min: num(b.min), total: num(b.total), streak: num(b.streak),
      dev: str(b.dev, 20), scr: str(b.scr, 16), lang: str(b.lang, 12), since: tsn(b.since), seen: Date.now(),
    });
    const adm = S("admin"), out = { ok: true, now: Date.now() };
    const bn = await isBanned(S, id);
    if (bn) out.banned = { reason: bn.reason || "", until: bn.until || 0 };
    const dm = await adm.get("dm:" + id, { type: "json" }).catch(() => null);
    if (dm && dm.length) { out.msg = dm; await adm.delete("dm:" + id).catch(() => {}); }
    return J(out);
  }
  if (!isAdmin(req)) return J({ error: "forbidden" }, 403);
  if (req.method === "DELETE") {
    const id = idOf(url.searchParams.get("id"));
    if (id) await store.delete(id);
    return J({ ok: true });
  }
  if (req.method === "GET") {
    const { blobs } = await store.list();
    const now = Date.now(), out = [];
    await Promise.all(blobs.map(async (x) => {
      const r = await store.get(x.key, { type: "json" }).catch(() => null);
      if (!r) return;
      if (now - r.seen > KEEP_MS) { await store.delete(x.key).catch(() => {}); return; }
      r.online = now - r.seen < ONLINE_MS;
      out.push(r);
    }));
    out.sort((a, b) => (b.online - a.online) || (b.seen - a.seen));
    return J({ now, users: out });
  }
  return J({ error: "method" }, 405);
}

/* ---------------- match ---------------- */
function me(b) { const m = b.me || {}; return { id: idOf(m.id), name: str(m.name, 30) || "Khách", av: str(m.av, 8) }; }
function pubRoom(r, id, since, chatSince) {
  return {
    room: r.id, game: r.game, variant: r.variant, status: r.status, players: r.players, end: r.end || null,
    moves: r.moves.slice(since), n: r.moves.length, chat: (r.chat || []).slice(chatSince), cn: (r.chat || []).length,
    seen: r.seen || {}, now: Date.now(), next: r.next || null, rematch: r.rematch || null,
  };
}
async function match(req, S) {
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const st = S("match");
  const b = await body(req, 3000);
  const act = str(b.act, 12);
  const now = Date.now();
  const game = str(b.game, 16), variant = str(b.variant, 16) || "std";
  if (["find", "create", "join"].includes(act)) { const bx = await isBanned(S, idOf((b.me && b.me.id) || "")); if (bx) return BAN(bx); }
  if ((act === "find" || act === "create" || act === "check" || act === "cancel") && !GAMES.test(game)) return J({ error: "bad_game" }, 400);
  const getRoom = async (id) => st.get("r:" + idOf(id), { type: "json" }).catch(() => null);
  const mk = (g, v, p0, p1, status) => {
    const sw = Math.random() < 0.5;
    return { id: rid(8), game: g, variant: v, players: p1 ? (sw ? [p1, p0] : [p0, p1]) : [p0], status, moves: [], chat: [], end: null, t: now, seen: {}, rev: 0 };
  };

  if (act === "find") {
    const m = me(b);
    if (m.id.length < 6) return J({ error: "bad_id" }, 400);
    const pre = `w:${game}:${variant}:`;
    await st.delete("u:" + m.id).catch(() => {});
    const { blobs } = await st.list({ prefix: pre });
    const cands = [];
    await Promise.all(blobs.map(async (x) => {
      const w = await st.get(x.key, { type: "json" }).catch(() => null);
      if (!w) return;
      if (now - w.t > WAIT_MS) { await st.delete(x.key).catch(() => {}); return; }
      if (w.id !== m.id) cands.push(w);
    }));
    cands.sort((a, c) => a.t - c.t);
    for (const c of cands) {
      const claimed = await st.get("u:" + c.id, { type: "json" }).catch(() => null);
      if (claimed && claimed.t > c.t) continue;
      const room = mk(game, variant, { id: c.id, name: c.name, av: c.av }, m, "active");
      await st.setJSON("r:" + room.id, room);
      await st.setJSON("u:" + c.id, { room: room.id, t: now });
      const verify = await st.get("u:" + c.id, { type: "json" }).catch(() => null);
      if (!verify || verify.room !== room.id) { await st.delete("r:" + room.id).catch(() => {}); continue; }
      await st.delete(`${pre}${c.id}`).catch(() => {});
      await st.setJSON("u:" + m.id, { room: room.id, t: now });
      if (Math.random() < 0.02) cleanup(st, now).catch(() => {});
      return J({ room: room.id });
    }
    await st.setJSON(`${pre}${m.id}`, { id: m.id, name: m.name, av: m.av, t: now });
    return J({ waiting: true });
  }
  if (act === "check") {
    const id = idOf(b.id);
    const u = await st.get("u:" + id, { type: "json" }).catch(() => null);
    if (u && now - u.t < 60000) return J({ room: u.room });
    const k = `w:${game}:${variant}:${id}`;
    const w = await st.get(k, { type: "json" }).catch(() => null);
    if (!w) return J({ waiting: false });
    w.t = now; await st.setJSON(k, w);
    return J({ waiting: true });
  }
  if (act === "cancel") {
    const id = idOf(b.id);
    await st.delete(`w:${game}:${variant}:${id}`).catch(() => {});
    return J({ ok: true });
  }
  if (act === "create") {
    const m = me(b);
    if (m.id.length < 6) return J({ error: "bad_id" }, 400);
    let code = "";
    for (let i = 0; i < 5; i++) code += "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)];
    const room = mk(game, variant, m, null, "open");
    room.id = code;
    await st.setJSON("r:" + code, room);
    return J({ room: code });
  }
  if (act === "join") {
    const m = me(b);
    const code = idOf(b.code).toUpperCase();
    const r = await getRoom(code);
    if (!r) return J({ error: "not_found" }, 404);
    if (r.players.some((p) => p.id === m.id)) return J({ room: r.id });
    if (r.status !== "open" || r.players.length >= 2) return J({ error: "full" }, 409);
    r.players = Math.random() < 0.5 ? [r.players[0], m] : [m, r.players[0]];
    r.status = "active"; r.rev++;
    await st.setJSON("r:" + r.id, r);
    return J({ room: r.id });
  }
  const r = await getRoom(b.room);
  if (!r) return J({ error: "not_found" }, 404);
  const id = idOf(b.id);
  const idx = r.players.findIndex((p) => p.id === id);
  if (idx < 0) return J({ error: "not_member" }, 403);
  if (act === "poll") {
    const since = Math.max(0, num(b.since)), cs = Math.max(0, num(b.cs));
    r.seen = r.seen || {};
    const stale = !r.seen[id] || now - r.seen[id] > 4000;
    if (stale) { r.seen[id] = now; await st.setJSON("r:" + r.id, r); }
    return J(pubRoom(r, id, since, cs));
  }
  if (act === "move") {
    if (r.status !== "active") return J({ error: "not_active", ...pubRoom(r, id, 0, 0) }, 409);
    if (num(b.idx) !== r.moves.length || r.moves.length % 2 !== idx || r.moves.length >= MAXMOVES) return J({ error: "bad_turn", ...pubRoom(r, id, Math.max(0, num(b.idx)), 0) }, 409);
    const mv = typeof b.move === "string" ? b.move.slice(0, 80) : JSON.stringify(b.move || "").slice(0, 80);
    r.moves.push(mv); r.seen = r.seen || {}; r.seen[id] = now; r.rev++;
    await st.setJSON("r:" + r.id, r);
    return J({ ok: true, n: r.moves.length });
  }
  if (act === "end") {
    if (r.status === "ended") return J(pubRoom(r, id, 0, 0));
    const reason = str(b.reason, 12);
    let winner = [0, 1, -1].includes(+b.winner) ? +b.winner : -1;
    if (reason === "resign") winner = 1 - idx;
    else if (reason === "abandon") {
      const o = r.players[1 - idx], ls = (r.seen || {})[o && o.id] || 0;
      if (now - ls < 45000) return J({ error: "opp_online" }, 409);
      winner = idx;
    }
    r.status = "ended"; r.end = { winner, reason: reason || "rule", by: id, t: now }; r.rev++;
    await st.setJSON("r:" + r.id, r);
    return J(pubRoom(r, id, 0, 0));
  }
  if (act === "chat") {
    const text = str(b.text, 140).trim();
    if (!text) return J({ ok: true });
    r.chat = r.chat || [];
    if (r.chat.length >= 100) r.chat.shift();
    r.chat.push({ i: idx, t: text, at: now });
    await st.setJSON("r:" + r.id, r);
    return J({ ok: true });
  }
  if (act === "rematch") {
    if (r.next) return J({ next: r.next });
    if (r.rematch && r.rematch.by !== id) {
      const p = r.players;
      const nr = mk(r.game, r.variant, p[1], p[0], "active");
      nr.players = [p[1], p[0]];
      await st.setJSON("r:" + nr.id, nr);
      r.next = nr.id; await st.setJSON("r:" + r.id, r);
      return J({ next: nr.id });
    }
    r.rematch = { by: id, t: now }; await st.setJSON("r:" + r.id, r);
    return J({ ok: true });
  }
  return J({ error: "bad_act" }, 400);
}
async function cleanup(st, now) {
  const { blobs } = await st.list({ prefix: "r:" });
  for (const x of blobs) {
    const r = await st.get(x.key, { type: "json" }).catch(() => null);
    if (r && now - r.t > ROOM_KEEP) await st.delete(x.key).catch(() => {});
  }
}

/* ---------------- board (xếp hạng) ---------------- */
async function board(req, S, url) {
  const st = S("board");
  if (req.method === "POST") {
    const b = await body(req, 1500);
    const game = str(b.game, 16), id = idOf(b.id);
    if (!GAMES.test(game) || id.length < 6) return J({ error: "bad" }, 400);
    { const bx = await isBanned(S, id); if (bx) return BAN(bx); }
    const res = ["w", "l", "d"].includes(b.res) ? b.res : null;
    if (!res) return J({ error: "bad_res" }, 400);
    const k = `lb:${game}:${id}`;
    const r = (await st.get(k, { type: "json" }).catch(() => null)) || { id, game, elo: 1000, w: 0, l: 0, d: 0, last: "" };
    const room = idOf(b.room);
    if (room && r.last === room) return J({ ok: true, elo: r.elo });
    let oe = 1000;
    const oid = idOf(b.opp);
    if (oid) { const o = await st.get(`lb:${game}:${oid}`, { type: "json" }).catch(() => null); if (o) oe = o.elo; }
    const exp = 1 / (1 + Math.pow(10, (oe - r.elo) / 400)), sc = res === "w" ? 1 : res === "d" ? 0.5 : 0;
    r.elo = Math.max(100, Math.round(r.elo + 24 * (sc - exp)));
    r[res]++; r.name = str(b.name, 30) || "Khách"; r.av = str(b.av, 8); r.last = room; r.t = Date.now();
    await st.setJSON(k, r);
    return J({ ok: true, elo: r.elo });
  }
  if (req.method === "GET") {
    const game = str(url.searchParams.get("game"), 16);
    if (!GAMES.test(game)) return J({ error: "bad" }, 400);
    const { blobs } = await st.list({ prefix: `lb:${game}:` });
    const rows = (await Promise.all(blobs.map((x) => st.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    rows.sort((a, b) => b.elo - a.elo);
    return J({ rows: rows.slice(0, 20).map((r) => ({ id: r.id, name: r.name, av: r.av, elo: r.elo, w: r.w, l: r.l, d: r.d })) });
  }
  return J({ error: "method" }, 405);
}

/* ---------------- feed ---------------- */
const REFRE = /^m[A-Za-z0-9]{12,24}$/;
const YT = /^https:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{6,20}([?&#][\w=&%.-]*)?$/;
function clean(p, admin, viewer) {
  const react = {};
  for (const [e, a] of Object.entries(p.react || {})) react[e] = { n: a.length, me: viewer ? a.includes(viewer) : false };
  return { key: p.key, id: p.id, by: p.by, name: p.name, av: p.av, text: p.text, mood: p.mood, images: p.images, video: p.video, t: p.t, react, comments: p.comments || [], reports: admin ? (p.reports || []).length : undefined, hidden: p.hidden ? true : undefined };
}
async function feed(req, S, url) {
  const st = S("feed"), ms = S("media");
  const now = Date.now();
  if (req.method === "GET") {
    const admin = isAdmin(req), viewer = idOf(url.searchParams.get("me"));
    const before = str(url.searchParams.get("before"), 60), limit = Math.min(30, Math.max(1, num(url.searchParams.get("limit")) || 15));
    const only = url.searchParams.get("reported") === "1" && admin, onlyHidden = url.searchParams.get("hidden") === "1" && admin;
    const { blobs } = await st.list({ prefix: "p:" });
    let keys = blobs.map((x) => x.key).sort();
    if (before) keys = keys.filter((k) => k > before);
    const out = [];
    let last = "";
    for (const k of keys) {
      if (out.length >= limit) break;
      const p = await st.get(k, { type: "json" }).catch(() => null);
      last = k;
      if (!p) continue;
      if (only ? !(p.reports || []).length : onlyHidden ? !p.hidden : (p.hidden && !admin)) continue;
      out.push(clean(p, admin, viewer));
    }
    return J({ posts: out, next: out.length >= limit ? last : null, now });
  }
  if (req.method === "DELETE") {
    const b = await body(req, 600);
    const k = str(b.key, 60), id = idOf(b.id);
    if (!k.startsWith("p:")) return J({ error: "bad" }, 400);
    const p = await st.get(k, { type: "json" }).catch(() => null);
    if (!p) return J({ ok: true });
    if (!(isAdmin(req) || (id && p.by === id))) return J({ error: "forbidden" }, 403);
    for (const r of [...(p.images || []), p.video && p.video.ref].filter(Boolean)) await ms.delete(r).catch(() => {});
    await st.delete(k);
    return J({ ok: true });
  }
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const b = await body(req, 8000);
  const act = str(b.act, 10), id = idOf(b.id);
  if (id.length < 6) return J({ error: "bad_id" }, 400);
  if (act === "post" || act === "comment") { const bx = await isBanned(S, id); if (bx) return BAN(bx); }
  if (act === "post") {
    const rl = await st.get("rl:" + id, { type: "json" }).catch(() => null);
    if (rl && now - rl.t < 8000) return J({ error: "rate" }, 429);
    const text = str(b.text, 2000).trim(), mood = str(b.mood, 8);
    const images = (Array.isArray(b.images) ? b.images : []).filter((r) => REFRE.test(r)).slice(0, 4);
    let video = null;
    if (b.video && REFRE.test(b.video.ref || "")) video = { ref: b.video.ref, kind: "file", dur: num(b.video.dur) };
    else if (b.video && YT.test(b.video.url || "")) video = { kind: "yt", url: b.video.url };
    if (!text && !images.length && !video && !mood) return J({ error: "empty" }, 400);
    const key = `p:${String(9999999999999 - now).padStart(13, "0")}:${rid(6)}`;
    const p = { key, by: id, name: str(b.name, 30) || "Khách", av: str(b.av, 8), text, mood, images, video, t: now, react: {}, comments: [], reports: [], hidden: false };
    await st.setJSON(key, p);
    await st.setJSON("rl:" + id, { t: now });
    return J({ ok: true, post: clean(p, false, id) });
  }
  const k = str(b.key, 60);
  if (!k.startsWith("p:")) return J({ error: "bad" }, 400);
  const p = await st.get(k, { type: "json" }).catch(() => null);
  if (!p) return J({ error: "gone" }, 404);
  if (act === "react") {
    const e = str(b.emoji, 8);
    p.react = p.react || {};
    for (const key of Object.keys(p.react)) { p.react[key] = p.react[key].filter((x) => x !== id); if (!p.react[key].length) delete p.react[key]; }
    if (e) { p.react[e] = p.react[e] || []; p.react[e].push(id); if (Object.keys(p.react).length > 8) return J({ error: "limit" }, 400); }
  } else if (act === "comment") {
    const text = str(b.text, 500).trim();
    if (!text) return J({ error: "empty" }, 400);
    p.comments = p.comments || [];
    if (p.comments.length >= 200) return J({ error: "limit" }, 400);
    p.comments.push({ c: rid(6), by: id, name: str(b.name, 30) || "Khách", av: str(b.av, 8), text, t: now });
  } else if (act === "uncomment") {
    p.comments = (p.comments || []).filter((c) => !(c.c === str(b.c, 10) && (c.by === id || isAdmin(req))));
  } else if (act === "report") {
    p.reports = p.reports || [];
    if (!p.reports.some((r) => r.by === id)) p.reports.push({ by: id, why: str(b.why, 60), t: now });
    if (p.reports.length >= 3) p.hidden = true;
  } else if (act === "hide" && isAdmin(req)) {
    p.hidden = true;
  } else if (act === "unhide" && isAdmin(req)) {
    p.hidden = false; p.reports = [];
  } else return J({ error: "bad_act" }, 400);
  await st.setJSON(k, p);
  return J({ ok: true, post: clean(p, isAdmin(req), id) });
}

/* ---------------- media ---------------- */
const IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"], VID = ["video/mp4", "video/webm", "video/quicktime"];
async function media(req, S, url, ref) {
  const st = S("media");
  if (req.method === "GET" && ref) {
    if (!REFRE.test(ref)) return J({ error: "bad" }, 400);
    const r = await st.getWithMetadata(ref, { type: "arrayBuffer" }).catch(() => null);
    if (!r) return J({ error: "gone" }, 404);
    return new Response(r.data, { status: 200, headers: { "content-type": (r.metadata && r.metadata.type) || "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "none" } });
  }
  if (req.method === "PUT") {
    const dev = idOf(req.headers.get("x-device") || "");
    if (dev.length < 6) return J({ error: "bad_id" }, 400);
    { const bx = await isBanned(S, dev); if (bx) return BAN(bx); }
    const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const isImg = IMG.includes(type), isVid = VID.includes(type);
    if (!isImg && !isVid) return J({ error: "bad_type" }, 415);
    const buf = await req.arrayBuffer();
    const max = isImg ? 1_800_000 : 4_700_000;
    if (buf.byteLength > max || buf.byteLength < 100) return J({ error: "too_large", max }, 413);
    const id = "m" + rid(16);
    await st.set(id, buf, { metadata: { type, by: dev, t: Date.now() } });
    return J({ ref: id, size: buf.byteLength });
  }
  return J({ error: "method" }, 405);
}

/* ---------------- Kho nhạc MP3 chung ---------------- */
const AUDIO_REF = /^a[A-Za-z0-9]{12,24}$/;
function publicTrack(t) {
  return { ref: t.ref, title: t.title, artist: t.artist, name: t.name, av: t.av, source: t.source, rights: t.rights, t: t.t, size: t.size, by: t.by };
}
async function music(req, S, url, parts) {
  const st = S("music"), ms = S("media"), now = Date.now();
  if (parts[0] === "session") {
    if (req.method !== "POST") return J({ error: "method" }, 405);
    const b = await body(req, 1000), session = issueChatSession(req);
    if (!session) return J({ error: "session_config" }, 503);
    const ban = await isBanned(S, session.id); if (ban) return BAN(ban);
    return J({ ok: true, session: { id: session.id }, name: str(b.name, 30) || "Thành viên" }, 200, session.cookie ? { "set-cookie": session.cookie } : {});
  }
  if (parts[0] === "file") {
    const ref = str(parts[1], 32);
    if (!AUDIO_REF.test(ref)) return J({ error: "bad_ref" }, 400);
    if (req.method !== "GET" && req.method !== "HEAD") return J({ error: "method" }, 405);
    const obj = await ms.getWithMetadata(ref, { type: "arrayBuffer" }).catch(() => null);
    if (!obj) return J({ error: "gone" }, 404);
    const data = Buffer.from(obj.data), size = data.length, range = req.headers.get("range");
    const headers = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-length": String(size) };
    if (!range || req.method === "HEAD") return new Response(req.method === "HEAD" ? null : data, { status: 200, headers });
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "cache-control": "no-store" } });
    let start, end;
    if (!m[1]) { const suffix = Math.max(1, Number(m[2]) || 0); start = Math.max(0, size - suffix); end = size - 1; }
    else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "cache-control": "no-store" } });
    end = Math.min(end, size - 1);
    const chunk = data.subarray(start, end + 1);
    return new Response(chunk, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(chunk.length) } });
  }
  if (req.method === "GET") {
    const admin = isAdmin(req), reported = url.searchParams.get("reported") === "1" && admin;
    const { blobs } = await st.list({ prefix: "track:" });
    const all = (await Promise.all(blobs.map((x) => st.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    all.sort((a, b) => b.t - a.t);
    const tracks = all.filter((x) => reported ? (x.reports || []).length : !x.hidden).slice(0, reported ? 100 : 100).map((x) => {
      const p = publicTrack(x);
      if (reported) p.reports = (x.reports || []).map((r) => ({ why: r.why, t: r.t }));
      return p;
    });
    return J({ tracks, now });
  }
  if (req.method === "POST" && url.searchParams.get("act") === "report") {
    const b = await body(req, 1200), session = chatSession(req), ref = str(b.ref, 32);
    if (!session) return J({ error: "session_required" }, 401);
    const id = session.id;
    if (!AUDIO_REF.test(ref)) return J({ error: "bad" }, 400);
    const ban = await isBanned(S, id); if (ban) return BAN(ban);
    const t = await st.get("track:" + ref, { type: "json" }).catch(() => null);
    if (!t) return J({ error: "gone" }, 404);
    t.reports = t.reports || [];
    if (!t.reports.some((r) => r.by === id)) t.reports.push({ by: id, why: str(b.why, 80), t: now });
    if (t.reports.length >= 3) t.hidden = true;
    await st.setJSON("track:" + ref, t);
    return J({ ok: true });
  }
  if (req.method === "DELETE") {
    const b = await body(req, 800), session = chatSession(req), ref = str(b.ref, 32);
    if (!AUDIO_REF.test(ref)) return J({ error: "bad" }, 400);
    const t = await st.get("track:" + ref, { type: "json" }).catch(() => null);
    if (!t) return J({ ok: true });
    if (!isAdmin(req) && (!session || t.by !== session.id)) return J({ error: "forbidden" }, 403);
    await ms.delete(ref).catch(() => {});
    await st.delete("track:" + ref);
    return J({ ok: true });
  }
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const session = chatSession(req);
  if (!session) return J({ error: chatSecret().length < 16 ? "session_config" : "session_required" }, chatSecret().length < 16 ? 503 : 401);
  const dev = session.id;
  const ban = await isBanned(S, dev); if (ban) return BAN(ban);
  if (url.searchParams.get("terms") !== "1") return J({ error: "terms_required" }, 400);
  const title = str(url.searchParams.get("title"), 100).trim(), artist = str(url.searchParams.get("artist"), 80).trim();
  const rights = str(url.searchParams.get("rights"), 16), source = str(url.searchParams.get("source"), 240).trim();
  const name = str(url.searchParams.get("name"), 30) || "Thành viên", av = str(url.searchParams.get("av"), 8);
  const filename = str(url.searchParams.get("filename"), 140);
  if (title.length < 2) return J({ error: "bad_title" }, 400);
  if (!["own", "public", "licensed", "copyright"].includes(rights)) return J({ error: "bad_rights" }, 400);
  if ((rights === "licensed" || rights === "copyright") && !source) return J({ error: "source_required" }, 400);
  if (!/\.mp3$/i.test(filename)) return J({ error: "bad_type" }, 415);
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(type)) return J({ error: "bad_type" }, 415);
  const limit = 4_500_000, buf = await req.arrayBuffer();
  if (buf.byteLength < 100 || buf.byteLength > limit) return J({ error: "too_large", max: limit }, 413);
  const bytes = new Uint8Array(buf), isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const isFrame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!isId3 && !isFrame) return J({ error: "bad_type" }, 415);
  const rlKey = "rl:upload:" + dev, prior = await st.get(rlKey, { type: "json" }).catch(() => null);
  if (prior && now - prior.t < 20_000) return J({ error: "rate" }, 429);
  const ref = "a" + rid(16), record = { ref, title, artist, name, av, source, rights, by: dev, t: now, size: bytes.byteLength, reports: [], hidden: false };
  await ms.set(ref, buf, { metadata: { type: "audio/mpeg", by: dev, t: now } });
  await st.setJSON("track:" + ref, record);
  await st.setJSON(rlKey, { t: now });
  return J({ ok: true, track: publicTrack(record) }, 201);
}

/* ---------------- Tin nhắn riêng ---------------- */
const CHAT_COOKIE = "tlchat";
function chatSecret() { return process.env.SESSION_SECRET || ""; }
function chatSig(id, secret) { return createHmac("sha256", secret).update(id).digest("base64url"); }
function chatSession(req) {
  const secret = chatSecret(); if (secret.length < 16) return null;
  const raw = req.headers.get("cookie") || "";
  const part = raw.split(";").map((x) => x.trim()).find((x) => x.startsWith(CHAT_COOKIE + "="));
  if (!part) return null;
  let value = ""; try { value = decodeURIComponent(part.slice(CHAT_COOKIE.length + 1)); } catch { return null; }
  const i = value.lastIndexOf("."), id = value.slice(0, i), sig = value.slice(i + 1);
  if (!/^c[A-Za-z0-9]{20,30}$/.test(id) || !sig) return null;
  const a = Buffer.from(chatSig(id, secret)), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b) ? { id } : null;
}
function issueChatSession(req) {
  const secret = chatSecret(); if (secret.length < 16) return null;
  const old = chatSession(req); if (old) return { id: old.id, cookie: "" };
  const id = "c" + rid(24), secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return { id, cookie: `${CHAT_COOKIE}=${id}.${chatSig(id, secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${secure ? "; Secure" : ""}` };
}
function chatPair(a, b) { return [a, b].sort().join(":"); }
function chatBlank(a, b) { return { users: [a, b].sort(), profiles: {}, messages: [], typing: {}, threadReports: [], next: 1, t: Date.now() }; }
function chatPeer(rec, id, fallback) {
  const p = (rec && rec.profiles && rec.profiles[id]) || fallback || {};
  return { id, name: str(p.name, 30) || "Thành viên", av: str(p.av, 8), online: !!p.online, seen: tsn(p.seen) };
}
async function chat(req, S, url) {
  const st = S("chat"), now = Date.now(), post = req.method === "POST" ? await body(req, 5000) : null;
  if (req.method === "POST") {
    const b = post, act = str(b.act, 16);
    if (act === "hello") {
      const session = issueChatSession(req);
      if (!session) return J({ error: "session_config" }, 503);
      const ban = await isBanned(S, session.id); if (ban) return BAN(ban);
      const profile = { id: session.id, name: str(b.name, 30) || "Thành viên", av: str(b.av, 8), seen: now };
      await st.setJSON("person:" + session.id, profile);
      return J({ ok: true, me: { id: session.id, name: profile.name, av: profile.av } }, 200, session.cookie ? { "set-cookie": session.cookie } : {});
    }
  }
  const auth = chatSession(req);
  if (!auth) return J({ error: chatSecret().length < 16 ? "session_config" : "session_required" }, chatSecret().length < 16 ? 503 : 401);
  const me = auth.id;
  if (req.method === "GET") {
    const act = str(url.searchParams.get("act"), 12);
    if (act === "contacts") {
      const list = new Map(), people = await st.list({ prefix: "person:" });
      await Promise.all(people.blobs.slice(0, 1000).map(async (x) => {
        const p = await st.get(x.key, { type: "json" }).catch(() => null);
        if (!p || p.id === me || now - (p.seen || 0) > KEEP_MS) return;
        list.set(p.id, { id: p.id, name: str(p.name, 30) || "Thành viên", av: str(p.av, 8), online: now - (p.seen || 0) < ONLINE_MS, seen: p.seen || 0, lastAt: 0, lastText: "", unread: 0 });
      }));
      const { blobs } = await st.list({ prefix: "dm:" });
      await Promise.all(blobs.slice(0, 1000).map(async (x) => {
        const r = await st.get(x.key, { type: "json" }).catch(() => null);
        if (!r || !Array.isArray(r.users) || !r.users.includes(me)) return;
        const other = r.users.find((id) => id !== me); if (!other) return;
        const p = await st.get("person:" + other, { type: "json" }).catch(() => null);
        const pp = r.profiles && r.profiles[other] || {}, old = list.get(other) || { id: other, name: str(pp.name, 30) || str(p && p.name, 30) || "Thành viên", av: str(pp.av, 8) || str(p && p.av, 8), online: !!(p && now - (p.seen || 0) < ONLINE_MS), seen: tsn(p && p.seen), lastAt: 0, lastText: "", unread: 0 };
        const last = (r.messages || []).slice(-1)[0];
        old.name = str((p && p.name) || pp.name, 30) || old.name; old.av = str((p && p.av) || pp.av, 8) || old.av;
        if (p) { old.online = now - (p.seen || 0) < ONLINE_MS; old.seen = p.seen || 0; }
        if (last) { old.lastAt = last.at || 0; old.lastText = (last.from === me ? "Bạn: " : "") + str(last.text, 72); }
        old.unread = (r.messages || []).filter((m) => m.to === me && !m.readAt).length;
        list.set(other, old);
      }));
      const contacts = Array.from(list.values()).sort((a, b) => (b.unread - a.unread) || (b.lastAt - a.lastAt) || (b.online - a.online) || (b.seen - a.seen)).slice(0, 100);
      return J({ contacts, now });
    }
    if (act === "thread") {
      const other = idOf(url.searchParams.get("with"));
      if (other.length < 20 || other === me) return J({ error: "bad_peer" }, 400);
      const key = "dm:" + chatPair(me, other), r = await st.get(key, { type: "json" }).catch(() => null);
      const person = await st.get("person:" + other, { type: "json" }).catch(() => null);
      const rec = r || chatBlank(me, other), all = rec.messages || [], since = num(url.searchParams.get("since"));
      const messages = since ? all.filter((m) => m.n > since) : all.slice(-80);
      const fallback = person ? { ...person, online: now - (person.seen || 0) < ONLINE_MS } : null;
      return J({ messages, n: Math.max(0, (rec.next || 1) - 1), peer: chatPeer(rec, other, fallback), typing: !!(rec.typing && rec.typing[other] && now - rec.typing[other] < 7000), now });
    }
    return J({ error: "bad_act" }, 400);
  }
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const b = post, act = str(b.act, 16), other = idOf(b.with || b.to);
  if (other.length < 20 || other === me) return J({ error: "bad_peer" }, 400);
  const key = "dm:" + chatPair(me, other);
  let r = await st.get(key, { type: "json" }).catch(() => null) || chatBlank(me, other);
  r.profiles = r.profiles || {}; r.messages = r.messages || []; r.typing = r.typing || {}; r.threadReports = r.threadReports || [];
  const prof = { name: str(b.name, 30) || "Thành viên", av: str(b.av, 8), seen: now };
  if (act === "send" || act === "typing") r.profiles[me] = prof;
  if (act === "send") {
    const ban = await isBanned(S, me); if (ban) return BAN(ban);
    const text = str(b.text, 1000).trim(); if (!text) return J({ error: "empty" }, 400);
    const rlKey = "rl:send:" + me, prev = await st.get(rlKey, { type: "json" }).catch(() => null);
    if (prev && now - prev.t < 700) return J({ error: "rate" }, 429);
    const nonce = str(b.nonce, 40);
    if (nonce) { const dup = r.messages.find((m) => m.from === me && m.nonce === nonce); if (dup) return J({ ok: true, message: dup }); }
    const message = { id: rid(10), n: r.next || 1, from: me, to: other, name: prof.name, av: prof.av, text, at: now, readAt: 0, nonce };
    r.next = message.n + 1; r.messages.push(message); if (r.messages.length > 300) r.messages.splice(0, r.messages.length - 300);
    r.typing[me] = 0; r.t = now;
    await st.setJSON(key, r); await st.setJSON(rlKey, { t: now });
    return J({ ok: true, message });
  }
  if (act === "typing") { r.typing[me] = now; r.t = now; await st.setJSON(key, r); return J({ ok: true }); }
  if (act === "read") {
    const upto = num(b.upto); let changed = 0;
    for (const m of r.messages) if (m.to === me && !m.readAt && m.n <= upto) { m.readAt = now; changed++; }
    r.typing[me] = 0; r.t = now; await st.setJSON(key, r); return J({ ok: true, changed });
  }
  if (act === "report") {
    const mid = str(b.message, 24), m = r.messages.find((x) => x.id === mid);
    if (!m || m.from === me) return J({ error: "bad_message" }, 400);
    m.reports = m.reports || [];
    if (!m.reports.some((x) => x.by === me)) m.reports.push({ by: me, why: str(b.why, 80), t: now });
    await st.setJSON(key, r); return J({ ok: true });
  }
  if (act === "report_thread") {
    if (!r.threadReports.some((x) => x.by === me)) r.threadReports.push({ by: me, why: str(b.why, 80), t: now });
    await st.setJSON(key, r); return J({ ok: true });
  }
  return J({ error: "bad_act" }, 400);
}

/* ---------------- Bảng điểm trò chơi tiệm trà ---------------- */
async function tea(req, S, url) {
  const st = S("tea");
  if (req.method === "GET") {
    const { blobs } = await st.list({ prefix: "rank:" });
    const rows = (await Promise.all(blobs.map((x) => st.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    rows.sort((a, b) => (b.score - a.score) || (a.t - b.t));
    return J({ rows: rows.slice(0, 20).map((r) => ({ id: r.id, name: r.name, av: r.av, score: r.score, day: r.day, sales: r.sales, t: r.t })) });
  }
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const b = await body(req, 1200), id = idOf(b.id);
  if (id.length < 6 || str(b.act, 12) !== "score") return J({ error: "bad" }, 400);
  const ban = await isBanned(S, id); if (ban) return BAN(ban);
  const key = "rank:" + id, score = Math.min(100_000_000, num(b.score));
  const old = await st.get(key, { type: "json" }).catch(() => null);
  if (!old || score >= old.score) await st.setJSON(key, { id, name: str(b.name, 30) || "Khách", av: str(b.av, 8), score, day: num(b.day), sales: num(b.sales), t: Date.now() });
  return J({ ok: true, score: Math.max(score, old && old.score || 0) });
}

/* ---------------- config công khai (thông báo) ---------------- */
async function pubConfig(req, S) {
  if (req.method !== "GET") return J({ error: "method" }, 405);
  const a = await S("admin").get("cfg:announce", { type: "json" }).catch(() => null);
  const on = a && a.text && (!a.until || a.until > Date.now());
  return J({ announce: on ? { id: a.id, text: a.text, level: a.level, t: a.t } : null, now: Date.now() });
}

/* ---------------- quản trị ---------------- */
async function adminLog(st, act, info) {
  const now = Date.now();
  await st.setJSON(`log:${String(9999999999999 - now).padStart(13, "0")}:${rid(4)}`, { t: now, act, info: str(info, 200) }).catch(() => {});
}
async function admin(req, S, url) {
  if (!isAdmin(req)) return J({ error: "forbidden" }, 403);
  const st = S("admin"), now = Date.now();
  if (req.method === "GET") {
    const what = str(url.searchParams.get("what"), 12);
    if (what === "stats") {
      const t0 = Date.now();
      const ps = S("presence"), fs = S("feed"), ms = S("match"), bs = S("board"), md = S("media"), mus = S("music"), chs = S("chat"), ts = S("tea");
      const [pl, fl, ml, bl, mdl, trl, chl, tlb] = await Promise.all([ps.list(), fs.list({ prefix: "p:" }), ms.list({ prefix: "r:" }), bs.list(), md.list(), mus.list({ prefix: "track:" }), chs.list({ prefix: "dm:" }), ts.list({ prefix: "rank:" })]);
      let active = 0, ended = 0, open = 0;
      await Promise.all(ml.blobs.slice(0, 150).map(async (x) => {
        const r = await ms.get(x.key, { type: "json" }).catch(() => null);
        if (!r) return;
        if (r.status === "active" && now - (r.t || 0) < 6 * 3600 * 1000) active++; else if (r.status === "ended") ended++; else if (r.status === "open") open++;
      }));
      let hidden = 0, reported = 0;
      await Promise.all(fl.blobs.slice(0, 200).map(async (x) => {
        const p = await fs.get(x.key, { type: "json" }).catch(() => null);
        if (!p) return;
        if (p.hidden) hidden++;
        if ((p.reports || []).length) reported++;
      }));
      const games = {};
      for (const x of bl.blobs) { const g = (x.key.split(":")[1] || ""); if (g) games[g] = (games[g] || 0) + 1; }
      const bans = (await st.list({ prefix: "ban:" })).blobs.length;
      return J({ now, ms: Date.now() - t0, presence: pl.blobs.length, posts: fl.blobs.length, hidden, reported, rooms: ml.blobs.length, active, ended, open, media: Math.max(0, mdl.blobs.length - trl.blobs.length), tracks: trl.blobs.length, chats: chl.blobs.length, teaPlayers: tlb.blobs.length, games, bans });
    }
    if (what === "community") {
      const mus = S("music"), chs = S("chat");
      const [tl, cl] = await Promise.all([mus.list({ prefix: "track:" }), chs.list({ prefix: "dm:" })]);
      const tracks = [], messages = [], threads = [];
      await Promise.all(tl.blobs.map(async (x) => {
        const t = await mus.get(x.key, { type: "json" }).catch(() => null);
        if (t && (t.reports || []).length) tracks.push({ ref: t.ref, title: t.title, artist: t.artist, name: t.name, source: t.source, by: t.by, t: t.t, hidden: !!t.hidden, reports: t.reports.map((r) => ({ why: r.why, t: r.t })) });
      }));
      await Promise.all(cl.blobs.map(async (x) => {
        const r = await chs.get(x.key, { type: "json" }).catch(() => null);
        if (!r) return;
        const pair = x.key.slice(3);
        if ((r.threadReports || []).length) threads.push({ pair, users: r.users || [], reports: r.threadReports.map((z) => ({ why: z.why, t: z.t })) });
        for (const m of (r.messages || [])) if ((m.reports || []).length) messages.push({ pair, id: m.id, from: m.from, to: m.to, name: m.name, text: m.text, at: m.at, reports: m.reports.map((z) => ({ why: z.why, t: z.t })) });
      }));
      tracks.sort((a, b) => b.t - a.t); messages.sort((a, b) => b.at - a.at); threads.sort((a, b) => (b.reports[0]?.t || 0) - (a.reports[0]?.t || 0));
      return J({ tracks: tracks.slice(0, 100), messages: messages.slice(0, 100), threads: threads.slice(0, 100), now });
    }
    if (what === "matches") {
      const ms = S("match");
      const { blobs } = await ms.list({ prefix: "r:" });
      const out = [];
      await Promise.all(blobs.slice(0, 150).map(async (x) => {
        const r = await ms.get(x.key, { type: "json" }).catch(() => null);
        if (!r) return;
        const last = Math.max(r.t || 0, ...Object.values(r.seen || {}));
        out.push({ id: r.id, game: r.game, variant: r.variant, status: r.status, players: (r.players || []).map((p) => ({ id: p.id, name: p.name, av: p.av })), n: (r.moves || []).length, t: r.t, last, end: r.end || null });
      }));
      out.sort((a, b) => b.last - a.last);
      return J({ now, rooms: out });
    }
    if (what === "bans") {
      const { blobs } = await st.list({ prefix: "ban:" });
      const rows = (await Promise.all(blobs.map((x) => st.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean);
      rows.sort((a, b) => b.t - a.t);
      return J({ now, rows });
    }
    if (what === "log") {
      const { blobs } = await st.list({ prefix: "log:" });
      const keys = blobs.map((x) => x.key).sort();
      const rows = (await Promise.all(keys.slice(0, 80).map((k) => st.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
      for (const k of keys.slice(300)) await st.delete(k).catch(() => {});
      return J({ now, rows });
    }
    if (what === "cfg") {
      const a = await st.get("cfg:announce", { type: "json" }).catch(() => null);
      return J({ now, announce: a || null });
    }
    return J({ error: "bad_what" }, 400);
  }
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const b = await body(req, 3000);
  const act = str(b.act, 12);
  if (act === "deltrack" || act === "cleartrack") {
    const ref = str(b.ref, 32), mus = S("music"), rec = await mus.get("track:" + ref, { type: "json" }).catch(() => null);
    if (!AUDIO_REF.test(ref) || !rec) return J({ error: "not_found" }, 404);
    if (act === "deltrack") { await S("media").delete(ref).catch(() => {}); await mus.delete("track:" + ref); await adminLog(st, "Xóa MP3 bị báo cáo", rec.title || ref); }
    else { rec.reports = []; rec.hidden = false; await mus.setJSON("track:" + ref, rec); await adminLog(st, "Gỡ báo cáo MP3", rec.title || ref); }
    return J({ ok: true });
  }
  if (act === "delchatmsg" || act === "clearchat" || act === "delchatthread") {
    const pair = str(b.pair, 100), users = pair.split(":").map(idOf), chs = S("chat"), key = "dm:" + pair;
    if (users.length !== 2 || users.some((x) => x.length < 6) || users[0] === users[1]) return J({ error: "bad_pair" }, 400);
    const rec = await chs.get(key, { type: "json" }).catch(() => null);
    if (!rec) return J({ ok: true });
    if (act === "delchatthread") { await chs.delete(key); await adminLog(st, "Xóa cuộc trò chuyện", pair); return J({ ok: true }); }
    if (act === "delchatmsg") { const id = str(b.message, 24); rec.messages = (rec.messages || []).filter((m) => m.id !== id); await adminLog(st, "Xóa tin nhắn bị báo cáo", pair); }
    if (act === "clearchat") { rec.threadReports = []; (rec.messages || []).forEach((m) => { m.reports = []; }); await adminLog(st, "Gỡ báo cáo trò chuyện", pair); }
    await chs.setJSON(key, rec); return J({ ok: true });
  }
  if (act === "endm") {
    const ms = S("match"), r = await ms.get("r:" + idOf(b.room), { type: "json" }).catch(() => null);
    if (!r) return J({ error: "not_found" }, 404);
    r.status = "ended"; r.end = { winner: -1, reason: "admin", by: "admin", t: now }; r.rev = (r.rev || 0) + 1;
    await ms.setJSON("r:" + r.id, r);
    await adminLog(st, "Kết thúc ván", `${r.game} ${r.id}`);
    return J({ ok: true });
  }
  if (act === "delm") {
    await S("match").delete("r:" + idOf(b.room)).catch(() => {});
    await adminLog(st, "Xóa ván", idOf(b.room));
    return J({ ok: true });
  }
  if (act === "resetb") {
    const game = str(b.game, 16), id = idOf(b.id), bs = S("board");
    if (!GAMES.test(game)) return J({ error: "bad" }, 400);
    if (id) { await bs.delete(`lb:${game}:${id}`).catch(() => {}); await adminLog(st, "Xóa điểm xếp hạng", `${game} ${id}`); return J({ ok: true, n: 1 }); }
    const { blobs } = await bs.list({ prefix: `lb:${game}:` });
    for (const x of blobs) await bs.delete(x.key).catch(() => {});
    await adminLog(st, "Đặt lại bảng xếp hạng", `${game} (${blobs.length} dòng)`);
    return J({ ok: true, n: blobs.length });
  }
  if (act === "ban") {
    const id = idOf(b.id);
    if (id.length < 6) return J({ error: "bad_id" }, 400);
    const hours = Math.max(0, Math.min(24 * 365, num(b.hours)));
    const rec = { id, name: str(b.name, 30), reason: str(b.reason, 100), t: now, until: hours ? now + hours * 3600 * 1000 : 0 };
    await st.setJSON("ban:" + id, rec);
    await adminLog(st, "Hạn chế người dùng", `${rec.name || id}${hours ? " " + hours + " giờ" : " vĩnh viễn"}${rec.reason ? ": " + rec.reason : ""}`);
    return J({ ok: true });
  }
  if (act === "unban") {
    await st.delete("ban:" + idOf(b.id)).catch(() => {});
    await adminLog(st, "Bỏ hạn chế", idOf(b.id));
    return J({ ok: true });
  }
  if (act === "announce") {
    const text = str(b.text, 300).trim();
    if (!text) { await st.delete("cfg:announce").catch(() => {}); await adminLog(st, "Gỡ thông báo", ""); return J({ ok: true, cleared: true }); }
    const hours = Math.max(0, Math.min(24 * 90, num(b.hours)));
    const rec = { id: rid(5), text, level: ["info", "warn"].includes(b.level) ? b.level : "info", t: now, until: hours ? now + hours * 3600 * 1000 : 0 };
    await st.setJSON("cfg:announce", rec);
    await adminLog(st, "Đăng thông báo", text);
    return J({ ok: true, announce: rec });
  }
  if (act === "msg") {
    const id = idOf(b.id), text = str(b.text, 300).trim();
    if (id.length < 6 || !text) return J({ error: "bad" }, 400);
    const cur = (await st.get("dm:" + id, { type: "json" }).catch(() => null)) || [];
    cur.push({ text, t: now }); while (cur.length > 5) cur.shift();
    await st.setJSON("dm:" + id, cur);
    await adminLog(st, "Nhắn người dùng", `${id}: ${text}`);
    return J({ ok: true });
  }
  if (act === "purge") {
    const days = Math.max(1, Math.min(365, num(b.days) || 30)), lim = now - days * 86400000;
    const ps = S("presence"), ms = S("match");
    let pu = 0, ro = 0;
    for (const x of (await ps.list()).blobs) { const r = await ps.get(x.key, { type: "json" }).catch(() => null); if (!r || (r.seen || 0) < lim) { await ps.delete(x.key).catch(() => {}); pu++; } }
    for (const x of (await ms.list({ prefix: "r:" })).blobs) { const r = await ms.get(x.key, { type: "json" }).catch(() => null); if (!r || (r.t || 0) < lim) { await ms.delete(x.key).catch(() => {}); ro++; } }
    await adminLog(st, "Dọn dữ liệu cũ", `${days} ngày: ${pu} người dùng, ${ro} ván`);
    return J({ ok: true, presence: pu, rooms: ro });
  }
  return J({ error: "bad_act" }, 400);
}
