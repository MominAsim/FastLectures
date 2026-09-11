"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const uiBootstrapSource = fs.readFileSync(path.join(root, "src/client/app/ui-bootstrap.js"), "utf8");
const canvasRuntimeSource = fs.readFileSync(path.join(root, "src/client/app/canvas-runtime.js"), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected ${name} in source`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `expected ${name} body`);

  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (["'", '"', "`"].includes(current)) {
      quote = current;
      continue;
    }
    if (current === "{") depth++;
    else if (current === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function ensureHarness(mode) {
  const state = { mode, handToolbarTargets: new Map() };
  const ensureHandToolbarRecord = vm.runInNewContext(
    `(${extractFunction(canvasRuntimeSource, "ensureHandToolbarRecord")})`,
    {
      Date,
      HAND_OBJECT_TOOLBAR_VISIBLE_MS: 10_000,
      handToolbarKey: (kind, id) => `${kind}:${id}`,
      state,
    },
  );
  return { ensureHandToolbarRecord, state };
}

function finishHarness({
  target,
  type = "pointerup",
  pointerId = 7,
  tapPointerId = pointerId,
  mode = "hand",
  viewMode = false,
  spacePan = false,
  touchCount = 0,
  dx = 0,
  dy = 0,
} = {}) {
  const state = {
    handToolbarTap: { id: tapPointerId, target, x: 100, y: 200 },
    mode,
    spacePan,
    touches: new Map(Array.from({ length: touchCount }, (_, index) => [index + 1, {}])),
    viewMode,
  };
  const calls = [];
  const finishHandCanvasTap = vm.runInNewContext(
    `(${extractFunction(uiBootstrapSource, "finishHandCanvasTap")})`,
    {
      Math,
      showHandObjectToolbar: (kind, object) => calls.push({ kind, object }),
      state,
    },
  );
  finishHandCanvasTap({
    clientX: 100 + dx,
    clientY: 200 + dy,
    pointerId,
    type,
  });
  return { calls, state };
}

test("Hand taps pass widget, image, text-box, and animation objects to the toolbar", () => {
  for (const kind of ["widget", "image", "text-box", "animation"]) {
    const object = { id: `${kind}-1` };
    const { calls, state } = finishHarness({ target: { kind, object } });

    assert.equal(calls.length, 1, `${kind} should be selected on a tap`);
    assert.equal(calls[0].kind, kind);
    assert.strictEqual(calls[0].object, object);
    assert.equal(state.handToolbarTap, null, `${kind} tap should be consumed`);
  }
});

test("Hand tap tolerance includes six pixels and rejects a larger drag", () => {
  const object = { id: "image-1" };
  assert.equal(finishHarness({ target: { kind: "image", object }, dx: 6 }).calls.length, 1);
  assert.equal(finishHarness({ target: { kind: "image", object }, dx: 6.01 }).calls.length, 0);
});

test("cancelled, multi-touch, view-mode, and space-pan gestures do not select", () => {
  const cases = [
    { type: "pointercancel" },
    { touchCount: 2 },
    { viewMode: true },
    { spacePan: true },
  ];
  for (const options of cases) {
    const { calls, state } = finishHarness({
      ...options,
      target: { kind: "text-box", object: { id: "text-1" } },
    });
    assert.equal(calls.length, 0, `${Object.keys(options).join("/")} must not select`);
    assert.equal(state.handToolbarTap, null, "the pending tap must be cleared");
  }
});

test("a different pointer cannot finish the pending Hand tap", () => {
  const tap = { id: 7, target: { kind: "animation", object: { id: "animation-1" } }, x: 100, y: 200 };
  const { calls, state } = finishHarness({
    pointerId: 8,
    tapPointerId: 7,
    target: tap.target,
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(state.handToolbarTap, tap);
});

test("Hand toolbar records accept all four object kinds", () => {
  const { ensureHandToolbarRecord, state } = ensureHarness("hand");
  for (const kind of ["widget", "image", "text-box", "animation"]) {
    const object = { id: `${kind}-2` };
    const result = ensureHandToolbarRecord(kind, object);

    assert.ok(result, `${kind} should be allowed in Hand mode`);
    assert.equal(result.key, `${kind}:${object.id}`);
    assert.equal(result.record.kind, kind);
    assert.equal(result.record.id, object.id);
    assert.strictEqual(state.handToolbarTargets.get(result.key), result.record);
  }
});

test("Hand toolbar record creation is idempotent for an object", () => {
  const { ensureHandToolbarRecord, state } = ensureHarness("hand");
  const object = { id: "widget-2" };
  const first = ensureHandToolbarRecord("widget", object);
  const second = ensureHandToolbarRecord("widget", object);

  assert.strictEqual(second.record, first.record);
  assert.equal(state.handToolbarTargets.size, 1);
});

test("Pen mode keeps toolbar records limited to widgets", () => {
  const { ensureHandToolbarRecord, state } = ensureHarness("pen");
  const widget = { id: "widget-pen" };
  assert.ok(ensureHandToolbarRecord("widget", widget));
  for (const kind of ["image", "text-box", "animation"]) {
    assert.equal(ensureHandToolbarRecord(kind, { id: `${kind}-pen` }), null, `${kind} must stay unavailable in Pen mode`);
  }
  assert.equal(state.handToolbarTargets.size, 1);
});
