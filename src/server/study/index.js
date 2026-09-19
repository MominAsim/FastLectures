"use strict";
// FastLectures Study Server: per-user decks, cards, reviews, notes, quizzes,
// attempts, focus sessions, goals, concepts. Every endpoint is authenticated. The
// whole module talks to one shared SQLite file (data/auth.sqlite) whose schema lives
// in ../auth/store.js. No external services; a single-server host handles thousands
// of students because every operation is a bounded local SQL query.
const { openStore } = require("../auth/store.js");
const { randomId } = require("../auth/crypto.js");
const { schedule, GRADES, preview, masteryScore, DAY_MS } = require("./scheduling.js");

const MAX_JSON_BODY = 512 * 1024; // notes/canvases can be big; still bounded
const MAX_TITLE = 240;
const MAX_BODY = 512 * 1024;
const MAX_QUESTIONS = 100;
const MAX_TAGS = 32;

const LIMITS = { DECKS:500, CARDS:20_000, REVIEWS_PER_DAY:5_000, NOTES:2_000, NOTE_VERSIONS:20, QUIZZES:500, ATTEMPTS:2_000, SESSIONS_PER_DAY:200, CONCEPTS:1_000 };

function now() { return Date.now(); }

function dayStart(ts) { const d = new Date(ts); d.setUTCHours(0,0,0,0); return d.getTime(); }
function dayEnd(ts) { return dayStart(ts) + DAY_MS; }

function studyError(code, message) { return Object.assign(new Error(message), { code }); }

function requireText(value, field, max = MAX_TITLE) {
  if (typeof value !== "string") throw studyError("invalid_request", `${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw studyError("invalid_request", `${field} is required.`);
  if (trimmed.length > max) throw studyError("invalid_request", `${field} is too long.`);
  return trimmed;
}
function optionalText(value, max = MAX_BODY) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw studyError("invalid_request", "Text values must be strings.");
  if (value.length > max) throw studyError("invalid_request", "Text value is too long.");
  return value;
}
function optionalNumber(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function optionalInteger(value, fallback = 0) { const n = Math.floor(Number(value)); return Number.isFinite(n) ? n : fallback; }
function optionalEnum(value, choices, fallback) { const v = String(value || "").toLowerCase(); return choices.includes(v) ? v : fallback; }
function optionalColor(value) {
  const v = optionalEnum(value, ["slate","teal","amber","rose","violet","green","blue"], "slate");
  return v;
}
function parseTags(value) {
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(list.map(t => String(t || "").trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS);
}

// ── store access ─────────────────────────────────────────────────────────────

function open(file) { return openStore(file); }

function getDecks(db, userId) {
  return db.prepare("SELECT * FROM decks WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC").all(userId);
}
function getDeck(db, userId, id) { return db.prepare("SELECT * FROM decks WHERE id = ? AND user_id = ?").get(id, userId); }

function getCards(db, userId, deckId) {
  const where = ["user_id = ?", "deleted_at IS NULL"];
  const args = [userId];
  if (deckId) { where.push("deck_id = ?"); args.push(deckId); }
  return db.prepare(`SELECT * FROM cards WHERE ${where.join(" AND ")} ORDER BY due_at ASC LIMIT 5000`).all(...args);
}

function getCard(db, userId, id) { return db.prepare("SELECT * FROM cards WHERE id = ? AND user_id = ?").get(id, userId); }

function insertCard(db, card) {
  db.prepare(`INSERT INTO cards (id, user_id, deck_id, front, back, hint, image, ease, interval_days, repetitions, lapses, due_at, last_review_at, created_at, updated_at, source, tags, deleted_at) VALUES (@id, @userId, @deckId, @front, @back, @hint, @image, @ease, @intervalDays, @repetitions, @lapses, @dueAt, @lastReviewAt, @createdAt, @updatedAt, @source, @tags, @deletedAt)`).run({
    id:card.id, userId:card.userId, deckId:card.deckId, front:card.front, back:card.back, hint:card.hint || "", image:card.image || "", ease:card.ease ?? 2500, intervalDays:card.interval_days ?? 0, repetitions:card.repetitions ?? 0, lapses:card.lapses ?? 0, dueAt:card.due_at ?? now(), lastReviewAt:card.last_review_at ?? null, createdAt:card.created_at ?? now(), updatedAt:card.updated_at ?? now(), source:card.source || "manual", tags:JSON.stringify(card.tags || []), deletedAt:card.deleted_at ?? null,
  });
}

// ── public endpoints (called by server.js) ───────────────────────────────────

function attachRoutes(server, ctx = {}) {
  const enabled = String(process.env.FASTLECTURES_AUTH_ENABLED || "").trim().toLowerCase() === "true";
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  const send = typeof ctx.send === "function" ? ctx.send : () => {};
  const readJson = typeof ctx.readJson === "function" ? ctx.readJson : readJsonDefault;
  const isJson = typeof ctx.isJson === "function" ? ctx.isJson : req => String(req.headers["content-type"] || "").includes("application/json");
  const authorize = typeof ctx.authorize === "function" ? ctx.authorize : () => null;
  const requireUser = typeof ctx.requireUser === "function" ? ctx.requireUser : () => null;

  let db = null;
  function ensureDb() {
    if (!db && ctx.file) { try { db = open(ctx.file); } catch (error) { log({ type:"study-init-error", error:String(error?.message||error) }); } }
    return db;
  }

  // Handlers do not await — they synchronously respond. This mirrors main.js: every
  // handler calls send() exactly once and does not proceed to any other route.
  function registerHandlers() {
    server.on("request", (req, res) => {
      if (!enabled) return;
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (!url.pathname.startsWith("/api/study/")) return;
      const database = ensureDb();
      if (!database) return send(res, 503, { error:"Study storage is unavailable." });
      const authError = authorize(req);
      if (authError) return send(res, 403, { error:authError });
      const user = requireUser(req);
      if (!user) return send(res, 401, { error:"Please sign in to use study features." });
      const api = buildApi(req, res, url, database, user, { log, send, readJson, isJson });
      if (!api.matched) return send(res, 404, { error:"Unknown study endpoint." });
      return undefined;
    });
  }

  function readJsonDefault(req) {
    return new Promise((resolve, reject) => {
      let size = 0, chunks = [];
      req.on("data", chunk => { size += chunk.length; if (size > MAX_JSON_BODY) { req.destroy(); return reject(studyError("payload_too_large", "Request body too large.")); } chunks.push(chunk); });
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(studyError("invalid_json", "Request body must be valid JSON.")); } });
      req.on("error", reject);
    });
  }

  function buildApi(req, res, url, database, user, deps) {
    const { send, readJson, isJson, log } = deps;
    const userId = user.id;
    const segments = url.pathname.replace(/^\/api\/study\/?/, "").split("/");
    const kind = segments[0];
    const id = segments[1];
    let matched = false;
    const reply = (code, data) => { matched = true; return send(res, code, data); };

    if (req.method === "GET" && kind === "decks") {
      matched = true;
      const rows = database.prepare("SELECT d.*, (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id AND c.deleted_at IS NULL) as cardCount, (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id AND c.deleted_at IS NULL AND c.due_at <= ?) as dueCount FROM decks d WHERE d.user_id = ? AND d.archived = 0 ORDER BY d.updated_at DESC").all(now(), userId);
      return reply(200, { decks:rows });
    }
    if (req.method === "POST" && kind === "decks") {
      matched = true;
      return json(req, database, deck => {
        const ts = now();
        const row = { id:randomId(), userId, title:requireText(deck.title,"title"), subject:optionalText(deck.subject), color:optionalColor(deck.color), canvasId:optionalText(deck.canvasId), createdAt:ts, updatedAt:ts, archived:0 };
        database.prepare("INSERT INTO decks (id, user_id, title, subject, color, canvas_id, created_at, updated_at, archived) VALUES (@id, @userId, @title, @subject, @color, @canvasId, @createdAt, @updatedAt, @archived)").run(row);
        reply(201, { deck:row });
      });
    }
    if (req.method === "PATCH" && kind === "decks" && id) {
      matched = true;
      return json(req, database, deck => {
        const existing = getDeck(database, userId, id);
        if (!existing) return reply(404, { error:"Deck not found." });
        const patch = {};
        if (deck.title !== undefined) patch.title = requireText(deck.title, "title");
        if (deck.subject !== undefined) patch.subject = optionalText(deck.subject);
        if (deck.color !== undefined) patch.color = optionalColor(deck.color);
        if (deck.canvasId !== undefined) patch.canvasId = optionalText(deck.canvasId);
        if (deck.archived !== undefined) patch.archived = deck.archived ? 1 : 0;
        if (!Object.keys(patch).length) return reply(400, { error:"No changes supplied." });
        const fields = Object.entries(patch).map(([k,v]) => `${k === 'canvasId' ? 'canvas_id' : k} = ?`).join(", ");
        const values = Object.values(patch);
        database.prepare(`UPDATE decks SET ${fields}, updated_at = ? WHERE id = ? AND user_id = ?`).run(...values, now(), id, userId);
        reply(200, { deck:getDeck(database, userId, id) });
      });
    }
    if (req.method === "DELETE" && kind === "decks" && id) {
      matched = true;
      const existing = getDeck(database, userId, id);
      if (!existing) return reply(404, { error:"Deck not found." });
      database.prepare("UPDATE decks SET archived = 1, updated_at = ? WHERE id = ? AND user_id = ?").run(now(), id, userId);
      database.prepare("UPDATE cards SET deleted_at = ?, updated_at = ? WHERE deck_id = ? AND user_id = ? AND deleted_at IS NULL").run(now(), now(), id, userId);
      return reply(200, { removed:true });
    }

    if (req.method === "GET" && kind === "cards") {
      matched = true;
      const deckId = id || null;
      const limit = Math.min(5000, optionalNumber(url.searchParams.get("limit"), 5000));
      const rows = database.prepare("SELECT * FROM cards WHERE user_id = ? AND deleted_at IS NULL AND (? IS NULL OR deck_id = ?) ORDER BY due_at ASC LIMIT ?").all(userId, deckId, deckId, limit);
      return reply(200, { cards:rows.map(row => ({ ...row, tags:JSON.parse(row.tags || "[]"), mastery:masteryScore(row) })) });
    }
    if (req.method === "POST" && kind === "cards") {
      matched = true;
      return json(req, database, body => {
        const deck = getDeck(database, userId, body.deckId);
        if (!deck) return reply(400, { error:"A valid deck is required." });
        const ts = now(), card = {
          id:randomId(), userId, deckId:deck.id,
          front:requireText(body.front,"front",4000), back:requireText(body.back,"back",8000),
          hint:optionalText(body.hint, 1000), image:"", source:optionalEnum(body.source, ["manual","ai","import","canvas"],"manual"),
          tags:parseTags(body.tags), ease:2500, interval_days:0, repetitions:0, lapses:0, due_at:ts, created_at:ts, updated_at:ts,
        };
        insertCard(database, card);
        database.prepare("UPDATE decks SET updated_at = ? WHERE id = ? AND user_id = ?").run(ts, deck.id, userId);
        return reply(201, { card });
      });
    }
    if (req.method === "PATCH" && kind === "cards" && id) {
      matched = true;
      return json(req, database, body => {
        const existing = getCard(database, userId, id);
        if (!existing) return reply(404, { error:"Card not found." });
        const patch = {};
        if (body.front !== undefined) patch.front = requireText(body.front, "front", 4000);
        if (body.back !== undefined) patch.back = requireText(body.back, "back", 8000);
        if (body.hint !== undefined) patch.hint = optionalText(body.hint, 1000);
        if (body.tags !== undefined) patch.tags = parseTags(body.tags);
        if (body.deckId && body.deckId !== existing.deck_id) {
          const target = getDeck(database, userId, body.deckId);
          if (!target) return reply(400, { error:"Target deck not found." });
          patch.deck_id = target.id;
        }
        if (!Object.keys(patch).length) return reply(400, { error:"No changes supplied." });
        const fields = Object.entries(patch).map(([k]) => `${k === "deck_id" ? "deck_id" : k} = ?`).join(", ");
        const values = Object.values(patch);
        database.prepare(`UPDATE cards SET ${fields}, updated_at = ? WHERE id = ? AND user_id = ?`).run(...values, now(), id, userId);
        return reply(200, { card:getCard(database, userId, id) });
      });
    }
    if (req.method === "DELETE" && kind === "cards" && id) {
      matched = true;
      const existing = getCard(database, userId, id);
      if (!existing) return reply(404, { error:"Card not found." });
      database.prepare("UPDATE cards SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(now(), now(), id, userId);
      return reply(200, { removed:true });
    }

    if (req.method === "GET" && kind === "review") {
      matched = true;
      const deckId = id || null;
      const cards = database.prepare("SELECT * FROM cards WHERE user_id = ? AND deleted_at IS NULL AND (? IS NULL OR deck_id = ?) AND due_at <= ? ORDER BY due_at ASC LIMIT 500").all(userId, deckId, deckId, now());
      const counts = { due:cards.length, new:cards.filter(c => (c.repetitions || 0) === 0).length, total:database.prepare("SELECT COUNT(*) as n FROM cards WHERE user_id = ? AND deleted_at IS NULL").get(userId).n };
      return reply(200, { cards, counts, preview:(card) => preview(card) });
    }
    if (req.method === "POST" && kind === "review") {
      matched = true;
      return json(req, database, body => {
        const card = getCard(database, userId, body.cardId);
        if (!card) return reply(404, { error:"Card not found." });
        const grade = Number(body.grade);
        let next;
        try { next = schedule(card, grade); } catch (error) { return reply(400, { error:error.message }); }
        const ts = now();
        database.prepare("UPDATE cards SET ease = ?, interval_days = ?, repetitions = ?, lapses = ?, due_at = ?, last_review_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(next.ease, next.interval_days, next.repetitions, next.lapses, next.due_at, ts, ts, card.id, userId);
        database.prepare("INSERT INTO reviews (user_id, card_id, deck_id, grade, previous_interval_days, next_interval_days, elapsed_ms, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(userId, card.id, card.deck_id, grade, Number(card.interval_days || 0), next.interval_days, Math.max(0, optionalNumber(body.elapsedMs, 0)), ts);
        database.prepare("UPDATE decks SET updated_at = ? WHERE id = ? AND user_id = ?").run(ts, card.deck_id, userId);
        return reply(200, { card:getCard(database, userId, card.id), preview:preview(getCard(database, userId, card.id)) });
      });
    }

    if (req.method === "GET" && kind === "stats") {
      matched = true;
      return reply(200, { stats:dashboardStats(database, userId) });
    }

    if (kind === "notes") {
      return attachNotes(req, res, database, userId, { send, readJson, log, reply });
    }
    if (kind === "quizzes") {
      return attachQuizzes(req, res, database, userId, { send, readJson, log, reply });
    }
    if (kind === "attempts") {
      return attachAttempts(req, res, database, userId, { send, readJson, log, reply });
    }
    if (kind === "focus") {
      return attachFocus(req, res, database, userId, { send, readJson, log, reply });
    }
    if (kind === "goals") {
      return attachGoals(req, res, database, userId, { send, readJson, log, reply });
    }
    if (kind === "concepts") {
      return attachConcepts(req, res, database, userId, { send, readJson, log, reply });
    }

    return { matched:false };
  }

  function json(req, database, handler) {
    if (!isJson(req)) return send(res, 415, { error:"Use application/json." });
    return Promise.resolve(readJson(req, MAX_JSON_BODY)).then(handler).catch(error => {
      if (error?.code === "payload_too_large") return send(res, 413, { error:"Request body too large." });
      if (error?.code === "invalid_json") return send(res, 400, { error:"Request body must be valid JSON." });
      if (error?.code === "invalid_request") return send(res, 400, { error:error.message });
      log({ type:"study-error", errorCode:String(error?.code||"study_error"), error:String(error?.message||error) });
      return send(res, 500, { error:"Study request failed." });
    });
  }

  registerHandlers();
  return { ensureDb };
}

// ── stats ───────────────────────────────────────────────────────────────────

function dashboardStats(db, userId) {
  const ts = now();
  const decks = db.prepare("SELECT COUNT(*) as n FROM decks WHERE user_id = ? AND archived = 0").get(userId).n;
  const cards = db.prepare("SELECT COUNT(*) as n FROM cards WHERE user_id = ? AND deleted_at IS NULL").get(userId).n;
  const due = db.prepare("SELECT COUNT(*) as n FROM cards WHERE user_id = ? AND deleted_at IS NULL AND due_at <= ?").get(userId, ts).n;
  const learned = db.prepare("SELECT COUNT(*) as n FROM cards WHERE user_id = ? AND deleted_at IS NULL AND interval_days >= 21").get(userId).n;
  const reviewsToday = db.prepare("SELECT COUNT(*) as n FROM reviews WHERE user_id = ? AND reviewed_at >= ?").get(userId, dayStart(ts)).n;
  const secondsToday = db.prepare("SELECT COALESCE(SUM(seconds), 0) as s FROM sessions_time WHERE user_id = ? AND started_at >= ?").get(userId, dayStart(ts)).s || 0;
  const streak = currentStreak(db, userId, ts);
  const accuracy = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN grade >= 3 THEN 1 ELSE 0 END) as correct FROM reviews WHERE user_id = ? AND reviewed_at >= ?").get(userId, ts - 30 * DAY_MS);
  const subjects = db.prepare("SELECT subject, COUNT(*) as count FROM decks WHERE user_id = ? AND archived = 0 GROUP BY subject ORDER BY count DESC").all(userId).filter(s => s.subject);
  const mastery = db.prepare("SELECT deck_id, AVG(interval_days) as days, COUNT(*) as cards FROM cards WHERE user_id = ? AND deleted_at IS NULL GROUP BY deck_id").all(userId);
  const weakest = [...mastery].sort((a,b) => Number(a.days) - Number(b.days)).slice(0, 5);
  const recent = db.prepare("SELECT r.*, c.front, c.back, d.title as deckTitle FROM reviews r JOIN cards c ON c.id = r.card_id JOIN decks d ON d.id = r.deck_id WHERE r.user_id = ? ORDER BY r.reviewed_at DESC LIMIT 20").all(userId);
  return { decks, cards, due, learned, reviewsToday, secondsToday, streak, accuracy:accuracy.total ? accuracy.correct / accuracy.total : null, subjects, weakest, recent };
}

function currentStreak(db, userId, ts) {
  const rows = db.prepare("SELECT DISTINCT (started_at / 86400000) as day FROM sessions_time WHERE user_id = ? AND ended_at > ? UNION SELECT DISTINCT (reviewed_at / 86400000) as day FROM reviews WHERE user_id = ? AND reviewed_at > ? ORDER BY day DESC").all(userId, ts - 366 * DAY_MS, userId, ts - 366 * DAY_MS).map(r => Number(r.day));
  let streak = 0, cursor = Math.floor(dayStart(ts) / DAY_MS);
  for (const day of rows) {
    if (day === cursor) { streak += 1; cursor -= 1; }
    else if (day > cursor) cursor = day;
    else break;
  }
  return streak;
}

// ── sub-route modules ───────────────────────────────────────────────────────

function attachNotes(req, res, db, userId, deps) {
  const { send, readJson, reply } = deps;
  if (req.method === "GET" && !res.headersSent) {
    const rows = db.prepare("SELECT id, title, body, subject, canvas_id, pinned, created_at, updated_at FROM notes WHERE user_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC").all(userId);
    return reply(200, { notes:rows });
  }
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error:"Use application/json." });
    return readJson(req).then(body => {
      const ts = now(), id = randomId();
      db.prepare("INSERT INTO notes (id, user_id, title, body, subject, canvas_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, requireText(body.title,"title"), optionalText(body.body), optionalText(body.subject), optionalText(body.canvasId), body.pinned ? 1 : 0, ts, ts);
      return reply(201, { note:db.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ?").get(id, userId) });
    }).catch(error => reply(400, { error:error.message }));
  }
  return send(res, 405, { error:"Method Not Allowed." });
}

function attachQuizzes(req, res, db, userId, deps) {
  const { send, readJson, reply } = deps;
  if (req.method === "GET") {
    const rows = db.prepare("SELECT id, title, subject, canvas_id, created_at FROM quizzes WHERE user_id = ? ORDER BY created_at DESC").all(userId);
    return reply(200, { quizzes:rows });
  }
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error:"Use application/json." });
    return readJson(req).then(body => {
      if (!Array.isArray(body.questions) || !body.questions.length) return reply(400, { error:"A quiz needs at least one question." });
      if (body.questions.length > MAX_QUESTIONS) return reply(400, { error:`A quiz is limited to ${MAX_QUESTIONS} questions.` });
      const ts = now(), id = randomId();
      db.prepare("INSERT INTO quizzes (id, user_id, title, subject, canvas_id, created_at, questions_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, userId, requireText(body.title,"title"), optionalText(body.subject), optionalText(body.canvasId), ts, JSON.stringify(body.questions));
      return reply(201, { quiz:{ id, title:body.title, questions:body.questions, created_at:ts } });
    }).catch(error => reply(400, { error:error.message }));
  }
  return send(res, 405, { error:"Method Not Allowed." });
}

function attachAttempts(req, res, db, userId, deps) {
  const { send, readJson, reply } = deps;
  if (req.method === "GET") {
    const rows = db.prepare("SELECT id, quiz_id, title, kind, score, total, correct, duration_ms, created_at FROM attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").all(userId);
    return reply(200, { attempts:rows });
  }
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error:"Use application/json." });
    return readJson(req).then(body => {
      const ts = now(), id = randomId();
      const correct = Math.max(0, optionalInteger(body.correct, 0));
      const total = Math.max(0, optionalInteger(body.total, 0)) || Math.max(1, correct);
      db.prepare("INSERT INTO attempts (id, user_id, quiz_id, title, kind, score, total, correct, duration_ms, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, body.quizId || null, requireText(body.title,"title"), optionalEnum(body.kind, ["quiz","exam","practice"],"quiz"), Math.min(1, correct / total), total, correct, optionalInteger(body.durationMs, 0), ts, JSON.stringify(Array.isArray(body.detail) ? body.detail.slice(0, MAX_QUESTIONS) : []));
      return reply(201, { attempt:db.prepare("SELECT * FROM attempts WHERE id = ? AND user_id = ?").get(id, userId) });
    }).catch(error => reply(400, { error:error.message }));
  }
  return send(res, 405, { error:"Method Not Allowed." });
}

function attachFocus(req, res, db, userId, deps) {
  const { send, readJson, reply } = deps;
  if (req.method === "GET") {
    const rows = db.prepare("SELECT id, mode, started_at, ended_at, seconds, deck_id, completed FROM sessions_time WHERE user_id = ? AND started_at > ? ORDER BY started_at DESC").all(userId, now() - 60 * DAY_MS);
    const summary = db.prepare("SELECT mode, SUM(seconds) as totalSeconds, COUNT(*) as sessions FROM sessions_time WHERE user_id = ? AND started_at > ? GROUP BY mode").all(userId, now() - 30 * DAY_MS);
    return reply(200, { sessions:rows, summary });
  }
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error:"Use application/json." });
    return readJson(req).then(body => {
      const ts = now(), seconds = Math.max(1, optionalInteger(body.seconds, 0));
      const started = optionalInteger(body.startedAt, ts - seconds * 1000);
      db.prepare("INSERT INTO sessions_time (user_id, mode, started_at, ended_at, seconds, deck_id, completed) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, optionalEnum(body.mode, ["pomodoro","deep","sprint","custom"],"pomodoro"), started, started + seconds * 1000, seconds, optionalText(body.deckId), body.completed === false ? 0 : 1);
      return reply(201, { ok:true });
    }).catch(error => reply(400, { error:error.message }));
  }
  return send(res, 405, { error:"Method Not Allowed." });
}

function attachGoals(req, res, db, userId, deps) {
  const { send, readJson, reply } = deps;
  if (req.method === "GET") {
    const row = db.prepare("SELECT * FROM goals WHERE user_id = ?").get(userId);
    return reply(200, { goal:row || defaultGoal(userId) });
  }
  if (req.method === "PUT") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error:"Use application/json." });
    return readJson(req).then(body => {
      const ts = now();
      const row = { user_id:userId, daily_seconds:clampNumber(body.dailySeconds, 60, 86_400, 1800), daily_cards:clampNumber(body.dailyCards, 1, 2000, 20), weekly_days:clampNumber(body.weeklyDays, 1, 7, 5), exam_date:body.examDate ? clampNumber(body.examDate, ts, ts + 3650 * DAY_MS, null) : null, exam_subject:optionalText(body.examSubject), updated_at:ts };
      db.prepare(`INSERT INTO goals (user_id, daily_seconds, daily_cards, weekly_days, exam_date, exam_subject, updated_at) VALUES (@user_id, @daily_seconds, @daily_cards, @weekly_days, @exam_date, @exam_subject, @updated_at) ON CONFLICT(user_id) DO UPDATE SET daily_seconds = excluded.daily_seconds, daily_cards = excluded.daily_cards, weekly_days = excluded.weekly_days, exam_date = excluded.exam_date, exam_subject = excluded.exam_subject, updated_at = excluded.updated_at`).run(row);
      return reply(200, { goal:db.prepare("SELECT * FROM goals WHERE user_id = ?").get(userId) });
    }).catch(error => reply(400, { error:error.message }));
  }
  return send(res, 405, { error:"Method Not Allowed." });
}

function defaultGoal(userId) { return { user_id:userId, daily_seconds:1800, daily_cards:20, weekly_days:5, exam_date:null, exam_subject:"", updated_at:now() }; }
function clampNumber(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback; }

function attachConcepts(req, res, db, userId, deps) {
  const { send, readJson, reply } = deps;
  if (req.method === "GET") {
    const rows = db.prepare("SELECT id, title, subject, mastery, edges, updated_at FROM concepts WHERE user_id = ? ORDER BY mastery DESC, title ASC").all(userId);
    return reply(200, { concepts:rows.map(row => ({ ...row, edges:JSON.parse(row.edges || "[]") })) });
  }
  if (req.method === "PUT") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error:"Use application/json." });
    return readJson(req).then(body => {
      if (!Array.isArray(body.concepts)) return reply(400, { error:"concepts must be an array." });
      const ts = now();
      db.prepare("DELETE FROM concepts WHERE user_id = ?").run(userId);
      for (const concept of body.concepts.slice(0, LIMITS.CONCEPTS)) {
        if (!concept || typeof concept.id !== "string") continue;
        const mastery = clampNumber(concept.mastery, 0, 100, 0);
        db.prepare("INSERT INTO concepts (user_id, id, title, subject, mastery, edges, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, concept.id.slice(0, 80), requireText(concept.title,"title").slice(0, 120), optionalText(concept.subject), mastery, JSON.stringify(Array.isArray(concept.edges) ? concept.edges.slice(0, 50) : []), ts);
      }
      return reply(200, { ok:true });
    }).catch(error => reply(400, { error:error.message }));
  }
  return send(res, 405, { error:"Method Not Allowed." });
}

module.exports = { attachRoutes, open, schedule, GRADES, preview, masteryScore, dayStart, dayEnd, dashboardStats, currentStreak, MAX_JSON_BODY };
