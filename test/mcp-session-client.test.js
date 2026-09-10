'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PassThrough}=require('node:stream');
const {createSessionClient}=require('../src/server/mcp/session-client.js');
const {createDirectHttpService}=require('../src/server/mcp/direct-http-service.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await wait(10);}throw Error('Timed out');}
function streams(){const stdin=new PassThrough(),stdout=new PassThrough(),messages=[];let buf='';stdout.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\n'))>=0){messages.push(JSON.parse(buf.slice(0,n)));buf=buf.slice(n+1);}});return {stdin,stdout,messages};}
function send(io,id,method,params){io.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');}
test('HTTPS bridge forwards, recovers expired owner and releases on idle and EOF',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'penecho-session-'));let clock=0;const disposed=[];
 const service=createDirectHttpService({stateDirectory:directory,preferredPort:0,getHostnames:()=>[],getAddresses:()=>[],announce:()=>({close(){}}),now:()=>clock,sessionIdleMs:10,disposeOwner:id=>disposed.push(id),callTool:async(ownerId,name,args)=>({ownerId,name,args})});
 const status=await service.start(),io=streams();let exit=false;
 const client=createSessionClient({...io,hostId:status.hostId,loadCredentials:()=>status,resolveEndpoint:async()=>({url:status.localUrl}),idleTimeoutMs:40,tickMs:5,onExit:()=>{exit=true;}});
 t.after(async()=>{await client.close();await service.close();fs.rmSync(directory,{recursive:true,force:true});});
 send(io,1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});await until(()=>io.messages.length===1);assert.ok(io.messages[0].result);const original=client.sessionId;
 send(io,2,'tools/list');await until(()=>io.messages.length===2);assert.ok(io.messages[1].result.tools.length);
 clock=11;send(io,3,'tools/call',{name:'penecho_list_canvases',arguments:{}});await until(()=>io.messages.length===3);assert.ok(io.messages[2].result.structuredContent.ownerId);assert.notEqual(client.sessionId,original);
 await until(()=>!client.sessionId&&disposed.length>=2);assert.ok(disposed.length>=2);assert.equal(exit,false);
 send(io,4,'ping');await until(()=>io.messages.length===4);assert.ok(io.messages[3].result);io.stdin.end();await until(()=>exit);assert.equal(client.sessionId,undefined);
});
test('ambiguous mutation failure is not replayed and pending work protects idle',async t=>{
 const io=streams();let calls=0,finish,exit=false;
 const client=createSessionClient({...io,loadCredentials:()=>({}),resolveEndpoint:async()=>({url:'https://127.0.0.1/mcp'}),idleExitMs:20,tickMs:2,onExit:()=>exit=true,request:async(url,creds,message)=>{
 if(message?.method==='initialize')return {status:200,session:'a',body:{result:{protocolVersion:'2025-11-25'}}};
 if(message?.method==='tools/call'){calls++;await new Promise(r=>finish=r);throw Object.assign(Error('socket closed'),{dispatched:true});}return {status:202};}});
 t.after(()=>client.close());send(io,1,'initialize',{});send(io,2,'tools/call',{name:'mutation'});await until(()=>calls===1);await wait(45);assert.equal(exit,false);finish();await until(()=>io.messages.length===2);assert.match(io.messages[1].error.message,/may have completed/);assert.equal(calls,1);await until(()=>exit);
});
test('idle exit closes an actual child process while parent holds stdin open',async()=>{
 const {spawn}=require('node:child_process');const child=spawn(process.execPath,[path.join(__dirname,'../src/server/mcp/session-client.js'),'--host-id','a'.repeat(64),'--idle-exit-ms','30'],{stdio:['pipe','pipe','pipe']});
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('child did not exit'));},3000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});child.once('error',reject);});assert.equal(code,0);
});
test('Canvas session recovery preserves document and maps original session ID',async t=>{
 const io=streams(),calls=[];let owner=0,expired=false,resolutions=0;
 const client=createSessionClient({...io,loadCredentials:()=>({}),resolveEndpoint:async()=>{resolutions++;return {url:'https://127.0.0.1/mcp'};},request:async(url,creds,message,sid)=>{
 if(message?.method==='initialize')return {status:200,session:`owner-${++owner}`,body:{result:{protocolVersion:'2025-11-25'}}};
 if(expired&&sid===`owner-${owner}`){expired=false;return {status:404};}
 if(message?.method==='tools/call'){calls.push(message.params);return {status:200,body:{jsonrpc:'2.0',id:message.id,result:{structuredContent:message.params.name==='penecho_start_session'?{sessionId:`canvas-${owner}`,documentId:'doc-1'}:{sessionId:message.params.arguments.sessionId}}}};}
 return {status:202};}});t.after(()=>client.close());
 send(io,1,'initialize',{});send(io,2,'tools/call',{name:'penecho_start_session',arguments:{client:'codex',sessionKey:'stable',target:'current'}});await until(()=>io.messages.length===2);expired=true;
 send(io,3,'tools/call',{name:'penecho_get_canvas',arguments:{sessionId:'canvas-1'}});await until(()=>io.messages.length===3);assert.equal(io.messages[2].result.structuredContent.sessionId,'canvas-1');assert.equal(calls[1].arguments.sessionKey,'stable');assert.equal(calls[1].arguments.documentId,'doc-1');assert.equal(calls[1].arguments.target,undefined);
 expired=true;send(io,4,'tools/call',{name:'penecho_get_canvas',arguments:{sessionId:'canvas-1'}});await until(()=>io.messages.length===4);assert.equal(io.messages[3].result.structuredContent.sessionId,'canvas-1');assert.equal(calls.at(-1).arguments.sessionId,'canvas-3');assert.equal(client.rememberedCount,1);assert.equal(resolutions,3);
});
test('failed initialize can retry, credentials are redacted, and closed queued work drains',async t=>{
 const io=streams();let attempts=0,resolutions=0;const token='secret-access-token',certificate='private-certificate';
 const client=createSessionClient({...io,loadCredentials:()=>({accessToken:token,certificatePem:certificate}),resolveEndpoint:async()=>{resolutions++;return {url:'https://127.0.0.1/mcp'};},request:async(url,creds,message)=>{
 if(message?.method==='initialize'){if(++attempts===1)throw Error(`bad ${token} ${certificate} -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----`);return {status:200,session:'owner',body:{result:{}}};}return {status:202};}});t.after(()=>client.close());
 send(io,1,'initialize',{});await until(()=>io.messages.length===1);assert.doesNotMatch(io.messages[0].error.message,/secret-access-token|private-certificate|abc/);
 send(io,2,'initialize',{});await until(()=>io.messages.length===2);assert.deepEqual(io.messages[1].result,{});assert.equal(resolutions,2);
 send(io,3,'ping');send(io,4,'ping');await client.close();await until(()=>client.pendingCount===0);
});
test('remembered handles are capped before dispatch and successful close frees capacity',async t=>{
 const io=streams();let starts=0;
 const client=createSessionClient({...io,loadCredentials:()=>({}),resolveEndpoint:async()=>({url:'https://127.0.0.1/mcp'}),request:async(url,creds,message)=>{
 if(message?.method==='initialize')return {status:200,session:'owner',body:{result:{}}};
 if(message?.params?.name==='penecho_start_session')return {status:200,body:{jsonrpc:'2.0',id:message.id,result:{structuredContent:{sessionId:`s${++starts}`,documentId:'doc'}}}};
 return {status:200,body:{jsonrpc:'2.0',id:message?.id,result:{}}};}});t.after(()=>client.close());
 send(io,1,'initialize',{});await until(()=>io.messages.length===1);
 for(let n=0;n<128;n++){send(io,n+2,'tools/call',{name:'penecho_start_session',arguments:{sessionKey:`k${n}`}});await until(()=>io.messages.length===n+2);}
 send(io,130,'tools/call',{name:'penecho_start_session',arguments:{sessionKey:'overflow'}});await until(()=>io.messages.length===130);assert.match(io.messages.at(-1).error.message,/128/);assert.equal(starts,128);assert.equal(client.rememberedCount,128);
 send(io,131,'tools/call',{name:'penecho_close_session',arguments:{sessionId:'s1'}});await until(()=>io.messages.length===131);assert.equal(client.rememberedCount,127);
});
test('periodic transport pings do not prevent idle process exit',async t=>{
 const io=streams();let clock=0,exit=false;
 const client=createSessionClient({...io,now:()=>clock,idleExitMs:60,tickMs:2,onExit:()=>exit=true,loadCredentials:()=>({}),resolveEndpoint:async()=>({url:'https://127.0.0.1/mcp'}),request:async(url,creds,message)=>message?.method==='initialize'?{status:200,session:'owner',body:{result:{}}}:{status:200,body:{jsonrpc:'2.0',id:message?.id,result:{}}}});t.after(()=>client.close());
 send(io,1,'initialize',{});await until(()=>io.messages.length===1);
 for(let n=1;n<=3;n++){clock=n*15;send(io,n+1,'ping');await until(()=>io.messages.length===n+1);assert.equal(exit,false);}
 clock=61;send(io,5,'ping');await until(()=>exit);assert.equal(client.sessionId,undefined);
});
test('same live CLI reconnects through updated cache then discovery after idle HTTP release, preserving document',async t=>{
 const discovery=require('../src/server/mcp/discovery-client.js');const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'penecho-idle-reconnect-'));let clock=0,current,discoveries=0;const attempts=[];
 const service=createDirectHttpService({stateDirectory:directory,preferredPort:0,getHostnames:()=>[],getAddresses:()=>[],announce:()=>({close(){}}),disposeOwner:()=>{},callTool:async(owner,name,args)=>name==='penecho_start_session'?{sessionId:`business-${owner}`,documentId:'persistent-doc'}:{sessionId:args.sessionId,documentId:'persistent-doc'}});
 current=await service.start();const first=current.localUrl;const stateDirectory=path.join(directory,'client');discovery.importCredentials({...current,initialUrl:first,addresses:[first]},{stateDirectory});const io=streams();let exited=false;
 const client=createSessionClient({...io,hostId:current.hostId,stateDirectory,now:()=>clock,idleTimeoutMs:10,tickMs:2,onExit:()=>exited=true,resolveEndpoint:opts=>discovery.resolveEndpoint({...opts,request:async(url,settings)=>{attempts.push(url);return discovery.requestStatus(url,settings);},discover:async()=>{discoveries++;return [current.localUrl];}})});
 t.after(async()=>{await client.close();await service.close();fs.rmSync(directory,{recursive:true,force:true});});
 send(io,1,'initialize',{});send(io,2,'tools/call',{name:'penecho_start_session',arguments:{client:'test',sessionKey:'persistent-key'}});await until(()=>io.messages.length===2);const original=io.messages[1].result.structuredContent.sessionId;
 clock=20;await until(()=>!client.sessionId&&service.status().sessionCount===0);assert.equal(exited,false);await service.close();current=await service.start();assert.notEqual(current.localUrl,first);const second=current.localUrl;fs.writeFileSync(path.join(stateDirectory,'hosts',current.hostId,'endpoint.json'),JSON.stringify({hostId:current.hostId,url:second}));attempts.length=0;
 send(io,3,'tools/call',{name:'penecho_get_canvas',arguments:{sessionId:original}});await until(()=>io.messages.length===3);assert.equal(io.messages[2].result.structuredContent.documentId,'persistent-doc');assert.equal(io.messages[2].result.structuredContent.sessionId,original);assert.deepEqual(attempts,[first,second]);assert.equal(discoveries,0);
 clock=40;await until(()=>!client.sessionId&&service.status().sessionCount===0);await service.close();current=await service.start();assert.notEqual(current.localUrl,second);attempts.length=0;
 send(io,4,'tools/call',{name:'penecho_get_canvas',arguments:{sessionId:original}});await until(()=>io.messages.length===4);assert.equal(io.messages[3].result.structuredContent.documentId,'persistent-doc');assert.equal(io.messages[3].result.structuredContent.sessionId,original);assert.deepEqual(attempts,[second,current.localUrl]);assert.equal(discoveries,1);assert.equal(exited,false);
});
test('offline then online recovers on next call without exiting or replaying ambiguous mutations',async t=>{
 const io=streams();let online=true,failMutation=false,init=0,mutations=0,exited=false;const client=createSessionClient({...io,onExit:()=>exited=true,loadCredentials:()=>({}),resolveEndpoint:async()=>{if(!online)throw Error('offline');return {url:'https://127.0.0.1/mcp'};},request:async(url,credentials,message)=>{
 if(!online)throw Object.assign(Error('offline'),{dispatched:false});if(message?.method==='initialize')return {status:200,session:`owner-${++init}`,body:{result:{}}};if(message?.method==='tools/call'){mutations++;if(failMutation){failMutation=false;throw Object.assign(Error('response lost'),{dispatched:true});}}return {status:200,body:{jsonrpc:'2.0',id:message?.id,result:{}}};}});t.after(()=>client.close());
 send(io,1,'initialize',{});await until(()=>io.messages.length===1);online=false;send(io,2,'ping');await until(()=>io.messages.length===2);assert.ok(io.messages[1].error);assert.equal(exited,false);
 online=true;send(io,3,'ping');await until(()=>io.messages.length===3);assert.ok(io.messages[2].result);assert.equal(init,2);
 failMutation=true;send(io,4,'tools/call',{name:'mutation'});await until(()=>io.messages.length===4);assert.match(io.messages[3].error.message,/may have completed/);assert.equal(mutations,1);assert.equal(client.sessionId,undefined);
 send(io,5,'ping');await until(()=>io.messages.length===5);assert.ok(io.messages[4].result);assert.equal(init,3);assert.equal(mutations,1);assert.equal(exited,false);
});
test('explicit business session expiry restores stable document before retrying the rejected operation',async t=>{
 const io=streams();let starts=0,mutations=0,rejections=0;const client=createSessionClient({...io,loadCredentials:()=>({}),resolveEndpoint:async()=>({url:'https://127.0.0.1/mcp'}),request:async(url,credentials,message)=>{
 if(message?.method==='initialize')return {status:200,session:'owner',body:{result:{}}};if(message?.method!=='tools/call')return {status:202};let result;
 if(message.params.name==='penecho_start_session'){starts++;if(starts===2){assert.equal(message.params.arguments.documentId,'doc');assert.equal(message.params.arguments.sessionKey,'stable');}result={structuredContent:{sessionId:`handle-${starts}`,documentId:'doc'}};}
 else if(!rejections++){result={isError:true,structuredContent:{code:'session_expired',details:{retry:'penecho_start_session',sessionKey:'stable',documentId:'doc'}}};}
 else{mutations++;assert.equal(message.params.arguments.sessionId,'handle-2');result={structuredContent:{sessionId:'handle-2'}};}
 return {status:200,body:{jsonrpc:'2.0',id:message.id,result}};}});t.after(()=>client.close());
 send(io,1,'initialize',{});send(io,2,'tools/call',{name:'penecho_start_session',arguments:{sessionKey:'stable'}});send(io,3,'tools/call',{name:'mutation',arguments:{sessionId:'handle-1'}});await until(()=>io.messages.length===3);assert.equal(starts,2);assert.equal(mutations,1);assert.equal(io.messages[2].result.structuredContent.sessionId,'handle-1');
});
test('close during initialization deletes a late created HTTP session and drains queued requests',async()=>{
 const io=streams();let complete,deleted=0;const client=createSessionClient({...io,loadCredentials:()=>({}),resolveEndpoint:async()=>({url:'https://127.0.0.1/mcp'}),request:async(url,credentials,message,sid,options)=>{if(message?.method==='initialize')return new Promise(resolve=>{complete=()=>resolve({status:200,session:'late-owner',body:{result:{}}});});if(options.method==='DELETE'){assert.equal(sid,'late-owner');deleted++;}return {status:202};}});
 send(io,1,'initialize',{});send(io,2,'ping');await until(()=>complete);const closing=client.close();complete();await closing;await until(()=>client.pendingCount===0);assert.equal(deleted,1);assert.equal(client.sessionId,undefined);assert.equal(io.messages.length,0);
});
test('TCP TLS setup timeout is independent of a long tool deadline',async t=>{
 const net=require('node:net'),{httpRequest}=require('../src/server/mcp/session-client.js'),sockets=new Set();const server=net.createServer(socket=>sockets.add(socket));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});const started=Date.now();await assert.rejects(httpRequest(`https://127.0.0.1:${server.address().port}/mcp`,{accessToken:'test'}, {jsonrpc:'2.0',id:1,method:'tools/call'},undefined,{connectTimeoutMs:60,timeoutMs:120000}),error=>error.dispatched===false&&/TCP\/TLS/.test(error.message));assert.ok(Date.now()-started<2000);
});
test('initialization notification race retries once and persistent failure stays bounded',async t=>{
 const io=streams();let initializations=0,notifications=0,deletes=0;
 const client=createSessionClient({...io,loadCredentials:()=>({}),resolveEndpoint:async()=>({url:'https://127.0.0.1/mcp'}),request:async(url,credentials,message,sid,opts)=>{if(message?.method==='initialize')return {status:200,session:`owner-${++initializations}`,body:{result:{}}};if(message?.method==='notifications/initialized'){notifications++;return {status:404};}if(opts.method==='DELETE')deletes++;return {status:200};}});t.after(()=>client.close());send(io,1,'initialize',{});await until(()=>io.messages.length===1);assert.ok(io.messages[0].error);assert.equal(initializations,2);assert.equal(notifications,2);assert.equal(deletes,2);assert.equal(client.sessionId,undefined);
});
test('document mismatch during explicit expiry recovery never replays the original mutation',async t=>{
 const io=streams();let starts=0,operations=0;
 const client=createSessionClient({...io,loadCredentials:()=>({}),resolveEndpoint:async()=>({url:'https://127.0.0.1/mcp'}),request:async(url,credentials,message)=>{
 if(message?.method==='initialize')return {status:200,session:'owner',body:{result:{}}};if(message?.method!=='tools/call')return {status:202};
 const result=message.params.name==='penecho_start_session'?{structuredContent:{sessionId:`handle-${++starts}`,documentId:starts===1?'original':'wrong-document'}}:(operations++,{isError:true,structuredContent:{code:'session_expired',details:{retry:'penecho_start_session',documentId:'original',sessionKey:'stable'}}});return {status:200,body:{jsonrpc:'2.0',id:message.id,result}};}});t.after(()=>client.close());send(io,1,'initialize',{});send(io,2,'tools/call',{name:'penecho_start_session',arguments:{sessionKey:'stable'}});send(io,3,'tools/call',{name:'mutation',arguments:{sessionId:'handle-1'}});await until(()=>io.messages.length===3);assert.match(io.messages[2].error.message,/original document/);assert.equal(operations,1);assert.equal(starts,2);
});
test('default CLI lifetime remains open with stdin and exits on EOF',async t=>{
 const {spawn}=require('node:child_process');const child=spawn(process.execPath,[path.join(__dirname,'../src/server/mcp/session-client.js'),'--host-id','a'.repeat(64),'--idle-timeout-ms','20'],{stdio:['pipe','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill();});await wait(350);assert.equal(child.exitCode,null);child.stdin.end();const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('EOF did not stop CLI')),2000);child.once('exit',value=>{clearTimeout(timer);resolve(value);});});assert.equal(code,0);
});
