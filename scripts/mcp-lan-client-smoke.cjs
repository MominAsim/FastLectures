"use strict";
// Run on a second machine. Uses an explicit temporary connection JSON and never edits client settings.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const file=path.resolve(process.argv[3]||path.join(__dirname,'../src/server/mcp/remote-client.js'));
const child=spawn(process.execPath,[file,...(config.hostId?['--host-id',config.hostId]:[]),...(config.url?['--remote',config.url]:[]),'--fingerprint',config.fingerprint,'--invitation',config.invitation,'--name',`LAN acceptance (${process.platform})`],{stdio:['pipe','pipe','pipe'],windowsHide:true});
const pending=new Map();let nextId=0,buffer='';const checks=[];
child.stderr.on('data',bytes=>process.stderr.write(bytes));
child.stdout.on('data',bytes=>{buffer+=bytes.toString();let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let value;try{value=JSON.parse(line);}catch{throw Error('Adapter wrote non-JSON stdout');}const entry=pending.get(value.id);if(entry){pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(Error(JSON.stringify(value.error))):entry.resolve(value.result);}}});
child.once('exit',code=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error(`Adapter exited ${code}`));}pending.clear();});
function rpc(method,params){const id=++nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(`Timeout: ${method}`));},150000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function tool(name,args={}){const r=await rpc('tools/call',{name,arguments:args});assert(!r.isError,JSON.stringify(r.structuredContent||r.content));return r.structuredContent||JSON.parse(r.content.find(c=>c.type==='text').text);}
(async()=>{
 const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'LAN acceptance',version:'1'}});assert.equal(init.serverInfo.name,'PenEcho');checks.push('initialize');
 const tools=await rpc('tools/list',{});assert(tools.tools.some(t=>t.name==='penecho_get_guidance'));checks.push('tool discovery');
 const prompts=await rpc('prompts/list',{});assert(prompts.prompts.some(p=>p.name==='penecho_visual_explorer'));checks.push('prompt discovery');
 const guidance=await tool('penecho_get_guidance',{id:'visual-explorer'});assert(guidance.document.includes('Visual Explorer'));checks.push('live Visual Explorer guidance');
 const list=await tool('penecho_list_canvases');const canvas=list.canvases[0];assert(canvas,'No opted-in Canvas');checks.push('cross-machine canvas discovery');
 const session=await tool('penecho_start_session',{instanceId:canvas.instanceId,canvasId:canvas.canvasId,target:'current',title:'LAN acceptance',client:'Windows LAN acceptance',sessionKey:`lan-smoke-${Date.now()}`});assert(session.sessionId);checks.push('owned session');
 await tool('penecho_present_widget',{sessionId:session.sessionId,artifactId:'lan-acceptance',title:'LAN connection verified',html:'<!doctype html><html><head><style>body{margin:0;padding:32px;box-sizing:border-box;font:18px/1.6 system-ui;color:#17352e;background:#f6faf8}h1{font-size:26px;margin:0 0 16px}p{margin:0}</style></head><body><h1>Windows → Mac</h1><p>LAN MCP connection verified.</p><p>Encrypted · authenticated by setup key</p></body></html>',capture:false,presentation:{intent:'deliver',size:'base'}});checks.push('remote widget creation');
 const inspection=await tool('penecho_inspect_session',{sessionId:session.sessionId});assert(inspection.browser.artifacts.some(a=>a.artifactId==='lan-acceptance'));checks.push('read back created artifact');
 await tool('penecho_close_session',{sessionId:session.sessionId});checks.push('close session');
 process.stdout.write(JSON.stringify({ok:true,platform:process.platform,checks})+'\n');
})().catch(error=>{process.stderr.write(`LAN acceptance failed: ${error.message}; completed: ${checks.join(", ")}\n`);process.exitCode=1;}).finally(()=>{child.stdin.end();child.kill();});
