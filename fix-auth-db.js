#!/usr/bin/env node
// Fix the FastLectures SQLite database by creating missing auth tables
// Run: node fix-auth-db.js
"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const dbFile = path.join(os.homedir(), ".fastlectures", "study.sqlite");
console.log("Database:", dbFile);

const db = new DatabaseSync(dbFile);

// Drop the broken sessions table (has 2 PRIMARY KEYs) and recreate it
db.exec("DROP TABLE IF EXISTS sessions");
db.exec(`CREATE TABLE sessions (
  id INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
)`);
db.exec("CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)");

// Create remaining auth tables
db.exec(`CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
)`);
db.exec("CREATE INDEX IF NOT EXISTS tokens_user_purpose_idx ON tokens(user_id, purpose)");
db.exec(`CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  link TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS login_rate (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL
)`);

// Create token_pepper if it doesn't exist
const existing = db.prepare("SELECT value FROM secrets WHERE key = 'token_pepper'").get();
if (!existing) {
  const pepper = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO secrets (key, value) VALUES ('token_pepper', ?)").run(pepper);
  console.log("Created token_pepper");
} else {
  console.log("token_pepper already exists");
}

// Verify all tables exist
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("Tables:", tables.map(t => t.name).join(", "));
db.close();
console.log("Done! Restart FastLectures to enable auth.");
