"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {getAuthoringGuidance}=require('../src/server/mcp/authoring-guidance.js');

test('first Agent model request contains the complete Visual Explorer design without a guidance round trip', async t => {
  const stateDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'fastlectures-initial-design-'));
  t.after(()=>fs.rmSync(stateDirectory,{recursive:true,force:true}));
  const {CanvasHarnessHost}=await import('../src/server/canvas-agent/runtime.mjs');
  const calls=[],messages=[];
  const connection={id:'design',provider:'codex-cli',cliPath:'codex-test',cliModel:'test',effort:'medium'};
  const host=new CanvasHarnessHost({stateDirectory,rootDirectory:path.resolve(__dirname,'..'),resolveConnection:()=>connection,listConnections:()=>[connection],callCli:async request=>{
    calls.push(request);
    return JSON.stringify({type:'final',text:'Contract inspection complete.'});
  }});
  t.after(()=>host.dispose());
  const session=await host.connect({clientId:'design',connectionId:connection.id,binding:{},send:(type,payload)=>messages.push({type,payload})});
  host.updateState(session,{revision:1,canvas:{width:100,height:100},objects:[]});
  await host.submit(session,'Explain how a compiler works visually.');
  const deadline=Date.now()+10000;
  while(!messages.some(event=>event.payload.kind==='turn_end') && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(messages.some(event=>event.payload.kind==='turn_end'));
  assert.equal(calls.length,1);
  const guidance=getAuthoringGuidance('visual-explorer','full');
  assert.ok(calls[0].systemPrompt.includes(guidance.document));
  assert.equal(calls[0].systemPrompt.split(guidance.document).length-1,1);
  assert.match(guidance.document,/Correct a concrete mismatch found in rendered evidence/);
  const tools=JSON.parse(calls[0].prompt).availableTools;
  assert.ok(tools.some(tool=>tool.name==='fastlectures_present_widget'));
  assert.ok(!tools.some(tool=>tool.name==='canvas_create'));
  assert.equal(messages.some(event=>event.type==='tool_request'),false);
});
