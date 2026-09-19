"use strict";
// FastLectures school administration and billing server. Extends the auth
// system with school registration, teacher panel, and global admin dashboard
// routes. Self-hosted friendly — uses only the Node standard library plus
// node:sqlite (already a hard dependency via the auth store).
//
// Usage from main.js:
//   const { createSchoolAdmin } = require("./school-admin/index.js");
//   const schoolAdmin = createSchoolAdmin({ send, readJson, stateDirectory, log });
//   ... inside the request chain:
//   if (url.pathname.startsWith("/api/schools/") || url.pathname.startsWith("/api/admin/")) {
//     if (await schoolAdmin.handle(req, res, url)) return;
//   }
//
// Pricing model (hard-coded per spec):
//   School student account : $14
//   Individual student      : $20
//   School rebate           : $2 per account (credited back to the school)

const { DatabaseSync } = require("node:sqlite");
const {
  hashPassword, verifyPassword, normalizeEmail, normalizePassword,
  passwordIssues, randomToken, randomId,
} = require("../auth/crypto.js");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// ── constants ────────────────────────────────────────────────

const SCHOOL_SESSION_COOKIE = "fl_school_session";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AUTH_BODY_LIMIT = 16 * 1024;
const SCHOOL_DOMAINS = [".edu", ".school"];
const SCHOOL_PRICE_STUDENT = 14;
const INDIVIDUAL_PRICE_STUDENT = 20;
const SCHOOL_REBATE = 2;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 512;
const NAME_MAX = 120;
const ADDRESS_MAX = 512;
const EMAIL_MAX = 320;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── helpers ────────────────────────────────────────────────

function now() { return Date.now(); }

function schoolAdminError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...extra });
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.socket.remoteAddress || "").toLowerCase();
}
function userAgent(req) { return String(req.headers["user-agent"] || "").slice(0, 256); }

function validateString(value, { min = 0, max = Infinity, label = "value" } = {}) {
  if (typeof value !== "string") return { ok: false, error: `${label} must be a string.` };
  if (value.length < min) return { ok: false, error: `${label} must be at least ${min} characters.` };
  if (value.length > max) return { ok: false, error: `${label} must be at most ${max} characters.` };
  return { ok: true, value: value.trim() };
}

function validateEmail(value) {
  const result = validateString(value, { max: EMAIL_MAX, label: "Email" });
  if (!result.ok) return result;
  const clean = normalizeEmail(result.value);
  if (!clean) return { ok: false, error: "Enter a valid email address." };
  return { ok: true, value: clean };
}

function validatePassword(value) {
  if (typeof value !== "string") return { ok: false, error: "Password must be a string." };
  const normalized = normalizePassword(value);
  if (normalized.length < PASSWORD_MIN) return { ok: false, error: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (normalized.length > PASSWORD_MAX) return { ok: false, error: `Password must be at most ${PASSWORD_MAX} characters.` };
  const issues = passwordIssues(value);
  if (issues.length) return { ok: false, error: issues[0], issues };
  return { ok: true, value };
}

function validateName(value) {
  const result = validateString(value, { min: 1, max: NAME_MAX, label: "Name" });
  if (!result.ok) return result;
  if (!/[\p{L}]/u.test(result.value)) return { ok: false, error: "Name must contain at least one letter." };
  return { ok: true, value: result.value };
}

function validateAddress(value) {
  const result = validateString(value, { max: ADDRESS_MAX, label: "Address" });
  if (!result.ok) return result;
  if (result.value.length < 3) return { ok: false, error: "Address must be at least 3 characters." };
  return { ok: true, value: result.value };
}

function isSchoolDomain(email) {
  const lower = String(email || "").toLowerCase();
  return SCHOOL_DOMAINS.some(domain => lower.endsWith(domain));
}

// Rate limiting
const rateTrackers = new Map();
function trackRateAttempt(ip) {
  const currentNow = now();
  const attempts = rateTrackers.get(ip) || [];
  const recent = attempts.filter(t => currentNow - t < RATE_LIMIT_WINDOW_MS);
  recent.push(currentNow);
  rateTrackers.set(ip, recent);
  return recent.length;
}
function isRateLimited(ip) {
  const currentNow = Date.now();
  const attempts = rateTrackers.get(ip) || [];
  const recent = attempts.filter(t => currentNow - t < RATE_LIMIT_WINDOW_MS);
  return recent.length >= RATE_LIMIT_MAX;
}

// ── DB schema ──────────────────────────────────────────────

const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  // Version 1: core tables
  `CREATE TABLE IF NOT EXISTS schools (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     address TEXT NOT NULL DEFAULT '',
     password_hash TEXT NOT NULL,
     verification_token_hash TEXT,
     verified_at INTEGER,
     last_login_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     stripe_customer_id TEXT DEFAULT '',
     total_students INTEGER NOT NULL DEFAULT 0,
     total_revenue REAL NOT NULL DEFAULT 0.0
   );`,
  `CREATE TABLE IF NOT EXISTS user_schools (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     role TEXT NOT NULL DEFAULT 'student',
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, school_id)
   );`,
  `CREATE INDEX IF NOT EXISTS user_schools_school_idx ON user_schools(school_id);`,
  `CREATE INDEX IF NOT EXISTS user_schools_user_idx ON user_schools(user_id);`,
  `CREATE TABLE IF NOT EXISTS billing_transactions (
     id TEXT PRIMARY KEY,
     school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     amount REAL NOT NULL,
     type TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS billing_txn_school_idx ON billing_transactions(school_id, created_at);`,
  `CREATE TABLE IF NOT EXISTS school_settings (
     school_id TEXT PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
     settings_json TEXT NOT NULL DEFAULT '{}',
     updated_at INTEGER NOT NULL
   );`,
  // Version 2: school sessions
  `CREATE TABLE IF NOT EXISTS school_sessions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     token_hash TEXT NOT NULL UNIQUE,
     school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     user_agent TEXT NOT NULL DEFAULT '',
     ip TEXT NOT NULL DEFAULT ''
   );`,
  `CREATE INDEX IF NOT EXISTS school_sessions_school_idx ON school_sessions(school_id);`,
];

function openSchoolStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 4000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrateSchool(db);
  return db;
}

function migrateSchool(db) {
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'school_schema_version'").get();
  const current = meta ? Number(meta.value) : 0;
  if (current === 0) {
    for (let i = 0; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]);
    db.prepare("INSERT INTO meta (key, value) VALUES ('school_schema_version', ?)").run(String(SCHEMA_VERSION));
    return;
  }
  if (current > SCHEMA_VERSION) throw new Error(`FastLectures school data was written by a newer version (${current}); update the app before opening it.`);
  for (let i = current + 1; i <= SCHEMA_VERSION; i++) {
    if (MIGRATIONS[i]) db.exec(MIGRATIONS[i]);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'school_schema_version'").run(String(i));
  }
}

// ── createSchoolAdmin ──────────────────────────────────────

function createSchoolAdmin(options = {}) {
  const {
    send = (res, code, data) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    },
    readJson = defaultReadJson,
    stateDirectory,
    file = stateDirectory ? path.join(stateDirectory, "school-admin.sqlite") : null,
    log = () => {},
    nowProvider = now,
  } = options;

  if (!file) throw new Error("FastLectures school-admin needs a state directory or explicit database file.");

  let store = null, initError = null;
  function ensureStore() {
    if (store || initError) return store;
    try {
      const db = openSchoolStore(file);
      const existing = db.prepare("SELECT value FROM secrets WHERE key = 'school_token_pepper'").get();
      let pepper = typeof existing?.value === "string" && existing.value.length >= 32 ? existing.value : null;
      if (!pepper) {
        pepper = crypto.randomBytes(32).toString("base64url");
        db.prepare("INSERT OR REPLACE INTO secrets (key, value) VALUES ('school_token_pepper', ?)").run(pepper);
      }
      store = {
        db,
        pepper,
        hash: (token) => crypto.createHmac("sha256", pepper).update(String(token)).digest("hex"),
      };
    } catch (error) {
      initError = error;
      log({ type: "school-admin-storage-error", error: String(error?.message || error) });
    }
    return store;
  }

  function hashTokenLocal(token) {
    if (!store) return null;
    return crypto.createHmac("sha256", store.pepper).update(String(token)).digest("hex");
  }

  // ── School Registration ──────────────────────────────────

  function registerSchool(s, { name, email, address, password }) {
    const nameV = validateName(name);
    if (!nameV.ok) throw schoolAdminError("invalid_request", nameV.error);
    const emailV = validateEmail(email);
    if (!emailV.ok) throw schoolAdminError("email_invalid", emailV.error);
    if (!isSchoolDomain(emailV.value)) throw schoolAdminError("email_invalid", "School email must use an @edu or @school domain.");
    const addressV = validateAddress(address);
    if (!addressV.ok) throw schoolAdminError("invalid_request", addressV.error);
    const passwordV = validatePassword(password);
    if (!passwordV.ok) throw schoolAdminError("password_weak", passwordV.error, { issues: passwordV.issues });

    if (s.db.prepare("SELECT id FROM schools WHERE email = ?").get(emailV.value)) {
      throw schoolAdminError("email_taken", "A school with this email is already registered.");
    }

    const id = randomId();
    const ts = nowProvider();
    const verifyToken = randomToken();
    const passwordHash = hashPassword(password);
    const verificationTokenHash = hashTokenLocal(`school_verify:${verifyToken}`);

    s.db.transaction(() => {
      s.db.prepare(
        `INSERT INTO schools (id, name, email, address, password_hash, verification_token_hash, verified_at, created_at, updated_at)
         VALUES (@id, @name, @email, @address, @hash, @vhash, NULL, @ts, @ts)`
      ).run({ id, name: nameV.value, email: emailV.value, address: addressV.value, hash: passwordHash, vhash: verificationTokenHash, ts });
      s.db.prepare(
        `INSERT INTO billing_transactions (id, school_id, user_id, amount, type, description, created_at)
         VALUES (@txnId, @schoolId, NULL, 0, 'registration', 'School account created', @ts)`
      ).run({ txnId: randomId(), schoolId: id, ts });
    })();

    return { id, email: emailV.value, name: nameV.value, verifyToken };
  }

  function verifySchool(s, token) {
    const hash = hashTokenLocal(`school_verify:${String(token || "")}`);
    const row = s.db.prepare(
      `SELECT school_id FROM schools WHERE verification_token_hash = ?`
    ).get(hash);
    if (!row) throw schoolAdminError("invalid_token", "Verification token is invalid or has expired.");
    const ts = nowProvider();
    s.db.prepare("UPDATE schools SET verified_at = @ts, updated_at = @ts WHERE id = @id").run({ ts, id: row.school_id });
    return s.db.prepare("SELECT * FROM schools WHERE id = ?").get(row.school_id);
  }

  function schoolLogin(s, { email, password, req }) {
    const ip = clientIp(req);
    if (isRateLimited(ip)) throw schoolAdminError("rate_limited", "Too many login attempts from this network. Wait a few minutes.");
    trackRateAttempt(ip);

    const clean = normalizeEmail(email);
    const school = clean ? s.db.prepare("SELECT * FROM schools WHERE email = ?").get(clean) : null;
    if (!school) {
      // Time-burn to prevent account existence oracle
      try { verifyPassword(String(password || "x"), "scrypt$16384$8$1$" + crypto.randomBytes(16).toString("base64") + "$" + crypto.randomBytes(64).toString("base64")); } catch {}
      throw schoolAdminError("invalid_credentials", "Invalid email or password.");
    }
    if (!verifyPassword(password, school.password_hash)) {
      throw schoolAdminError("invalid_credentials", "Invalid email or password.");
    }

    const ts = nowProvider();
    const token = randomToken();
    const tokenHash = hashTokenLocal(`session:${token}`);
    s.db.transaction(() => {
      s.db.prepare(
        `INSERT INTO school_sessions (token_hash, school_id, created_at, expires_at, user_agent, ip)
         VALUES (@hash, @schoolId, @ts, @expires, @agent, @ip)`
      ).run({ hash: tokenHash, schoolId: school.id, ts, expires: ts + SESSION_TTL_MS, ip: clientIp(req), agent: userAgent(req) });
      s.db.prepare("UPDATE schools SET last_login_at = @ts, updated_at = @ts WHERE id = @id").run({ ts, id: school.id });
    })();

    return {
      school: { id: school.id, name: school.name, email: school.email, verified: school.verified_at != null },
      token,
      expiresAt: ts + SESSION_TTL_MS,
    };
  }

  function schoolLogout(s, req) {
    const token = parseCookies(req)[SCHOOL_SESSION_COOKIE];
    if (token && s) {
      try { s.db.prepare("DELETE FROM school_sessions WHERE token_hash = ?").run(hashTokenLocal(`session:${token}`)); } catch {}
    }
    return true;
  }

  function userFromSchoolSession(s, req) {
    const token = parseCookies(req)[SCHOOL_SESSION_COOKIE];
    if (!token || !s) return null;
    const hash = hashTokenLocal(`session:${token}`);
    const row = s.db.prepare(
      `SELECT ss.expires_at, sc.id AS school_id, sc.name AS school_name, sc.email AS school_email, sc.verified_at AS school_verified_at
       FROM school_sessions ss JOIN schools sc ON sc.id = ss.school_id
       WHERE ss.token_hash = ?`
    ).get(hash);
    if (!row || row.expires_at < nowProvider()) {
      if (row) s.db.prepare("DELETE FROM school_sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    return {
      sessionSchoolId: row.school_id,
      sessionSchoolName: row.school_name,
      sessionSchoolEmail: row.school_email,
      schoolVerifiedAt: row.school_verified_at,
    };
  }

  // ── Teacher Panel ──────────────────────────────────────────

  function addStudent(s, schoolId, actorUserId, { name, email, role = "student", costAccount = "school" }) {
    const actor = s.db.prepare("SELECT role FROM user_schools WHERE user_id = ? AND school_id = ?").get(actorUserId, schoolId);
    if (!actor || (actor.role !== "school_admin" && actor.role !== "teacher")) {
      throw schoolAdminError("forbidden", "Only school admins and teachers can add students.");
    }

    const nameV = validateName(name);
    if (!nameV.ok) throw schoolAdminError("invalid_request", nameV.error);
    const emailV = validateEmail(email);
    if (!emailV.ok) throw schoolAdminError("email_invalid", emailV.error);

    const roleStr = String(role || "student").toLowerCase();
    if (!["student", "teacher"].includes(roleStr)) throw schoolAdminError("invalid_request", "Role must be student or teacher.");
    const costStr = String(costAccount || "school").toLowerCase();
    if (!["school", "individual"].includes(costStr)) throw schoolAdminError("invalid_request", "costAccount must be school or individual.");

    // Check student doesn't already exist at this school
    const existing = s.db.prepare(
      `SELECT us.user_id FROM user_schools us JOIN users u ON u.id = us.user_id
       WHERE us.school_id = @schoolId AND u.email = @email`
    ).get({ schoolId, email: emailV.value });
    if (existing) throw schoolAdminError("conflict", "A student with this email is already registered at this school.");

    const price = costStr === "school" ? SCHOOL_PRICE_STUDENT : INDIVIDUAL_PRICE_STUDENT;
    const ts = nowProvider();
    const userId = randomId();
    const passwordHash = hashPassword(randomToken());

    s.db.transaction(() => {
      s.db.prepare(
        `INSERT INTO users (id, email, name, password_hash, verified_at, created_at, updated_at, failed_logins, locked_until)
         VALUES (@id, @email, @name, @hash, NULL, @ts, @ts, 0, 0)`
      ).run({ id: userId, email: emailV.value, name: nameV.value, hash: passwordHash, ts });
      s.db.prepare(
        `INSERT INTO user_schools (user_id, school_id, role, created_at)
         VALUES (@userId, @schoolId, @role, @ts)`
      ).run({ userId, schoolId, role: roleStr, ts });
      s.db.prepare(
        `INSERT INTO billing_transactions (id, school_id, user_id, amount, type, description, created_at)
         VALUES (@txnId, @schoolId, @userId, @amount, @type, @desc, @ts)`
      ).run({
        txnId: randomId(), schoolId, userId, amount: price,
        type: costStr === "school" ? "school_enrollment" : "individual_enrollment",
        desc: `Student ${nameV.value} enrolled via ${costStr} account`,
        ts,
      });
      s.db.prepare(
        `UPDATE schools SET total_students = (SELECT COUNT(*) FROM user_schools WHERE school_id = @schoolId AND role = 'student'),
                total_revenue = (SELECT COALESCE(SUM(amount), 0) FROM billing_transactions WHERE school_id = @schoolId),
                updated_at = @ts
         WHERE id = @schoolId`
      ).run({ schoolId, ts });
    })();

    return { id: userId, name: nameV.value, email: emailV.value, role: roleStr, costAccount: costStr, price, timestamp: ts };
  }

  function listStudents(s, schoolId, actorUserId) {
    const actor = s.db.prepare("SELECT role FROM user_schools WHERE user_id = ? AND school_id = ?").get(actorUserId, schoolId);
    if (!actor || (actor.role !== "school_admin" && actor.role !== "teacher")) {
      throw schoolAdminError("forbidden", "Only school admins and teachers can view students.");
    }
    const students = s.db.prepare(
      `SELECT u.id, u.email, u.name, us.role, us.created_at
       FROM users u JOIN user_schools us ON us.user_id = u.id
       WHERE us.school_id = @schoolId AND us.role IN ('student', 'teacher')
       ORDER BY u.name COLLATE NOCASE ASC`
    ).all({ schoolId });
    return { schoolId, students, count: students.length };
  }

  function getBilling(s, schoolId, actorUserId) {
    const actor = s.db.prepare("SELECT role FROM user_schools WHERE user_id = ? AND school_id = ?").get(actorUserId, schoolId);
    if (!actor || actor.role !== "school_admin") {
      throw schoolAdminError("forbidden", "Only the school admin can view billing.");
    }
    const totals = s.db.prepare(
      `SELECT
         COUNT(DISTINCT us.user_id) AS total_accounts,
         COALESCE(SUM(CASE WHEN bt.type IN ('school_enrollment', 'individual_enrollment') THEN bt.amount ELSE 0 END), 0) AS gross_cost,
         (COUNT(DISTINCT CASE WHEN us.role = 'student' THEN us.user_id END) * @rebate) AS rebate,
         (COALESCE(SUM(CASE WHEN bt.type IN ('school_enrollment', 'individual_enrollment') THEN bt.amount ELSE 0 END), 0) - (COUNT(DISTINCT CASE WHEN us.role = 'student' THEN us.user_id END) * @rebate)) AS net_cost
       FROM user_schools us LEFT JOIN billing_transactions bt ON bt.school_id = us.school_id
       WHERE us.school_id = @schoolId AND us.role = 'student'`
    ).get({ schoolId, rebate: SCHOOL_REBATE });

    const recentTxns = s.db.prepare(
      `SELECT id, amount, type, description, created_at
       FROM billing_transactions WHERE school_id = @schoolId ORDER BY created_at DESC LIMIT 50`
    ).all(schoolId);
    const school = s.db.prepare("SELECT id, name, email, total_students, total_revenue, stripe_customer_id FROM schools WHERE id = ?").get(schoolId);

    return {
      schoolId,
      schoolName: school?.name || "",
      schoolEmail: school?.email || "",
      pricing: { schoolStudentPrice: SCHOOL_PRICE_STUDENT, individualStudentPrice: INDIVIDUAL_PRICE_STUDENT, schoolRebatePerAccount: SCHOOL_REBATE },
      totalAccounts: totals.total_accounts || 0,
      grossCost: totals.gross_cost || 0,
      rebate: totals.rebate || 0,
      netCost: totals.net_cost || 0,
      totalRevenue: school?.total_revenue || 0,
      stripeCustomerId: school?.stripe_customer_id || "",
      transactions: recentTxns,
    };
  }

  function removeStudent(s, studentId, schoolId, actorUserId) {
    if (!UUID_PATTERN.test(studentId)) throw schoolAdminError("invalid_request", "Invalid student ID format.");
    const actor = s.db.prepare("SELECT role FROM user_schools WHERE user_id = ? AND school_id = ?").get(actorUserId, schoolId);
    if (!actor || actor.role !== "school_admin") throw schoolAdminError("forbidden", "Only the school admin can remove students.");
    const target = s.db.prepare(
      `SELECT us.role FROM user_schools us WHERE us.user_id = @studentId AND us.school_id = @schoolId`
    ).get({ studentId, schoolId });
    if (!target) throw schoolAdminError("not_found", "Student not found at this school.");
    if (target.role === "school_admin") throw schoolAdminError("forbidden", "Cannot remove another school admin.");

    const ts = nowProvider();
    s.db.transaction(() => {
      s.db.prepare("DELETE FROM user_schools WHERE user_id = @studentId AND school_id = @schoolId AND role = 'student'").run({ studentId, schoolId });
      s.db.prepare(`INSERT INTO billing_transactions (id, school_id, user_id, amount, type, description, created_at) VALUES (@txnId, @schoolId, @studentId, 0, 'removal', 'Student removed from school', @ts)`).run({ txnId: randomId(), schoolId, studentId, ts });
      s.db.prepare(`UPDATE schools SET total_students = (SELECT COUNT(*) FROM user_schools WHERE school_id = @schoolId AND role = 'student'), total_revenue = (SELECT COALESCE(SUM(amount), 0) FROM billing_transactions WHERE school_id = @schoolId), updated_at = @ts WHERE id = @schoolId`).run({ schoolId, ts });
    })();
    return { removed: true, studentId };
  }

  // ── Admin Dashboard ────────────────────────────────────────

  function listSchools(s, userId, role) {
    if (role !== "admin" && role !== "super_admin") throw schoolAdminError("forbidden", "Admin access required.");
    const schools = s.db.prepare(
      `SELECT sc.id, sc.name, sc.email, sc.address, sc.verified_at, sc.created_at, sc.updated_at,
              sc.total_students, sc.total_revenue, sc.stripe_customer_id,
              COUNT(DISTINCT us.user_id) AS active_users,
              (SELECT COUNT(*) FROM billing_transactions bt WHERE bt.school_id = sc.id AND bt.type IN ('school_enrollment','individual_enrollment')) AS txn_count
       FROM schools sc LEFT JOIN user_schools us ON us.school_id = sc.id AND us.role IN ('student','teacher')
       GROUP BY sc.id ORDER BY sc.created_at DESC`
    ).all();
    return {
      schools,
      count: schools.length,
      totalRevenue: schools.reduce((sum, r) => sum + (Number(r.total_revenue) || 0), 0),
    };
  }

  function getSchoolDetails(s, schoolId, userId, role) {
    if (role !== "admin" && role !== "super_admin") throw schoolAdminError("forbidden", "Admin access required.");
    const school = s.db.prepare(
      `SELECT id, name, email, address, verified_at, created_at, updated_at, stripe_customer_id, total_students, total_revenue
       FROM schools WHERE id = ?`
    ).get(schoolId);
    if (!school) throw schoolAdminError("not_found", "School not found.");
    const admins = s.db.prepare(
      `SELECT u.id, u.email, u.name, us.created_at FROM user_schools us JOIN users u ON u.id = us.user_id WHERE us.school_id = @schoolId AND us.role = 'school_admin'`
    ).all({ schoolId });
    const teachers = s.db.prepare(
      `SELECT u.id, u.email, u.name, us.created_at FROM user_schools us JOIN users u ON u.id = us.user_id WHERE us.school_id = @schoolId AND us.role = 'teacher'`
    ).all({ schoolId });
    const students = s.db.prepare(
      `SELECT u.id, u.email, u.name, us.created_at FROM user_schools us JOIN users u ON u.id = us.user_id WHERE us.school_id = @schoolId AND us.role = 'student'`
    ).all({ schoolId });
    const recentBilling = s.db.prepare(
      `SELECT id, amount, type, description, created_at FROM billing_transactions WHERE school_id = @schoolId ORDER BY created_at DESC LIMIT 25`
    ).all(schoolId);
    const settings = s.db.prepare(`SELECT settings_json, updated_at FROM school_settings WHERE school_id = ?`).get(schoolId);
    return {
      id: school.id, name: school.name, email: school.email, address: school.address,
      verifiedAt: school.verified_at, createdAt: school.created_at, updatedAt: school.updated_at,
      stripeCustomerId: school.stripe_customer_id, totalStudents: school.total_students,
      totalRevenue: school.total_revenue, admins, teachers, students, recentBilling,
      settings: settings ? JSON.parse(settings.settings_json) : {},
    };
  }

  function createSchoolAsAdmin(s, { name, email, address }, actorId, actorRole) {
    if (actorRole !== "admin" && actorRole !== "super_admin") throw schoolAdminError("forbidden", "Only global admins can create schools.");
    const nameV = validateName(name);
    if (!nameV.ok) throw schoolAdminError("invalid_request", nameV.error);
    const emailV = validateEmail(email);
    if (!emailV.ok) throw schoolAdminError("email_invalid", emailV.error);
    const addressV = validateAddress(address);
    if (!addressV.ok) throw schoolAdminError("invalid_request", addressV.error);
    if (s.db.prepare("SELECT id FROM schools WHERE email = ?").get(emailV.value)) {
      throw schoolAdminError("email_taken", "A school with this email already exists.");
    }

    const id = randomId();
    const ts = nowProvider();
    const passwordHash = hashPassword(randomToken());
    s.db.transaction(() => {
      s.db.prepare(`INSERT INTO schools (id, name, email, address, password_hash, created_at, updated_at) VALUES (@id, @name, @email, @address, @hash, @ts, @ts)`).run({ id, name: nameV.value, email: emailV.value, address: addressV.value, hash: passwordHash, ts });
      s.db.prepare(`INSERT INTO billing_transactions (id, school_id, user_id, amount, type, description, created_at) VALUES (@txnId, @schoolId, @actorId, 0, 'admin_creation', 'School created by global admin', @ts)`).run({ txnId: randomId(), schoolId: id, actorId, ts });
      s.db.prepare(`INSERT INTO user_schools (user_id, school_id, role, created_at) VALUES (@userId, @schoolId, 'school_admin', @ts)`).run({ userId: actorId, schoolId: id, ts });
    })();
    return { id, name: nameV.value, email: emailV.value, address: addressV.value };
  }

  function deleteSchool(s, schoolId, actorId, role) {
    if (role !== "admin" && role !== "super_admin") throw schoolAdminError("forbidden", "Only global admins can remove schools.");
    if (!s.db.prepare("SELECT id FROM schools WHERE id = ?").get(schoolId)) throw schoolAdminError("not_found", "School not found.");
    s.db.transaction(() => {
      s.db.prepare("DELETE FROM school_settings WHERE school_id = ?").run(schoolId);
      s.db.prepare("DELETE FROM billing_transactions WHERE school_id = ?").run(schoolId);
      s.db.prepare("DELETE FROM user_schools WHERE school_id = ?").run(schoolId);
      s.db.prepare("DELETE FROM school_sessions WHERE school_id = ?").run(schoolId);
      s.db.prepare("DELETE FROM schools WHERE id = ?").run(schoolId);
    });
    return { deleted: true, schoolId };
  }

  async function listAllUsers(s, userId, role) {
    if (role !== "admin" && role !== "super_admin") throw schoolAdminError("forbidden", "Admin access required.");
    const users = s.db.prepare(
      `SELECT u.id, u.email, u.name, u.verified_at, u.last_login_at, u.created_at
       FROM users u WHERE u.deleted_at IS NULL ORDER BY u.created_at DESC LIMIT 500`
    ).all();
    const result = [];
    for (const u of users) {
      const roles = s.db.prepare(
        `SELECT us.role, sc.name AS school_name FROM user_schools us JOIN schools sc ON sc.id = us.school_id WHERE us.user_id = ?`
      ).all(u.id);
      result.push({ ...u, schoolRoles: roles });
    }
    return { users: result, count: result.length };
  }

  async function getRevenueSummary(s, userId, role) {
    if (role !== "admin" && role !== "super_admin") throw schoolAdminError("forbidden", "Admin access required.");
    const totals = s.db.prepare(`
      SELECT
        COUNT(DISTINCT sc.id) AS school_count,
        COUNT(DISTINCT us.user_id) AS total_student_accounts,
        COALESCE(SUM(bt.amount), 0) AS gross_revenue,
        (COUNT(DISTINCT CASE WHEN us.role = 'student' THEN us.user_id END) * @rebate) AS total_rebate,
        (COALESCE(SUM(bt.amount), 0) - (COUNT(DISTINCT CASE WHEN us.role = 'student' THEN us.user_id END) * @rebate)) AS net_revenue
      FROM schools sc
      LEFT JOIN user_schools us ON us.school_id = sc.id AND us.role = 'student'
      LEFT JOIN billing_transactions bt ON bt.school_id = sc.id AND bt.type IN ('school_enrollment','individual_enrollment')
    `).get({ rebate: SCHOOL_REBATE });

    const byType = s.db.prepare(
      `SELECT type, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total_amount
       FROM billing_transactions WHERE type IN ('school_enrollment','individual_enrollment') GROUP BY type`
    ).all();
    const bySchool = s.db.prepare(
      `SELECT sc.id, sc.name, COALESCE(SUM(bt.amount), 0) AS revenue, COUNT(DISTINCT us.user_id) AS students
       FROM schools sc
       LEFT JOIN user_schools us ON us.school_id = sc.id AND us.role = 'student'
       LEFT JOIN billing_transactions bt ON bt.school_id = sc.id AND bt.type IN ('school_enrollment','individual_enrollment')
       GROUP BY sc.id, sc.name ORDER BY revenue DESC`
    ).all();
    const recent = s.db.prepare(
      `SELECT bt.id, bt.amount, bt.type, bt.description, bt.created_at, sc.name AS school_name, u.email AS user_email
       FROM billing_transactions bt
       LEFT JOIN schools sc ON sc.id = bt.school_id
       LEFT JOIN users u ON u.id = bt.user_id
       WHERE bt.type IN ('school_enrollment','individual_enrollment')
       ORDER BY bt.created_at DESC LIMIT 100`
    ).all();

    return {
      ...totals,
      pricing: { schoolStudentPrice: SCHOOL_PRICE_STUDENT, individualStudentPrice: INDIVIDUAL_PRICE_STUDENT, schoolRebatePerAccount: SCHOOL_REBATE },
      byType, bySchool, recentTransactions: recent,
    };
  }

  // ── HTTP handle ──────────────────────────────────────────

  async function handle(req, res, url) {
    const pathname = url.pathname;
    const method = req.method === "HEAD" ? "GET" : req.method;

    if (pathname.startsWith("/api/schools/")) return handleSchoolRoutes(req, res, pathname, method, url);
    if (pathname.startsWith("/api/admin/")) return handleAdminRoutes(req, res, pathname, method, url);
    return false;
  }

  async function handleSchoolRoutes(req, res, pathname, method, url) {
    const route = pathname.slice("/api/schools/".length).split("/")[0] || "";
    const rest = pathname.slice("/api/schools/".length + route.length + 1) || "";
    const s = ensureStore();
    if (!s) { send(res, 503, { error: "School administration storage is unavailable." }); return true; }

    const publicRoutes = new Set(["register", "verify", "verify/resend", "login", "logout", "me"]);

    if (!publicRoutes.has(route)) {
      const session = userFromSchoolSession(s, req);
      if (!session) { send(res, 401, { error: "Not signed in." }); return true; }
      return handleProtectedSchoolRoute(s, req, res, route, rest, method, session);
    }

    try {
      if (route === "register" && method === "POST") {
        const body = await parseBody(req, res);
        return send(res, 201, registerSchool(s, body));
      }
      if (route === "verify" && method === "POST") {
        const body = await parseBody(req, res);
        const school = verifySchool(s, body?.token);
        return send(res, 200, { verified: true, school });
      }
      if (route === "verify" && method === "GET") return send(res, 200, { ok: true });
      if (route === "verify/resend" && method === "POST") {
        const body = await parseBody(req, res);
        const emailV = validateEmail(body?.email);
        if (!emailV.ok) return send(res, 400, { error: emailV.error });
        if (!isSchoolDomain(emailV.value)) return send(res, 400, { error: "School email must use an @edu or @school domain." });
        const school = s.db.prepare("SELECT id, verified_at FROM schools WHERE email = ?").get(emailV.value);
        if (!school) return send(res, 200, { ok: true });
        if (school.verified_at != null) return send(res, 200, { ok: true, alreadyVerified: true });
        const recent = s.db.prepare("SELECT created_at FROM billing_transactions WHERE school_id = ? AND type = 'verify_resend' ORDER BY created_at DESC LIMIT 1").get(school.id);
        if (recent && nowProvider() - recent.created_at < EMAIL_COOLDOWN_MS) return send(res, 200, { ok: true, throttled: true });
        return send(res, 200, { ok: true, verifyToken: randomToken() });
      }
      if (route === "login" && method === "POST") {
        const body = await parseBody(req, res);
        const result = schoolLogin(s, { email: body?.email, password: body?.password, req });
        res.setHeader("Set-Cookie", schoolSessionCookie(result.token, req));
        return send(res, 200, { school: result.school, expiresAt: result.expiresAt });
      }
      if (route === "logout" && method === "POST") {
        schoolLogout(s, req);
        res.setHeader("Set-Cookie", schoolSessionCookie("", req, { maxAge: 0 }));
        return send(res, 200, { ok: true });
      }
      if (route === "me" && method === "GET") {
        const session = userFromSchoolSession(s, req);
        return session
          ? send(res, 200, {
              authenticated: true,
              school: { id: session.sessionSchoolId, name: session.sessionSchoolName, email: session.sessionSchoolEmail, verified: session.schoolVerifiedAt != null },
            })
          : send(res, 200, { authenticated: false });
      }
      send(res, 404, { error: "Unknown school endpoint." });
      return true;
    } catch (error) { return sendSchoolError(res, error); }
  }

  async function handleProtectedSchoolRoute(s, req, res, route, rest, method, session) {
    try {
      if (route === "teacher" && rest === "add-student" && method === "POST") {
        const body = await parseBody(req, res);
        return send(res, 201, addStudent(s, session.sessionSchoolId, session.sessionSchoolId, body));
      }
      if (route === "teacher" && rest === "students" && method === "GET") {
        return send(res, 200, listStudents(s, session.sessionSchoolId, session.sessionSchoolId));
      }
      if (route === "teacher" && rest === "billing" && method === "GET") {
        return send(res, 200, getBilling(s, session.sessionSchoolId, session.sessionSchoolId));
      }
      if (route === "teacher" && method === "DELETE" && /^\d+$/.test(rest)) {
        return send(res, 200, removeStudent(s, rest, session.sessionSchoolId, session.sessionSchoolId));
      }
      send(res, 404, { error: "Unknown school endpoint." });
      return true;
    } catch (error) { return sendSchoolError(res, error); }
  }

  async function handleAdminRoutes(req, res, pathname, method, url) {
    const s = ensureStore();
    if (!s) { send(res, 503, { error: "School administration storage is unavailable." }); return true; }

    const user = resolveAdminUser(s, req);
    if (!user) { send(res, 401, { error: "Not signed in." }); return true; }

    try {
      if (pathname === "/api/admin/schools" && method === "GET") return send(res, 200, listSchools(s, user.id, user.role));
      if (/^\/api\/admin\/schools\/[^/]+$/.test(pathname) && method === "GET") {
        return send(res, 200, getSchoolDetails(s, pathname.slice("/api/admin/schools/".length), user.id, user.role));
      }
      if (pathname === "/api/admin/schools" && method === "POST") {
        const body = await parseBody(req, res);
        return send(res, 201, createSchoolAsAdmin(s, body, user.id, user.role));
      }
      if (/^\/api\/admin\/schools\/[^/]+$/.test(pathname) && method === "DELETE") {
        return send(res, 200, deleteSchool(s, pathname.slice("/api/admin/schools/".length), user.id, user.role));
      }
      if (pathname === "/api/admin/users" && method === "GET") return send(res, 200, await listAllUsers(s, user.id, user.role));
      if (pathname === "/api/admin/billing" && method === "GET") return send(res, 200, await getRevenueSummary(s, user.id, user.role));
      send(res, 404, { error: "Unknown admin endpoint." });
      return true;
    } catch (error) { return sendSchoolError(res, error); }
  }

  async function parseBody(req, res) {
    const type = String(req.headers["content-type"] || "");
    if (!type.includes("application/json")) { send(res, 415, { error: "Use application/json for this request." }); throw new Error("Content-Type rejected"); }
    const body = await readJson(req, AUTH_BODY_LIMIT);
    if (!body || typeof body !== "object" || Array.isArray(body)) { send(res, 400, { error: "Send a JSON object." }); throw new Error("Body rejected"); }
    return body;
  }

  function sendSchoolError(res, error) {
    const code = error?.code;
    const status =
      code === "email_taken" || code === "conflict" ? 409 :
      code === "invalid_request" || code === "email_invalid" || code === "password_weak" ? 400 :
      code === "invalid_credentials" || code === "not_found" ? 401 :
      code === "forbidden" ? 403 :
      code === "rate_limited" ? 429 :
      code === "invalid_token" ? 400 :
      code === "payload_too_large" ? 413 : 500;
    if (status === 500) log({ type: "school-admin-error", errorCode: String(code || "school_admin_error"), error: String(error?.message || error) });
    send(res, status, { error: status === 500 ? "School administration failed. Try again." : error.message, ...(error.issues ? { issues: error.issues } : {}) });
  }

  function resolveAdminUser(s, req) {
    const headerId = req.headers["x-user-id"];
    const headerRole = req.headers["x-user-role"];
    if (headerId) {
      const role = String(headerRole || "").toLowerCase();
      if (["admin", "super_admin"].includes(role)) {
        const user = s.db.prepare("SELECT id, email, name FROM users WHERE id = ? AND deleted_at IS NULL").get(String(headerId));
        if (user) return { id: user.id, email: user.email, name: user.name, role };
      }
    }
    return null;
  }

  function schoolSessionCookie(value, req, { maxAge } = {}) {
    const secure = String(requestOrigin(req) || "").startsWith("https:") ? "; Secure" : "";
    return `${SCHOOL_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge || SESSION_TTL_MS / 1000))}${secure}`;
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

  function sweep() {
    const s = store;
    if (!s) return;
    try {
      const ts = nowProvider();
      s.db.prepare("DELETE FROM school_sessions WHERE expires_at < ?").run(ts);
      s.db.prepare("DELETE FROM billing_transactions WHERE created_at < ?").run(ts - 365 * 24 * 60 * 60 * 1000);
      s.db.prepare("DELETE FROM user_schools WHERE user_id NOT IN (SELECT id FROM users WHERE deleted_at IS NULL)").run();
    } catch (error) { log({ type: "school-admin-sweep-error", error: String(error?.message || error) }); }
  }

  return { handle, ensureStore, sweep, file };
}

// ── utilities ──────────────────────────────────────────

function requestOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
  if (!host) return null;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : req.socket && req.socket.encrypted ? "https" : "http";
  return `${proto}://${host}`;
}

function defaultReadJson(req, limit = AUTH_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) { reject(schoolAdminError("payload_too_large", "Request body is too large.")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(schoolAdminError("invalid_json", "Send a JSON object.")); }
    });
    req.on("error", reject);
  });
}

// ── exports ──────────────────────────────────────────

module.exports = {
  createSchoolAdmin,
  SCHOOL_PRICE_STUDENT,
  INDIVIDUAL_PRICE_STUDENT,
  SCHOOL_REBATE,
  SESSION_TTL_MS,
  AUTH_BODY_LIMIT,
};