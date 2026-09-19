"use strict";
// SQLite-backed persistence for accounts and study data. node:sqlite ships with the
// Node runtime this project already requires (>=22.19) and Canvas Agent file reads
// already depend on it, so authentication adds no third-party dependency and no
// external database service to pay for or operate.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 2;

// A single connection is shared by the whole server. WAL keeps readers (the study
// dashboard polling its own progress) from blocking the writer (a review session),
// and busy_timeout absorbs the rare multi-tab write collision.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     verified_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_login_at INTEGER,
     failed_logins INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0,
     deleted_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS sessions (
     id INTEGER NOT NULL DEFAULT 0,
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     user_agent TEXT NOT NULL DEFAULT '',
     ip TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
   CREATE TABLE IF NOT EXISTS tokens (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     purpose TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     consumed_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS tokens_user_purpose_idx ON tokens(user_id, purpose);
   CREATE TABLE IF NOT EXISTS email_outbox (
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
   );
   CREATE TABLE IF NOT EXISTS secrets (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS login_rate (
     bucket_key TEXT PRIMARY KEY,
     window_started_at INTEGER NOT NULL,
     count INTEGER NOT NULL
   );`,

  `CREATE TABLE IF NOT EXISTS decks (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     color TEXT NOT NULL DEFAULT 'slate',
     canvas_id TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS decks_user_idx ON decks(user_id, updated_at);
   CREATE TABLE IF NOT EXISTS cards (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
     front TEXT NOT NULL,
     back TEXT NOT NULL,
     hint TEXT NOT NULL DEFAULT '',
     image TEXT NOT NULL DEFAULT '',
     ease INTEGER NOT NULL DEFAULT 2500,
     interval_days INTEGER NOT NULL DEFAULT 0,
     repetitions INTEGER NOT NULL DEFAULT 0,
     lapses INTEGER NOT NULL DEFAULT 0,
     due_at INTEGER NOT NULL,
     last_review_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     source TEXT NOT NULL DEFAULT 'manual',
     tags TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX IF NOT EXISTS cards_due_idx ON cards(user_id, due_at);
   CREATE INDEX IF NOT EXISTS cards_deck_idx ON cards(deck_id);
   CREATE TABLE IF NOT EXISTS reviews (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     deck_id TEXT NOT NULL,
     grade INTEGER NOT NULL,
     previous_interval_days INTEGER NOT NULL,
     next_interval_days INTEGER NOT NULL,
     elapsed_ms INTEGER NOT NULL DEFAULT 0,
     reviewed_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS reviews_user_day_idx ON reviews(user_id, reviewed_at);
   CREATE TABLE IF NOT EXISTS notes (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     subject TEXT NOT NULL DEFAULT '',
     canvas_id TEXT NOT NULL DEFAULT '',
     pinned INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS notes_user_idx ON notes(user_id, updated_at);
   CREATE TABLE IF NOT EXISTS note_versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     saved_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS note_versions_idx ON note_versions(note_id, saved_at);
   CREATE TABLE IF NOT EXISTS quizzes (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     canvas_id TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     questions_json TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS quizzes_user_idx ON quizzes(user_id, created_at);
   CREATE TABLE IF NOT EXISTS attempts (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     quiz_id TEXT,
     title TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'quiz',
     score REAL NOT NULL DEFAULT 0,
     total INTEGER NOT NULL DEFAULT 0,
     correct INTEGER NOT NULL DEFAULT 0,
     duration_ms INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     detail_json TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX IF NOT EXISTS attempts_user_idx ON attempts(user_id, created_at);
   CREATE TABLE IF NOT EXISTS sessions_time (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER NOT NULL,
     seconds INTEGER NOT NULL,
     deck_id TEXT NOT NULL DEFAULT '',
     completed INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX IF NOT EXISTS sessions_time_user_idx ON sessions_time(user_id, started_at);
   CREATE TABLE IF NOT EXISTS goals (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     daily_seconds INTEGER NOT NULL DEFAULT 1800,
     daily_cards INTEGER NOT NULL DEFAULT 20,
     weekly_days INTEGER NOT NULL DEFAULT 5,
     exam_date INTEGER,
     exam_subject TEXT NOT NULL DEFAULT '',
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS concepts (
     user_id TEXT NOT NULL,
     id TEXT NOT NULL,
     title TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     mastery INTEGER NOT NULL DEFAULT 0,
     edges TEXT NOT NULL DEFAULT '[]',
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, id)
   );`,
];

function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 4000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(MIGRATIONS[0]);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;
  if (current === 0) {
    for (let index = 1; index < MIGRATIONS.length; index += 1) db.exec(MIGRATIONS[index]);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    return;
  }
  if (current > SCHEMA_VERSION) throw new Error(`FastLectures data was written by a newer version (${current}); update the app before opening it.`);
  for (let index = current + 1; index <= SCHEMA_VERSION; index += 1) {
    if (MIGRATIONS[index]) db.exec(MIGRATIONS[index]);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(index));
  }
}

module.exports = { openStore, SCHEMA_VERSION, MIGRATIONS };
