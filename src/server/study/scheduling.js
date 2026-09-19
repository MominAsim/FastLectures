"use strict";
// SM-2 derived spaced repetition with four answer grades. Kept pure and
// deterministic (caller supplies "now") so it is unit-testable without a database.
// Intervals are whole days except the "again" relearn step, which is minutes so a
// missed card comes back inside the same study session.

const MIN_EASE = 1300, MAX_EASE = 3000, START_EASE = 2500;
const DAY_MS = 86_400_000;
const AGAIN_DELAY_MS = 10 * 60_000;

const GRADES = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });

function clampEase(value) { return Math.min(MAX_EASE, Math.max(MIN_EASE, Math.round(value))); }

// A card is "new" until it has been answered correctly once.
function isLearning(card) { return Number(card?.repetitions || 0) === 0; }

// Compute the next state for a card given a grade. Returns the fields the caller
// persists; does not mutate the input.
function schedule(card, grade, now = Date.now()) {
  const quality = Number(grade);
  if (!Number.isInteger(quality) || quality < 1 || quality > 4) throw new Error("Flashcard grade must be 1 (again), 2 (hard), 3 (good) or 4 (easy).");
  const ease = clampEase(Number(card?.ease) || START_EASE);
  const repetitions = Math.max(0, Number(card?.repetitions) || 0);
  const intervalDays = Math.max(0, Number(card?.interval_days) || 0);
  const lapses = Math.max(0, Number(card?.lapses) || 0);

  if (quality === GRADES.again) {
    return {
      ease: clampEase(ease - 200),
      repetitions: 0,
      interval_days: 0,
      lapses: lapses + 1,
      due_at: now + AGAIN_DELAY_MS,
      last_review_at: now,
    };
  }

  // Interval progression for a correct answer.
  let nextInterval, nextEase, nextRepetitions;
  if (repetitions === 0) {
    nextInterval = quality === GRADES.hard ? 1 : quality === GRADES.easy ? 4 : 1;
    nextRepetitions = 1;
  } else if (repetitions === 1) {
    nextInterval = quality === GRADES.hard ? Math.max(1, Math.round(intervalDays * 1.2)) : quality === GRADES.easy ? 10 : 6;
    nextRepetitions = 2;
  } else {
    const factor = quality === GRADES.hard ? 1.2 : quality === GRADES.easy ? (ease / 1000) * 1.3 : ease / 1000;
    nextInterval = Math.max(1, Math.round(intervalDays * factor));
    nextRepetitions = repetitions + 1;
  }
  nextEase = quality === GRADES.hard ? clampEase(ease - 150) : quality === GRADES.easy ? clampEase(ease + 150) : ease;
  return {
    ease: nextEase,
    repetitions: nextRepetitions,
    interval_days: nextInterval,
    lapses,
    due_at: now + nextInterval * DAY_MS,
    last_review_at: now,
  };
}

// Preview intervals (human labels) so the review UI can show what each button does.
function preview(card) {
  const ease = clampEase(Number(card?.ease) || START_EASE);
  const repetitions = Math.max(0, Number(card?.repetitions) || 0);
  const intervalDays = Math.max(0, Number(card?.interval_days) || 0);
  const goodSecond = repetitions === 0 ? 1 : repetitions === 1 ? 6 : Math.max(1, Math.round(intervalDays * (ease / 1000)));
  return {
    again: "10 min",
    hard: formatInterval(repetitions === 0 ? 1 : Math.max(1, Math.round((repetitions === 1 ? 6 : intervalDays) * 1.2))),
    good: formatInterval(goodSecond),
    easy: formatInterval(repetitions === 0 ? 4 : Math.max(1, Math.round(goodSecond * 1.3))),
  };
}

function formatInterval(days) {
  if (days < 1) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.round(days / 30);
  return months === 1 ? "1 month" : `${months} months`;
}

// A 0-100 mastery estimate for dashboards, from review history + scheduling state.
function masteryScore(card) {
  const repetitions = Number(card?.repetitions) || 0;
  const lapses = Number(card?.lapses) || 0;
  const intervalDays = Number(card?.interval_days) || 0;
  if (repetitions === 0) return 0;
  const reach = Math.min(1, intervalDays / 21);          // ~3 weeks is "learned"
  const reliability = 1 - Math.min(1, lapses / (repetitions + lapses || 1));
  return Math.round(Math.min(100, reach * 70 + reliability * 20 + Math.min(1, repetitions / 6) * 10));
}

module.exports = { GRADES, DAY_MS, START_EASE, MIN_EASE, MAX_EASE, schedule, preview, formatInterval, masteryScore, isLearning };
