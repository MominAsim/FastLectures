"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");

function harness(fetchImpl) {
  const nodes=new Map(),requests=[],clipboard=[],clientInputs=["codex","claude","other"].map(value=>({value,checked:value==="codex",disabled:false}));
  for(const id of ["mcpTroubleshoot","mcpTroubleshootStatus","mcpCopyFirewallCommand","mcpCopyTroubleshootPrompt","mcpSetupBlock","mcpSetupPrompt","mcpSetupPromptCode","mcpToolbarToggle","mcpManualSteps","mcpManual","mcpCanvasRing","mcpCanvasNotice","mcpCanvasNoticeButton","mcpEnabled","mcpConnectionStatus","mcpConfig","mcpConfigure","mcpCopyInstructions","mcpClients","mcpExamples","mcpExampleStatus","mcpRefresh","mcpConfigStatus","mcpConfigureStatus","mcpSetupStatus","settingsPageMcp","mcpLan","mcpResetCertificate","mcpCertificateNotice","mcpCertificateDialog","mcpCertificateTitle","mcpCertificateStatus","mcpCertificateConfirm","mcpCertificateCancel","mcpLanStatus","mcpLanClients","mcpLanPairDialog","mcpLanPairIdentity","mcpLanPairCode","mcpLanPairStatus","mcpLanApprove","mcpLanReject","mcpLanBlock"]){
    nodes.set(id,{hidden:id==="settingsPageMcp"||id==="mcpConfigStatus",value:"",textContent:"",disabled:false,dataset:{},listeners:{},classList:{toggle(){}},attributes:{},replaceChildren(...children){this.children=children;if(children[0])this.value=children[0].value;},showModal(){this.open=true;},close(){this.open=false;},setAttribute(key,value){this.attributes[key]=value;},addEventListener(type,listener){this.listeners[type]=listener;}});
  }
  const ui={status:"",page:null},storage=new Map();
  const context=vm.createContext({document:{createElement:tag=>({tagName:tag,value:"",textContent:""}),getElementById:id=>nodes.get(id)||null,querySelectorAll:selector=>selector==='input[name="mcpClient"]'?clientInputs:[]},state:{language:"en"},window:{PENECHO_CONFIG:{}},WebSocket:{OPEN:1,CONNECTING:0},URL,AbortSignal,AbortController,setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,performance,addEventListener(){},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},setStatus:value=>{ui.status=value;},openSettings(){},selectSettingsPage:value=>{ui.page=value;},
    location:{protocol:"http:",host:"localhost:3921"},canvasClientId:()=>"canvas-test",
    authenticatedApiHeaders:headers=>({...headers,"X-PenEcho-Session":"test-page-session"}),
    fetch:async(url,options)=>{requests.push({url,options});return fetchImpl(url,options);},writeClipboardText:async text=>{clipboard.push(text);return true;},t:key=>key,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/client/app/mcp-troubleshoot.js"),"utf8")+fs.readFileSync(path.join(__dirname,"../src/client/app/mcp-runtime.js"),"utf8")+"\nglobalThis.api={mcpRuntime,mcpRefreshSettings,mcpRenderSettings,mcpDisconnect,mcpHeartbeat,mcpBeginMutation,mcpEndMutation,mcpToolbarClick};",context);
  return {...context.api,nodes,requests,state:context.state,context,ui,storage,clipboard,clientInputs,
    selectClient(value){for(const input of clientInputs)input.checked=input.value===value;nodes.get("mcpClients").listeners.change({target:{}});}};
}
const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});
const httpFixture=()=>({enabled:true,hostId:"a".repeat(64),certificatePem:"TEST-CA",accessToken:"test-token",urls:["https://192.168.1.4:3922/mcp"],discoveryCliUrl:"http://192.168.1.4:3888/api/mcp/discovery-client.js",discoveryCliSha256:"c".repeat(64),sessionCliUrl:"http://192.168.1.4:3888/api/mcp/session-client.js",sessionCliSha256:"f".repeat(64)});
const ready=()=>response(200,{config:{command:"/node",args:["/mcp/client.js"]},http:httpFixture()});

test("MCP configuration is available while canvas access is off and uses authenticated page headers",async()=>{
  const h=harness(()=>ready());await h.mcpRefreshSettings();
  assert.match(h.nodes.get("mcpConnectionStatus").textContent,/Not discoverable/);
  for(const id of ["mcpConfigure","mcpCopyInstructions"])assert.equal(h.nodes.get(id).disabled,false,id);
  assert.equal(h.requests[0].options.headers["X-PenEcho-Session"],"test-page-session");
  assert.equal(h.requests[0].options.credentials,"same-origin");assert.equal(h.requests[0].options.cache,"no-store");
});
test("unavailable setup cannot copy a partial prompt, and retry restores the controls",async()=>{
  let denied=true;const h=harness(url=>url.endsWith("/skill")?response(200,{text:"workflow"}):denied?response(403,{error:{code:"local_host_required",message:"Host only"}}):ready());
  await h.mcpRefreshSettings();const notice=h.nodes.get("mcpConfigStatus"),message=notice.textContent;
  assert.match(message,/computer running PenEcho/);assert.equal(notice.hidden,false);assert.equal(h.nodes.get("mcpConfigure").disabled,true);
  await h.nodes.get("mcpCopyInstructions").listeners.click();assert.equal(h.clipboard.length,0);assert.equal(notice.textContent,message);assert.equal(notice.hidden,false);
  denied=false;await h.mcpRefreshSettings();assert.equal(notice.hidden,true);assert.equal(h.nodes.get("mcpConfigure").disabled,false);
});
test("an old non-JSON backend or missing launch data produces an actionable restart message",async()=>{
  const h=harness(()=>({ok:false,status:405,json:async()=>{throw Error("Not JSON");}}));await h.mcpRefreshSettings();
  assert.match(h.nodes.get("mcpConfigStatus").textContent,/Restart PenEcho/);assert.equal(h.mcpRuntime.loading,null);
  const malformed=harness(()=>response(200,{config:{command:"",args:[]}}));await malformed.mcpRefreshSettings();
  assert.equal(malformed.nodes.get("mcpCopyInstructions").disabled,true);assert.match(malformed.nodes.get("mcpConfigStatus").textContent,/Restart PenEcho/);
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
  assert.ok(!h.nodes.get("mcpManual").open,"temporary configuring state keeps manual setup collapsed");
  assert.equal(h.nodes.get("mcpConfigure").textContent,"Configuring…");assert.ok(h.clientInputs.every(input=>input.disabled));
  assert.match(h.nodes.get("mcpConfigureStatus").textContent,/Saving/);await click();assert.equal(h.requests.filter(r=>r.url.endsWith("/configure")).length,1);
  resolve(response(200,{configured:true}));await pending;
  const notice=h.nodes.get("mcpConfigureStatus");assert.equal(notice.hidden,false);assert.match(notice.textContent,/Codex · Configuration saved/);assert.match(notice.textContent,/Reload/);
  await h.nodes.get("mcpCopyInstructions").listeners.click();assert.match(notice.textContent,/Configuration saved/);assert.ok(h.clientInputs.every(input=>!input.disabled));
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
test("MCP toolbar opts in immediately without depending on local client configuration",async()=>{
  const h=harness(()=>{throw Error("Client inspection must not gate registration");});h.context.WebSocket=CanvasSocket;
  try{await h.mcpToolbarClick();assert.equal(h.ui.page,null);assert.ok(h.mcpRuntime.socket);assert.equal(h.requests.length,0);}finally{h.mcpDisconnect();}
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
  assert.ok(manual.includes('id="mcpCopyInstructions"'));
  for(const id of ["mcpCopyConfig","mcpCopySkill","mcpCopyGuide","mcpConfig"])assert.ok(!manual.includes(`id="${id}"`));
  assert.ok(html.indexOf('id="mcpToolbarToggle"')<html.indexOf('id="canvasAgentToggle"'));
  assert.match(html,/Connect your AI Agent/);
  assert.ok(manual.includes('id="mcpResetCertificate"'));
  assert.ok(!html.includes('id="mcpLanCopy"'));
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
    await h.mcpRefreshSettings();assert.ok(h.mcpRuntime.loadError);
    offline=false;await h.mcpToolbarClick();await h.mcpRefreshSettings();
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


test("one-step setup includes launch configuration and live guidance without installing a skill",async()=>{
  const h=harness(()=>ready());
  await h.mcpRefreshSettings();await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.equal(h.clipboard.length,1);const prompt=h.clipboard[0];
  assert.match(prompt,/"transport": "stdio-http"/);
  assert.match(prompt,/Optional helper skill/);
  assert.match(prompt,/penecho:\/\/guidance\/skill/);
  assert.equal(h.requests.filter(r=>r.url.endsWith("\/skill")).length,0);
  assert.equal(h.nodes.get("mcpSetupStatus").textContent,"Copied");
});



test("HTTP setup contains target-machine instructions, trust and verified client hash",async()=>{
  const http=httpFixture(),h=harness(()=>response(200,{config:{command:"/host/node",args:[]},http}));
  await h.mcpRefreshSettings();h.mcpRuntime.ready=true;h.mcpRuntime.socket={readyState:1};h.mcpRenderSettings();
  assert.equal(h.nodes.get("mcpLan").hidden,false);assert.equal(h.nodes.get("mcpCopyInstructions").disabled,false);
  await h.nodes.get("mcpCopyInstructions").listeners.click();const prompt=h.clipboard.at(-1);
  assert.match(prompt,/192\.168\.1\.4:3922/);assert.ok(prompt.includes(http.sessionCliSha256));assert.ok(prompt.includes(http.hostId));
  assert.match(prompt,/"transport": "stdio-http"/);assert.match(prompt,/BEFORE execution/);
  assert.doesNotMatch(prompt,/invitation|remote-client\.js|\/host\/node/);
});
test("remote browsers cannot copy connection keys",async()=>{
  const h=harness(()=>response(200,{canConfigureLocalClients:false,config:null,http:httpFixture()}));await h.mcpRefreshSettings();
  assert.equal(h.nodes.get("mcpLan").hidden,true);await h.nodes.get("mcpCopyInstructions").listeners.click();assert.equal(h.clipboard.length,0);
});
test("LAN settings do not expose an Allow confirmation",async()=>{
  const h=harness(()=>response(200,{config:{command:"/node",args:[]},http:httpFixture()}));
  await h.mcpRefreshSettings();
  const html=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8");
  assert.doesNotMatch(html,/id="mcpLanPairDialog"|id="mcpLanApprove"/);
  assert.equal(h.nodes.get("mcpLanApprove").listeners.click,undefined);
});

test("certificate reset requires confirmation and copy updates existing identity",async()=>{
  const initial=httpFixture(),fresh={...initial,hostId:"d".repeat(64),certificatePem:"NEW-CA",accessToken:"new-token"};
  const h=harness(url=>url.endsWith("/http")?response(200,{http:fresh}):response(200,{config:{command:"/node",args:[]},http:initial}));
  await h.mcpRefreshSettings();
  await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.equal(h.nodes.get("mcpSetupStatus").textContent,"Copied");
  h.nodes.get("mcpResetCertificate").listeners.click();
  assert.equal(h.nodes.get("mcpCertificateDialog").open,true);
  assert.equal(h.requests.filter(r=>r.url.endsWith("/http")).length,0);
  h.nodes.get("mcpCertificateCancel").listeners.click();
  assert.equal(h.requests.filter(r=>r.url.endsWith("/http")).length,0);
  h.nodes.get("mcpResetCertificate").listeners.click();
  await h.nodes.get("mcpCertificateConfirm").listeners.click();
  assert.equal(JSON.parse(h.requests.at(-1).options.body).action,"reset-certificate");
  assert.equal(h.nodes.get("mcpCertificateDialog").open,false);
  assert.equal(h.nodes.get("mcpSetupStatus").textContent,"");
  assert.equal(h.nodes.get("mcpManual").open,true);
  assert.equal(h.nodes.get("mcpCertificateNotice").hidden,false);
  assert.equal(h.nodes.get("mcpCopyInstructions").textContent,"Copy new setup prompt");
  await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.ok(h.clipboard.at(-1).includes(fresh.hostId));
  assert.ok(!h.clipboard.at(-1).includes(initial.hostId));
  assert.match(h.nodes.get("mcpSetupStatus").textContent,/each previously connected Agent/);
});
test("failed certificate reset keeps confirmation visible and existing identity",async()=>{
  const initial=httpFixture();const h=harness(url=>url.endsWith("/http")?response(500,{error:{message:"Disk failure"}}):response(200,{config:{command:"/node",args:[]},http:initial}));
  await h.mcpRefreshSettings();h.nodes.get("mcpResetCertificate").listeners.click();await h.nodes.get("mcpCertificateConfirm").listeners.click();
  assert.equal(h.nodes.get("mcpCertificateDialog").open,true);
  assert.equal(h.mcpRuntime.status.http.hostId,initial.hostId);
  assert.equal(h.nodes.get("mcpCertificateConfirm").disabled,false);
  assert.match(h.nodes.get("mcpCertificateStatus").textContent,/Could not update/);
});
test("remote browsers cannot reset the host certificate",async()=>{
  const h=harness(()=>response(200,{canConfigureLocalClients:false,config:null,http:httpFixture()}));await h.mcpRefreshSettings();
  h.nodes.get("mcpResetCertificate").listeners.click();await h.nodes.get("mcpCertificateConfirm").listeners.click();
  assert.equal(h.requests.filter(r=>r.url.endsWith("/http")).length,0);
});

test("HTTP unavailable never copies legacy LAN configuration",async()=>{
  const h=harness(()=>response(200,{config:{command:"/host/node",args:[]},http:{...httpFixture(),enabled:false},lan:{enabled:true,invitation:"old-secret"}}));
  await h.mcpRefreshSettings();await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.equal(h.clipboard.length,0);assert.equal(h.nodes.get("mcpCopyInstructions").disabled,true);
  assert.equal(h.requests.some(r=>r.url.endsWith("/lan")),false);
});


test("overwriting an existing entry reports updated and reload without a connection claim",async()=>{
  const h=harness(()=>response(200,{configured:true,updated:true}));
  await h.nodes.get("mcpConfigure").listeners.click();
  assert.equal(h.mcpRuntime.configureResult.kind,"updated");
  assert.match(h.nodes.get("mcpConfigureStatus").textContent,/Configuration updated/);
  assert.match(h.nodes.get("mcpConfigureStatus").textContent,/Reload your AI client/);
  assert.doesNotMatch(h.nodes.get("mcpConfigureStatus").textContent,/No changes|verified|connected/i);
});


test("manual code block shows the exact full prompt and allows repeated copies",async()=>{
  const h=harness(()=>response(200,{config:{command:"/node",args:[]},http:httpFixture()}));
  await h.mcpRefreshSettings();
  assert.equal(h.nodes.get("mcpSetupPromptCode").textContent,"");
  h.nodes.get("mcpManual").open=true;h.nodes.get("mcpManual").listeners.toggle();
  await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.equal(h.nodes.get("mcpSetupPromptCode").textContent,h.clipboard.at(-1));
  await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.equal(h.clipboard.length,2);assert.equal(h.nodes.get("mcpCopyInstructions").disabled,false);
  assert.equal(h.nodes.get("mcpSetupStatus").textContent,"Copied (2)");
});
test("remote browser never displays host setup keys in the code block",async()=>{
  const h=harness(()=>response(200,{canConfigureLocalClients:false,config:{command:"/host"},http:httpFixture()}));
  h.nodes.get("mcpManual").open=true;await h.mcpRefreshSettings();
  assert.equal(h.nodes.get("mcpSetupBlock").hidden,true);
  assert.equal(h.nodes.get("mcpSetupPromptCode").textContent,"");
});

test("authorized LAN browser copies remote setup without host launch paths",async()=>{
  const h=harness(()=>response(200,{canConfigureLocalClients:false,canCopyLanSetup:true,config:{command:"/private/host/node",args:[]},http:httpFixture()}));
  await h.mcpRefreshSettings();assert.equal(h.nodes.get("mcpManual").open,true);
  assert.equal(h.nodes.get("mcpSetupBlock").hidden,false);
  assert.equal(h.nodes.get("mcpConfigure").disabled,true);
  assert.equal(h.nodes.get("mcpCopyInstructions").disabled,false);
  await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.equal(h.clipboard.at(-1),h.nodes.get("mcpSetupPromptCode").textContent);
  assert.match(h.clipboard.at(-1),/"transport": "stdio-http"/);
  assert.doesNotMatch(h.clipboard.at(-1),/private\/host/);
  assert.match(h.nodes.get("mcpManualSteps").textContent,/Open a conversation/);
});

test("closing a host canvas does not disable shared LAN access for other canvases",async()=>{
  const h=harness(()=>response(200,{config:{command:"/node",args:[]},http:{...httpFixture(),enabled:true}}));
  await h.mcpRefreshSettings();
  h.mcpDisconnect();
  assert.equal(h.requests.filter(r=>r.url.endsWith('/lan')).length,0);
  assert.equal(h.mcpRuntime.ready,false);
});

test("native HTTP setup exposes discovery and certificate trust without a stdio bridge",async()=>{
  const http={enabled:true,hostId:"a".repeat(64),certificatePem:"TEST-CA",accessToken:"test-access",urls:["https://192.168.1.2:4567/mcp"],localUrl:"https://127.0.0.1:4567/mcp",discoveryCliUrl:"http://192.168.1.2:3888/api/mcp/discovery-client.js",discoveryCliSha256:"b".repeat(64)};
  const h=harness(url=>response(200,url.endsWith("/configure")?{configured:true,trustRequired:true}:{http,config:{type:"http",url:http.localUrl},canConfigureLocalClients:true}));
  await h.mcpRefreshSettings();assert.equal(h.mcpRuntime.loadError,null);
  await h.nodes.get("mcpCopyInstructions").listeners.click();
  assert.match(h.clipboard[0],/native Streamable HTTP/);assert.match(h.clipboard[0],/CODEX_CA_CERTIFICATE/);
  assert.match(h.clipboard[0],/Never configure the helper itself as a stdio MCP server/);
  await h.nodes.get("mcpConfigure").listeners.click();
  assert.equal(h.mcpRuntime.configureResult.kind,"trust");assert.match(h.nodes.get("mcpConfigureStatus").textContent,/certificate setup required/);
  assert.equal(h.nodes.get("mcpManual").open,true);
});

test("browser reconnect preserves its registration identity and explicit opt-out cancels retry",async()=>{
  const h=harness(()=>ready()),scheduled=new Map();let sequence=0;
  h.context.setTimeout=(fn,ms)=>{scheduled.set(++sequence,{fn,ms});return sequence;};h.context.clearTimeout=id=>scheduled.delete(id);
  h.context.WebSocket=class extends CanvasSocket{send(value){this.hello=JSON.parse(value);}};
  try{
    await h.mcpToolbarClick();const first=h.mcpRuntime.socket;first.listeners.open();
    first.listeners.close();assert.equal(h.mcpRuntime.wanted,true);
    const retry=scheduled.get(h.mcpRuntime.reconnectTimer);assert.equal(retry.ms,1000);retry.fn();
    const second=h.mcpRuntime.socket;second.listeners.open();assert.notEqual(first,second);assert.equal(second.hello.canvasId,first.hello.canvasId);
    second.listeners.close();assert.ok(h.mcpRuntime.reconnectTimer);
    h.mcpDisconnect();assert.equal(h.mcpRuntime.wanted,false);assert.equal(h.mcpRuntime.reconnectTimer,0);
  }finally{h.mcpDisconnect();}
});


test("default setup uses the session CLI without changing global AI trust",async()=>{
  const http={enabled:true,hostId:"a".repeat(64),certificatePem:"TEST-CA",accessToken:"test-access",initialUrl:"https://192.168.1.2:3922/mcp",urls:["https://192.168.1.2:3922/mcp"],discoveryCliUrl:"http://192.168.1.2:3888/api/mcp/discovery-client.js",discoveryCliSha256:"b".repeat(64),sessionCliUrl:"http://192.168.1.2:3888/api/mcp/session-client.js",sessionCliSha256:"c".repeat(64),clientIdleMs:1800000};
  const h=harness(url=>response(200,url.endsWith("/configure")?{configured:true,trustRequired:false,reloadRequired:true}:{http,config:{type:"stdio",command:"/node",args:["/mcp/client.js","--host-id",http.hostId]},canConfigureLocalClients:true}));
  await h.mcpRefreshSettings();
  await h.nodes.get("mcpCopyInstructions").listeners.click();
  const prompt=h.clipboard[0];
  assert.match(prompt,/one lightweight stdio CLI/);
  assert.match(prompt,/WITHOUT --client/);
  assert.match(prompt,/idle for 30 minutes releases only HTTP/);
  assert.doesNotMatch(prompt,/--idle-exit-ms/);
  assert.match(prompt,/same complete sequence runs if reconnecting after idle release fails/);
  assert.match(prompt,/One-shot examples/);
  assert.match(prompt,/Use PenEcho to draw a simple flowchart/);
  assert.match(prompt,/Echo this idea as a diagram/);
  assert.match(prompt,/Show this architecture on a canvas/);
  assert.match(prompt,/在画布上比较这两个方案/);
  assert.match(prompt,/sessionKey/);assert.match(prompt,/documentId/);
  assert.match(prompt,/192\.168\.1\.2:3922/);
  assert.doesNotMatch(prompt,/CODEX_CA_CERTIFICATE/);
  await h.nodes.get("mcpConfigure").listeners.click();
  assert.notEqual(h.mcpRuntime.configureResult.kind,"trust");
  assert.doesNotMatch(h.nodes.get("mcpConfigureStatus").textContent,/certificate setup required/);
});


test("troubleshoot copies the newly fetched listener port, not the cached setup port",async()=>{
  let currentPort=49101;
  const h=harness(()=>response(200,{http:{enabled:true,localUrl:`https://127.0.0.1:${currentPort}/mcp`,preferredUrl:"https://old.local:3922/mcp"}}));
  h.mcpRuntime.status={http:{enabled:true,localUrl:"https://127.0.0.1:3922/mcp"}};
  await h.nodes.get("mcpCopyFirewallCommand").listeners.click();
  assert.match(h.clipboard[0],/\$port = 49101/);
  assert.doesNotMatch(h.clipboard[0],/3922/);
  currentPort=49102;
  await h.nodes.get("mcpCopyTroubleshootPrompt").listeners.click();
  assert.match(h.clipboard[1],/TCP port 49102/);
  assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].options.cache,"no-store");
  assert.match(h.nodes.get("mcpTroubleshootStatus").textContent,/49102/);
  assert.ok(!h.nodes.get("mcpTroubleshoot").open);
});
test("troubleshoot refuses stale commands on status failure and permits a fresh retry",async()=>{
  let available=false;
  const h=harness(()=>available?response(200,{http:{enabled:true,localUrl:"https://127.0.0.1:50999/mcp"}}):response(503,{error:"offline"}));
  h.mcpRuntime.status={http:{enabled:true,localUrl:"https://127.0.0.1:3922/mcp"}};
  await h.nodes.get("mcpCopyFirewallCommand").listeners.click();
  assert.equal(h.clipboard.length,0);
  assert.match(h.nodes.get("mcpTroubleshootStatus").textContent,/unavailable/);
  assert.equal(h.nodes.get("mcpCopyFirewallCommand").disabled,false);
  available=true;
  await h.nodes.get("mcpCopyFirewallCommand").listeners.click();
  assert.match(h.clipboard[0],/50999/);
});
test("troubleshoot copy coalesces repeated clicks and keeps both actions busy",async()=>{
  let resolve;
  const h=harness(()=>new Promise(done=>resolve=done));
  const pending=h.nodes.get("mcpCopyFirewallCommand").listeners.click();
  assert.equal(h.nodes.get("mcpCopyTroubleshootPrompt").disabled,true);
  await h.nodes.get("mcpCopyTroubleshootPrompt").listeners.click();
  assert.equal(h.requests.length,1);
  resolve(response(200,{http:{enabled:true,localUrl:"https://127.0.0.1:50888/mcp"}}));
  await pending;
  assert.equal(h.clipboard.length,1);
  assert.equal(h.nodes.get("mcpCopyTroubleshootPrompt").disabled,false);
});
