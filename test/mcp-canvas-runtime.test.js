"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
function harness(){
  const widgets=new Map(),sent=[],saved=[],captureRequests=[],listeners={},state={language:"en",userRevision:1};let next=1,captures=0;
  const document={getElementById:()=>null,querySelectorAll:()=>[]};
  const context=vm.createContext({SIZE:32768,state,document,window:{PENECHO_CONFIG:{}},location:{origin:"http://127.0.0.1"},WebSocket:{OPEN:1},AbortController,AbortSignal,setTimeout,clearTimeout,performance,
    addEventListener:(type,fn)=>{listeners[type]=fn;},save:()=>saved.push(true),canvasAgentObject:id=>widgets.has(id)?{kind:"widget",item:widgets.get(id)}:null,
    canvasAgentCreate:async(args)=>{const item=args.items[0],id=`widget-${next++}`,widget={id,...item,x:item.placement?.x||0,y:item.placement?.y||0,contentVersion:0,contentW:item.width,contentH:item.height,w:item.width,h:item.height,hostReady:true,renderActive:true,frame:{contentWindow:{postMessage:value=>sent.push(value)}}};widgets.set(id,widget);state.userRevision++;return{receipts:[{objectId:id}]};},
    canvasAgentBox:object=>({x:object.item.x,y:object.item.y,w:object.item.w,h:object.item.h}),requestWidgetSnapshot:()=>{captures++;throw Error("not requested");},
    unionDirtyBounds:(a,b)=>!a?{...b}:({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.max(a.x+a.w,b.x+b.w)-Math.min(a.x,b.x),h:Math.max(a.y+a.h,b.y+b.h)-Math.min(a.y,b.y)}),
    canvasAgentAssertToolExecution:()=>{},canvasAgentCapture:async(args)=>{captures++;captureRequests.push(args);return {dataUrl:"data:image/webp;base64,AQ==",logicalRegion:args.region,encodedBytes:1};},
    canvasAgentPlacementBox:(w,h,p,reserved)=>({x:100+reserved.length*5000,y:100,w,h,crowded:false}),canvasAgentInternalRect:b=>b,visibleInkBounds:()=>null,intersection:(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y,
    canvasAgentFramePlan:()=>({scale:.6}),canvasAgentFrameRegion:region=>{context.frames.push(region);},frames:[],
    writeClipboardText:async()=>true,peButton:()=>{},canvasAgentAllObjects:()=>[...widgets.values()].map(w=>({id:w.id,box:{x:w.x,y:w.y,w:w.w,h:w.h}})),canvasAgentContentBounds:()=>widgets.size?{}:null,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/client/app/mcp-runtime.js"),"utf8")+"\nglobalThis.api={mcpRuntime,mcpExecute,mcpBoardHtml,mcpDisconnect,mcpExecutionCurrent,syncMcpWidgetProgress,mcpRecordFeedback,mcpQueueView,mcpFlushView,mcpPauseView,mcpTaskBounds};",context);
  return {...context.api,context,captureRequests,widgets,sent,saved,state,listeners,captures:()=>captures};
}
test("external sessions keep distinct board objects and progress never recreates a frame or takes a screenshot",async()=>{
  const h=harness(),one=await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Build",client:"Codex"},{}),two=await h.mcpExecute("mcp_start_session",{sessionId:"two",title:"Review",client:"Kimi"},{});
  assert.notEqual(one.boardObjectId,two.boardObjectId);const first=h.widgets.get(one.boardObjectId),frame=first.frame;
  await h.mcpExecute("mcp_update_session",{sessionId:"one",summary:"Contract confirmed",steps:[{id:"api",label:"API",status:"done"}],events:[{id:"check",text:"Validated"}]},{});
  assert.equal(first.frame,frame);assert.equal(h.widgets.size,2);assert.equal(h.sent.length,1);assert.equal(h.captures(),0);assert.equal(h.saved.length,0);
  assert.equal(h.mcpRuntime.sessions.get("two").summary,"");
  await h.mcpExecute("mcp_update_session",{sessionId:"one",events:[{id:"check",text:"Revalidated"}]},{});
  assert.equal(h.mcpRuntime.sessions.get("one").events.length,1);
});
test("hidden board updates stay canonical and defer iframe work until visible",async()=>{
  const h=harness(),one=await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Build"},{}),widget=h.widgets.get(one.boardObjectId);widget.renderActive=false;
  await h.mcpExecute("mcp_update_session",{sessionId:"one",summary:"Latest saved source"},{});
  assert.equal(h.sent.length,0);assert.match(widget.html,/Latest saved source/);assert.equal(h.captures(),0);
  widget.renderActive=true;h.syncMcpWidgetProgress(widget);h.syncMcpWidgetProgress(widget);assert.equal(h.sent.length,1);
});
test("disconnect revokes in-flight executions and session bindings; retained canvas artifacts remain",async()=>{
  const h=harness(),socket={readyState:1,close(){this.readyState=3;}},controller=new AbortController();h.mcpRuntime.socket=socket;h.mcpRuntime.controllers.set("call",controller);
  const execution={socket,generation:0,controller};assert.equal(h.mcpExecutionCurrent(execution),true);
  await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Build"},{});h.mcpDisconnect();
  assert.equal(controller.signal.aborted,true);assert.equal(h.mcpExecutionCurrent(execution),false);assert.equal(h.mcpRuntime.sessions.size,0);assert.equal(h.widgets.size,1);
  await assert.rejects(h.mcpExecute("mcp_inspect_session",{sessionId:"one"},{}),/no longer connected/);
});
test("board data escapes script terminators and untrusted markup stays text",()=>{
  const h=harness(),html=h.mcpBoardHtml({title:"</script><img src=x onerror=alert(1)>",client:"",status:"working"});
  assert.ok(!html.includes("</script><img"));assert.match(html,/\\u003c\/script>/);assert.match(html,/textContent/);
});

test("feedback is incremental, replayable, session-scoped and independent of dirty tracking",async()=>{
  const h=harness();h.mcpRuntime.socket={readyState:1,close(){}};const bounds={x:10,y:20,w:100,h:40};
  h.mcpRecordFeedback("text",bounds,{id:"old",text:"before session"});
  await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Design"},{});
  h.state.dirty={...bounds};h.mcpRecordFeedback("text",bounds,{id:"text-1",text:"Make this blue"});h.mcpRecordFeedback("stroke",bounds);
  const first=await h.mcpExecute("mcp_read_feedback",{capture:false,sessionId:"one",limit:1},{});
  assert.equal(first.entries.length,1);assert.equal(first.entries[0].text,"Make this blue");assert.equal(first.hasMore,true);
  assert.equal((await h.mcpExecute("mcp_read_feedback",{capture:false,sessionId:"one",limit:1},{})).entries[0].cursor,first.nextCursor);
  const next=await h.mcpExecute("mcp_read_feedback",{capture:false,sessionId:"one",after:first.nextCursor},{});assert.equal(next.entries[0].kind,"stroke");assert.equal(next.hasMore,false);
  assert.deepEqual(h.state.dirty,bounds);assert.equal(h.captures(),0);
  await h.mcpExecute("mcp_start_session",{sessionId:"two",title:"Other"},{});assert.equal((await h.mcpExecute("mcp_read_feedback",{capture:false,sessionId:"two",after:0},{})).entries.length,0);
  await assert.rejects(h.mcpExecute("mcp_read_feedback",{capture:false,sessionId:"one",after:999},{}),/cursor/);
  h.mcpDisconnect();await assert.rejects(h.mcpExecute("mcp_read_feedback",{capture:false,sessionId:"one"},{}),/no longer connected/);
});
test("feedback history is bounded and reports gaps without silently consuming input",async()=>{
  const h=harness();h.mcpRuntime.socket={readyState:1};await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Design"},{});
  for(let i=0;i<205;i++)h.mcpRecordFeedback("text",{x:0,y:0,w:10,h:10},{id:"a",text:"x".repeat(4001)});
  const result=await h.mcpExecute("mcp_read_feedback",{capture:false,sessionId:"one",limit:50},{});assert.equal(h.mcpRuntime.feedback.length,200);assert.equal(result.truncated,true);assert.equal(result.entries.length,50);assert.equal(result.entries[0].text.length,4000);assert.equal(result.entries[0].textTruncated,true);
  h.mcpRuntime.socket=null;h.mcpRecordFeedback("image",{x:0,y:0,w:10,h:10},{id:"new"});assert.equal(h.mcpRuntime.feedbackSequence,205);
});

test("inspect exposes owned preview bounds for interpreting spatial user feedback",async()=>{
  const h=harness();await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Design"},{});
  h.widgets.set("preview",{id:"preview",x:10,y:20,w:300,h:200});h.mcpRuntime.sessions.get("one").artifacts.set("design",{objectId:"preview",title:"Design"});
  const result=await h.mcpExecute("mcp_inspect_session",{sessionId:"one"},{});assert.equal(result.artifacts[0].bounds.x,10);assert.equal(result.artifacts[0].bounds.w,300);
});

test("feedback defaults to compressed Canvas context even for text, and pages distant input",async()=>{
  const h=harness();h.mcpRuntime.socket={readyState:1};await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Design"},{});
  h.mcpRecordFeedback("text",{x:10,y:20,w:100,h:40},{text:"Smaller"});h.mcpRecordFeedback("stroke",{x:10000,y:20,w:40,h:40});
  const first=await h.mcpExecute("mcp_read_feedback",{sessionId:"one"},{});
  assert.equal(first.entries.length,1);assert.equal(first.hasMore,true);assert.ok(first.dataUrl);
  assert.equal(h.captureRequests[0].quality,"basic");assert.equal(h.captureRequests[0].coordinates,"metadata");
  assert.equal(first.logicalRegion.x,0);assert.equal(first.logicalRegion.width,230);
  const second=await h.mcpExecute("mcp_read_feedback",{sessionId:"one",after:first.nextCursor},{});assert.equal(second.hasMore,false);assert.ok(second.logicalRegion.x>9000);
  await h.mcpExecute("mcp_read_feedback",{sessionId:"one",after:second.nextCursor},{});assert.equal(h.captures(),2,"empty reads do not encode screenshots");
});
test("baseline follows applied output, and failed capture never consumes feedback",async()=>{
  const h=harness();h.mcpRuntime.socket={readyState:1};const original=h.context.canvasAgentCreate;
  h.context.canvasAgentCreate=async args=>{h.mcpRecordFeedback("text",{x:0,y:0,w:10,h:10},{text:"before applied"});return original(args);};
  const start=await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Design"},{});assert.equal(start.feedbackCursor,1);
  assert.equal((await h.mcpExecute("mcp_read_feedback",{sessionId:"one"},{})).entries.length,0);
  h.mcpRecordFeedback("text",{x:0,y:0,w:10,h:10},{text:"after applied"});h.state.drawing=true;
  await assert.rejects(h.mcpExecute("mcp_read_feedback",{sessionId:"one"},{}),/Finish/);h.state.drawing=false;
  const originalCapture=h.context.canvasAgentCapture;h.context.canvasAgentCapture=async()=>{throw Error("snapshot unavailable");};
  await assert.rejects(h.mcpExecute("mcp_read_feedback",{sessionId:"one"},{}),/snapshot unavailable/);h.context.canvasAgentCapture=originalCapture;
  await h.mcpExecute("mcp_update_session",{sessionId:"one",summary:"Another update"},{});
  const presentation=await h.mcpExecute("mcp_present_widget",{sessionId:"one",artifactId:"next",title:"Next",html:"<p>Next design</p>"},{});assert.equal(presentation.feedbackCursor,3);assert.equal(h.mcpRuntime.sessions.get("one").feedbackStart,1);
  const retry=await h.mcpExecute("mcp_read_feedback",{sessionId:"one"},{});assert.equal(retry.entries[0].text,"after applied");
});

test("PenEcho lays out task shelves without moving earlier or manually placed objects",async()=>{
  const h=harness();await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Design"},{});
  const create=id=>h.mcpExecute("mcp_present_widget",{sessionId:"one",artifactId:id,title:id,html:"<p>Preview</p>",width:960,height:640},{});
  const a=await create("a"),b=await create("b"),c=await create("c"),wa=h.widgets.get(a.objectId),wb=h.widgets.get(b.objectId),wc=h.widgets.get(c.objectId);
  assert.equal(wa.y,wb.y);assert.ok(wb.x>=wa.x+wa.w+24);assert.equal(wc.x,wa.x);assert.ok(wc.y>=wa.y+wa.h+24);
  const old={x:wb.x,y:wb.y};wa.x+=25;await create("d");assert.deepEqual({x:wb.x,y:wb.y},old);assert.equal(wa.x,125);
  const other=await h.mcpExecute("mcp_start_session",{sessionId:"two",title:"Other"},{});assert.ok(h.widgets.get(other.boardObjectId).x>wc.x+wc.w);
});
test("new previews frame once as a batch, user navigation pauses following, disconnect clears it",async()=>{
  const h=harness();await h.mcpExecute("mcp_start_session",{sessionId:"one",title:"Design"},{});
  h.mcpRuntime.ready=true;h.mcpRuntime.socket={readyState:1,close(){}};
  for(const id of ["a","b","c"])await h.mcpExecute("mcp_present_widget",{sessionId:"one",artifactId:id,title:id,html:"<p>Preview</p>"},{});
  assert.equal(h.context.frames.length,0);h.mcpFlushView();assert.equal(h.context.frames.length,1);assert.ok(h.context.frames[0].w>1900);assert.ok(h.context.frames[0].h>1200);
  h.mcpPauseView();await h.mcpExecute("mcp_present_widget",{sessionId:"one",artifactId:"d",title:"D",html:"<p>D</p>"},{});h.mcpFlushView();assert.equal(h.context.frames.length,1);assert.equal(h.mcpRuntime.pendingView.size,1);
  h.mcpFlushView(true);assert.equal(h.context.frames.length,2);assert.equal(h.mcpRuntime.pendingView.size,0);
  h.mcpQueueView(h.mcpRuntime.sessions.get("one"),h.widgets.values().next().value);h.mcpDisconnect();assert.equal(h.mcpRuntime.pendingView.size,0);assert.equal(h.mcpRuntime.layoutTimer,0);
});

test('native artifact bounds include every owned object and capture reuses bounded Canvas path',async()=>{
  const h=harness();await h.mcpExecute('mcp_start_session',{sessionId:'one',title:'Drawing'},{});
  h.widgets.set('first',{id:'first',x:100,y:200,w:100,h:80});h.widgets.set('last',{id:'last',x:400,y:400,w:100,h:80});
  h.mcpRuntime.sessions.get('one').artifacts.set('drawing',{kind:'drawing',objectId:'first',objectIds:['first','last'],elements:[['a',{objectId:'first',kind:'image'}],['b',{objectId:'last',kind:'text'}]]});
  const inspected=await h.mcpExecute('mcp_inspect_session',{sessionId:'one'},{});assert.equal(inspected.artifacts[0].bounds.w,400);assert.equal(inspected.artifacts[0].elements.length,2);
  await h.mcpExecute('mcp_capture_primitives',{sessionId:'one',artifactId:'drawing'},{});assert.equal(h.captureRequests[0].quality,'basic');assert.equal(h.captureRequests[0].region.width,448);
  await assert.rejects(h.mcpExecute('mcp_capture_primitives',{sessionId:'one',artifactId:'unowned'},{}),/not found/);
});
