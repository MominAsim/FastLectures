"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { widgetSourceHash } = require("../src/server/widget-patch.js");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const functionSource = (source, name) => {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart === -1 ? source.indexOf(`function ${name}(`) : asyncStart;
  assert.notEqual(start, -1, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${name}`);
};

const canvasRuntimeSource = read("src/client/app/canvas-runtime.js");
const agentRuntimeSource = read("src/client/app/canvas-agent-runtime.js");
const visualExplorerSourceFormat = "penecho-visual-explorer+html";

function clientFunctions(overrides = {}) {
  const source = [
    functionSource(canvasRuntimeSource, "normalizedWidgetSource"),
    functionSource(canvasRuntimeSource, "widgetSourceMirrorsHtml"),
    functionSource(canvasRuntimeSource, "widgetUsesHtmlCopySource"),
    functionSource(canvasRuntimeSource, "widgetBox"),
    functionSource(canvasRuntimeSource, "widgetEditContext"),
    functionSource(agentRuntimeSource, "canvasAgentHash"),
    functionSource(agentRuntimeSource, "canvasAgentWidgetSourceState"),
  ].join("\n");
  return vm.runInNewContext(`(()=>{const VISUAL_EXPLAINER_SOURCE_FORMAT=${JSON.stringify(visualExplorerSourceFormat)};${source}\nreturn {widgetEditContext,canvasAgentHash,canvasAgentWidgetSourceState};})()`, {
    TextEncoder,
    crypto:webcrypto,
    structuredClone,
    VISUAL_EXPLORER_SOURCE_FORMAT:visualExplorerSourceFormat,
    ...overrides,
  });
}

function htmlWidget(overrides = {}) {
  const html = "<!doctype html>\n<main><h1>Old</h1></main>\n";
  return {
    id:"widget-1",
    widgetType:"html_widget",
    pluginId:"general",
    title:"Existing Widget",
    x:100,
    y:200,
    w:900,
    h:600,
    contentW:900,
    contentH:600,
    refreshSeconds:15,
    html,
    source:"const oldSource = true;",
    copyText:"const oldSource = true;",
    copyLabel:"Copy source",
    sourceFormat:"",
    frameworkVersion:"",
    contentVersion:3,
    runtimeDiagnostics:{ errors:[{ message:"old runtime warning" }] },
    visualDiagnostics:{ status:"old" },
    ...overrides,
  };
}

async function browserSourceHash(client, widget) {
  const edit = client.widgetEditContext(widget, "agent");
  const sourceState = client.canvasAgentWidgetSourceState(edit);
  return {
    edit,
    sourceState,
    hash:await client.canvasAgentHash(sourceState),
  };
}

test("browser source fingerprint matches server widgetSourceHash for HTML, diagrams, mirrors, empty source, and CRLF", async () => {
  const client = clientFunctions();
  const crlfHtml = "<!doctype html>\r\n<main>\r\n  <h1>CRLF</h1>\r\n</main>\r\n";
  const cases = [
    ["html with distinct source", htmlWidget()],
    ["html source mirrors html", htmlWidget({ source:"ignored source", copyText:htmlWidget().html })],
    ["html with empty source", htmlWidget({ source:"", copyText:"" })],
    ["html CRLF mirror", htmlWidget({ html:crlfHtml, source:"", copyText:crlfHtml })],
    ["diagram source", htmlWidget({
      widgetType:"diagram_source",
      diagramKind:"flow",
      title:"Diagram",
      html:"",
      source:"nodes:\r\n  - id: one\r\n",
      copyText:"",
      copyLabel:"",
      sourceFormat:"penecho-diagram+yaml",
      frameworkVersion:"",
    })],
  ];
  for (const [label, widget] of cases) {
    const actual = await browserSourceHash(client, widget);
    const expected = widgetSourceHash(actual.edit);
    assert.match(actual.hash, /^[0-9a-f]{64}$/, `${label} should use SHA-256 when crypto.subtle is available`);
    assert.equal(actual.hash, expected, `${label} source fingerprint diverged from server`);
  }
});

test("browser source hash ignores geometry, diagnostics, and contentVersion but tracks source and manifest changes", async () => {
  const client = clientFunctions();
  const base = htmlWidget();
  const original = await browserSourceHash(client, base);
  const geometryAndRuntimeOnly = await browserSourceHash(client, {
    ...base,
    x:777,
    y:888,
    w:1200,
    h:720,
    contentW:1200,
    contentH:720,
    contentVersion:99,
    runtimeDiagnostics:{ errors:[{ message:"new runtime error" }] },
    visualDiagnostics:{ status:"new visual result" },
  });
  assert.equal(geometryAndRuntimeOnly.hash, original.hash);

  const changedHtml = await browserSourceHash(client, { ...base, html:base.html.replace("Old", "New") });
  const changedSource = await browserSourceHash(client, { ...base, copyText:"const newSource = true;", source:"const newSource = true;" });
  const changedManifest = await browserSourceHash(client, { ...base, title:"Changed title" });
  assert.notEqual(changedHtml.hash, original.hash);
  assert.notEqual(changedSource.hash, original.hash);
  assert.notEqual(changedManifest.hash, original.hash);
});

function replaceHarness({ onDigestStart = null } = {}) {
  const widget = htmlWidget();
  const state = {
    userRevision:7,
    widgets:[widget],
    widgetEdit:null,
    widgetHistoryBefore:null,
    frontCanvasObjectKind:"widget",
    frontPlacedCanvasObjectKind:"widget",
  };
  let releaseDigest;
  let digestStarted;
  const digestGate = new Promise(resolve => { releaseDigest = resolve; });
  const digestStartedPromise = new Promise(resolve => { digestStarted = resolve; });
  let digestCalls = 0;
  const digestCrypto = {
    subtle:{
      digest:async (algorithm, bytes) => {
        digestCalls += 1;
        if (digestCalls === 1) {
          digestStarted();
          onDigestStart?.({ state, release:releaseDigest });
          await digestGate;
        }
        return webcrypto.subtle.digest(algorithm, bytes);
      },
    },
  };
  const trace = [];
  const saveKinds = [];
  const functionSourceText = [
    functionSource(canvasRuntimeSource, "normalizedWidgetSource"),
    functionSource(canvasRuntimeSource, "widgetSourceMirrorsHtml"),
    functionSource(canvasRuntimeSource, "widgetUsesHtmlCopySource"),
    functionSource(canvasRuntimeSource, "widgetBox"),
    functionSource(canvasRuntimeSource, "widgetEditContext"),
    functionSource(agentRuntimeSource, "canvasAgentHash"),
    functionSource(agentRuntimeSource, "canvasAgentWidgetSourceState"),
    functionSource(agentRuntimeSource, "canvasAgentReplaceWidget"),
  ].join("\n");
  const replace = vm.runInNewContext(`(()=>{const VISUAL_EXPLAINER_SOURCE_FORMAT=${JSON.stringify(visualExplorerSourceFormat)};${functionSourceText}\nreturn canvasAgentReplaceWidget;})()`, {
    TextEncoder,
    crypto:digestCrypto,
    structuredClone,
    VISUAL_EXPLAINER_SOURCE_FORMAT:visualExplorerSourceFormat,
    state,
    canvasAgentWaitForSourceCommit:async () => {},
    canvasAgentAssertToolExecution:() => {},
    canvasAgentAssertRevision:() => {},
    canvasAgentMutationIdle:() => {},
    canvasAgentObject:id => id === widget.id ? { kind:"widget", item:state.widgets[0] } : null,
    canvasAgentToolError:(code, message) => Object.assign(Error(message), { code }),
    canvasAgentWidgetPluginAllowed:() => true,
    widgetRecord:record => ({ ...state.widgets[0], ...record }),
    canvasAgentSealWidgetGeometryEdit:() => trace.push("geometry-history-sealed"),
    save:() => {
      saveKinds.push(state.widgetHistoryBefore ? "widget-history-save" : "plain-save");
      state.widgetHistoryBefore = null;
      trace.push("source-save");
    },
    serializedWidgets:() => "serialized-widgets",
    positionWidget:() => {},
    sendWidgetInit:() => {},
    sendWidgetHostState:() => {},
    requestRender:() => {},
    canvasAgentSyncState:() => {},
    canvasAgentRecordChange:() => {},
    canvasAgentBox:() => ({ x:state.widgets[0].x, y:state.widgets[0].y, w:state.widgets[0].w, h:state.widgets[0].h }),
    canvasAgentClientId:() => "source-change",
  });
  return { state, widget, replace, trace, saveKinds, digestStartedPromise, releaseDigest };
}

test("source-only replace can consume receipt.sourceHash repeatedly without global revision and preserves geometry changed during hash", async () => {
  const client = clientFunctions();
  const initial = htmlWidget();
  const expected = await browserSourceHash(client, initial);
  const harness = replaceHarness();
  const firstCommand = {
    tool:"html_widget",
    widgetType:"html_widget",
    pluginId:"general",
    title:initial.title,
    refreshSeconds:initial.refreshSeconds,
    html:initial.html.replace("Old", "First"),
    source:"const firstSource = true;",
    copyText:"const firstSource = true;",
    copyLabel:initial.copyLabel,
  };
  const firstPromise = harness.replace({
    objectId:harness.widget.id,
    expectedSourceHash:expected.hash,
    changeId:"first-source",
    command:firstCommand,
  }, {});
  await harness.digestStartedPromise;
  harness.widget.x = 444;
  harness.widget.y = 555;
  harness.widget.w = 1000;
  harness.widget.h = 700;
  harness.widget.contentW = 1000;
  harness.widget.contentH = 700;
  harness.state.userRevision = 88;
  harness.releaseDigest();
  const first = await firstPromise;
  assert.equal(first.ok, true);
  assert.equal(first.previousRevision, 88);
  assert.equal(JSON.stringify(first.geometry), JSON.stringify({ x:444, y:555, w:1000, h:700, contentW:1000, contentH:700 }));
  assert.deepEqual({ x:harness.widget.x, y:harness.widget.y, w:harness.widget.w, h:harness.widget.h }, { x:444, y:555, w:1000, h:700 });
  assert.equal(first.receipts[0].sourceHash, first.sourceHash);
  assert.deepEqual(harness.trace, ["geometry-history-sealed", "source-save", "source-save"]);
  assert.deepEqual(harness.saveKinds, ["plain-save", "widget-history-save"], "source-only replace must save the pre-source baseline before the source history entry");
  assert.equal(harness.state.widgetHistoryBefore, null);

  const second = await harness.replace({
    objectId:harness.widget.id,
    expectedSourceHash:first.receipts[0].sourceHash,
    changeId:"second-source",
    command:{ ...firstCommand, html:firstCommand.html.replace("First", "Second"), source:"const secondSource = true;", copyText:"const secondSource = true;" },
  }, {});
  assert.equal(second.ok, true);
  assert.equal(second.receipts[0].sourceHash, second.sourceHash);
  assert.equal(harness.state.userRevision, 90);
  assert.deepEqual(harness.saveKinds, ["plain-save", "widget-history-save", "plain-save", "widget-history-save"]);
  assert.equal(harness.state.widgetHistoryBefore, null);
});

test("source-only replace rejects a real source mutation that lands while the expected hash is pending", async () => {
  const client = clientFunctions();
  const initial = htmlWidget();
  const expected = await browserSourceHash(client, initial);
  const harness = replaceHarness();
  const originalHtml = harness.widget.html;
  const pending = harness.replace({
    objectId:harness.widget.id,
    expectedSourceHash:expected.hash,
    changeId:"source-conflict",
    command:{
      tool:"html_widget",
      widgetType:"html_widget",
      pluginId:"general",
      title:initial.title,
      refreshSeconds:initial.refreshSeconds,
      html:originalHtml.replace("Old", "Agent"),
      source:"const agentSource = true;",
      copyText:"const agentSource = true;",
      copyLabel:initial.copyLabel,
    },
  }, {});
  await harness.digestStartedPromise;
  harness.widget.html = originalHtml.replace("Old", "User");
  harness.state.userRevision = 89;
  harness.releaseDigest();
  await assert.rejects(pending, error => error?.code === "SOURCE_CONFLICT");
  assert.equal(harness.widget.html, originalHtml.replace("Old", "User"));
  assert.equal(harness.trace.length, 0);
});

test("selected widgetEdit seals geometry history before the source history entry", () => {
  const widget = htmlWidget();
  const state = {
    widgetEdit:{ id:widget.id, changed:true },
    widgets:[widget],
    widgetHistoryBefore:"geometry-before",
    frontCanvasObjectKind:"widget",
    frontPlacedCanvasObjectKind:"widget",
  };
  const saved = [];
  const source = [
    functionSource(canvasRuntimeSource, "widgetBox"),
    functionSource(canvasRuntimeSource, "widgetLayout"),
    functionSource(agentRuntimeSource, "canvasAgentSealWidgetGeometryEdit"),
  ].join("\n");
  const seal = vm.runInNewContext(`(()=>{const VISUAL_EXPLORER_SOURCE_FORMAT=${JSON.stringify(visualExplorerSourceFormat)};${source}\nreturn canvasAgentSealWidgetGeometryEdit;})()`, {
    state,
    saveUserCanvasChange:() => saved.push("geometry-history"),
  });
  seal();
  assert.deepEqual(saved, ["geometry-history"]);
  assert.equal(state.widgetEdit.changed, false);
  assert.equal(JSON.stringify(state.widgetEdit.before), JSON.stringify({ x:100, y:200, w:900, h:600, contentW:900, contentH:600 }));
  assert.equal(state.widgetHistoryBefore, null);
});

test("re-entering the selected widget edit reopens geometry history without replacing the edit", () => {
  const widget = htmlWidget();
  const edit = {
    id:widget.id,
    before:{ x:widget.x, y:widget.y, w:widget.w, h:widget.h, contentW:widget.contentW, contentH:widget.contentH },
    changed:false,
  };
  const state = {
    selectedWidgetId:widget.id,
    widgetEdit:edit,
    widgetHistoryBefore:null,
    imageEdit:null,
  };
  let serializedCalls = 0;
  const source = [
    functionSource(canvasRuntimeSource, "recordWidgetsBefore"),
    functionSource(canvasRuntimeSource, "beginWidgetEdit"),
  ].join("\n");
  const begin = vm.runInNewContext(`(()=>{${source}\nreturn beginWidgetEdit;})()`, {
    state,
    serializedWidgets:() => {
      serializedCalls += 1;
      return "geometry-snapshot";
    },
  });
  assert.equal(begin(widget), true);
  assert.equal(state.selectedWidgetId, widget.id);
  assert.equal(state.widgetEdit, edit, "same-widget begin must preserve the active edit object");
  assert.equal(state.widgetHistoryBefore, "geometry-snapshot");
  assert.equal(serializedCalls, 1);
});
