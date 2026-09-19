"use strict";
// Password and token primitives for FastLectures accounts. Everything here is
// deliberately dependency-free so the whole authentication stack stays installable
// offline on the Node runtime the app already requires (>=22.19).
const crypto = require("node:crypto");

// scrypt parameters follow the OWASP 2024 minimum (N=2^15 is ideal; 2^14 keeps a
// sub-120ms hash on low-powered student laptops while staying well above the floor).
const SCRYPT = Object.freeze({ N: 1 << 14, r: 8, p: 1, keylen: 64, saltBytes: 16 });
const TOKEN_BYTES = 32;

function randomToken() { return crypto.randomBytes(TOKEN_BYTES).toString("base64url"); }
function randomId() { return crypto.randomUUID(); }

// Tokens are never stored in the clear: only an HMAC-SHA256 digest lives in the
// database, so a stolen dump cannot be replayed as a session or reset link.
function hashToken(token, pepper) {
  return crypto.createHmac("sha256", pepper).update(String(token)).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const derived = crypto.scryptSync(normalizePassword(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), derived.toString("base64")].join("$");
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  let expected;
  try {
    expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(normalizePassword(password), Buffer.from(saltB64, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// NFKC + trim so visually identical passwords compare equal across keyboards.
function normalizePassword(password) { return String(password == null ? "" : password).normalize("NFKC"); }

// Returns a list of human-readable weaknesses (empty means acceptable).
function passwordIssues(password) {
  const value = normalizePassword(password), issues = [];
  if (value.length < 10) issues.push("Use at least 10 characters.");
  if (value.length > 512) issues.push("Passwords cannot exceed 512 characters.");
  if (!/[\p{L}\p{N}]/u.test(value)) issues.push("Include at least one letter or number.");
  if (/[ ]/.test(value) && value.trim().length < 2) issues.push("Avoid a password of only spaces.");
  if (/^(?:password|qwerty|letmein|welcome|admin|123456)/i.test(value)) issues.push("That is a commonly guessed password; choose something less predictable.");
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value), /[^a-zA-Z0-9]/.test(value)].filter(Boolean).length;
  if (classes < 2 && value.length < 16) issues.push("Mix letters with numbers or symbols, or use a longer phrase.");
  return issues;
}

function normalizeEmail(email) {
  const value = String(email == null ? "" : email).trim().toLowerCase();
  if (value.length > 320 || !/^[^\s@,;]+@[^\s@.,;][^\s@,;]*\.[^\s@,;.]{2,}$/.test(value)) return null;
  return value;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

module.exports = { randomToken, randomId, hashToken, hashPassword, verifyPassword, normalizePassword, normalizeEmail, passwordIssues, timingSafeEqualHex, SCRYPT };
