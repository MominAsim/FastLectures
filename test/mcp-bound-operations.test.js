"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BOUND_CANVAS_TOOL_NAMES, executeBoundCanvasTool, patchVirtualFile } = require("../src/server/mcp/bound-operations.js");
function harness(respond, callOptions = {}) {
  const session = {id:"bound",connection:{},mutationRequests:new Map()}, calls = [];
  return {session,calls,run:(name,args) => executeBoundCanvasTool({name,args:{sessionId:session.id,...args},session,canvasCall:async (connection,operation,args) => {
    assert.equal(connection,session.connection); calls.push({operation,args});
    return {result:await respond(operation,args),timing:{requestedAt:calls.length*10,completedAt:calls.length*10+5,durationMs:5}};
  },callOptions})};
}
test("bound tools exclude external session lifecycle and enforce schema and binding", async () => {
  for (const name of ["penecho_list_canvases","penecho_open_canvas","penecho_start_session","penecho_close_session"]) assert.ok(!BOUND_CANVAS_TOOL_NAMES.includes(name));
  const h=harness(() => ({}));
  await assert.rejects(h.run("penecho_read_file",{path:"/notes.md",unexpected:true}));
  await assert.rejects(h.run("penecho_read_file",{sessionId:"other",path:"/notes.md"}),{code:"session_mismatch"});
  assert.equal(h.calls.length,0);
});

const captureNotReady = () => Object.assign(new Error("A live widget could not be captured. Wait for it to finish loading and try again."), {code:"CANVAS_TOOL_FAILED",details:{privatePath:"/private/should-not-escape"}});
const widgetArgs = {artifactId:"chart",title:"Chart",html:"<p>chart</p>",capture:true};
test("a background capture failure preserves the committed artifact without navigating or retrying", async () => {
  const h=harness(op => {
    if(op === "mcp_present_widget") return {artifactId:"chart",objectId:"widget",revision:7,visible:false};
    throw Object.assign(new Error("Show this Canvas"),{code:"CANVAS_NOT_VISIBLE",details:{privatePath:"must-not-escape"}});
  });
  const result=await h.run("penecho_present_widget",widgetArgs);
  assert.equal(result.applied,true);
  assert.equal(result.pixelVerified,false);
  assert.equal(result.objectId,"widget");
  assert.equal(result.captureFailure.code,"CANVAS_NOT_VISIBLE");
  assert.match(result.captureFailure.message,/Explicitly show/);
  assert.ok(!JSON.stringify(result).includes("must-not-escape"));
  assert.deepEqual(h.calls.map(c=>c.operation),["mcp_present_widget","mcp_capture_widget"]);
});
test("post-commit capture readiness failure retains the receipt without retrying or exposing browser details", async () => {
  const h=harness(op => {
    if (op === "mcp_present_widget") return {artifactId:"chart",objectId:"widget",revision:7,feedbackCursor:3};
    throw captureNotReady();
  });
  const result=await h.run("penecho_present_widget",widgetArgs);
  assert.equal(result.applied,true);
  assert.equal(result.pixelVerified,false);
  assert.equal(result.objectId,"widget");
  assert.equal(result.revision,7);
  assert.equal(result.feedbackCursor,3);
  assert.deepEqual(result.timing,{requestedAt:10,completedAt:15,durationMs:5});
  assert.equal(result.image,undefined);
  assert.equal(result.captureFailure.code,"CANVAS_TOOL_FAILED");
  assert.equal(result.captureFailure.retryTool,"penecho_capture_widget");
  assert.deepEqual(result.captureFailure.retryArguments,{sessionId:"bound",artifactId:"chart"});
  assert.ok(!JSON.stringify(result).includes("should-not-escape"));
  assert.deepEqual(h.calls.map(call=>call.operation),["mcp_present_widget","mcp_capture_widget"]);
});
test("post-commit capture preserves cancellation, session failures, and invalid browser responses", async () => {
  for (const error of [Object.assign(new Error("cancelled"),{code:"request_cancelled"}), Object.assign(new Error("Session revoked"),{code:"CANVAS_TOOL_FAILED"}), Object.assign(new Error("Preview load was cancelled."),{code:"CANVAS_TOOL_FAILED"}), Object.assign(new Error("invalid metadata"),{code:"invalid_browser_result"})]) {
    const h=harness(op => {if(op==="mcp_present_widget")return {artifactId:"chart",objectId:"widget",revision:1};throw error;});
    await assert.rejects(h.run("penecho_present_widget",widgetArgs),value=>value===error);
  }
  const controller=new AbortController(),error=captureNotReady();
  const h=harness(op=>{if(op==="mcp_present_widget")return {artifactId:"chart",objectId:"widget",revision:1};controller.abort();throw error;},{signal:controller.signal});
  await assert.rejects(h.run("penecho_present_widget",widgetArgs),value=>value===error);
  const invalid=harness(op=>op==="mcp_present_widget"?{artifactId:"chart",objectId:"widget",revision:1}:{dataUrl:"data:image/webp;base64,AQIDBA==",revision:-1});
  await assert.rejects(invalid.run("penecho_present_widget",widgetArgs),{code:"invalid_browser_result"});
  const applyError=captureNotReady(),failedApply=harness(()=>{throw applyError;});
  await assert.rejects(failedApply.run("penecho_present_widget",widgetArgs),value=>value===applyError);
  assert.equal(failedApply.calls.length,1);
});
test("structured Widget capture deadlines preserve applied receipts but never override cancellation", async () => {
  for (const code of ["WIDGET_READY_TIMEOUT","WIDGET_CAPTURE_TIMEOUT"]) {
    const error=Object.assign(new Error("Capture deadline reached"),{code,details:{stage:"host-ready"}});
    const controller=new AbortController();
    let abort=false;
    const h=harness(op=>{
      if(op==="mcp_present_widget")return {artifactId:"chart",objectId:"widget",revision:9};
      if(abort)controller.abort();
      throw error;
    },{signal:controller.signal});
    const result=await h.run("penecho_present_widget",widgetArgs);
    assert.equal(result.applied,true);
    assert.equal(result.pixelVerified,false);
    assert.equal(result.objectId,"widget");
    assert.equal(result.revision,9);
    assert.equal(result.captureFailure.code,code);
    assert.equal(h.calls.length,2);
    abort=true;
    await assert.rejects(h.run("penecho_present_widget",widgetArgs),value=>value===error);
  }
});
test("draw and plot retain applied receipts when optional capture transport fails", async () => {
  for (const [name,kind,args] of [["penecho_draw","drawing",{items:[{id:"n",type:"rect"}]}],["penecho_plot","plot",{expression:"x"}]]) {
    const h=harness(op=>{if(op==="mcp_capture_primitives")throw Object.assign(new Error("timeout"),{code:"canvas_timeout"});return {artifactId:"native",kind,objectIds:["object"],revision:8,feedbackCursor:4};});
    const result=await h.run(name,{artifactId:"native",title:"Native",...args,capture:true});
    assert.equal(result.applied,true);
    assert.equal(result.pixelVerified,false);
    assert.equal(result.revision,8);
    assert.deepEqual(result.objectIds,["object"]);
    assert.equal(result.captureFailure.code,"canvas_timeout");
    assert.equal(result.captureFailure.retryTool,"penecho_capture_canvas");
    assert.deepEqual(result.captureFailure.retryArguments,{sessionId:"bound",target:"canvas"});
    assert.equal(h.calls.length,2);
    const invalid=harness(op=>op==="mcp_capture_primitives"?{artifactId:"other",dataUrl:"data:image/webp;base64,AQIDBA==",width:100,height:100,encodedBytes:4}:{artifactId:"native",kind,objectIds:["object"],revision:8,feedbackCursor:4});
    await assert.rejects(invalid.run(name,{artifactId:"native",title:"Native",...args,capture:true}),{code:"invalid_browser_result"});
  }
});
test("bound patch keeps exact source conflict and retry receipt semantics", async () => {
  const h=harness((op,args) => op === "mcp_prepare_patch" ? {content:"hello\n",contentHash:"hash-1"} : {applied:true,contentHash:"hash-2"});
  const args={path:"/notes.md",contentHash:"hash-1",requestId:"patch-1",patch:"--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-hello\n+world\n"};
  await assert.rejects(h.run("penecho_patch_file",{...args,contentHash:"stale"}),{code:"SOURCE_CONFLICT"});
  assert.equal(h.session.mutationRequests.size,0);
  assert.equal((await h.run("penecho_patch_file",args)).applied,true);
  assert.equal(h.calls.at(-1).args.content,"world\n");
  const count=h.calls.length;
  assert.equal((await h.run("penecho_patch_file",args)).reused,true);
  assert.equal(h.calls.length,count);
  await assert.rejects(h.run("penecho_patch_file",{...args,patch:args.patch.replace("world","again")}),{code:"REQUEST_ID_CONFLICT"});
});
test("malformed hunk counts keep parse diagnostics and never write", async () => {
  let applied = false;
  const h = harness((op) => {
    if (op === "mcp_prepare_patch") return {content:"hello\n",contentHash:"hash-1"};
    applied = true;
    return {applied:true,contentHash:"hash-2"};
  });
  const args = {
    path:"/notes.md",contentHash:"hash-1",requestId:"bad-hunk-count",
    // No trailing newline keeps the malformed count visible to the parser.
    patch:"--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n-hello\n+world",
  };
  await assert.rejects(h.run("penecho_patch_file",args),error => {
    assert.equal(error.code,"invalid_patch");
    assert.match(error.message,/Added line count did not match for hunk at line 3\./);
    assert.doesNotMatch(error.message,/hello|world/);
    return true;
  });
  assert.equal(applied,false);
  assert.deepEqual(h.calls.map(call => call.operation),["mcp_prepare_patch"]);
  assert.equal(h.session.mutationRequests.size,0);
});
test("patch parse diagnostics redact invalid lines and use a generic message for unknown errors", () => {
  const secret = "PRIVATE_SOURCE_SHOULD_NOT_BE_ECHOED";
  assert.throws(() => patchVirtualFile("hello\n",`--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-hello\n${secret}\n+world`,"/notes.md"),error => {
    assert.equal(error.code,"invalid_patch");
    assert.match(error.message,/Hunk at line 3 contains an invalid line\./);
    assert.doesNotMatch(error.message,new RegExp(secret));
    return true;
  });
  assert.throws(() => patchVirtualFile("hello\n",undefined,"/notes.md"),error => {
    assert.equal(error.code,"invalid_patch");
    assert.equal(error.message,"patch must be a valid unified diff.");
    return true;
  });
});
test("bound presentation only verifies pixels after capture and merges timing", async () => {
  const h=harness((op,args) => op === "mcp_present_widget" ? {artifactId:args.artifactId,objectId:"widget",revision:1} : {dataUrl:"data:image/webp;base64,AQIDBA==",width:480,height:360,revision:2});
  const args={artifactId:"chart",title:"Chart",html:"<p>chart</p>"};
  assert.equal((await h.run("penecho_present_widget",args)).pixelVerified,false);
  const result=await h.run("penecho_present_widget",{...args,capture:true});
  assert.equal(result.pixelVerified,true);
  assert.deepEqual(result.image,{mimeType:"image/webp",data:"AQIDBA==",bytes:4});
  assert.equal(result.captureRevision,2);
  assert.equal(result.timing.durationMs,15);
  assert.deepEqual(h.calls.map(c => c.operation),["mcp_present_widget","mcp_present_widget","mcp_capture_widget"]);
  const invalid=harness((op,args) => ({artifactId:args.artifactId,objectId:"widget",revision:1}));
  await assert.rejects(invalid.run("penecho_present_widget",{...args,capture:true}),{code:"invalid_capture"});
});
