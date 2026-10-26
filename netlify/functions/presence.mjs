import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

const getPresenceStore = () => getStore("so-tay-user-presence");
const ACTIVE_MS = 90_000;
const COOKIE = "presence_admin";
const COOKIE_PATH = "/.netlify/functions/presence";

function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function tokenFor(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function validAdmin(req) {
  const secret = process.env.PRESENCE_SIGNING_SECRET;
  if (!secret || secret.length < 32) return false;
  const cookie = (req.headers.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const token = cookie.slice(COOKIE.length + 1);
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload?.role === "admin" && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

async function allBlobs() {
  const found = [];
  let cursor;
  do {
    const page = await getPresenceStore().list({ prefix: "session:", ...(cursor ? { cursor } : {}) });
    found.push(...(page.blobs || []));
    cursor = page.cursor;
  } while (cursor);
  return found;
}

function normalizedName(name) {
  return String(name || "").normalize("NFC").trim().replace(/\s+/g, " ").slice(0, 60);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  let body = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return reply({ error: "Dữ liệu gửi lên không hợp lệ." }, 400);
    }
  }

  if (req.method === "POST" && body.op === "admin-login") {
    const password = process.env.PRESENCE_ADMIN_PASSWORD;
    const signingSecret = process.env.PRESENCE_SIGNING_SECRET;
    if (!password || !signingSecret || signingSecret.length < 32) {
      return reply({ error: "Chưa cấu hình PRESENCE_ADMIN_PASSWORD và PRESENCE_SIGNING_SECRET trong Netlify." }, 503);
    }
    const submitted = Buffer.from(String(body.password || ""));
    const configured = Buffer.from(password);
    if (submitted.length !== configured.length || !timingSafeEqual(submitted, configured)) {
      return reply({ error: "Mật khẩu bảng trạng thái không đúng." }, 401);
    }
    const value = tokenFor({ role: "admin", exp: Date.now() + 12 * 60 * 60 * 1000 }, signingSecret);
    return reply({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=43200`,
    });
  }

  if (req.method === "POST" && body.op === "admin-logout") {
    return reply({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=0`,
    });
  }

  if (req.method === "GET") {
    if (!validAdmin(req)) return reply({ error: "Cần xác thực quản trị để xem trạng thái." }, 401);
    try {
      const now = Date.now();
      const blobs = await allBlobs();
      const active = [];
      for (const item of blobs) {
        const record = await getPresenceStore().get(item.key, { type: "json" });
        if (!record || typeof record.updatedAt !== "number") continue;
        if (now - record.updatedAt > ACTIVE_MS) {
          await getPresenceStore().delete(item.key);
          continue;
        }
        active.push(record);
      }
      const grouped = new Map();
      for (const record of active) {
        const name = normalizedName(record.name);
        if (!name) continue;
        const key = name.toLocaleLowerCase("vi-VN");
        const row = grouped.get(key) || { name, sessions: 0, lastSeen: 0 };
        row.sessions += 1;
        row.lastSeen = Math.max(row.lastSeen, record.updatedAt);
        grouped.set(key, row);
      }
      const users = [...grouped.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      return reply({ users, checkedAt: now, expiresAfterSeconds: ACTIVE_MS / 1000 });
    } catch (error) {
      console.error("Presence read failed", error);
      return reply({ error: "Không đọc được trạng thái từ Netlify Blobs." }, 503);
    }
  }

  if (req.method === "POST" && body.op === "beat") {
    const sessionId = String(body.sessionId || "");
    const name = normalizedName(body.name);
    if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !name) {
      return reply({ error: "Thiếu mã phiên hoặc tên người dùng." }, 400);
    }
    try {
      const key = `session:${sessionId}`;
      const now = Date.now();
      const previous = await getPresenceStore().get(key, { type: "json" });
      // Ignore unusually frequent repeats; regular clients send one heartbeat every 30 seconds.
      if (previous && now - Number(previous.updatedAt || 0) < 15_000) return reply({ ok: true });
      await getPresenceStore().setJSON(key, { name, updatedAt: now });
      return reply({ ok: true });
    } catch (error) {
      console.error("Presence heartbeat failed", error);
      return reply({ error: "Không lưu được heartbeat." }, 503);
    }
  }

  return reply({ error: "Phương thức hoặc thao tác không được hỗ trợ." }, 405, { Allow: "GET, POST, OPTIONS" });
};
