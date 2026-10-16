// Máy chủ chung cho "Sổ tay học tập" (một hàm duy nhất, đường dẫn /api/*), lưu bằng Netlify Blobs.
//   /api/presence  tín hiệu hoạt động + danh sách cho quản trị viên
//   /api/match     ghép trận, phòng riêng, chuyển nước đi cho game đối kháng
//   /api/board     bảng xếp hạng ELO
//   /api/feed      bảng tin (bài đăng, cảm xúc, bình luận, báo cáo)
//   /api/media     ảnh và video ngắn của bảng tin
// Biến môi trường: ADMIN_KEY (mật khẩu quản trị) dùng cho các thao tác quản trị.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomBytes } from "node:crypto";

const ONLINE_MS = 90 * 1000, KEEP_MS = 30 * 24 * 3600 * 1000;
const WAIT_MS = 25 * 1000, ROOM_KEEP = 24 * 3600 * 1000;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(1e9, Math.round(+v))) : 0);
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
    return J({ error: "not_found" }, 404);
  } catch (e) {
    if (e && e.code) return J({ error: e.message }, e.code);
    console.error(e);
    return J({ error: "server" }, 500);
  }
};
export const config = { path: "/api/*" };

/* ---------------- presence ---------------- */
async function presence(req, S, url) {
  const store = S("presence");
  if (req.method === "POST") {
    const b = await body(req, 4000);
    const id = idOf(b.id);
    if (id.length < 6) return J({ error: "bad_id" }, 400);
    await store.setJSON(id, {
      id, name: str(b.name, 30) || "Khách", av: str(b.av, 8), guest: !!b.guest, reg: num(b.reg),
      act: str(b.act, 80), view: str(b.view, 20), tool: str(b.tool, 30), subj: str(b.subj, 60),
      lvl: num(b.lvl), xp: num(b.xp), min: num(b.min), total: num(b.total), streak: num(b.streak),
      dev: str(b.dev, 20), scr: str(b.scr, 16), lang: str(b.lang, 12), since: num(b.since), seen: Date.now(),
    });
    return J({ ok: true, now: Date.now() });
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
    const only = url.searchParams.get("reported") === "1" && admin;
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
      if (only ? !(p.reports || []).length : (p.hidden && !admin)) continue;
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
