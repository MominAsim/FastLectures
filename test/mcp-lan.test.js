'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const https=require('node:https');const crypto=require('node:crypto');
const {createLanService,createLanCertificate,isPrivateAddress}=require('../src/server/mcp/lan-service');
function request(state,path,body,token,headers={}) {return new Promise((resolve,reject)=>{const port=new URL(state.urls[0]).port;const r=https.request({hostname:'127.0.0.1',port,path,method:'POST',rejectUnauthorized:false,headers:{host:`192.168.1.9:${port}`,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:data?JSON.parse(data):null}));});r.on('error',reject);r.end(JSON.stringify(body));});}
test('certificate is parseable self-signed EC and fingerprint pins DER',()=>{const c=createLanCertificate(),x=new crypto.X509Certificate(c.cert);assert(x.verify(x.publicKey));assert.equal(c.fingerprint,crypto.createHash('sha256').update(x.raw).digest('hex'));assert(isPrivateAddress('172.31.2.1'));assert(!isPrivateAddress('172.32.2.1'));assert(!isPrivateAddress('8.8.8.8'));});
test('HTTPS pairing authenticates before discovery, isolates owners and revokes on disable',async t=>{
 const owners=[],disposed=[];const lan=createLanService({getAddresses:()=>['192.168.1.9'],disposeOwner:id=>disposed.push(id),callTool:async(owner,name)=>{owners.push(owner);return {name};}});t.after(()=>lan.close());let state=await lan.action({action:'enable'});
 const rpc=(token,method='tools/list',params)=>request(state,'/mcp',{jsonrpc:'2.0',id:1,method,params},token);
 assert.equal((await rpc()).status,401);
 assert.equal((await request(state,'/pair',{clientId:crypto.randomUUID(),name:'AI'})).status,403);
 assert.equal((await request(state,'/pair',{invitation:state.fingerprint,clientId:crypto.randomUUID(),name:'AI'})).status,403);
 assert.equal((await request(state,'/pair',{invitation:'bad',clientId:crypto.randomUUID(),name:'AI'})).status,403);assert.equal(lan.status().pending,undefined);
 assert.equal((await request(state,'/pair',{},null,{origin:'http://evil'})).status,403);
 assert.equal((await request(state,'/pair',{},null,{host:'evil.test'})).status,403);
 async function pair(name){const id=crypto.randomUUID();const p=(await request(state,'/pair',{invitation:state.invitation,clientId:id,name})).body;assert.equal(p.status,'approved');assert.deepEqual(Object.keys(p).sort(),['idleSuspend','leaseSeconds','status','token']);assert.match(p.token,/^[a-f0-9]{64}$/);assert.equal((await request(state,'/pair/status',{})).status,404);assert.equal((await request(state,'/pair',{invitation:state.invitation,clientId:id,name})).status,409);return p.token;}

 const a=await pair('one'),b=await pair('two');assert.equal((await rpc(a)).body.error.code,-32002);
 for(const token of [a,b]){assert((await rpc(token,'initialize')).body.result.instructions);const tools=(await rpc(token)).body.result.tools;assert(tools.length>5);assert.equal(tools.find(t=>t.name==='penecho_list_canvases').annotations.readOnlyHint,true);assert((await rpc(token,'prompts/list')).body.result.prompts.length>0);await rpc(token,'tools/call',{name:'penecho_list_canvases',arguments:{}});}
 const {RESOURCES,DISCOVERY_URI,SKILL_URI}=require('../src/server/mcp/resources');
 assert.equal((await rpc(undefined,'resources/list')).status,401);
 const fresh=await pair('resources');assert.equal((await rpc(fresh,'resources/list')).body.error.code,-32002);
 assert.deepEqual((await rpc(fresh,'initialize')).body.result.capabilities.resources,{subscribe:false,listChanged:false});
 assert.deepEqual((await rpc(fresh,'resources/list')).body.result.resources,RESOURCES);
 assert.deepEqual((await rpc(fresh,'resources/templates/list')).body.result,{resourceTemplates:[]});
 const discovery=(await rpc(fresh,'resources/read',{uri:DISCOVERY_URI})).body.result.contents[0];
 for(const tool of (await rpc(fresh)).body.result.tools)assert(discovery.text.includes(tool.name));
 assert.match((await rpc(fresh,'resources/read',{uri:SKILL_URI})).body.result.contents[0].text,/画布/);
 for(const params of [{uri:'penecho://missing'}, {}, {uri:42}])assert.equal((await rpc(fresh,'resources/read',params)).body.error.code,-32602);
 assert.notEqual(owners[0],owners[1]);
 assert.equal((await rpc(a)).status,200);assert.equal(lan.status().pending,undefined);assert.equal(lan.status().pairingBlocked,undefined);
 const old=state;await lan.action({action:'disable'});assert.equal(disposed.length,3);state=await lan.action({action:'enable'});assert.equal((await rpc(a)).status,401);assert.equal(state.invitation,old.invitation);
});
test('enable requires an opted-in Canvas and a private interface',async()=>{for(const options of [{canEnable:()=>false,getAddresses:()=>['192.168.1.1']},{getAddresses:()=>[]}]){const lan=createLanService({...options,callTool:()=>{},disposeOwner:()=>{}});await assert.rejects(lan.action({action:'enable'}),{status:409});assert.equal(lan.status().enabled,false);await lan.close();}});
test('host authorization, real Canvas owner isolation, guidance and opt-out cleanup',async t=>{
 const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {WebSocket}=require('ws');const {createMcpService}=require('../src/server/mcp/service');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-lan-'));let service;const server=http.createServer((req,res)=>{void service.handleHttp(req,res);});
 service=createMcpService({autoStartHttp:false,server,registryStateDirectory:dir,authorizeBrowser:req=>req.headers['x-browser']==='yes'?null:'Forbidden',lanAddresses:()=>['192.168.1.9']});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));service.register(server.address());
 t.after(async()=>{await service.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 function host(action,authorized=true){return new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/mcp/lan',method:'POST',headers:{'content-type':'application/json',...(authorized?{'x-browser':'yes'}:{})}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});r.on('error',reject);r.end(JSON.stringify(action));});}
 assert.equal((await host({action:'enable'},false)).status,403);assert.equal((await host({action:'enable'})).status,409);assert.equal(service.status(false).lan,undefined);
 const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/mcp/canvas`,{headers:{'x-browser':'yes'}});t.after(()=>ws.terminate());
 let notifications=0;await new Promise((resolve,reject)=>{ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({type:'hello',canvasId:'canvas-a',title:'Test'})));ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='ready')resolve();if(m.type==='lan-status-changed')notifications++;if(m.type==='call')ws.send(JSON.stringify({type:'result',requestId:m.requestId,ok:true,result:{sessionId:m.arguments.sessionId,revision:1,boardObjectId:null,documentId:'doc'}}));});});
 const state=(await host({action:'enable'})).body.lan;
 const downloaded=await new Promise((resolve,reject)=>http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/mcp/lan-client.js'},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(Buffer.concat(chunks)));}).on('error',reject));assert.equal(crypto.createHash('sha256').update(downloaded).digest('hex'),state.clientSha256);assert(downloaded.includes(Buffer.from('function discover')));
 const rpc=(token,method,params)=>request(state,'/mcp',{jsonrpc:'2.0',id:1,method,params},token);
 async function pair(){const p=(await request(state,'/pair',{invitation:state.invitation,clientId:crypto.randomUUID(),name:'AI'})).body;assert.equal(p.status,'approved');const token=p.token;await rpc(token,'initialize');return token;}
 const a=await pair(),b=await pair();const opened=(await rpc(a,'tools/call',{name:'penecho_start_session',arguments:{instanceId:service.instanceId,canvasId:'canvas-a',title:'Test'}})).body.result.structuredContent;assert(opened.sessionId);
 const stolen=(await rpc(b,'tools/call',{name:'penecho_close_session',arguments:{sessionId:opened.sessionId}})).body.result;assert.equal(stolen.isError,true);assert.equal(stolen.structuredContent.code,'session_not_found');
 const guidance=(await rpc(a,'tools/call',{name:'penecho_get_guidance',arguments:{id:'general-html'}})).body.result;assert(!guidance.isError);assert(guidance.content[0].text.includes('guidance'));
 const prompt=(await rpc(a,'prompts/get',{name:'penecho_explain_selection'})).body.result;assert(prompt.messages.length);
 assert(notifications>0);ws.terminate();await new Promise(r=>ws.once('close',r));for(let i=0;i<50&&service.status().lan.enabled;i++)await new Promise(r=>setTimeout(r,10));assert.equal(service.status().lan.enabled,false);
});
test('direct authorization, client limits and serialized listener replacement',async t=>{
 const lan=createLanService({getAddresses:()=>['192.168.1.9'],disposeOwner:()=>{},callTool:()=>({})});t.after(()=>lan.close());
 const [a,b]=await Promise.all([lan.action({action:'enable'}),lan.action({action:'enable'})]);assert.deepEqual(a.urls,b.urls);
 const cert=createLanCertificate(['192.168.1.9']);assert.equal(new crypto.X509Certificate(cert.cert).checkIP('192.168.1.9'),'192.168.1.9');
 let p;for(let i=0;i<16;i++)p=(await request(a,'/pair',{invitation:a.invitation,clientId:crypto.randomUUID(),name:`AI ${i}`})).body;
 assert.equal((await request(a,'/pair',{invitation:a.invitation,clientId:crypto.randomUUID(),name:'overflow'})).status,429);
 assert.equal(p.status,'approved');assert.equal(lan.status().clients.length,16);for(const action of ['approve','reject','block'])await assert.rejects(lan.action({action}),{status:400});
 const operations=[lan.action({action:'disable'}),lan.action({action:'enable'}),lan.close(),lan.action({action:'enable'})];const results=await Promise.allSettled(operations);assert(results.every(x=>x.status==='fulfilled'));const state=lan.status();assert(state.enabled);assert(state.urls[0].match(/:\d+\/mcp$/));assert.equal((await request(state,'/mcp',{jsonrpc:'2.0',id:1,method:'initialize'})).status,401);
 await lan.close();await assert.rejects(request(state,'/mcp',{}),e=>['ECONNREFUSED','ECONNRESET'].includes(e.code));
});
test('client concurrency cannot be lowered by rejected calls and disable aborts all work',async t=>{
 let started=0,aborted=0,time=1000;const lan=createLanService({now:()=>time,getAddresses:()=>['192.168.1.9'],disposeOwner:()=>{},callTool:(_owner,_name,_args,{signal})=>new Promise((resolve,reject)=>{started++;signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancelled'));},{once:true});})});t.after(()=>lan.close());
 const state=await lan.action({action:'enable'}),p=(await request(state,'/pair',{invitation:state.invitation,clientId:crypto.randomUUID(),name:'AI'})).body;const token=p.token;
 await request(state,'/mcp',{jsonrpc:'2.0',id:1,method:'initialize'},token);
 const call=()=>request(state,'/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'penecho_list_canvases',arguments:{}}},token);
 const pending=Array.from({length:8},()=>call().catch(e=>e));for(let i=0;i<50&&started<8;i++)await new Promise(r=>setTimeout(r,10));assert.equal(started,8);
 time+=120001;
 assert.equal((await call()).status,429);assert.equal((await call()).status,429);assert.equal(started,8);assert.equal(lan.status().clients.length,1);
 await lan.close();await Promise.all(pending);assert.equal(aborted,8);
});
test('trusted setup key reconnects after restart while reset revokes both key and runtime bearers',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lan-direct-key-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const disposed=[];
 const options={stateDirectory:dir,getAddresses:()=>['192.168.1.9'],callTool:()=>({}),disposeOwner:id=>disposed.push(id),announce:()=>({close(){}})};let lan=createLanService(options);t.after(()=>lan.close());let state=await lan.action({action:'enable'});const original=state;
 const connect=invitation=>request(state,'/pair',{invitation,clientId:crypto.randomUUID(),name:'Trusted AI'});const rpc=token=>request(state,'/mcp',{jsonrpc:'2.0',id:1,method:'initialize'},token);
 const first=(await connect(original.invitation)).body;assert.equal(first.status,'approved');assert.equal((await rpc(first.token)).status,200);await lan.close();assert.equal(disposed.length,1);
 lan=createLanService(options);state=await lan.action({action:'enable'});assert.equal(state.fingerprint,original.fingerprint);assert.equal(state.invitation,original.invitation);assert.equal((await rpc(first.token)).status,401);
 const second=(await connect(original.invitation)).body;assert.equal(second.status,'approved');assert.notEqual(second.token,first.token);assert.equal((await rpc(second.token)).status,200);
 state=await lan.action({action:'reset-certificate'});assert.notEqual(state.fingerprint,original.fingerprint);assert.equal((await rpc(second.token)).status,401);assert.equal((await connect(original.invitation)).status,403);assert.equal(disposed.length,2);const third=(await connect(state.invitation)).body;assert.equal(third.status,'approved');assert.equal((await rpc(third.token)).status,200);assert.equal(lan.status().pending,undefined);assert(!JSON.stringify(lan.status()).includes(third.token));
});

test('client leases renew, expire and release capacity without restarting the host',async t=>{
 let time=1000;const disposed=[];
 const lan=createLanService({getAddresses:()=>['192.168.1.9'],disposeOwner:id=>disposed.push(id),callTool:()=>({}),now:()=>time});t.after(()=>lan.close());
 const state=await lan.action({action:'enable'});
 const pair=()=>request(state,'/pair',{invitation:state.invitation,clientId:crypto.randomUUID(),name:'Lease test'});
 const clients=[];for(let i=0;i<16;i++){const p=await pair();assert.equal(p.status,200);assert.equal(p.body.leaseSeconds,120);clients.push(p.body.token);}
 assert.equal((await pair()).status,429);
 assert.equal((await request(state,'/disconnect',{},'invalid')).status,401);
 time+=60000;assert.equal((await request(state,'/heartbeat',{},clients[0])).status,200);
 time+=60001;assert.equal((await request(state,'/heartbeat',{},clients[0])).status,200);
 assert.equal(lan.status().clients.length,1);assert.equal(disposed.length,15);
 assert.equal((await request(state,'/heartbeat',{},clients[1])).status,401);
 assert.equal((await pair()).status,200);
 assert.equal((await request(state,'/disconnect',{},clients[0])).status,200);
 assert.equal(lan.status().clients.length,1);
 assert.equal((await request(state,'/mcp',{jsonrpc:'2.0',id:1,method:'ping'},clients[0])).status,401);
 await lan.action({action:'disable'});assert.equal(lan.status().clients.length,0);
});

test('idle suspension frees a slot while retaining owner and initialization for demand resume',async t=>{
 let time=1000;const disposed=[],owners=[];
 const lan=createLanService({getAddresses:()=>['192.168.1.9'],disposeOwner:id=>disposed.push(id),callTool:owner=>{owners.push(owner);return {};},now:()=>time});t.after(()=>lan.close());
 const state=await lan.action({action:'enable'});
 const pair=()=>request(state,'/pair',{invitation:state.invitation,clientId:crypto.randomUUID(),name:'Idle test'});
 const token=(await pair()).body.token;
 const rpc=(method,params)=>request(state,'/mcp',{jsonrpc:'2.0',id:1,method,params},token);
 await rpc('initialize');await rpc('tools/call',{name:'penecho_list_canvases',arguments:{}});
 assert.equal((await request(state,'/suspend',{},token)).status,200);assert.equal(lan.status().clients.length,0);assert.equal(disposed.length,0);
 for(let i=0;i<16;i++)assert.equal((await pair()).status,200);
 assert.equal((await request(state,'/heartbeat',{},token)).status,429);
 time+=120001;
 assert.equal((await request(state,'/heartbeat',{},token)).status,200);assert.equal(lan.status().clients.length,1);
 assert.equal((await rpc('tools/call',{name:'penecho_list_canvases',arguments:{}})).status,200);assert.equal(owners[0],owners[1]);
 await request(state,'/suspend',{},token);assert.equal((await request(state,'/disconnect',{},token)).status,200);
 assert.equal((await request(state,'/heartbeat',{},token)).status,401);
 const expiring=(await pair()).body.token;await request(state,'/suspend',{},expiring);time+=30*60*1000;
 assert.equal((await request(state,'/heartbeat',{},expiring)).status,401);
});

test('remote adapter parks and resumes against the real host without losing logical owner',async t=>{
 const {PassThrough}=require('node:stream');const {RemoteMcpClient}=require('../src/server/mcp/remote-client.js');
 const owners=[];const lan=createLanService({getAddresses:()=>['192.168.1.9'],disposeOwner:()=>{},callTool:owner=>{owners.push(owner);return {ok:true};}});t.after(()=>lan.close());
 const state=await lan.action({action:'enable'}),input=new PassThrough(),output=new PassThrough();let buffer='';const responses=[];
 output.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){responses.push(JSON.parse(buffer.slice(0,at)));buffer=buffer.slice(at+1);}});
 const client=new RemoteMcpClient({remoteUrl:state.urls[0],fingerprint:state.fingerprint,invitation:state.invitation,input,output,errorOutput:new PassThrough(),request:async({url,body,headers})=>{
   const result=await request(state,url.pathname,JSON.parse(body),headers.authorization?.replace(/^Bearer /,''));return {statusCode:result.status,headers:{'content-type':'application/json'},body:result.body?Buffer.from(JSON.stringify(result.body)):Buffer.alloc(0)};
 }});client.idleTimeoutMs=20;t.after(()=>client.close());client.start();
 const wait=async predicate=>{for(let i=0;i<200&&!predicate();i++)await new Promise(r=>setTimeout(r,5));assert.ok(predicate());};
 const send=(id,method,params)=>input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 assert.equal(lan.status().clients.length,0);
 send(1,'initialize',{});await wait(()=>responses.some(r=>r.id===1));
 send(2,'tools/call',{name:'penecho_list_canvases',arguments:{}});await wait(()=>responses.some(r=>r.id===2));
 await wait(()=>lan.status().clients.length===0&&!client.recovery);
 send(3,'tools/call',{name:'penecho_list_canvases',arguments:{}});await wait(()=>responses.some(r=>r.id===3));
 assert.equal(owners.length,2);assert.equal(owners[0],owners[1]);assert.ok(responses.every(r=>!r.error));
 input.end();await client.done;assert.equal(lan.status().clients.length,0);
});
