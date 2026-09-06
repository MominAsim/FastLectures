"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { widgetSourceHash } = require("../src/server/widget-patch.js");

const OLD_HTML = "<!doctype html>\n<main>\n  <h1>Old</h1>\n</main>\n";
const NEW_HTML = "<!doctype html>\n<main>\n  <h1>New</h1>\n</main>\n";
const PATCH = "--- a/widget.html\n+++ b/widget.html\n@@ -1,4 +1,4 @@\n <!doctype html>\n <main>\n-  <h1>Old</h1>\n+  <h1>New</h1>\n </main>\n";

function widgetEdit(overrides = {}) {
  return {
    mode:"replace",
    widgetType:"html_widget",
    pluginId:"general",
    title:"Existing Widget",
    instructionMode:"implicit-polish",
    box:{x:100,y:200,w:1200,h:700},
    refreshSeconds:0,
    html:OLD_HTML,
    sourceFormat:"penecho-visual-explorer+html",
    frameworkVersion:"penecho-visual-explorer/1",
    source:OLD_HTML,
    sourceMirrorsHtml:true,
    copyLabel:"",
    ...overrides,
  };
}

async function sourcePatchRuntime(current, rpcCalls) {
  const { createCanvasAgentNativeRuntime, freshCanvasAgentTurnBudget, freshVisualExplorerBudget } = await import("../src/server/canvas-agent/runtime.mjs");
  const visualExplorerBudget=freshVisualExplorerBudget();
  visualExplorerBudget.objectIds.add("widget-1");
  visualExplorerBudget.deliveryModes.set("widget-1","oneShot");
  const session={
    projectRuntimeDirectory:path.join(os.tmpdir(),"penecho-source-patch-test"),
    widgetCapabilities:{fingerprint:"test",professionalEnabled:false,privatePlugins:[]},
    generalHtmlContract:{hash:"a".repeat(64),document:"general"},
    professionalDiagramsContract:null,
    visualExplorerContract:{hash:"b".repeat(64),document:"visual"},
    visualSkillContracts:{},
    widgetContractsLoaded:new Set(),
    visualSkillsLoaded:new Set(),
    nextWidgetContractOrder:500,
    webSearch:{enabled:false},
    canvasTurnBudget:freshCanvasAgentTurnBudget(),
    canvasAgentTurnLimit:100,
    visualExplorerBudget,
    widgetPatchAttempts:new Map(),
    canvasLayoutReviewRequired:true,
    stateDigest:{revision:99,counts:{widgets:1},canvas:{contentBounds:{x:0,y:0,width:1200,height:700}}},
  };
  session.rpc=async(name,args)=>{
    rpcCalls.push({name,args});
    if(name==="canvas_internal_widget")return current;
    if(name==="canvas_internal_replace_widget")return {ok:true,revision:100,changeId:"source-change",sourceHash:"browser-authoritative-new-source"};
    throw new Error(`Unexpected browser tool ${name}`);
  };
  const runtime=await createCanvasAgentNativeRuntime({attachments:{saveImages:async()=>[]},session});
  return {runtime,session};
}

test("sourceHash dispatch preserves geometry, bypasses visual review, and returns bounded source receipts",async()=>{
  const edit=widgetEdit(), sourceHash=widgetSourceHash(edit), rpcCalls=[], {runtime}=await sourcePatchRuntime({
    revision:99,
    hash:"legacy-widget-hash",
    sourceHash,
    widgetEdit:edit,
  },rpcCalls);
  const result=await runtime.tool("canvas_patch_widget").execute({objectId:"widget-1",sourceHash,patch:PATCH},{callId:"source-patch",signal:new AbortController().signal});
  assert.deepEqual(rpcCalls.map(call=>call.name),["canvas_internal_widget","canvas_internal_replace_widget"]);
  const write=rpcCalls[1].args;
  assert.equal(write.expectedSourceHash,sourceHash);
  assert.equal(Object.hasOwn(write,"baseRevision"),false);
  assert.equal(Object.hasOwn(write,"expectedHash"),false);
  assert.deepEqual({x:write.command.x,y:write.command.y,w:write.command.w,h:write.command.h},edit.box);
  assert.equal(write.command.html,NEW_HTML);
  assert.deepEqual(result.changedResources,["widget.html"]);
  assert.deepEqual(result.appliedRanges,[{path:"widget.html",oldStart:1,oldLines:4,newStart:1,newLines:4}]);
  assert.equal(result.afterWindows.length,1);
  assert.match(result.afterWindows[0].content,/<h1>New<\/h1>/);
  assert.equal(result.newSourceHash,"browser-authoritative-new-source");
  assert.match(runtime.instructions(),/receipt\.newSourceHash[\s\S]*afterWindows[\s\S]*hashes ignore geometry[\s\S]*Re-read only for incomplete source, conflict, or mismatch/);
});

test("sourceHash conflict stops before replacement and legacy baseRevision keeps the old dispatch",async()=>{
  const edit=widgetEdit({sourceFormat:"",frameworkVersion:""}), currentSourceHash=widgetSourceHash(edit), conflictCalls=[], {runtime:conflictRuntime}=await sourcePatchRuntime({
    revision:7,hash:"legacy-hash",sourceHash:currentSourceHash,widgetEdit:edit,
  },conflictCalls);
  await assert.rejects(
    conflictRuntime.tool("canvas_patch_widget").execute({objectId:"widget-1",sourceHash:"c".repeat(64),patch:PATCH},{callId:"conflict",signal:new AbortController().signal}),
    error=>error?.code==="SOURCE_CONFLICT",
  );
  assert.deepEqual(conflictCalls.map(call=>call.name),["canvas_internal_widget"]);

  const legacyCalls=[], {runtime:legacyRuntime}=await sourcePatchRuntime({revision:7,hash:"legacy-hash",widgetEdit:edit},legacyCalls);
  await legacyRuntime.tool("canvas_patch_widget").execute({objectId:"widget-1",baseRevision:7,patch:PATCH},{callId:"legacy",signal:new AbortController().signal});
  assert.equal(legacyCalls[1].args.baseRevision,7);
  assert.equal(legacyCalls[1].args.expectedHash,"legacy-hash");
  assert.equal(Object.hasOwn(legacyCalls[1].args,"expectedSourceHash"),false);
});

test("sourceHash dispatch accepts the browser fallback fingerprint as an opaque capability",async()=>{
  const edit=widgetEdit({sourceFormat:"",frameworkVersion:""}), sourceHash="fallback-widget-source-123", rpcCalls=[], {runtime}=await sourcePatchRuntime({
    revision:7,hash:"legacy-hash",sourceHash,widgetEdit:edit,
  },rpcCalls);
  await runtime.tool("canvas_patch_widget").execute({objectId:"widget-1",sourceHash,patch:PATCH},{callId:"fallback-source",signal:new AbortController().signal});
  assert.equal(rpcCalls[1].args.expectedSourceHash,sourceHash);
});

test("same-target patch tracing does not impose the removed twenty-attempt terminal stop",async()=>{
  const edit=widgetEdit({sourceFormat:"",frameworkVersion:""}), rpcCalls=[], {runtime,session}=await sourcePatchRuntime({revision:7,hash:"legacy-hash",widgetEdit:edit},rpcCalls);
  session.widgetPatchAttempts.set("widget-1\u0000",{attempt:20,lastError:{code:"OLD_FAILURE",message:"retry"}});
  const result=await runtime.tool("canvas_patch_widget").execute({objectId:"widget-1",baseRevision:7,patch:PATCH},{callId:"attempt-21",signal:new AbortController().signal});
  assert.equal(result.ok,true);
  assert.equal(session.widgetPatchAttempts.get("widget-1\u0000").attempt,21);
});

test("native contract loader returns the first-use document once and only durable identity after that",async()=>{
  const edit=widgetEdit(), rpcCalls=[], {runtime}=await sourcePatchRuntime({revision:1,hash:"legacy",sourceHash:widgetSourceHash(edit),widgetEdit:edit},rpcCalls);
  runtime.instructions();
  const first=await runtime.tool("load_widget_contract").execute({route:"general-html"},{callId:"load-contract",signal:new AbortController().signal});
  assert.equal(first.document,"general");
  const repeated=await runtime.tool("load_widget_contract").execute({route:"general-html"},{callId:"load-contract-again",signal:new AbortController().signal});
  assert.deepEqual(Object.keys(repeated).sort(),["alreadyLoaded","loaded","route","sha256"]);
  assert.equal(repeated.alreadyLoaded,true);
  assert.match(runtime.turnAdditionalContext().map(context=>context.value).join("\n"),/general/);
});
