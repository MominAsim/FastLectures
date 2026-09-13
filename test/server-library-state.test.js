"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../src/client/app/persistence.js"), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0);
  const rest = source.slice(start + 1);
  const end = rest.search(/^  (?:async )?function /m);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}
function harness(code, previous = "server") {
  const rendered = [], activity = [];
  const context = {
    state:{ snapshotLocation:"server" }, snapshotListGeneration:0, snapshotItemsLocation:previous,
    snapshotItems:[{id:"old"}], cloudHistoryCache:null, snapshotListInProgress:false,
    serverSnapshotUnavailableKey:"", serverCanvasProjects:[{id:"old"}],
    snapshotsAt:async () => { if (code) throw Object.assign(Error(code), {code}); return []; },
    renderSnapshotListLoading:() => rendered.push("loading"),
    renderSnapshotList:() => rendered.push(context.serverSnapshotUnavailableKey || "empty"),
    setHistoryActivity:() => activity.push("loading"), hideHistoryActivity:() => activity.push("hidden"),
    updateHistoryReadControls:() => {}, t:key => key, snapshotLocationLabel:value => value,
  };
  vm.createContext(context);
  vm.runInContext(extract("refreshSnapshots"), context);
  return {context, rendered, activity};
}
for (const code of ["device_offline", "linked_device_required"]) {
  for (const previous of ["server", "cloud", null]) {
    test(`${code} replaces ${previous} results and ends loading without an action`, async () => {
      const {context, rendered, activity} = harness(code, previous);
      assert.equal(await context.refreshSnapshots(), false);
      assert.equal(context.serverSnapshotUnavailableKey, code === "device_offline" ? "serverHistoryDeviceOffline" : "serverHistoryDeviceRequired");
      assert.equal(rendered.at(-1), context.serverSnapshotUnavailableKey);
      assert.equal(context.snapshotItems.length, 0);
      assert.equal(context.serverCanvasProjects.length, 0);
      assert.equal(context.snapshotListInProgress, false);
      assert.equal(activity.at(-1), "hidden");
    });
  }
}
test("successful empty Server read clears an earlier connection notice", async () => {
  const {context, rendered} = harness(null);
  context.serverSnapshotUnavailableKey = "serverHistoryDeviceOffline";
  assert.equal(await context.refreshSnapshots(), true);
  assert.equal(context.serverSnapshotUnavailableKey, "");
  assert.equal(rendered.at(-1), "empty");
});
test("connection notice renders one localized message and a working retry control", async () => {
  const list = {querySelector:()=>null, replaceChildren(...items) { this.children = items; }};
  let retries = 0;
  const context = {
    state:{snapshotLocation:"server"}, serverSnapshotUnavailableKey:"serverHistoryDeviceOffline",
    document:{querySelector:() => list, createElement:tag => ({tag,setAttribute(){},append(...nodes){this.children=nodes;}})},
    renderServerProjectUi(){}, updateHistoryLibrarySummary(){}, peButton(){}, snapshotListInProgress:false, refreshSnapshots:async()=>{retries++;},
    cancelHistoryListRender(){}, releaseHistoryPreviewUrls(){}, updateHistorySelectionUi(){}, window:{},
    t:key => key, snapshotLocationLabel:value => value,
  };
  vm.createContext(context);
  vm.runInContext(extract("renderSnapshotListError"), context);
  context.renderSnapshotListError();
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].tag, "div");
  const [title, detail, retry] = list.children[0].children[0].children;
  assert.equal(detail.textContent, "serverHistoryDeviceOffline");
  assert.equal(title.textContent, "snapshotLibraryUnavailable");
  retry.onclick();
  assert.equal(retries, 1);
  assert.equal(retry.disabled, true);
});
test("list rerender preserves the connection notice while the refresh is settling", () => {
  let shown = "";
  const context = {
    state:{snapshotLocation:"server"}, snapshotItems:[], snapshotItemsLocation:null,
    snapshotListInProgress:true, snapshotListFailedLocation:null, serverSnapshotUnavailableKey:"serverHistoryDeviceOffline",
    document:{querySelector:selector => selector === "#historyPanel" ? {classList:{contains:() => true}} : {}},
    snapshotItemsForCurrentView:() => [], historySearchQuery:() => "", historySortItems:items => items,
    cancelHistoryListRender(){}, renderServerProjectUi(){}, updateHistoryLibrarySummary(){},
    renderSnapshotListError:() => {shown = "offline";}, renderSnapshotListLoading:() => {shown = "loading";},
  };
  vm.createContext(context);
  vm.runInContext(extract("renderSnapshotList"), context);
  context.renderSnapshotList();
  assert.equal(shown, "offline");
});

test("gateway failure replaces the old location with one error and hides loading", async () => {
  const {context,rendered,activity} = harness("gateway_error", "cloud");
  context.renderSnapshotListError=(location,retained)=>rendered.push({location,retained});
  await assert.rejects(context.refreshSnapshots(), /gateway_error/);
  assert.deepEqual(rendered.at(-1), {location:"server",retained:false});
  assert.equal(context.snapshotItems.length,0);
  assert.equal(context.snapshotListInProgress,false);
  assert.equal(activity.at(-1),"hidden");
  assert.equal(activity.filter(x=>x==="loading").length,1);
});
