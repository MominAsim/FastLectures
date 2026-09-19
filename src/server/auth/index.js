"use strict";
// FastLectures authentication: accounts, sessions, email verification, password
// reset. Self-hosted friendly — uses only the Node standard library plus node:sqlite
// (already a hard dependency via Canvas Agent), so there is no auth vendor, no paid
// database, and no per-user cost as the student base grows.
//
// Usage from main.js:
//   const { createAuth } = require("./auth/index.js");
//   const auth = createAuth({ send, readJson, isJsonRequest, stateDirectory, log });
//   ... inside the request chain:
//   if (url.pathname.startsWith("/api/auth/")) return auth.handle(req, res, url);
const { openStore } = require("./store.js");
const { hashToken, hashPassword, verifyPassword, normalizeEmail, passwordIssues, randomToken, randomId } = require("./crypto.js");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_COOKIE = "fl_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MS = 30 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const MAX_LOGIN_PER_IP = 20;
const LOGIN_RATE_WINDOW_MS = 60 * 60 * 1000;
const AUTH_BODY_LIMIT = 16 * 1024;
const AUTH_ROUTES = new Set(["register", "login", "logout", "me", "verify", "verify/resend", "forgot", "reset", "status", "sessions", "sessions/revoke", "sessions/revoke-all"]);

function now() { return Date.now(); }

function authError(code, message, extra) { return Object.assign(new Error(message), { code, ...extra }); }

function publicUser(row) { return row ? { id: row.id, email: row.email, name: row.name, verified: row.verified_at != null } : null; }

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.socket.remoteAddress || "").toLowerCase();
}
function userAgent(req) { return String(req.headers["user-agent"] || "").slice(0, 256); }

const loginIpTracker = new Map();
function trackLoginAttempt(ip) {
  const now = nowProvider();
  const attempts = loginIpTracker.get(ip) || [];
  const recent = attempts.filter(t => now - t < LOGIN_RATE_WINDOW_MS);
  recent.push(now);
  loginIpTracker.set(ip, recent);
  return recent.length;
}
function isIpRateLimited(ip) {
  const attempts = loginIpTracker.get(ip) || [];
  const recent = attempts.filter(t => nowProvider() - t < LOGIN_RATE_WINDOW_MS);
  return recent.length >= MAX_LOGIN_PER_IP;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      const key = part.slice(0, index).trim();
      let value = part.slice(index + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (key) out[key] = value;
    }
  }
  return out;
}

function requestOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
  if (!host) return null;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : req.socket && req.socket.encrypted ? "https" : "http";
  return `${proto}://${host}`;
}
// State-changing auth requests must come from this page's own origin. The Origin
// header is only required when the browser sends one (it always does for POST), so
// direct CLI/test callers that omit it are not blocked by accident.
function sameOriginWrite(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  const expected = requestOrigin(req);
  if (!expected) return false;
  try { const url = new URL(origin); return url.origin === expected && !url.pathname.slice(1) && !url.search && !url.hash && !url.username && !url.password; } catch { return false; }
}

function sessionCookie(value, req, { maxAge = SESSION_TTL_MS / 1000 } = {}) {
  // Secure is only valid over https; browsers silently drop Secure cookies sent on
  // http://localhost, which is where students run this app by default.
  const secure = String(requestOrigin(req) || "").startsWith("https:") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure}`;
}

function emailContent(kind, url) {
  const action = kind === "verify" ? "verify your email address" : "reset your password";
  const ttl = kind === "verify" ? "24 hours" : "1 hour";
  return {
    subject: kind === "verify" ? "Verify your FastLectures email" : "Reset your FastLectures password",
    text:`Welcome to FastLectures!\n\nOpen this link to ${action}:\n\n${url}\n\nThe link expires in ${ttl}. If you didn't request it, ignore this message — nothing changes.\n\n— FastLectures\n`,
    html:`<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#17181c"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:28px"><h2 style="margin:0 0 10px;font-size:19px">FastLectures</h2><p style="margin:0 0 20px;font-size:15px">Open this link to <strong>${action}</strong>:</p><p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-size:15px">${kind === "verify" ? "Verify email" : "Choose a new password"}</a></p><p style="margin:0 0 4px;color:#6b6f76;font-size:13px">Or paste this link into your browser:</p><p style="margin:0 0 20px;word-break:break-all;font-size:13px"><a href="${url}" style="color:#2f6fed">${url}</a></p><p style="margin:0;color:#9aa1ad;font-size:12px">Expires in ${ttl}. Didn't ask for this? Ignore it — nothing changes.</p></div></body></html>`,
  };
}

function createAuth(options = {}) {
  const {
    send = (res, code, data) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); },
    readJson = defaultReadJson,
    stateDirectory,
    file = stateDirectory ? path.join(stateDirectory, "study.sqlite") : null,
    log = () => {},
    sendEmail = null,
    nowProvider = now,
  } = options;
  if (!file) throw new Error("FastLectures auth needs a state directory or explicit database file.");

  let store = null, initError = null;
  function ensureStore() {
    if (store || initError) return store;
    try {
      const db = openStore(file);
      const existing = db.prepare("SELECT value FROM secrets WHERE key = 'token_pepper'").get();
      let pepper = typeof existing?.value === "string" && existing.value.length >= 32 ? existing.value : null;
      if (!pepper) {
        pepper = crypto.randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO secrets (key, value) VALUES ('token_pepper', ?)").run(pepper);
      }
      store = { db, pepper, hash: token => hashToken(String(token), pepper) };
    } catch (error) {
      initError = error;
      log({ type: "auth-storage-error", error: String(error?.message || error) });
    }
    return store;
  }

  const queue = { write: null };
  function verificationQueue() {
    if (queue.write !== null) return queue.write;
    try {
      const dir = path.join(path.dirname(file), "verification-queue");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      queue.write = dir;
    } catch { queue.write = false; }
    return queue.write;
  }

  async function deliver(s, { to, kind, url }) {
    const content = emailContent(kind, url), createdAt = nowProvider();
    const id = randomId();
    s.db.prepare("INSERT INTO email_outbox (id, to_email, subject, text_body, html_body, link, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, to, content.subject, content.text, content.html, url, kind, createdAt);
    const dir = verificationQueue();
    if (dir) { try { fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ to, kind, url, subject: content.subject, text: content.text }, null, 2) + "\n", { mode: 0o600 }); } catch (error) { log({ type: "auth-queue-error", error: String(error?.message || error) }); } }
    const endpoint = String(process.env.FASTLECTURES_EMAIL_ENDPOINT || "").trim();
    if (!endpoint) return { delivered: false, queued: true };
    try {
      const response = await (sendEmail || (payload => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) })))(
        { to, subject: content.subject, text: content.text, html: content.html },
      );
      const ok = response === true || !!response?.ok;
      s.db.prepare("UPDATE email_outbox SET delivered_at = ?, attempts = attempts + 1 WHERE id = ?").run(ok ? nowProvider() : null, id);
      if (!ok) s.db.prepare("UPDATE email_outbox SET error = ? WHERE id = ?").run(`status:${response?.status ?? "unknown"}`, id);
      return { delivered: ok, queued: !ok };
    } catch (error) {
      s.db.prepare("UPDATE email_outbox SET attempts = attempts + 1, error = ? WHERE id = ?").run(String(error?.message || "send_error").slice(0, 200), id);
      return { delivered: false, queued: true };
    }
  }

  // ── services ───────────────────────────────────────────────────────────────

  function register(s, { email, password, name }) {
    const clean = normalizeEmail(email);
    if (!clean) throw authError("email_invalid", "Enter a valid email address.");
    const issues = passwordIssues(password);
    if (issues.length) throw authError("password_weak", issues[0], { issues });
    const display = String(name == null ? "" : name).trim().slice(0, 80) || clean.split("@")[0];
    if (s.db.prepare("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL").get(clean)) throw authError("email_taken", "An account with this email already exists. Try signing in instead.");
    const id = randomId(), ts = nowProvider();
    const verifyToken = randomToken();
    s.db.transaction(() => {
      s.db.prepare("INSERT INTO users (id, email, name, password_hash, verified_at, created_at, updated_at) VALUES (@id, @email, @name, @hash, NULL, @ts, @ts)")
        .run({ id, email: clean, name: display, hash: hashPassword(password), ts });
      s.db.prepare("INSERT INTO tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (@hash, @userId, 'verify', @ts, @expires)")
        .run({ hash: s.hash(`verify:${verifyToken}`), userId: id, ts, expires: ts + VERIFY_TTL_MS });
    })();
    return { id, email: clean, name: display, verifyToken };
  }

  function login(s, { email, password, req }) {
    const ip = clientIp(req);
    if (isIpRateLimited(ip)) {
      throw authError("rate_limited", "Too many login attempts from this network. Wait a few minutes.");
    }
    trackLoginAttempt(ip);
    const clean = normalizeEmail(email);
    const user = clean ? s.db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(clean) : null;
    if (!user || (user.locked_until > nowProvider())) {
      // Burn a comparable amount of time even when the account is unknown, so the
      // response cannot be timed into an account-existence oracle.
      if (!user) try { verifyPassword(String(password || "x"), "scrypt$16384$8$1$" + crypto.randomBytes(16).toString("base64") + "$" + crypto.randomBytes(64).toString("base64")); } catch {}
      throw authError("invalid_credentials", user && user.locked_until > nowProvider() ? "Too many attempts. Wait a few minutes or reset your password." : "That email or password doesn't match an account.");
    }
    if (!verifyPassword(password, user.password_hash)) {
      const failed = user.failed_logins + 1;
      s.db.prepare("UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?").run(failed, failed >= MAX_LOGIN_ATTEMPTS ? nowProvider() + LOCK_MS : 0, nowProvider(), user.id);
      throw authError("invalid_credentials", "That email or password doesn't match an account.");
    }
    const ts = nowProvider(), token = randomToken();
    s.db.transaction(() => {
      s.db.prepare("UPDATE users SET last_login_at = @ts, failed_logins = 0, locked_until = 0, updated_at = @ts WHERE id = @id").run({ ts, id: user.id });
      s.db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip) VALUES (@hash, @userId, @ts, @expires, @agent, @ip)")
        .run({ hash: s.hash(`session:${token}`), userId: user.id, ts, expires: ts + SESSION_TTL_MS, agent: userAgent(req), ip: clientIp(req) });
    })();
    return { user: publicUser(user), token, expiresAt: ts + SESSION_TTL_MS };
  }

  function userFromRequest(s, req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const row = s.db.prepare("SELECT s.expires_at AS session_expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.deleted_at IS NULL").get(s.hash(`session:${token}`));
    if (!row) return null;
    if (row.session_expires_at < nowProvider()) {
      s.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(s.hash(`session:${token}`));
      return null;
    }
    return publicUser(row);
  }

  function verifyEmail(s, token) {
    const hash = s.hash(`verify:${String(token || "")}`);
    const row = s.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND purpose = 'verify' AND consumed_at IS NULL AND expires_at > ?").get(hash, nowProvider());
    if (!row) return null;
    const ts = nowProvider();
    const user = s.db.transaction(() => {
      s.db.prepare("UPDATE tokens SET consumed_at = @ts WHERE token_hash = @hash").run({ ts, hash });
      s.db.prepare("UPDATE users SET verified_at = @ts, updated_at = @ts WHERE id = @id").run({ ts, id: row.user_id });
      return s.db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(row.user_id);
    })();
    return publicUser(user);
  }

  function beginReset(s, email) {
    const clean = normalizeEmail(email);
    const user = clean ? s.db.prepare("SELECT id, email, name, verified_at FROM users WHERE email = ? AND deleted_at IS NULL").get(clean) : null;
    if (!user) return null;
    const recent = s.db.prepare("SELECT created_at FROM email_outbox WHERE to_email = ? AND kind = 'reset' ORDER BY created_at DESC LIMIT 1").get(user.email);
    if (recent && nowProvider() - recent.created_at < EMAIL_COOLDOWN_MS) return { throttled: true, user };
    const token = randomToken(), ts = nowProvider();
    s.db.prepare("INSERT INTO tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (@hash, @userId, 'reset', @ts, @expires)")
      .run({ hash: s.hash(`reset:${token}`), userId: user.id, ts, expires: ts + RESET_TTL_MS });
    return { token, user };
  }

  function completeReset(s, { token, password }) {
    const issues = passwordIssues(password);
    if (issues.length) throw authError("password_weak", issues[0], { issues });
    const hash = s.hash(`reset:${String(token || "")}`);
    const row = s.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND purpose = 'reset' AND consumed_at IS NULL AND expires_at > ?").get(hash, nowProvider());
    if (!row) return null;
    const ts = nowProvider();
    const user = s.db.transaction(() => {
      s.db.prepare("UPDATE tokens SET consumed_at = @ts WHERE token_hash = @hash").run({ ts, hash });
      s.db.prepare("UPDATE users SET password_hash = @hash2, updated_at = @ts, failed_logins = 0, locked_until = 0 WHERE id = @id").run({ ts, hash2: hashPassword(password), id: row.user_id });
      s.db.prepare("DELETE FROM sessions WHERE user_id = @id").run({ id: row.user_id });
      return s.db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(row.user_id);
    })();
    return publicUser(user);
  }

  function status(s, req) {
    const user = s ? userFromRequest(s, req) : null;
    return {
      enabled: true,
      authenticated: !!user,
      user,
      emailDelivery: String(process.env.FASTLECTURES_EMAIL_ENDPOINT || "").trim() ? "endpoint" : "queue",
      returnsLinks: process.env.FASTLECTURES_AUTH_RETURN_LINKS === "true",
    };
  }

  function authLink(req, path) {
    const origin = requestOrigin(req);
    return origin && path ? `${origin}${path}` : path || null;
  }

  // ── route table ────────────────────────────────────────────────────────────

  const routes = {
    "status GET": async ({ req, res }) => send(res, 200, status(ensureStore(), req)),
    "me GET": async ({ req, res, s }) => {
      const user = userFromRequest(s, req);
      return user ? send(res, 200, { authenticated: true, user }) : send(res, 401, { authenticated: false, error: "Not signed in." });
    },
    "register POST": async ({ req, res, s, body }) => {
      if (!body?.email || !body?.password || !body?.name) throw authError("invalid_request", "Email, password, and name are required.");
      const created = register(s, body);
      const url = authLink(req, `/verify.html?token=${encodeURIComponent(created.verifyToken)}`);
      const delivery = await deliver(s, { to: created.email, kind: "verify", url: url || "" });
      const showLink = process.env.FASTLECTURES_AUTH_RETURN_LINKS === "true";
      return send(res, 201, { user: publicUser({ ...created, verified_at: null }), verificationDelivery: delivery.delivered ? "sent" : "queued", ...(showLink && url ? { verifyUrl: url } : {}) });
    },
    "login POST": async ({ req, res, s, body }) => {
      if (!body?.email || !body?.password) throw authError("invalid_request", "Email and password are required.");
      const result = login(s, { email: body?.email, password: body?.password, req });
      res.setHeader("Set-Cookie", sessionCookie(result.token, req));
      return send(res, 200, { user: result.user, expiresAt: result.expiresAt });
    },
    "logout POST": async ({ req, res, s }) => {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) s.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(s.hash(`session:${token}`));
      res.setHeader("Set-Cookie", sessionCookie("", req, { maxAge: 0 }));
      return send(res, 200, { ok: true });
    },
    "sessions GET": async ({ req, res, s }) => {
      const user = userFromRequest(s, req);
      if (!user) return send(res, 401, { authenticated: false, error: "Not signed in." });
      const currentToken = parseCookies(req)[SESSION_COOKIE];
      const currentHash = currentToken ? s.hash(`session:${currentToken}`) : null;
      const sessions = s.db.prepare("SELECT token_hash AS token, id, created_at, expires_at, user_agent, ip, CASE WHEN token_hash = ? THEN 1 ELSE 0 END AS is_current FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 25").all(currentHash, user.id, nowProvider());
      return send(res, 200, { sessions });
    },
    "sessions/revoke POST": async ({ req, res, s, body }) => {
      const user = userFromRequest(s, req);
      if (!user) return send(res, 401, { authenticated: false, error: "Not signed in." });
      const token = parseCookies(req)[SESSION_COOKIE];
      const currentHash = token ? s.hash(`session:${token}`) : null;
      const revokeHash = body?.token ? s.hash(`session:${body.token}`) : null;
      if (revokeHash && revokeHash !== currentHash) {
        s.db.prepare("DELETE FROM sessions WHERE token_hash = ? AND user_id = ?").run(revokeHash, user.id);
      }
      return send(res, 200, { ok: true });
    },
    "sessions/revoke-all POST": async ({ req, res, s }) => {
      const user = userFromRequest(s, req);
      if (!user) return send(res, 401, { authenticated: false, error: "Not signed in." });
      const token = parseCookies(req)[SESSION_COOKIE];
      const currentHash = token ? s.hash(`session:${token}`) : null;
      s.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(user.id, currentHash);
      return send(res, 200, { ok: true });
    },
    "verify POST": async ({ req, res, s, body }) => {
      const user = verifyEmail(s, body?.token);
      if (!user) return send(res, 400, { error: "That verification link is invalid or has expired. Request a new one." });
      // A verified email is proof of control — start a session so the student lands
      // straight in the app instead of having to type a password again.
      const token = randomToken(), ts = nowProvider();
      s.db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip) VALUES (@hash, @userId, @ts, @expires, @agent, @ip)")
        .run({ hash: s.hash(`session:${token}`), userId: user.id, ts, expires: ts + SESSION_TTL_MS, agent: userAgent(req), ip: clientIp(req) });
      res.setHeader("Set-Cookie", sessionCookie(token, req));
      return send(res, 200, { verified: true, user });
    },
    "verify/resend POST": async ({ req, res, s, body }) => {
      const clean = normalizeEmail(body?.email);
      const user = clean ? s.db.prepare("SELECT id, email, name, verified_at FROM users WHERE email = ? AND deleted_at IS NULL").get(clean) : null;
      if (!user) return send(res, 200, { ok: true }); // never reveal whether an account exists
      if (user.verified_at != null) return send(res, 200, { ok: true, alreadyVerified: true });
      const recent = s.db.prepare("SELECT created_at FROM email_outbox WHERE to_email = ? AND kind = 'verify' ORDER BY created_at DESC LIMIT 1").get(user.email);
      if (recent && nowProvider() - recent.created_at < EMAIL_COOLDOWN_MS) return send(res, 200, { ok: true, throttled: true });
      const token = randomToken(), ts = nowProvider();
      s.db.prepare("INSERT INTO tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (@hash, @userId, 'verify', @ts, @expires)")
        .run({ hash: s.hash(`verify:${token}`), userId: user.id, ts, expires: ts + VERIFY_TTL_MS });
      const url = authLink(req, `/verify.html?token=${encodeURIComponent(token)}`);
      await deliver(s, { to: user.email, kind: "verify", url: url || "" });
      return send(res, 200, { ok: true, ...(process.env.FASTLECTURES_AUTH_RETURN_LINKS === "true" && url ? { verifyUrl: url } : {}) });
    },
    "forgot POST": async ({ req, res, s, body }) => {
      const reset = beginReset(s, body?.email);
      if (reset?.token) {
        const url = authLink(req, `/reset.html?token=${encodeURIComponent(reset.token)}`);
        await deliver(s, { to: reset.user.email, kind: "reset", url: url || "" });
      }
      // Identical response whether or not the address exists — no account oracle.
      return send(res, 200, { ok: true, checkInbox: true });
    },
    "reset POST": async ({ req, res, s, body }) => {
      const user = completeReset(s, { token: body?.token, password: body?.password });
      if (!user) return send(res, 400, { error: "That reset link is invalid or has expired. Request a new one." });
      return send(res, 200, { reset: true });
    },
  };

  async function handle(req, res, url) {
    const route = url.pathname.slice("/api/auth/".length);
    if (!AUTH_ROUTES.has(route)) { send(res, 404, { error: "Unknown auth endpoint." }); return false; }
    const method = req.method === "HEAD" ? "GET" : req.method;
    const key = `${route} ${method}`;
    const handler = routes[key];
    if (!handler) { res.setHeader("Allow", method === "GET" ? "GET" : "POST"); return send(res, 405, { error: "Method Not Allowed" }), true; }
    if (method !== "GET" && !sameOriginWrite(req)) { send(res, 403, { error: "Requests must come from your own FastLectures page." }); return true; }
    const s = ensureStore();
    if (!s) { send(res, 503, { error: "Authentication storage is unavailable on this FastLectures instance." }); return true; }
    try {
      const body = method === "POST" ? await readJson(req, AUTH_BODY_LIMIT) : null;
      if (method === "POST") {
        const type = String(req.headers["content-type"] || "");
        if (!type.includes("application/json")) { send(res, 415, { error: "Use application/json for this request." }); return true; }
        if (!body || typeof body !== "object" || Array.isArray(body)) { send(res, 400, { error: "Send a JSON object." }); return true; }
      }
      await handler({ req, res, url, s, body });
      return true;
    } catch (error) {
      const code = error?.code;
      const status = code === "email_taken" ? 409 : code === "password_weak" || code === "email_invalid" || code === "invalid_json" || code === "invalid_request" ? 400 : code === "invalid_credentials" ? 401 : code === "rate_limited" ? 429 : code === "locked" ? 423 : code === "payload_too_large" ? 413 : 500;
      if (status === 500) log({ type: "auth-error", errorCode: String(code || "auth_error"), error: String(error?.message || error) });
      send(res, status, { error: status === 500 ? "Authentication failed. Try again." : error.message, ...(error.issues ? { issues: error.issues } : {}) });
      return true;
    }
  }

  function sweep() {
    const s = store;
    if (!s) return;
    try {
      const ts = nowProvider();
      s.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(ts);
      s.db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(ts);
      s.db.prepare("DELETE FROM email_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?").run(ts - 30 * 24 * 60 * 60 * 1000);
    } catch (error) { log({ type: "auth-sweep-error", error: String(error?.message || error) }); }
  }

  return {
    handle,
    status: req => status(store, req),
    user: req => (store ? userFromRequest(store, req) : null),
    isAuthenticated: req => !!userFromRequest(store, req),
    ensureStore,
    sweep,
    SESSION_COOKIE,
    file,
    get enabled() { return true; },
  };
}

function defaultReadJson(req, limit = AUTH_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(authError("payload_too_large", "Request body is too large.")); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(authError("invalid_json", "Send a JSON object.")); } });
    req.on("error", reject);
  });
}

module.exports = { createAuth, SESSION_COOKIE, SESSION_TTL_MS, VERIFY_TTL_MS, RESET_TTL_MS, MAX_LOGIN_ATTEMPTS, LOCK_MS, parseCookies, requestOrigin, sameOriginWrite, sessionCookie, emailContent, publicUser, authError };
