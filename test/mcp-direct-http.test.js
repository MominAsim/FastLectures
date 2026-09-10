'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const {createDirectHttpService} = require('../src/server/mcp/direct-http-service.js');
function request(status, body, options = {}) {
  return new Promise((resolve,reject) => {
    const req = https.request(status.localUrl.replace('/mcp',options.path || '/mcp'), {method:options.method || 'POST',ca:status.certificatePem,agent:false,servername:options.servername,headers:{authorization:`Bearer ${status.accessToken}`,'content-type':'application/json',...(options.session ? {'mcp-session-id':options.session} : {}),...options.headers}}, res => {
      let data = ''; res.on('data',c => data += c); res.on('end',() => resolve({status:res.statusCode,headers:res.headers,body:data ? JSON.parse(data) : null,certificate:req.socket.getPeerCertificate().raw}));
    }); req.on('error',reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const message = (method,id = 1,params) => ({jsonrpc:'2.0',method,id,params});
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'penecho-direct-test-'));
  const disposed = []; const service = createDirectHttpService({preferredPort:0,getHostnames:()=>[],stateDirectory:directory,getAddresses:() => [],announce:() => ({close(){}}),callTool:async ownerId => ({ownerId}),disposeOwner:id => disposed.push(id),...options});
  t.after(async () => { await service.close(); fs.rmSync(directory,{recursive:true,force:true}); });
  return {service,status:await service.start(),directory,disposed};
}
test('trusted HTTPS, auth, host, discovery, independent sessions and restart identity',async t => {
  const {service,status,directory,disposed} = await fixture(t);
  assert.equal((await request(status,message('initialize'),{headers:{authorization:''}})).status,401);
  assert.equal((await request(status,message('initialize'),{servername:'localhost',headers:{host:'attacker.test'}})).status,403);
  assert.equal((await request(status,message('initialize'),{headers:{origin:'https://attacker.test'}})).status,403);
  const first = await request(status,message('initialize')); const second = await request(status,message('initialize'));
  for(const pem of [status.certificatePem,first.certificate])assert.equal(Date.parse(new crypto.X509Certificate(pem).validTo),Date.parse('9999-12-31T23:59:59Z'));
  assert.equal(first.body.result.protocolVersion,'2025-11-25');
  const a = first.headers['mcp-session-id'], b = second.headers['mcp-session-id']; assert.notEqual(a,b);
  assert.ok((await request(status,message('tools/list'),{session:a})).body.result.tools.length);
  const calls = await Promise.all([a,b].map(session => request(status,message('tools/call',77,{name:'penecho_list_canvases'}),{session})));
  assert.notEqual(calls[0].body.result.structuredContent.ownerId,calls[1].body.result.structuredContent.ownerId);
  assert.equal((await request(status,message('ping'))).status,400);
  assert.equal((await request(status,undefined,{method:'GET'})).status,405);
  const summary = await request(status,undefined,{method:'GET',path:'/status'}); assert.equal(summary.body.hostId,status.hostId); assert.equal(summary.body.accessToken,undefined);
  assert.equal((await request(status,undefined,{session:a,method:'DELETE'})).status,200);
  assert.equal((await request(status,message('ping'),{session:a})).status,404); assert.equal(disposed.length,1);
  const stored = path.join(directory,'direct-http','identity.json'); assert.equal(fs.statSync(stored).mode & 0o777,0o600);
  await service.close(); const next = await service.start(); assert.equal(next.accessToken,status.accessToken); assert.equal(next.hostId,status.hostId);
  const restarted = await request(next,message('initialize')); assert.notDeepEqual(first.certificate,restarted.certificate);
});
test('upgrading retains an existing finite-lived CA and token without silently resetting trust',async t => {
  const vm = require('node:vm');
  const modulePath = require.resolve('../src/server/mcp/direct-http-identity.js');
  const legacy = {exports:{}};
  vm.runInNewContext(fs.readFileSync(modulePath,'utf8').replace("Date.parse('9999-12-31T23:59:59Z')", "Date.now() + 3650 * 86400000"), {require,module:legacy,Buffer,process});
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'penecho-existing-ca-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const existing = legacy.exports.loadDirectHttpIdentity(directory);
  const file = path.join(directory,'direct-http','identity.json'), before = fs.readFileSync(file);
  const current = require(modulePath).loadDirectHttpIdentity(directory);
  assert.equal(current.hostId,existing.hostId); assert.equal(current.accessToken,existing.accessToken);
  assert.equal(current.certificatePem,existing.certificatePem); assert.deepEqual(fs.readFileSync(file),before);
});
test('IP refresh leaf retains CA trust and session expiry disposes owner',async t => {
  let addresses = [], clock = 100;
  const {service,status,disposed} = await fixture(t,{getAddresses:() => addresses,now:() => clock,sessionIdleMs:10});
  const initial = await request(status,message('initialize')); const session = initial.headers['mcp-session-id'];
  addresses = ['192.168.42.8']; service.status();
  const refreshed = await request(status,message('ping'),{session});
  const cert = new crypto.X509Certificate(refreshed.certificate); assert.equal(cert.checkIP('192.168.42.8'),'192.168.42.8'); assert.equal(cert.verify(new crypto.X509Certificate(status.certificatePem).publicKey),true);
  clock = 111; assert.equal((await request(status,message('ping'),{session})).status,404); assert.equal(disposed.length,1);
});
test('cancellation is session-scoped; capacity remains protected until work settles',async t => {
  const pending = []; let clock = 0;
  const {status,service} = await fixture(t,{now:() => clock,sessionIdleMs:10,maxSessionRequests:1,maxRequests:2,callTool:(ownerId,name,args,{signal}) => new Promise(resolve => pending.push({ownerId,signal,resolve}))});
  const a = (await request(status,message('initialize'))).headers['mcp-session-id'];
  const b = (await request(status,message('initialize'))).headers['mcp-session-id'];
  const one = request(status,message('tools/call',7,{name:'test'}),{session:a});
  const two = request(status,message('tools/call',7,{name:'test'}),{session:b});
  while(pending.length < 2) await new Promise(resolve => setTimeout(resolve,5));
  clock = 100; assert.equal(service.status().sessionCount,2);
  assert.equal((await request(status,message('ping',8),{session:a})).status,429);
  assert.equal((await request(status,{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:7}},{session:a})).status,202);
  assert.equal((await one).body.error.code,-32800);
  assert.equal(pending.filter(p => p.signal.aborted).length,1);
  assert.equal((await request(status,message('ping',8),{session:a})).status,429);
  pending.forEach(p => p.resolve({done:true})); assert.equal((await two).body.result.structuredContent.done,true);
});
test('session bound and invalid stored identity fail closed',async t => {
  const {service,status,directory} = await fixture(t,{maxSessions:1});
  assert.equal((await request(status,message('initialize'))).status,200);
  assert.equal((await request(status,message('initialize'))).status,429);
  await service.close();
  const file = path.join(directory,'direct-http','identity.json'); const value = JSON.parse(fs.readFileSync(file)); value.key = crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'pkcs8'}); fs.writeFileSync(file,JSON.stringify(value));
  await assert.rejects(service.start(),/identity is invalid/); assert.equal(service.status().enabled,false);
});
test('HTTP disconnect does not cancel a tool; service shutdown cancels it',async t => {
  let operation;
  const {service,status} = await fixture(t,{callTool:(owner,name,args,{signal}) => new Promise(resolve => { operation = {signal,resolve}; })});
  const session = (await request(status,message('initialize'))).headers['mcp-session-id'];
  const req = https.request(status.localUrl,{method:'POST',ca:status.certificatePem,agent:false,headers:{authorization:`Bearer ${status.accessToken}`,'content-type':'application/json','mcp-session-id':session}});
  req.on('error',() => {}); req.end(JSON.stringify(message('tools/call',1,{name:'test'})));
  while (!operation) await new Promise(resolve => setTimeout(resolve,5));
  req.destroy(); await new Promise(resolve => setTimeout(resolve,10)); assert.equal(operation.signal.aborted,false);
  await service.close(); assert.equal(operation.signal.aborted,true); operation.resolve({done:true});
});
test('concurrent processes atomically publish one shared identity',async t => {
  const {execFile} = require('node:child_process'); const {promisify} = require('node:util');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'penecho-direct-race-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const modulePath = path.resolve(__dirname,'../src/server/mcp/direct-http-identity.js');
  const script = `const x=require(process.argv[1]).loadDirectHttpIdentity(process.argv[2]); process.stdout.write(JSON.stringify({hostId:x.hostId,token:x.accessToken}));`;
  const values = await Promise.all(Array.from({length:4},() => promisify(execFile)(process.execPath,['-e',script,modulePath,directory])));
  assert.equal(new Set(values.map(v => v.stdout)).size,1);
  assert.deepEqual(fs.readdirSync(path.join(directory,'direct-http')),['identity.json']);
});
test('identity rejects symlinks and oversized files without changing external modes',async t => {
  const {loadDirectHttpIdentity} = require('../src/server/mcp/direct-http-identity.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'penecho-direct-files-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const external = path.join(directory,'external'); fs.mkdirSync(external,{mode:0o755});
  const state = path.join(directory,'state'); fs.mkdirSync(state);
  fs.symlinkSync(external,path.join(state,'direct-http'));
  assert.throws(() => loadDirectHttpIdentity(state),/invalid/); assert.equal(fs.statSync(external).mode & 0o777,0o755);
  fs.unlinkSync(path.join(state,'direct-http')); fs.mkdirSync(path.join(state,'direct-http'));
  const outside = path.join(external,'outside.json'); fs.writeFileSync(outside,'{}',{mode:0o644});
  const file = path.join(state,'direct-http','identity.json'); fs.symlinkSync(outside,file);
  assert.throws(() => loadDirectHttpIdentity(state),/invalid/); assert.equal(fs.statSync(outside).mode & 0o777,0o644);
  fs.unlinkSync(file); fs.writeFileSync(file,'x'.repeat(65537)); assert.throws(() => loadDirectHttpIdentity(state),/invalid/);
});
test('leaf does not rotate on a monthly timer and unsupported protocol does not dispatch',async t => {
  let clock = 0, calls = 0;
  const {service,status} = await fixture(t,{now:() => clock,callTool:async () => { calls++; return {}; }});
  const first = await request(status,message('initialize')); const session = first.headers['mcp-session-id'];
  assert.equal((await request(status,message('tools/call',2,{name:'test'}),{session,headers:{'mcp-protocol-version':'2026-07-28'}})).status,400); assert.equal(calls,0);
  assert.equal((await request(status,message('ping'),{session,headers:{'mcp-protocol-version':'2025-11-25'}})).status,200);
  clock = 29 * 86400000; service.status();
  const current = await request(status,message('initialize')); assert.deepEqual(current.certificate,first.certificate); assert.equal(service.status().hostId,status.hostId);
});
test('tool recovery details remain available, bounded and redact credentials',async t => {
  let detail;
  const {status} = await fixture(t,{callTool:async () => { throw Object.assign(new Error('Recover connection'),{code:'BROWSER_DISCONNECTED',details:detail}); }});
  const session = (await request(status,message('initialize'))).headers['mcp-session-id'];
  detail = {recoverable:true,instanceId:'instance-a',nested:{accessToken:status.accessToken,text:`secret ${status.accessToken}`},long:'x'.repeat(100000)};
  const response = await request(status,message('tools/call',3,{name:'test'}),{session});
  const failure = response.body.result.structuredContent;
  assert.equal(failure.details.recoverable,true); assert.equal(failure.details.instanceId,'instance-a'); assert.equal(failure.details.nested.accessToken,'[redacted]');
  assert.equal(JSON.stringify(failure).includes(status.accessToken),false); assert.ok(Buffer.byteLength(JSON.stringify(failure.details)) <= 16384);
});
test('explicit reset replaces CA and token, disposes sessions and survives restart',async t => {
  const {service,status,directory,disposed} = await fixture(t);
  const oldLan = path.join(directory,'lan-identity.json'); fs.writeFileSync(oldLan,'legacy identity stays');
  const session = (await request(status,message('initialize'))).headers['mcp-session-id'];
  const next = await service.reset(); assert.equal(next.enabled,true);
  assert.notEqual(next.hostId,status.hostId); assert.notEqual(next.accessToken,status.accessToken); assert.equal(next.sessionCount,0); assert.equal(disposed.length,1);
  assert.equal((await request(next,message('initialize'),{headers:{authorization:`Bearer ${status.accessToken}`}})).status,401);
  assert.equal((await request(next,message('ping'),{session})).status,404);
  assert.equal((await request(next,message('initialize'))).status,200);
  await assert.rejects(request({...next,certificatePem:status.certificatePem},message('initialize')));
  await service.close(); const restarted = await service.start(); assert.equal(restarted.hostId,next.hostId); assert.equal(restarted.accessToken,next.accessToken);
  assert.equal(fs.readFileSync(oldLan,'utf8'),'legacy identity stays');
  await service.close(); const file = path.join(directory,'direct-http','identity.json'); fs.writeFileSync(file,'broken');
  await assert.rejects(service.start(),/invalid/); const repaired = await service.reset(); assert.equal(repaired.enabled,true); assert.notEqual(repaired.hostId,next.hostId);
});
test('capacity pressure evicts only sufficiently idle sessions; active work and fresh sessions survive',async t=>{
  let clock=0, operation;
  const {service,status,disposed}=await fixture(t,{now:()=>clock,maxSessions:2,callTool:()=>new Promise(resolve=>{operation=resolve;})});
  const a=(await request(status,message('initialize'))).headers['mcp-session-id'];
  const b=(await request(status,message('initialize'))).headers['mcp-session-id'];
  clock=30000;assert.equal((await request(status,message('initialize'))).status,429);
  clock=61000;await request(status,message('ping'),{session:b});
  const c=(await request(status,message('initialize'))).headers['mcp-session-id'];
  assert.equal((await request(status,message('ping'),{session:a})).status,404);assert.equal(disposed.length,1);
  const ongoing=request(status,message('tools/call',9,{name:'test'}),{session:b});while(!operation)await new Promise(resolve=>setTimeout(resolve,5));
  clock=122000;assert.equal((await request(status,message('initialize'))).status,200);
  assert.equal((await request(status,message('ping'),{session:c})).status,404);assert.equal(service.status().sessionCount,2);
  assert.equal((await request(status,message('initialize'))).status,429);
  operation({done:true});assert.equal((await ongoing).body.result.structuredContent.done,true);
  assert.equal((await request(status,undefined,{method:'DELETE',session:b})).status,200);assert.equal(service.status().sessionCount,1);
});
test('TCP capacity is independent of protocol sessions and status reports bounded timeouts',async t=>{
  const tls=require('node:tls');const {status}=await fixture(t);
  const sockets=[];t.after(()=>sockets.forEach(socket=>socket.destroy()));
  const summary=await request(status,undefined,{method:'GET',path:'/status'});
  assert.deepEqual(summary.body.limits,{sessions:256,requestsPerSession:8,requests:32,tcpConnections:512});
  assert.deepEqual(summary.body.timeouts,{sessionIdleMs:1800000,pressureIdleMs:60000,keepAliveMs:5000,headersMs:10000,requestUploadMs:15000});
  const port=Number(new URL(status.localUrl).port);
  await Promise.all(Array.from({length:65},()=>new Promise((resolve,reject)=>{
    const socket=tls.connect({host:'127.0.0.1',port,ca:status.certificatePem},resolve);sockets.push(socket);socket.on('error',reject);
  })));
  assert.equal((await request(status,message('initialize'))).status,200);
});
test('preferred port is reused across restarts with machine hostname TLS and Host allowlist',async t=>{
 const net=require('node:net'),reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'0.0.0.0',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const {service,status}=await fixture(t,{preferredPort:port,getHostnames:()=>['mcp-test-box','mcp-test-box.local']});assert.equal(new URL(status.localUrl).port,String(port));assert.equal(status.preferredUrl,`https://mcp-test-box:${port}/mcp`);
 const response=await request(status,message('initialize'),{servername:'mcp-test-box.local',headers:{host:`mcp-test-box.local:${port}`}});assert.equal(response.status,200);const cert=new crypto.X509Certificate(response.certificate);assert.equal(cert.checkHost('mcp-test-box.local'),'mcp-test-box.local');assert.equal(cert.checkHost('mcp-test-box'),'mcp-test-box');
 assert.equal((await request(status,message('initialize'),{servername:'localhost',headers:{host:`not-this-box:${port}`}})).status,403);
 await service.close();const restarted=await service.start();assert.equal(new URL(restarted.localUrl).port,String(port));assert.equal(restarted.hostId,status.hostId);
});
test('occupied preferred port falls back to an available listener',async t=>{
 const net=require('node:net'),occupied=net.createServer();await new Promise(resolve=>occupied.listen(0,'0.0.0.0',resolve));t.after(()=>new Promise(resolve=>occupied.close(resolve)));const port=occupied.address().port;
 const {status}=await fixture(t,{preferredPort:port,getHostnames:()=>['mcp-test-box']});assert.notEqual(new URL(status.localUrl).port,String(port));assert.equal((await request(status,message('initialize'))).status,200);assert.equal(occupied.listening,true);
});
