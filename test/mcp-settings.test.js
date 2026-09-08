"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");

function harness(fetchImpl) {
  const nodes=new Map(),requests=[],clipboard=[],clientInputs=["codex","claude","other"].map(value=>({value,checked:value==="codex",disabled:false}));
  for(const id of ["mcpToolbarToggle","mcpManualSteps","mcpManual","mcpCanvasRing","mcpCanvasNotice","mcpCanvasNoticeButton","mcpEnabled","mcpConnectionStatus","mcpConfig","mcpConfigure","mcpCopyConfig","mcpCopyInstructions","mcpCopySkill","mcpCopyGuide","mcpClients","mcpExamples","mcpExampleStatus","mcpRefresh","mcpConfigStatus","mcpConfigureStatus","mcpSetupStatus","settingsPageMcp"]){
    nodes.set(id,{hidden:id==="settingsPageMcp"||id==="mcpConfigStatus",value:"",textContent:"",disabled:false,dataset:{},listeners:{},classList:{toggle(){}},attributes:{},setAttribute(key,value){this.attributes[key]=value;},addEventListener(type,listener){this.listeners[type]=listener;}});
  }
  const ui={status:"",page:null},storage=new Map();
  const context=vm.createContext({document:{getElementById:id=>nodes.get(id)||null,querySelectorAll:selector=>selector==='input[name="mcpClient"]'?clientInputs:[]},state:{language:"en"},window:{PENECHO_CONFIG:{}},WebSocket:{OPEN:1,CONNECTING:0},AbortSignal,AbortController,setTimeout,clearTimeout,performance,addEventListener(){},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},setStatus:value=>{ui.status=value;},openSettings(){},selectSettingsPage:value=>{ui.page=value;},
    location:{protocol:"http:",host:"localhost:3921"},canvasClientId:()=>"canvas-test",
    authenticatedApiHeaders:headers=>({...headers,"X-PenEcho-Session":"test-page-session"}),
    fetch:async(url,options)=>{requests.push({url,options});return fetchImpl(url,options);},writeClipboardText:async text=>{clipboard.push(text);return true;},t:key=>key,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/client/app/mcp-runtime.js"),"utf8")+"\nglobalThis.api={mcpRuntime,mcpRefreshSettings,mcpRenderSettings,mcpDisconnect,mcpHeartbeat,mcpBeginMutation,mcpEndMutation,mcpToolbarClick};",context);
  return {...context.api,nodes,requests,state:context.state,context,ui,storage,clipboard,clientInputs,
    selectClient(value){for(const input of clientInputs)input.checked=input.value===value;nodes.get("mcpClients").listeners.change({target:{}});}};
}
const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});
const ready=()=>response(200,{config:{command:"/node",args:["/PenEcho/src/server/mcp/stdio.js"]}});

test("MCP configuration is available while canvas access is off and uses authenticated page headers",async()=>{
  const h=harness(()=>ready());await h.mcpRefreshSettings();
  assert.match(h.nodes.get("mcpConnectionStatus").textContent,/Not discoverable/);
  for(const id of ["mcpConfigure","mcpCopyConfig","mcpCopyInstructions"])assert.equal(h.nodes.get(id).disabled,false,id);
  assert.equal(h.requests[0].options.headers["X-PenEcho-Session"],"test-page-session");
  assert.equal(h.requests[0].options.credentials,"same-origin");assert.equal(h.requests[0].options.cache,"no-store");
});
test("copying a skill cannot hide the configuration failure, and retry restores the controls",async()=>{
  let denied=true;const h=harness(url=>url.endsWith("/skill")?response(200,{text:"workflow"}):denied?response(403,{error:{code:"local_host_required",message:"Host only"}}):ready());
  await h.mcpRefreshSettings();const notice=h.nodes.get("mcpConfigStatus"),message=notice.textContent;
  assert.match(message,/computer running PenEcho/);assert.equal(notice.hidden,false);assert.equal(h.nodes.get("mcpConfigure").disabled,true);
  await h.nodes.get("mcpCopySkill").listeners.click();assert.equal(h.nodes.get("mcpSetupStatus").textContent,"Copied");assert.equal(notice.textContent,message);assert.equal(notice.hidden,false);
  denied=false;await h.mcpRefreshSettings();assert.equal(notice.hidden,true);assert.equal(h.nodes.get("mcpConfigure").disabled,false);
});
test("an old non-JSON backend or missing launch data produces an actionable restart message",async()=>{
  const h=harness(()=>({ok:false,status:405,json:async()=>{throw Error("Not JSON");}}));await h.mcpRefreshSettings();
  assert.match(h.nodes.get("mcpConfigStatus").textContent,/Restart PenEcho/);assert.equal(h.mcpRuntime.loading,null);
  const malformed=harness(()=>response(200,{config:{command:"",args:[]}}));await malformed.mcpRefreshSettings();
  assert.equal(malformed.nodes.get("mcpCopyConfig").disabled,true);assert.match(malformed.nodes.get("mcpConfigStatus").textContent,/Restart PenEcho/);
});
test("configuration loading coalesces checks and localizes a recoverable failure",async()=>{
  let resolve;const pending=new Promise(done=>resolve=done),h=harness(()=>pending);
  const first=h.mcpRefreshSettings(),second=h.mcpRefreshSettings();assert.equal(h.requests.length,1);assert.match(h.nodes.get("mcpConfigStatus").textContent,/Loading/);
  resolve(response(403,{error:{code:"forbidden"}}));await Promise.all([first,second]);
  h.state.language="zh";h.mcpRenderSettings();assert.match(h.nodes.get("mcpConfigStatus").textContent,/刷新并解锁/);assert.equal(h.mcpRuntime.loading,null);
});

test("automatic configuration shows immediate progress and a persistent confirmed result",async()=>{
  let resolve;const h=harness(url=>url.endsWith("/configure")?new Promise(done=>resolve=done):ready());await h.mcpRefreshSettings();
  const click=h.nodes.get("mcpConfigure").listeners.click,pending=click();
  assert.equal(h.nodes.get("mcpConfigure").textContent,"Configuring…");assert.ok(h.clientInputs.every(input=>input.disabled));
  assert.match(h.nodes.get("mcpConfigureStatus").textContent,/Saving/);await click();assert.equal(h.requests.filter(r=>r.url.endsWith("/configure")).length,1);
  resolve(response(200,{configured:true}));await pending;
  const notice=h.nodes.get("mcpConfigureStatus");assert.equal(notice.hidden,false);assert.match(notice.textContent,/Codex · Configuration saved/);assert.match(notice.textContent,/Reload/);
  await h.nodes.get("mcpCopyConfig").listeners.click();assert.match(notice.textContent,/Configuration saved/);assert.ok(h.clientInputs.every(input=>!input.disabled));
  h.state.language="zh";h.mcpRenderSettings();assert.match(notice.textContent,/配置已保存/);
  h.selectClient("claude");assert.equal(notice.hidden,true);
});
test("the selected client card drives the configure request and Other falls back to manual details",async()=>{
  const h=harness(()=>ready());await h.mcpRefreshSettings();h.selectClient("claude");
  assert.equal(h.nodes.get("mcpConfigure").hidden,false);
  await h.nodes.get("mcpConfigure").listeners.click();
  assert.match(h.requests.at(-1).options.body,/"client":"claude"/);assert.match(h.nodes.get("mcpConfigureStatus").textContent,/Claude Code/);
  h.selectClient("other");assert.equal(h.nodes.get("mcpConfigure").hidden,true);assert.equal(h.nodes.get("mcpManual").open,true);
});
test("example prompts copy the localized text and confirm on the row",async()=>{
  const h=harness(()=>ready()),row={dataset:{mcpExample:"exampleDesignPrompt"},classList:{add(){},remove(){}}},event={target:{closest:selector=>selector==="[data-mcp-example]"?row:null}};
  await h.nodes.get("mcpExamples").listeners.click(event);
  assert.equal(h.clipboard.at(-1),"Echo this UI idea in PenEcho with three design options, then let me choose.");
  assert.equal(h.nodes.get("mcpExampleStatus").textContent,"Prompt copied");
  h.state.language="zh";h.mcpRenderSettings();
  await h.nodes.get("mcpExamples").listeners.click(event);
  assert.equal(h.clipboard.at(-1),"帮我 echo 一下这个界面想法，在 PenEcho 上展示三个方案，让我选择。");
  assert.equal(h.nodes.get("mcpExampleStatus").textContent,"提示词已复制");
});
test("an existing entry is not reported as verified or newly saved",async()=>{
  const h=harness(()=>response(422,{existing:true,configured:false,error:"Old raw instruction to remove the entry"}));await h.nodes.get("mcpConfigure").listeners.click();
  const notice=h.nodes.get("mcpConfigureStatus");assert.match(notice.textContent,/Existing configuration found · not verified/);assert.match(notice.textContent,/No changes were made/);assert.doesNotMatch(notice.textContent,/Old raw|Configuration saved/);
});
test("configuration failures and uncertain network outcomes have distinct actionable feedback",async()=>{
  for(const [fetchImpl,expected] of [[()=>response(422,{error:"CLI was not found"}),/Automatic configuration failed/],[()=>{throw Error("Network failed");},/Configuration result not confirmed/],[()=>response(200,{}),/Configuration result not confirmed/]]){
    const h=harness(fetchImpl);await h.nodes.get("mcpConfigure").listeners.click();assert.match(h.nodes.get("mcpConfigureStatus").textContent,expected);assert.equal(h.mcpRuntime.configuring,false);
  }
});

test("the canvas MCP notice follows live access, not saved client configuration",async()=>{
  const h=harness(()=>ready());await h.mcpRefreshSettings();const notice=h.nodes.get("mcpCanvasNotice");assert.equal(notice.hidden,true);
  h.mcpRuntime.socket={readyState:0};h.mcpRenderSettings();assert.equal(notice.hidden,true);
  h.mcpRuntime.socket={readyState:1};h.mcpRuntime.ready=true;h.mcpRenderSettings();assert.equal(notice.hidden,false);assert.match(h.nodes.get("mcpCanvasNoticeButton").textContent,/Waiting for AI/);
  h.state.language="zh";h.mcpRenderSettings();assert.match(h.nodes.get("mcpCanvasNoticeButton").textContent,/等待 AI/);
  h.mcpRuntime.socket=null;h.mcpRenderSettings();assert.equal(notice.hidden,true);
});

test("MCP canvas status distinguishes sessions, actual mutation and unexpected disconnect",()=>{
  const h=harness(()=>ready()),socket={readyState:1,close(){}};h.mcpRuntime.socket=socket;h.mcpRuntime.ready=true;
  h.mcpRuntime.sessions.set("a",{client:"Codex"});h.mcpRenderSettings();assert.match(h.nodes.get("mcpCanvasNoticeButton").textContent,/Codex · 1 session/);assert.equal(h.nodes.get("mcpCanvasRing").hidden,false);
  h.mcpBeginMutation("Codex");assert.match(h.nodes.get("mcpCanvasNoticeButton").textContent,/updating/);assert.equal(h.mcpRuntime.glowing,true);
  h.mcpEndMutation();assert.doesNotMatch(h.nodes.get("mcpCanvasNoticeButton").textContent,/updating/);
  h.mcpDisconnect(true);assert.equal(h.nodes.get("mcpCanvasRing").hidden,true);assert.equal(h.nodes.get("mcpCanvasNotice").hidden,false);assert.match(h.nodes.get("mcpCanvasNoticeButton").textContent,/lost/);
  h.mcpDisconnect();assert.equal(h.nodes.get("mcpCanvasNotice").hidden,true);
});
test("a visible browser with an expired heartbeat revokes access",()=>{
  const h=harness(()=>ready()),socket={readyState:1,close(){}};h.mcpRuntime.socket=socket;h.mcpRuntime.ready=true;h.mcpRuntime.heartbeatSupported=true;h.mcpRuntime.lastPong=Date.now()-46000;
  h.mcpHeartbeat(socket);assert.equal(h.mcpRuntime.socket,null);assert.equal(h.mcpRuntime.connectionLost,true);assert.equal(h.mcpRuntime.heartbeatTimer,0);
});

test("a legacy ready connection does not receive unsupported JSON heartbeats",()=>{
  const h=harness(()=>ready()),socket={readyState:1,close(){},send(){throw Error("Legacy protocol");}};
  h.mcpRuntime.socket=socket;h.mcpRuntime.ready=true;h.mcpRuntime.lastPong=Date.now()-60000;
  h.mcpHeartbeat(socket);assert.equal(h.mcpRuntime.socket,socket);assert.equal(h.mcpRuntime.connectionLost,false);h.mcpDisconnect();
});

class CanvasSocket {
  static OPEN=1;
  constructor(){this.readyState=0;this.listeners={};}
  addEventListener(name,fn){this.listeners[name]=fn;}
  send(){}
  close(){this.readyState=3;}
}
test("unconfigured MCP toolbar opens setup without enabling discovery",async()=>{
  const h=harness(()=>ready());h.context.WebSocket=CanvasSocket;
  await h.mcpToolbarClick();assert.equal(h.ui.page,"mcp");assert.equal(h.mcpRuntime.socket,null);assert.equal(h.requests[0].url,"/api/mcp/status?inspectClients=1");
});
test("configured toolbar reports discoverability only after ready, and toggles off",()=>{
  const h=harness(()=>ready());h.context.WebSocket=CanvasSocket;h.mcpRuntime.setupKnown=true;
  try{
    h.mcpToolbarClick();assert.match(h.ui.status,/Opening/);assert.equal(h.mcpRuntime.ready,false);
    const socket=h.mcpRuntime.socket;socket.readyState=1;socket.listeners.message({data:JSON.stringify({type:"ready"})});
    assert.match(h.ui.status,/Discoverable/);assert.equal(h.nodes.get("mcpToolbarToggle").attributes["aria-pressed"],"true");
    h.mcpToolbarClick();assert.equal(h.mcpRuntime.socket,null);assert.equal(h.ui.status,"Not discoverable");
  }finally{h.mcpDisconnect();}
});
test("MCP toolbar keeps retry available after a connection constructor failure",()=>{
  const h=harness(()=>ready());h.mcpRuntime.setupKnown=true;h.context.WebSocket=class{constructor(){throw Error("Unavailable");}};
  h.mcpToolbarClick();assert.match(h.ui.status,/retry/);assert.equal(h.mcpRuntime.toolbarPending,false);
  h.context.WebSocket=CanvasSocket;
  try{h.mcpToolbarClick();assert.ok(h.mcpRuntime.socket);assert.match(h.ui.status,/Opening/);}finally{h.mcpDisconnect();}
});
test("manual setup tools are disclosed together and the toolbar precedes Agent",()=>{
  const html=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8");
  const manual=html.slice(html.indexOf('<details id="mcpManual"'),html.indexOf('</details>',html.indexOf('<details id="mcpManual"')));
  for(const id of ["mcpCopyConfig","mcpCopyInstructions","mcpCopySkill","mcpCopyGuide"])assert.ok(manual.includes(`id="${id}"`));
  assert.ok(html.indexOf('id="mcpToolbarToggle"')<html.indexOf('id="canvasAgentToggle"'));
  assert.match(html,/Give your AI a spatial workspace/);
});

test("existing client setup is detected on demand without a browser setup hint",async()=>{
  const h=harness(()=>response(200,{configuredClients:["codex"]}));h.context.WebSocket=CanvasSocket;
  try{await h.mcpToolbarClick();assert.ok(h.mcpRuntime.socket);assert.equal(h.ui.page,null);assert.equal(h.mcpRuntime.ready,false);assert.match(h.ui.status,/Opening/);}finally{h.mcpDisconnect();}
});
test("a failed setup check releases the button and shows a connection failure",async()=>{
  const h=harness(()=>{throw Error("Offline");});
  await h.mcpToolbarClick();assert.equal(h.mcpRuntime.socket,null);assert.equal(h.mcpRuntime.connectionLost,true);assert.match(h.ui.status,/retry/);assert.equal(h.nodes.get("mcpConnectionStatus").dataset.state,"error");assert.equal(h.nodes.get("mcpToolbarToggle").disabled,false);
});

test("toolbar discovery status changes to retry when an established connection drops",()=>{
  const h=harness(()=>ready());h.context.WebSocket=CanvasSocket;h.mcpRuntime.setupKnown=true;
  h.mcpToolbarClick();const socket=h.mcpRuntime.socket;socket.readyState=1;socket.listeners.message({data:JSON.stringify({type:"ready"})});
  assert.match(h.ui.status,/Discoverable/);h.mcpDisconnect(true);assert.match(h.ui.status,/retry/);
});


test("LAN browser opens discovery without host CLI setup and accepts status without local paths",async()=>{
  const h=harness(()=>response(200,{enabled:true,canConfigureLocalClients:false,config:null}));h.context.WebSocket=CanvasSocket;
  try {
    await h.mcpRefreshSettings();
    assert.equal(h.mcpRuntime.loadError,null);
    assert.equal(h.nodes.get("mcpConfigure").hidden,false);
    assert.equal(h.nodes.get("mcpConfigure").disabled,true);
    assert.equal(h.nodes.get("mcpManual").hidden,false);
    assert.match(h.nodes.get("mcpManualSteps").textContent,/computer running PenEcho/);
    assert.equal(h.nodes.get("mcpEnabled").disabled,false);
    await h.nodes.get("mcpConfigure").listeners.click();
    assert.equal(h.requests.filter(r=>r.url.endsWith("/configure")).length,0);
    await h.mcpToolbarClick();
    assert.ok(h.mcpRuntime.socket);
    assert.equal(h.ui.page,null);
    assert.equal(h.nodes.get("mcpConnectionStatus").dataset.state,"pending");
    h.mcpRuntime.socket.readyState=1;h.mcpRuntime.socket.listeners.message({data:JSON.stringify({type:"ready",heartbeat:true})});
    assert.equal(h.nodes.get("mcpConnectionStatus").dataset.state,"on");
    h.mcpDisconnect(true);
    assert.equal(h.nodes.get("mcpConnectionStatus").dataset.state,"error");
  } finally { h.mcpDisconnect(); }
});
test("first LAN toolbar click registers despite no configured host clients",async()=>{
  const h=harness(()=>response(200,{enabled:true,canConfigureLocalClients:false,config:null}));h.context.WebSocket=CanvasSocket;
  try {await h.mcpToolbarClick();assert.ok(h.mcpRuntime.socket);assert.equal(h.ui.page,null);}finally{h.mcpDisconnect();}
});
test("Cloud registers using the linked-device MCP socket and never offers local setup",async()=>{
  const h=harness(()=>response(200,{enabled:true,canConfigureLocalClients:false,config:null}));
  let target;h.context.window.PENECHO_CONFIG.runtime="cloud";h.context.WebSocket=class extends CanvasSocket{constructor(url){super();target=url;}};
  try {
    await h.mcpRefreshSettings();await h.mcpToolbarClick();
    assert.equal(target,"http:".replace("http","ws")+"//localhost:3921/api/v1/remote-canvas/mcp");
    assert.equal(h.nodes.get("mcpConfigure").hidden,false);
    assert.equal(h.nodes.get("mcpConfigure").disabled,true);
    assert.equal(h.nodes.get("mcpEnabled").disabled,false);
    const socket=h.mcpRuntime.socket;socket.listeners.error();
    assert.equal(h.nodes.get("mcpToolbarToggle").attributes["data-state"],"failed");
    assert.match(h.nodes.get("mcpConnectionStatus").textContent,/retry/);
  } finally {h.mcpDisconnect();}
});

test("retrying a failed LAN setup check clears stale errors after registration",async()=>{
  let offline=true;
  const h=harness(()=>{if(offline)throw Error("offline");return response(200,{canConfigureLocalClients:false,config:null});});
  h.context.WebSocket=CanvasSocket;
  try{
    await h.mcpToolbarClick();assert.ok(h.mcpRuntime.loadError);
    offline=false;await h.mcpToolbarClick();
    assert.equal(h.mcpRuntime.loadError,null);assert.ok(h.mcpRuntime.socket);
    assert.equal(h.nodes.get("mcpConfigStatus").hidden,true);
  }finally{h.mcpDisconnect();}
});


test("prompt emphasis preserves readable text and feedback copy uses the current canvas",async()=>{
  const h=harness(()=>ready());
  const label={dataset:{mcpLabel:"exampleFeedbackPrompt"},textContent:"",children:[],replaceChildren(...children){this.children=children;}};
  const original=h.context.document.querySelectorAll;
  h.context.document.querySelectorAll=selector=>selector==='[data-mcp-label]'?[label]:original(selector);
  h.context.document.createTextNode=text=>({textContent:text});
  h.context.document.createElement=tag=>({tagName:tag,textContent:""});
  for(const language of ["en","zh"]){
    h.state.language=language;h.mcpRenderSettings();
    assert.equal(label.children.map(node=>node.textContent).join(""),label.textContent);
    assert.deepEqual(label.children.filter(node=>node.tagName==="b").map(node=>node.textContent),language==="en"?["PenEcho","canvas"]:["PenEcho","画布"]);
    const row={dataset:{mcpExample:"exampleFeedbackPrompt"},classList:{add(){},remove(){}}};
    await h.nodes.get("mcpExamples").listeners.click({target:{closest:()=>row}});
    assert.equal(h.clipboard.at(-1),label.textContent);
    assert.doesNotMatch(h.clipboard.at(-1),/<b>|\*\*/);
  }
});
