"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/client/app/core.js"), "utf8");
function extract(name) {
  const start=source.indexOf(`function ${name}(`), body=source.indexOf("{",start);
  let depth=0;
  for(let i=body;i<source.length;i++) {
    if(source[i]==="{")depth++;
    else if(source[i]==="}"&&!--depth)return source.slice(start,i+1);
  }
  throw new Error(`Missing ${name}`);
}
function routing(runtime) {
  const calls=[], settings={ startupConnectionsChecked:false };
  const context=vm.createContext({ settings, window:{PENECHO_CONFIG:{runtime}}, selectSettingsPage:page=>calls.push(page), openSettings:()=>calls.push("open") });
  vm.runInContext(extract("routeStartupConnections"),context);
  return {calls,context};
}
test("first launch opens Connections once for empty or incomplete configuration",()=>{
  for(const runtime of [undefined,"local","desktop"]) {
    const {calls,context}=routing(runtime);
    context.routeStartupConnections({hasUsableConnection:false});
    context.routeStartupConnections({hasUsableConnection:false});
    assert.deepEqual(calls,["connections","open"]);
  }
});
test("configured launches remain on Canvas; explicit configure opens Connections",()=>{
  const normal=routing("local"); normal.context.routeStartupConnections({hasUsableConnection:true});
  assert.deepEqual(normal.calls,[]);
  const explicit=routing("local"); explicit.context.routeStartupConnections({hasUsableConnection:true,openConnections:true});
  assert.deepEqual(explicit.calls,["connections","open"]);
  for(const runtime of ["cloud","viewer"]) {
    const remote=routing(runtime);remote.context.routeStartupConnections({hasUsableConnection:false,openConnections:true});
    assert.deepEqual(remote.calls,[]);
  }
});
test("startup and Agent share one in-flight configuration request",async()=>{
  let resolve,loads=0;
  const context=vm.createContext({settings:{configurationLoad:null},performCanvasSettingsLoad:()=>{loads++;return new Promise(done=>{resolve=done;});}});
  vm.runInContext(extract("loadCanvasSettings"),context);
  const first=context.loadCanvasSettings(),second=context.loadCanvasSettings();
  assert.equal(first,second);assert.equal(loads,1);
  resolve();await first;
  assert.equal(context.settings.configurationLoad,null);
});
test("selection falls back to first saved connection and preserves explicit saved choice",()=>{
  let selected="default";
  const settings={connections:[{id:"first"},{id:"second"}]};
  const context=vm.createContext({window:{PENECHO_CONFIG:{}},settings,AI_CONNECTION_STORAGE_KEY:"connection",selectedAiConnectionId:()=>selected,localStorage:{setItem:(_key,value)=>{selected=value;}}});
  vm.runInContext(extract("syncLocalConnectionSelection"),context);
  context.syncLocalConnectionSelection();assert.equal(selected,"first");assert.equal(settings.connections[0].active,true);
  selected="second";context.syncLocalConnectionSelection();assert.equal(selected,"second");assert.equal(settings.connections[1].active,true);
  settings.connections=[];context.syncLocalConnectionSelection();assert.equal(settings.connections.length,0);
  selected="second";Object.assign(context.window.PENECHO_CONFIG,{browserCanvasEditing:true,linkedDeviceOnline:false});
  context.syncLocalConnectionSelection();assert.equal(selected,"second","offline must not silently select a different local model");
});
test("desktop Settings menu reveals the existing Canvas and sends the shared-page event",()=>{
  const main=fs.readFileSync(path.join(__dirname,"../desktop/main.js"),"utf8"),calls=[];
  const context=vm.createContext({mainWindow:{isDestroyed:()=>false,show:()=>calls.push("show"),focus:()=>calls.push("focus"),webContents:{send:channel=>calls.push(channel)}}});
  vm.runInContext(main.slice(main.indexOf("function showSettings()"),main.indexOf("function createMainWindow(")),context);
  context.showSettings();
  assert.deepEqual(calls,["show","focus","penecho:show-connections"]);
});
test("desktop bootstrap starts Canvas without checking whether AI is configured",async()=>{
  const main=fs.readFileSync(path.join(__dirname,"../desktop/main.js"),"utf8"),calls=[],configuration={};
  const context=vm.createContext({createUpdateManager:()=>({start:()=>calls.push("updates")}),app:{},DESKTOP_VERSION:"test",net:{},updateDesktopUpdateUi:()=>{},installMenu:()=>{},registerIpc:()=>{},loadConfiguration:()=>({configuration}),startServer:async value=>{assert.equal(value,configuration);calls.push("server");return "http://127.0.0.1:1234/";},server:{address:()=>({port:1234})},process:{env:{HOST:"127.0.0.1"}},createMainWindow:url=>{calls.push(url);return {};},dialog:{showMessageBox:()=>assert.fail("startup should succeed")}});
  vm.runInContext(main.slice(main.indexOf("async function bootstrap()"),main.indexOf("if (gotLock) {",main.indexOf("async function bootstrap()"))),context);
  await context.bootstrap();
  assert.deepEqual(calls,["updates","server","http://127.0.0.1:1234/"]);
});
