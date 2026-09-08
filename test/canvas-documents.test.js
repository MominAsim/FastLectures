"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function clientFunction(file, name) {
  const source = fs.readFileSync(path.join(ROOT, "src/client/app", file), "utf8");
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function memoryDb(records, control) {
  return {
    transaction(_name, mode) {
      const tx = { error: null };
      tx.objectStore = () => ({
        getAll: () => ({ value: [...records.values()] }),
        put: value => {
          queueMicrotask(() => {
            if (control.persistFailures > 0) {
              control.persistFailures -= 1;
              tx.error = Error("simulated persistence failure");
              tx.onerror?.();
              return;
            }
            records.set(value.id, structuredClone(value));
            control.persistWrites += 1;
            tx.oncomplete?.();
          });
        },
        delete: id => {
          records.delete(id);
          queueMicrotask(() => tx.oncomplete?.());
          return { value: undefined };
        },
      });
      if (mode === "readonly") queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

function harness(options = {}) {
  const records = options.records || new Map();
  const control = { persistFailures: 0, persistWrites: 0, mounts: 0, frames: 0, renders: 0 };
  const state = {
    language: "en", theme: "light", userRevision: 1, snapshotSavedRevision: 0,
    currentSnapshotId: null, currentSnapshotLocation: null, currentSnapshotName: "Visible",
    currentSnapshotBundleExtensions: {
      penechoDocument: { version: 1, documentId: options.activeId || "visible-document", title: "Visible", bindings: [], locators: [], processor: { kind: "penecho" } },
    },
    currentSnapshotManifestExtensions: {}, currentSnapshotPreservedAssets: [],
    widgets: [], textBoxes: [], images: [], history: [], future: [], historyBefore: new Map(),
    nextWidgetId: 1, nextTextBoxId: 1, nextImageId: 1, scale: 1, panX: 0, panY: 0,
    inkColor: "#111", aiFont: "sans-serif", inkBounds: new Map(),
  };
  const listeners = {};
  const context = vm.createContext({
    SIZE: 32768, TILE: 512, MAX_HISTORY: 50, state, crypto: options.crypto || crypto.webcrypto,
    TextEncoder, TextDecoder, Blob, URL, structuredClone, queueMicrotask,
    AbortController, AbortSignal, setTimeout, clearTimeout, performance,
    document: { getElementById: () => null, querySelectorAll: () => [], hidden: false, createElement: () => ({}) },
    window: { PENECHO_CONFIG: {} }, location: { origin: "http://127.0.0.1" }, WebSocket: { OPEN: 1 },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    requestResult: async request => request.value,
    indexedDB: { open: () => { throw Error("unexpected IndexedDB open"); } },
    allSnapshots: async () => options.snapshots || [],
    fetch: async url => ({ ok: true, json: async () => ({ canvases: options.remote?.[String(url)] || [] }) }),
    authenticatedApiHeaders: () => ({}),
    readSnapshot: async (location, id) => options.saved?.get(`${location}:${id}`) || null,
    widgetRecord: value => ({ ...value }), widgetUsesHtmlCopySource: () => false,
    renderedTextBoxRecord: async value => ({ id: value.id || `text-box-${state.nextTextBoxId++}`, text: value.text, x: value.x || 0, y: value.y || 0, w: value.w || value.maxWidth || 240, h: value.h || 48 }),
    canvasAgentHash: async value => crypto.createHash("sha256").update(String(value)).digest("hex"),
    canvasAgentAssertToolExecution: () => {}, canvasAgentMutationIdle: () => {},
    canvasAgentObject: id => {
      const item = state.widgets.find(entry => entry.id === id) || state.textBoxes.find(entry => entry.id === id) || state.images.find(entry => entry.id === id);
      return item ? { kind: state.widgets.includes(item) ? "widget" : state.textBoxes.includes(item) ? "text" : "image", item } : null;
    },
    canvasAgentCreate: async args => {
      control.mounts += 1;
      const input = args.items[0], item = { id: `widget-${state.nextWidgetId++}`, ...input, x: input.placement?.x || 0, y: input.placement?.y || 0, w: input.width, h: input.height, contentW: input.width, contentH: input.height };
      state.widgets.push(item); state.userRevision += 1;
      return { receipts: [{ objectId: item.id }] };
    },
    canvasAgentReplaceWidget: async () => { throw Error("active replacement was not expected"); },
    canvasAgentEdit: async () => { throw Error("active edit was not expected"); },
    canvasAgentBox: object => ({ x: object.item.x, y: object.item.y, w: object.item.w, h: object.item.h }),
    canvasAgentAllObjects: () => state.widgets.map(item => ({ id: item.id, box: { x: item.x, y: item.y, w: item.w, h: item.h } })),
    canvasAgentContentBounds: () => null, canvasAgentPlacementBox: (w, h) => ({ x: 96, y: 96, w, h, crowded: false }),
    canvasAgentInternalRect: box => box, canvasAgentFramePlan: () => ({ scale: 1 }),
    canvasAgentFrameRegion: () => { control.frames += 1; }, canvasAgentViewFacts: () => ({}),
    canvasAgentSelectionIds: () => [], canvasAgentSyncState: () => {}, canvasAgentSyncAutomaticAIStatus: () => {},
    canvasAgentCanvasDidChange: () => {}, canvasAgentCapture: async () => { throw Error("capture was not expected"); },
    canvasAgentInput: { value: "" }, canvasAgent: { attachments: [], inkPresent: false }, canvasAgentResizeInput: () => {},
    visibleInkBounds: () => null, viewportRect: () => ({ x: 0, y: 0, w: 1200, h: 800 }),
    intersection: (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
    unionDirtyBounds: (a, b) => !a ? { ...b } : a, tiles: new Map(),
    save: () => {}, requestRender: () => { control.renders += 1; }, render: () => { control.renders += 1; },
    serializedWidgets: () => state.widgets.map(item => ({ ...item })), storedTextBoxes: () => state.textBoxes.map(item => ({ ...item })), storedImages: () => state.images.map(item => ({ ...item })), serializedAnimations: () => [],
    imageHistoryState: () => [], textBoxHistoryState: () => [], positionWidget: () => {}, unmountWidget: () => { control.mounts += 1; },
    snapshotExtensionObject: value => structuredClone(value || {}), snapshotPreservedAssets: value => structuredClone(value || []),
    finalizeCanvasForSnapshot: async () => {}, canvasBlob: async value => value, cloneCanvas: value => value,
    offscreen: () => ({ getContext: () => ({ drawImage: () => {}, clearRect: () => {} }) }),
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }), dataUrlBlob: () => new Blob([], { type: "image/png" }),
    writeClipboardText: async () => true, peButton: () => {}, requestWidgetSnapshot: () => { throw Error("snapshot was not expected"); },
    stopActiveAutomaticAI: () => {}, schedule: () => {}, clearTextEditors: () => {}, invalidateRecognition: () => {}, cancelPendingForRevision: () => {}, cancelSelection: () => {}, clearSharpOverlays: () => {},
    enableSnapshotWidgetPlugins: async () => {}, decodeSnapshotTilesInBatches: async () => new Map(), decodeSnapshotImagesInBatches: async () => [], releaseSnapshotTileCanvases: () => {},
    restoreAnimations: () => {},
    restoreWidgets: items => state.widgets.splice(0, state.widgets.length, ...items.map(item => ({ ...item }))),
    restoreImages: items => state.images.splice(0, state.images.length, ...items.map(item => ({ ...item }))),
    restoreTextBoxes: async items => state.textBoxes.splice(0, state.textBoxes.length, ...items.map(item => ({ ...item }))),
    applyTheme: () => {}, updateCoordinates: () => {}, setCanvasNavigationLocked: () => {},
    snapshotLoadInProgress: false, plotObjectImage: async () => { throw Error("plot was not expected"); }, mcpPlotView: () => ({}), mcpPrimitiveLayout: () => ({}), mcpPrimitiveRaster: () => ({}),
  });
  const scripts = ["document-identity.js", "mcp-runtime.js", "canvas-documents.js"]
    .map(file => fs.readFileSync(path.join(ROOT, "src/client/app", file), "utf8")).join("\n");
  vm.runInContext(`${clientFunction("core.js", "canvasClientId")}\n${["currentCanvasDisplayName","currentCanvasNeedsAgentName","applyCurrentCanvasGeneratedName"].map(name=>clientFunction("persistence.js",name)).join("\n")}\n${scripts}\nglobalThis.api={canvasDocumentIdentity,canvasDocuments,canvasDocumentsReady,canvasDocumentsCurrent,canvasDocumentsExternal,canvasDocumentsRecord,canvasDocumentsSaveMetadata,canvasDocumentsDidSave,canvasDocumentsExecute,canvasDocumentsQueueMessage,canvasDocumentsClose,mcpRuntime};`, context);
  context.api.canvasDocuments.db = memoryDb(records, control);
  return { ...context.api, context, control, records, state, listeners };
}

async function createHidden(h, requestId, title) {
  return h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", create: true, title, requestId, show: false }, {});
}

async function startHidden(h, documentId, sessionId, sessionKey = `${sessionId}-key`, client = "Codex") {
  return h.canvasDocumentsExecute("mcp_start_session", { sessionId, documentId, sessionKey, client, title: sessionId, slotIndex: 0, takeover: false }, {});
}

test("reading Agent availability before workspace initialization does not create a Canvas", () => {
  const h = harness({ crypto: {} });
  h.state.currentSnapshotBundleExtensions = {};
  assert.equal(h.canvasDocumentsExternal(), false);
  assert.equal(h.canvasDocuments.activeId, null);
  assert.equal(h.canvasDocuments.records.size, 0);
  vm.runInContext(`canvasDocuments = undefined;`, h.context);
  assert.equal(h.canvasDocumentsExternal(), false);
});

test("Canvas boot reaches theme paint and creates distinct documents without randomUUID", async () => {
  const h = harness({ crypto: { getRandomValues: crypto.webcrypto.getRandomValues.bind(crypto.webcrypto) } });
  h.state.currentSnapshotBundleExtensions = {};
  h.state.paint = { paper: "#ead9ad" };
  Object.assign(h.context, {
    canvasAgentSend: { setAttribute() {}, removeAttribute() {} },
    canvasAgentExecutionAvailable: () => true,
    getComputedStyle: () => ({ getPropertyValue: name => name === "--paper" ? "#ffffff" : "" }),
  });
  vm.runInContext(`${clientFunction("canvas-agent-runtime.js", "canvasAgentSyncSendAvailability")}
    ${clientFunction("core.js", "updatePaint")}
    canvasAgentSyncSendAvailability(); updatePaint();`, h.context);
  assert.equal(h.state.paint.paper, "#ffffff", "Agent controls must not stop the white theme from initializing");
  await h.canvasDocumentsReady();
  const current = h.canvasDocumentsCurrent();
  assert.match(current.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h.canvasDocumentsCurrent().id, current.id);
  const other = await createHidden(h, "no-uuid-create", "Another Canvas");
  assert.notEqual(other.documentId, current.id);
  assert.equal(h.canvasDocumentsExternal(), false);
  current.processor = { kind: "external", bindingKey: "test-key", client: "Test AI" };
  assert.equal(h.canvasDocumentsExternal(), true);
});

test("History closes only after an already-open Canvas has successfully activated", async () => {
  for (const location of ["device", "server", "cloud"]) {
    const h = harness();
    const events = [];
    let finish;
    Object.assign(h.context, {
      canvasDocuments: { activeId: "current", records: new Map([["qed", { id: "qed", locator: { id: "saved-qed", location } }]]) },
      canvasDocumentsShow: async id => { events.push(id); await new Promise(resolve => { finish = resolve; }); },
      closeHistoryPanel: () => events.push("closed"),
      setStatusKey: key => events.push(key),
    });
    vm.runInContext(`async ${clientFunction("persistence.js", "loadSnapshot")}`, h.context);
    const loading = h.context.loadSnapshot("saved-qed", location);
    assert.deepEqual(events, ["qed"], "Library stays visible while switching");
    finish();
    assert.equal(await loading, true);
    assert.deepEqual(events, ["qed", "closed", "snapshotLoaded"]);
    events.length = 0;
    h.context.canvasDocumentsShow = async () => { throw Error("Canvas is busy"); };
    await assert.rejects(h.context.loadSnapshot("saved-qed", location), /Canvas is busy/);
    assert.deepEqual(events, [], "failed activation keeps Library open without a success status");
  }
});

test("History loads legacy canvases without Web Crypto and permits retry after a read failure", async () => {
  for (const location of ["device", "server", "cloud"]) {
    const item = {
      id: "旧画布-1", name: "QED 板书视觉分析", version: 2, theme: "studio",
      widgets: [{ id: "widget-1", html: "<p>Preserved lesson</p>", x: 100, y: 200, w: 640, h: 400 }],
      textBoxes: [{ id: "text-box-1", text: "原有笔记", x: 800, y: 200, w: 200, h: 60 }],
      images: [], animations: [], bundleExtensions: {}, manifestExtensions: {}, preservedAssets: [],
    };
    const original = JSON.stringify(item), saved = new Map([[`${location}:${item.id}`, { item, tileEntries: [] }]]);
    const h = harness({ saved, crypto: { getRandomValues: crypto.webcrypto.getRandomValues.bind(crypto.webcrypto) } });
    h.state.snapshotLoadGeneration = 0;
    let closed = false, status = null;
    Object.assign(h.context, {
      snapshotItems: [item], snapshotLoadingId: null, snapshotName: value => value.name,
      t: key => key, updateHistoryReadControls() {}, setHistoryActivity() {},
      refreshVisibleTextBoxQuality() {}, closeHistoryPanel() { closed = true; },
      setStatusKey(key) { status = key; },
    });
    vm.runInContext(`async ${clientFunction("persistence.js", "loadSnapshot")}`, h.context);
    const read = h.context.readSnapshot;
    h.context.readSnapshot = async () => { throw Error("simulated read failure"); };
    await assert.rejects(h.context.loadSnapshot(item.id, location), /simulated read failure/);
    assert.equal(h.context.snapshotLoadInProgress, false, "the failed attempt releases the load lock");
    h.context.readSnapshot = read;
    assert.equal(await h.context.loadSnapshot(item.id, location), true);
    const expected = `legacy-${crypto.createHash("sha256").update(JSON.stringify({ location, scope: "", id: item.id })).digest("hex")}`;
    assert.equal(h.canvasDocumentsCurrent().id, expected);
    assert.equal(h.state.currentSnapshotBundleExtensions.penechoDocument.documentId, expected);
    assert.equal(h.state.widgets[0].html, item.widgets[0].html);
    assert.equal(h.state.textBoxes[0].text, item.textBoxes[0].text);
    assert.equal(h.state.currentSnapshotLocation, location);
    assert.equal(status, "snapshotLoaded");
    assert.equal(closed, true);
    assert.equal(h.context.snapshotLoadInProgress, false);
    assert.equal(JSON.stringify(item), original, "loading does not rewrite the saved bundle");
  }
});

test("MCP finds legacy canvases in every store without misreporting missing Web Crypto as unavailable storage", async () => {
  const h = harness({
    crypto: { getRandomValues: crypto.webcrypto.getRandomValues.bind(crypto.webcrypto) },
    snapshots: [{ id: "device-old", name: "Device lesson" }],
    remote: {
      "/api/canvases?metadataOnly=1": [{ id: "server-old", name: "Server lesson" }],
      "/api/cloud/library": [{ id: "cloud-old", name: "Cloud lesson" }],
    },
  });
  const found = await h.canvasDocumentsExecute("mcp_find_canvases", {}, {});
  for (const location of ["device", "server", "cloud"]) {
    assert.equal(found.providers.find(provider => provider.location === location).status, "ok");
    const expected = `legacy-${crypto.createHash("sha256").update(JSON.stringify({ location, scope: "", id: `${location}-old` })).digest("hex")}`;
    assert.equal(found.canvases.find(canvas => canvas.locator?.location === location).documentId, expected);
  }
});

test("two documents route hidden sessions without changing or mounting the visible Canvas", async () => {
  const h = harness(), initial = h.canvasDocumentsCurrent().id;
  const one = await createHidden(h, "create-one", "One");
  const two = await createHidden(h, "create-two", "Two");
  assert.notEqual(one.documentId, two.documentId);
  const session = await startHidden(h, two.documentId, "hidden-session");
  assert.equal(session.documentId, two.documentId);
  assert.equal(session.active, false);
  assert.equal(session.boardObjectId, null);
  assert.equal(h.canvasDocuments.records.get(two.documentId).stored.item.widgets.length, 0);
  assert.equal(h.canvasDocuments.activeId, initial);
  assert.equal(h.control.mounts, 0);
  assert.equal(h.control.frames, 0);
  await assert.rejects(
    h.canvasDocumentsExecute("mcp_capture_canvas", { sessionId: "hidden-session", target: "viewport", quality: "basic" }, {}),
    error => error.code === "CANVAS_NOT_VISIBLE" && error.details.documentId === two.documentId && error.details.retryable === true,
  );

  const first = await h.canvasDocumentsExecute("mcp_present_widget", { sessionId: "hidden-session", artifactId: "report", title: "Report", html: "<p>first</p>" }, {});
  const second = await h.canvasDocumentsExecute("mcp_present_widget", { sessionId: "hidden-session", artifactId: "report", title: "Report", html: "<p>second</p>" }, {});
  assert.equal(second.objectId, first.objectId);
  const doc = h.canvasDocuments.records.get(two.documentId);
  assert.equal(doc.stored.item.widgets.filter(item => item.id === first.objectId).length, 1);
  assert.equal(doc.stored.item.widgets.find(item => item.id === first.objectId).html, "<p>second</p>");
  assert.equal(h.canvasDocuments.activeId, initial);
  assert.equal(h.control.mounts, 0);
  assert.equal(h.control.frames, 0);
});

test("virtual source edits preserve geometry, reject stale hashes, and recover mutation retries after persistence failure", async () => {
  const h = harness(), opened = await createHidden(h, "create-files", "Files");
  await startHidden(h, opened.documentId, "files-session");
  const shown = await h.canvasDocumentsExecute("mcp_present_widget", { sessionId: "files-session", artifactId: "artifact", title: "Artifact", html: "<p>old</p>" }, {});
  const pathName = `objects/${shown.objectId}/widget.html`;
  const listing = await h.canvasDocumentsExecute("mcp_list_files", { sessionId: "files-session", path: `objects/${shown.objectId}` }, {});
  assert.ok(listing.entries.some(entry => entry.path === pathName));
  const read = await h.canvasDocumentsExecute("mcp_read_file", { sessionId: "files-session", path: pathName }, {});
  assert.equal(read.content, "<p>old</p>");
  const doc = h.canvasDocuments.records.get(opened.documentId), widget = doc.stored.item.widgets.find(item => item.id === shown.objectId);
  const geometry = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };

  await assert.rejects(
    h.canvasDocumentsExecute("mcp_apply_patch", { sessionId: "files-session", path: pathName, content: "<p>stale</p>", expectedHash: "stale", requestId: "stale-patch" }, {}),
    error => error.code === "SOURCE_CONFLICT" && error.details.currentHash === read.contentHash,
  );
  assert.equal(widget.html, "<p>old</p>");

  const prepared = await h.canvasDocumentsExecute("mcp_prepare_patch", { sessionId: "files-session", path: pathName, expectedHash: read.contentHash, requestId: "source-patch" }, {});
  assert.equal(prepared.content, "<p>old</p>");
  h.control.persistFailures = 1;
  const applyArgs = { sessionId: "files-session", path: pathName, content: "<p>new</p>", expectedHash: read.contentHash, requestId: "source-patch" };
  await assert.rejects(h.canvasDocumentsExecute("mcp_apply_patch", applyArgs, {}), /simulated persistence failure/);
  const revisionAfterMutation = doc.revision;
  const retry = await h.canvasDocumentsExecute("mcp_apply_patch", applyArgs, {});
  assert.equal(retry.applied, true);
  assert.equal(doc.revision, revisionAfterMutation);
  assert.equal(widget.html, "<p>new</p>");
  assert.deepEqual({ x: widget.x, y: widget.y, w: widget.w, h: widget.h }, geometry);
  const recovered = await h.canvasDocumentsExecute("mcp_prepare_patch", { sessionId: "files-session", path: pathName, expectedHash: read.contentHash, requestId: "source-patch" }, {});
  assert.equal(recovered.alreadyApplied, true);
  assert.equal(recovered.result.contentHash, retry.contentHash);
});

test("existing-content edits require the current document revision", async () => {
  const h = harness(), opened = await createHidden(h, "create-edit", "Edit");
  await startHidden(h, opened.documentId, "edit-session");
  const created = await h.canvasDocumentsExecute("mcp_present_widget", { sessionId: "edit-session", artifactId: "move-target", title: "Move target", html: "<p>Move me</p>" }, {});
  const doc = h.canvasDocuments.records.get(opened.documentId);
  await assert.rejects(
    h.canvasDocumentsExecute("mcp_edit_canvas", { sessionId: "edit-session", action: "move", objectId: created.objectId, region: { x: 1200, y: 1200, w: 840, h: 600 }, requestId: "move-no-revision" }, {}),
    error => error.code === "REVISION_CONFLICT",
  );
  const moved = await h.canvasDocumentsExecute("mcp_edit_canvas", { sessionId: "edit-session", action: "move", objectId: created.objectId, region: { x: 1200, y: 1200, w: 840, h: 600 }, baseRevision: doc.revision, requestId: "move-current" }, {});
  assert.equal(moved.applied, true);
  assert.equal(doc.stored.item.widgets.find(item => item.id === created.objectId).x, 1200);
});

test("pull inbox is isolated by client and key, reading does not acknowledge, and cancellation is final", async () => {
  const h = harness(), opened = await createHidden(h, "create-inbox", "Inbox");
  await startHidden(h, opened.documentId, "session-a", "key-a", "Codex");
  await startHidden(h, opened.documentId, "session-b", "key-b", "Claude");
  const doc = h.canvasDocuments.records.get(opened.documentId);
  doc.messageSequence = 3;
  doc.messages.push(
    { id: "a-queued", cursor: 1, bindingKey: "key-a", client: "Codex", text: "A", status: "queued" },
    { id: "b-queued", cursor: 2, bindingKey: "key-b", client: "Claude", text: "B", status: "queued" },
    { id: "a-cancelled", cursor: 3, bindingKey: "key-a", client: "Codex", text: "Stop", status: "cancelled" },
  );
  const read = await h.canvasDocumentsExecute("mcp_read_messages", { sessionId: "session-a", after: 0, limit: 20 }, {});
  assert.equal(read.entries.map(entry => entry.id).join(","), "a-queued,a-cancelled");
  assert.equal(doc.messages[0].status, "queued");
  assert.match(read.delivery, /does not acknowledge/);
  await assert.rejects(
    h.canvasDocumentsExecute("mcp_ack_messages", { sessionId: "session-a", ids: ["b-queued"], status: "received", requestId: "wrong-owner" }, {}),
    error => error.code === "MESSAGE_NOT_FOUND",
  );
  await assert.rejects(
    h.canvasDocumentsExecute("mcp_ack_messages", { sessionId: "session-a", ids: ["a-cancelled"], status: "working", requestId: "cancelled" }, {}),
    error => error.code === "MESSAGE_CANCELLED",
  );
  assert.equal(doc.messages[2].status, "cancelled");
});

test("persisted conversation bindings reopen the same document and artifact identity", async () => {
  const records = new Map(), first = harness({ records });
  const opened = await createHidden(first, "create-persisted", "Persisted");
  const original = await startHidden(first, opened.documentId, "old-session", "conversation-key", "Codex");
  assert.equal(original.boardObjectId, null);
  const originalArtifact = await first.canvasDocumentsExecute("mcp_present_widget", { sessionId: "old-session", artifactId: "persisted-artifact", title: "Persisted artifact", html: "<p>Retained artifact</p>", presentation: { intent: "compare", role: "supporting", size: "wide", attention: "quiet" } }, {});
  assert.ok(records.has(opened.documentId));

  const second = harness({ records, activeId: "another-visible-document" });
  const reopened = await startHidden(second, opened.documentId, "new-session", "conversation-key", "Codex");
  assert.equal(reopened.documentId, opened.documentId);
  assert.equal(reopened.boardObjectId, null);
  const inspected = await second.canvasDocumentsExecute("mcp_inspect_session", { sessionId: "new-session" }, {});
  const persistedArtifact = inspected.artifacts.find(artifact => artifact.artifactId === "persisted-artifact");
  assert.equal(persistedArtifact.objectId, originalArtifact.objectId);
  assert.equal(JSON.stringify(persistedArtifact.presentation), JSON.stringify(originalArtifact.presentation));
  assert.equal(second.canvasDocuments.activeId, "another-visible-document");
});

test("unseen background updates survive reload and clear persistently when shown", async () => {
  const records = new Map(), first = harness({ records });
  const opened = await createHidden(first, "unseen-persist", "Unread");
  await startHidden(first, opened.documentId, "unseen-session");
  await first.canvasDocumentsExecute("mcp_present_widget", { sessionId: "unseen-session", artifactId: "unseen-artifact", title: "Unread artifact", html: "<p>New content</p>" }, {});
  const firstDoc = first.canvasDocuments.records.get(opened.documentId), unseen = firstDoc.unseen;
  assert.ok(unseen > 0);
  assert.equal(records.get(opened.documentId).unseen, unseen);

  const second = harness({ records, activeId: "reload-visible-document" });
  await second.canvasDocumentsReady();
  const reloaded = second.canvasDocuments.records.get(opened.documentId);
  assert.equal(reloaded.unseen, unseen);

  await second.canvasDocumentsExecute("mcp_open_canvas", { documentId: opened.documentId, requestId: "unseen-show", show: true }, {});
  assert.equal(reloaded.unseen, 0);
  assert.equal(records.get(opened.documentId).unseen, 0);

  const third = harness({ records, activeId: "clear-visible-document" });
  await third.canvasDocumentsReady();
  assert.equal(third.canvasDocuments.records.get(opened.documentId).unseen, 0);
});

test("invalid persisted unseen values reset to zero", async () => {
  const records = new Map(), first = harness({ records });
  const opened = await createHidden(first, "unseen-invalid", "Invalid");
  const persisted = records.get(opened.documentId);
  persisted.unseen = -1;
  const negative = harness({ records, activeId: "negative-visible-document" });
  await negative.canvasDocumentsReady();
  assert.equal(negative.canvasDocuments.records.get(opened.documentId).unseen, 0);

  persisted.unseen = Number.MAX_SAFE_INTEGER + 1;
  const oversized = harness({ records, activeId: "oversized-visible-document" });
  await oversized.canvasDocumentsReady();
  assert.equal(oversized.canvasDocuments.records.get(opened.documentId).unseen, 0);
});

test("blank Canvas defaults to the first conversation, separates a new key, and reconnects each key to its document", async () => {
  const h = harness(), visibleId = h.canvasDocumentsCurrent().id;
  const first = await h.canvasDocumentsExecute("mcp_start_session", { sessionId: "first", sessionKey: "key-one", client: "Codex", title: "First", slotIndex: 0, takeover: false }, {});
  assert.equal(first.documentId, visibleId);
  assert.equal(first.active, true);

  const second = await h.canvasDocumentsExecute("mcp_start_session", { sessionId: "second", sessionKey: "key-two", client: "Codex", title: "Second", slotIndex: 1, takeover: false }, {});
  assert.notEqual(second.documentId, visibleId);
  assert.equal(second.active, false);
  assert.equal(h.canvasDocuments.activeId, visibleId);

  const secondReconnect = await h.canvasDocumentsExecute("mcp_start_session", { sessionId: "second-reconnect", sessionKey: "key-two", client: "Codex", title: "Second again", slotIndex: 2, takeover: false }, {});
  const firstReconnect = await h.canvasDocumentsExecute("mcp_start_session", { sessionId: "first-reconnect", sessionKey: "key-one", client: "Codex", title: "First again", slotIndex: 3, takeover: false }, {});
  assert.equal(secondReconnect.documentId, second.documentId);
  assert.equal(firstReconnect.documentId, first.documentId);
  assert.equal(h.canvasDocuments.records.size, 2);
});

test("Save as creates independent identity while retaining source and separating conversation bindings", async () => {
  const h = harness(), original = h.canvasDocumentsCurrent(), originalId = original.id;
  h.state.widgets.push({ id: "widget-5", title: "Source", widgetType: "html_widget", pluginId: "general", html: "<p>retained source</p>", x: 100, y: 100, w: 640, h: 400, contentW: 640, contentH: 400 });
  await h.canvasDocumentsExecute("mcp_start_session", { sessionId: "original-session", documentId: originalId, sessionKey: "original-key", client: "Codex", title: "Original", slotIndex: 0, takeover: false }, {});
  assert.equal(original.bindings[0].key, "original-key");

  const bundleExtensions = h.canvasDocumentsSaveMetadata({ copy: true }), copiedId = bundleExtensions.penechoDocument.documentId;
  assert.notEqual(copiedId, originalId);
  assert.equal(bundleExtensions.penechoDocument.bindings.length, 0);
  const item = {
    version: 2, name: "Independent copy", theme: "light", view: { scale: 1, panX: 0, panY: 0, navigationLocked: false },
    widgets: h.state.widgets.map(widget => ({ ...widget })), textBoxes: [], images: [], animations: [],
    bundleExtensions, manifestExtensions: {}, preservedAssets: [],
  };
  await h.canvasDocumentsDidSave(item, "device", "saved-copy", []);

  const copied = h.canvasDocuments.records.get(copiedId), parkedOriginal = h.canvasDocuments.records.get(originalId);
  assert.equal(h.canvasDocuments.activeId, copiedId);
  assert.equal(copied.locator.location, "device");
  assert.equal(copied.locator.id, "saved-copy");
  assert.equal(h.state.widgets.find(widget => widget.id === "widget-5").html, "<p>retained source</p>");
  assert.equal(parkedOriginal.stored.item.widgets.find(widget => widget.id === "widget-5").html, "<p>retained source</p>");
  assert.equal(parkedOriginal.bindings[0].key, "original-key");
  assert.equal(copied.bindings.length, 0);

  await h.canvasDocumentsExecute("mcp_start_session", { sessionId: "copy-session", documentId: copiedId, sessionKey: "copy-key", client: "Codex", title: "Copy", slotIndex: 1, takeover: false }, {});
  assert.equal(copied.bindings[0].key, "copy-key");
  assert.equal(parkedOriginal.bindings.some(binding => binding.key === "copy-key"), false);
  assert.equal(h.state.currentSnapshotBundleExtensions.penechoDocument.documentId, copiedId);
});

test("open distinguishes an exact locator from ambiguous IDs and unavailable storage", async () => {
  const metadata = documentId => ({ penechoDocument: { version: 1, documentId, title: documentId, bindings: [], locators: [], processor: { kind: "penecho" } } });
  const snapshots = [
    { id: "copy-a", name: "A", bundleExtensions: metadata("shared-document") },
    { id: "copy-b", name: "B", bundleExtensions: metadata("shared-document") },
  ];
  const saved = new Map([["device:copy-a", { item: { name: "A", widgets: [], textBoxes: [], images: [], animations: [], bundleExtensions: metadata("shared-document") }, tileEntries: [] }]]);
  const h = harness({ snapshots, saved });
  await assert.rejects(
    h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", documentId: "shared-document", requestId: "ambiguous", show: false }, {}),
    error => error.code === "DOCUMENT_AMBIGUOUS" && error.details.status === "ambiguous" && error.details.candidates.length === 2,
  );
  const exact = await h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", documentId: "shared-document", locator: { location: "device", id: "copy-a" }, requestId: "exact", show: false }, {});
  assert.equal(exact.documentId, "shared-document");
  assert.equal(exact.locator.id, "copy-a");

  const unavailable = h.canvasDocumentIdentity.resolveCandidates({ documentId: "missing", candidates: [], providers: [{ location: "cloud", status: "offline", retryable: true }] });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.retryable, true);
});

test("legacy and identified saved copies keep independent content across visible switches", async () => {
  const identifiedId = "identified-document";
  const extension = { penechoDocument: { version: 1, documentId: identifiedId, title: "Identified", bindings: [], locators: [], processor: { kind: "penecho" } } };
  const stored = (name, html, bundleExtensions = {}) => ({
    item: {
      version: 2, name, theme: "light", view: { scale: 1, panX: 0, panY: 0, navigationLocked: false },
      widgets: [{ id: "widget-1", title: name, widgetType: "html_widget", pluginId: "general", html, x: 100, y: 100, w: 640, h: 400, contentW: 640, contentH: 400 }],
      textBoxes: [], images: [], animations: [], bundleExtensions, manifestExtensions: {}, preservedAssets: [],
    },
    tileEntries: [],
  });
  const saved = new Map([
    ["device:legacy-copy", stored("Legacy", "<p>legacy content</p>")],
    ["device:identified-copy", stored("Identified", "<p>identified content</p>", extension)],
  ]);
  const h = harness({ saved });
  const legacy = await h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", locator: { location: "device", id: "legacy-copy" }, requestId: "open-legacy", show: false }, {});
  const identified = await h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", documentId: identifiedId, locator: { location: "device", id: "identified-copy" }, requestId: "open-identified", show: false }, {});
  assert.match(legacy.documentId, /^legacy-[0-9a-f]{64}$/);
  assert.equal(identified.documentId, identifiedId);

  await h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", documentId: legacy.documentId, requestId: "show-legacy", show: true }, {});
  assert.equal(h.state.widgets[0].html, "<p>legacy content</p>");
  h.state.widgets[0].html = "<p>legacy edited</p>";
  h.state.userRevision += 1;

  await h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", documentId: identifiedId, requestId: "show-identified", show: true }, {});
  assert.equal(h.state.widgets[0].html, "<p>identified content</p>");
  assert.equal(h.canvasDocuments.records.get(legacy.documentId).stored.item.widgets[0].html, "<p>legacy edited</p>");

  await h.canvasDocumentsExecute("mcp_open_canvas", { instanceId: "instance", canvasId: "bridge", documentId: legacy.documentId, requestId: "show-legacy-again", show: true }, {});
  assert.equal(h.state.widgets[0].html, "<p>legacy edited</p>");
  assert.equal(h.canvasDocuments.records.get(identifiedId).stored.item.widgets[0].html, "<p>identified content</p>");
});

test("showing an updated Canvas acknowledges only that document", async () => {
  const h=harness();
  const one=await createHidden(h,"unread-one","One"),two=await createHidden(h,"unread-two","Two");
  await startHidden(h,one.documentId,"unread-session-one");
  await startHidden(h,two.documentId,"unread-session-two");
  await h.canvasDocumentsExecute("mcp_present_widget",{sessionId:"unread-session-one",artifactId:"unread-artifact-one",title:"Unread one",html:"<p>One update</p>"},{});
  await h.canvasDocumentsExecute("mcp_present_widget",{sessionId:"unread-session-two",artifactId:"unread-artifact-two",title:"Unread two",html:"<p>Two update</p>"},{});
  const first=h.canvasDocuments.records.get(one.documentId),second=h.canvasDocuments.records.get(two.documentId);
  assert.ok(first.unseen>0);assert.ok(second.unseen>0);
  await h.canvasDocumentsExecute("mcp_open_canvas",{documentId:one.documentId,requestId:"read-one",show:true},{});
  assert.equal(first.unseen,0);assert.ok(second.unseen>0);
});


test("closing a Canvas does not block on inbox and revokes its session", async () => {
  const h = harness();
  await h.canvasDocumentsReady();
  const original = h.canvasDocumentsCurrent();
  original.messages.push({id:"pending",status:"queued"});
  h.mcpRuntime.sessions.set("closed-session",{sessionId:"closed-session",documentId:original.id,artifacts:new Map(),steps:[],events:[]});
  assert.equal(await h.canvasDocumentsClose(original.id),true);
  assert.equal(h.canvasDocuments.records.has(original.id),false);
  assert.equal(h.canvasDocuments.records.size,1,"last Canvas is replaced with a usable blank Canvas");
  assert.equal(h.mcpRuntime.sessions.get("closed-session").closed,true);
  await assert.rejects(h.canvasDocumentsExecute("mcp_update_session",{sessionId:"closed-session",summary:"late"},{}),{code:"SESSION_EXPIRED"});
  assert.equal(h.state.widgets.length,0);
});

test("failed close preserves the original Canvas and its session", async () => {
  const h = harness();await h.canvasDocumentsReady();const original=h.canvasDocumentsCurrent();
  h.mcpRuntime.sessions.set("working-session",{sessionId:"working-session",documentId:original.id,artifacts:new Map(),steps:[],events:[]});
  h.control.persistFailures=1;
  await assert.rejects(h.canvasDocumentsClose(original.id),/simulated persistence failure/);
  assert.equal(h.canvasDocuments.activeId,original.id);
  assert.equal(h.canvasDocuments.records.size,1);
  assert.notEqual(h.mcpRuntime.sessions.get("working-session").closed,true);
});


test("session titles name only untitled unsaved documents and survive reconnect", async () => {
  const h=harness();const doc=h.canvasDocumentsCurrent();doc.title="Untitled Canvas";
  h.state.currentSnapshotName="";h.state.currentSnapshotHasExplicitName=false;
  await h.canvasDocumentsExecute("mcp_start_session",{sessionId:"named",sessionKey:"name-key",client:"Codex",title:"  Research   map  ",slotIndex:0},{});
  assert.equal(doc.title,"Research map");assert.equal(h.state.currentCanvasSuggestedName,"Research map");
  await h.canvasDocumentsExecute("mcp_start_session",{sessionId:"renamed",sessionKey:"name-key",client:"Codex",title:"Other title",slotIndex:0},{});
  assert.equal(doc.title,"Research map");
  const saved=await createHidden(h,"saved-name","Untitled Canvas"),savedDoc=h.canvasDocuments.records.get(saved.documentId);
  savedDoc.locator={location:"device",id:"saved"};
  await startHidden(h,saved.documentId,"Must not rename");assert.equal(savedDoc.title,"Untitled Canvas");
  const explicit=await createHidden(h,"explicit-name","My chosen name");
  await startHidden(h,explicit.documentId,"Different name");assert.equal(h.canvasDocuments.records.get(explicit.documentId).title,"My chosen name");
});


test("closing after Save as removes both workspace handles but preserves unrelated documents", async () => {
  const h=harness();await h.canvasDocumentsReady();const original=h.canvasDocumentsCurrent();
  const copy=await createHidden(h,"close-copy","Copy"),copyDoc=h.canvasDocuments.records.get(copy.documentId);
  // A successful Save as makes its new identity active before the close transition.
  h.canvasDocuments.activeId=copyDoc.id;
  await h.canvasDocumentsClose(copyDoc.id,original.id);
  assert.equal(h.canvasDocuments.records.has(copyDoc.id),false);
  assert.equal(h.canvasDocuments.records.has(original.id),false);
  assert.equal(h.canvasDocuments.records.size,1);
});
