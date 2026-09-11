"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const runtimeSource = fs.readFileSync(path.join(root, "src/client/app/canvas-runtime.js"), "utf8");
const bootstrapSource = fs.readFileSync(path.join(root, "src/client/app/ui-bootstrap.js"), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = body; index < source.length; index++) {
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

const runtimeFunctions = [
  "imageBox",
  "widgetResizeHit",
  "selectedImage",
  "imageControlHit",
  "imagePointerHit",
  "imageResizeCursor",
  "syncWidgetResizeCursor",
].map(name => extractFunction(runtimeSource, name));

function runtimeHarness({ scale = 1, mode = "select", selected = true, viewMode = false, spacePan = false, widgetGesture = null, imageGesture = null } = {}) {
  const item = { id: "image-1", x: 100, y: 200, w: 300, h: 200 };
  const cursorCalls = [];
  const state = {
    scale,
    mode,
    viewMode,
    spacePan,
    widgetGesture,
    imageGesture,
    images: [item],
    selectedImageId: selected ? item.id : null,
    imageEdit: selected ? { id: item.id } : null,
  };
  const context = {
    state,
    setCanvasCursor(cursor) { cursorCalls.push(["set", cursor]); },
    resetCanvasCursor() { cursorCalls.push(["reset"]); },
  };
  const api = vm.runInNewContext(`(() => {
    function widgetResizeCursor() { return ""; }
    ${runtimeFunctions.join("\n")}
    return { imageBox, widgetResizeHit, imageControlHit, imagePointerHit, imageResizeCursor, syncWidgetResizeCursor };
  })()`, context);
  return { api, cursorCalls, item, state };
}

function resizeStartHarness({ mode = "hand", imageResult = null, viewMode = false, spacePan = false, pointerType = "mouse", pending = null, pendingResult = null, widgetResult = null, animationResult = null, widgetRuntime = false } = {}) {
  const calls = [];
  const state = {
    mode,
    viewMode,
    spacePan,
    pending,
    selectedAnimationId: null,
  };
  const item = { id: "image-1", x: 100, y: 200, w: 300, h: 200 };
  const beginHandObjectResize = vm.runInNewContext(
    `(${extractFunction(bootstrapSource, "beginHandObjectResize")})`,
    {
      acceptAnimationEdit() { calls.push("accept-animation"); },
      animationPointerHit() { calls.push("animation-hit"); return animationResult; },
      beginAnimationGesture() { calls.push("animation-begin"); return true; },
      beginImageGesture(event, point, result) {
        calls.push(["image-begin", event.pointerId, point, result]);
        return true;
      },
      beginPendingGesture() { calls.push("pending-begin"); return true; },
      beginWidgetGesture() { calls.push("widget-begin"); return true; },
      imagePointerHit() { calls.push("image-hit"); return imageResult; },
      pendingHit() { calls.push("pending-hit"); return pendingResult; },
      refreshHandObjectToolbar() { calls.push("refresh-toolbar"); },
      state,
      valid: () => true,
      widgetPointerHit() { calls.push("widget-hit"); return widgetResult; },
      widgetRuntimeEnabled: () => widgetRuntime,
    },
  );
  const result = beginHandObjectResize(
    { pointerId: 12, pointerType, button: 0 },
    { x: item.x + item.w, y: item.y + 40 },
  );
  return { calls, item, result, state };
}

test("imageControlHit exposes non-center right/bottom edges and prioritizes the corner", () => {
  for (const scale of [0.5, 2]) {
    const h = runtimeHarness({ scale });
    const box = h.item;
    const logicalScreenInset = 5 / scale;

    assert.equal(h.api.imageControlHit(box, { x: box.x + box.w - logicalScreenInset, y: box.y + 40 }), "width", `right edge at ${scale}x`);
    assert.equal(h.api.imageControlHit(box, { x: box.x + 60, y: box.y + box.h - logicalScreenInset }), "height", `bottom edge at ${scale}x`);
    assert.equal(h.api.imageControlHit(box, {
      x: box.x + box.w - logicalScreenInset,
      y: box.y + box.h - logicalScreenInset,
    }), "resize", `corner priority at ${scale}x`);
  }
});

test("imageControlHit falls back to move inside the image and rejects points outside", () => {
  const h = runtimeHarness();
  assert.equal(h.api.imageControlHit(h.item, { x: 240, y: 300 }), "move");
  assert.equal(h.api.imageControlHit(h.item, { x: 40, y: 140 }), null);
});

test("imageResizeCursor maps selected image edges and stays empty for an unselected image", () => {
  const h = runtimeHarness();
  assert.equal(h.api.imageResizeCursor({ x: 395, y: 240 }), "ew-resize");
  assert.equal(h.api.imageResizeCursor({ x: 180, y: 395 }), "ns-resize");
  assert.equal(h.api.imageResizeCursor({ x: 395, y: 395 }), "nwse-resize");

  const unselected = runtimeHarness({ selected: false });
  assert.equal(unselected.api.imageResizeCursor({ x: 395, y: 240 }), "");
});

test("Hand and Select can start an image resize only from an image edge", () => {
  for (const mode of ["hand", "select"]) {
    const h = resizeStartHarness({ mode, imageResult: { image: { id: "image-1" }, hit: "width" } });
    assert.equal(h.result, true, `${mode} should start image resize`);
    assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === "image-begin").length, 1);
    assert.equal(h.calls.includes("widget-begin"), false);
  }

  const interior = resizeStartHarness({ mode: "hand", imageResult: { image: { id: "image-1" }, hit: "move" } });
  assert.equal(interior.result, false);
  assert.equal(interior.calls.some(call => Array.isArray(call) && call[0] === "image-begin"), false, "an interior point must not start resize");

  const unselected = resizeStartHarness({ mode: "select", imageResult: null });
  assert.equal(unselected.result, false);
  assert.equal(unselected.calls.some(call => Array.isArray(call) && call[0] === "image-begin"), false, "an unselected image must not start resize");
});

test("Hand leaves Select-only pending, Widget, and animation resize branches untouched", () => {
  const h = resizeStartHarness({
    mode: "hand",
    pending: { revealProgress: 0 },
    pendingResult: "resize",
    widgetRuntime: true,
    widgetResult: { widget: { id: "widget-1" }, hit: "width" },
    animationResult: { animation: { id: "animation-1" }, hit: "height" },
  });

  assert.equal(h.result, false);
  assert.equal(h.calls.includes("pending-hit"), false);
  assert.equal(h.calls.includes("widget-hit"), false);
  assert.equal(h.calls.includes("animation-hit"), false);
  assert.equal(h.calls.includes("pending-begin"), false);
  assert.equal(h.calls.includes("widget-begin"), false);
  assert.equal(h.calls.includes("animation-begin"), false);

  const select = resizeStartHarness({ mode: "select", pending: { revealProgress: 0 }, pendingResult: "resize" });
  assert.equal(select.result, true);
  assert.equal(select.calls.includes("pending-hit"), true);
  assert.equal(select.calls.includes("pending-begin"), true);
});

test("resize hover cursor is available in Hand and Select, but suppressed by temporary navigation or active gestures", () => {
  for (const mode of ["hand", "select"]) {
    const h = runtimeHarness({ mode });
    assert.equal(h.api.syncWidgetResizeCursor({ x: 395, y: 240 }), true, `${mode} should expose image resize cursor`);
    assert.deepEqual(h.cursorCalls, [["set", "ew-resize"]]);
  }

  for (const options of [
    { spacePan: true },
    { viewMode: true },
    { pointerType: "touch" },
    { widgetGesture: { id: 1 } },
    { imageGesture: { id: 1 } },
  ]) {
    const h = runtimeHarness({ ...options });
    assert.equal(h.api.syncWidgetResizeCursor({ x: 395, y: 240 }, options.pointerType || "mouse"), false);
    assert.deepEqual(h.cursorCalls, [], `${Object.keys(options).join("/")} must not set a hover cursor`);
  }
});
