'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createLanService}=require('../src/server/mcp/lan-service');
const {identityStore,validateIdentity}=require('../src/server/mcp/lan-identity');
const {parsePacket,announcement,names,privateIP,discover}=require('../src/server/mcp/lan-discovery');
test('identity persists privately across restart, disabled status and explicit reset',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lan-identity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const options={stateDirectory:dir,getAddresses:()=>['192.168.1.9'],callTool:()=>{},disposeOwner:()=>{},announce:()=>({close(){}})};
 let lan=createLanService(options);t.after(()=>lan.close());const first=await lan.action({action:'enable'});assert.equal(first.hostId,first.fingerprint);assert.match(first.hostId,/^[a-f0-9]{64}$/);await lan.close();assert.equal(lan.status().invitation,first.invitation);assert.equal(lan.status().enabled,false);assert(!JSON.stringify(lan.status()).includes('PRIVATE KEY'));
 const reset=await lan.action({action:'reset-certificate'});assert.notEqual(reset.fingerprint,first.fingerprint);assert.notEqual(reset.invitation,first.invitation);assert(!reset.enabled);
 lan=createLanService(options);const restored=lan.status();assert.equal(restored.fingerprint,reset.fingerprint);assert.equal(restored.invitation,reset.invitation);await lan.action({action:'enable'});const replaced=await lan.action({action:'reset-certificate'});assert(replaced.enabled);assert.notEqual(replaced.fingerprint,restored.fingerprint);await lan.close();
 if(process.platform!=='win32'){assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(path.join(dir,'lan-identity.json')).mode&0o777,0o600);}
 assert.deepEqual(fs.readdirSync(dir),['lan-identity.json']);
});
test('invalid persisted identity fails closed and requires explicit replacement',()=>{const store=identityStore();const first=store.create(),other=store.create();assert.throws(()=>validateIdentity({...first,key:other.key}));assert.throws(()=>validateIdentity({...first,fingerprint:'0'.repeat(64)}));assert.throws(()=>validateIdentity({...first,invitation:'bad'}));});
test('bounded DNS parser handles announcements and rejects malformed packets',()=>{
 const hostId=crypto.randomBytes(32).toString('hex'),packet=announcement(hostId,12345,['192.168.1.9','8.8.8.8']);const result=parsePacket(packet),n=names(hostId);assert(result.response);assert(result.records.some(r=>r.type===33&&r.name===n.instance&&r.value.port===12345));assert.deepEqual(result.records.filter(r=>r.type===1).map(r=>r.value),['192.168.1.9']);assert(n.instance.split('.')[0].length<=63);assert(!privateIP('10.999.1.1'));
 for(let i=0;i<packet.length;i++)assert.throws(()=>parsePacket(packet.subarray(0,i)));
 const loop=Buffer.alloc(18);loop.writeUInt16BE(1,4);loop[12]=192;loop[13]=12;assert.throws(()=>parsePacket(loop));const many=Buffer.alloc(12);many.writeUInt16BE(129,4);assert.throws(()=>parsePacket(many));
});
test('discovery respects already aborted callers',async()=>{const controller=new AbortController();controller.abort();assert.deepEqual(await discover({hostId:'a'.repeat(64),signal:controller.signal}),[]);});
test('download bundles execute without adjacent modules',()=>{const {lanClientBundle}=require('../src/server/mcp/lan-client-bundle');const {spawnSync}=require('node:child_process');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lan-bundle-'));try{const file=path.join(dir,'client.js');fs.writeFileSync(file,lanClientBundle());const result=spawnSync(process.execPath,[file,'--help'],{encoding:'utf8',timeout:5000,cwd:dir});assert(!String(result.stderr).includes('MODULE_NOT_FOUND'));assert(!result.error);assert(result.status!==null);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('discovery parses real UDP answers while retaining private-address filtering',async t=>{
 const dgram=require('node:dgram');const sender=dgram.createSocket('udp4');t.after(()=>sender.close());const hostId=crypto.randomBytes(32).toString('hex');
 const address=Object.values(os.networkInterfaces()).flat().find(a=>a?.family==='IPv4'&&privateIP(a.address))?.address;if(!address){t.skip('No private multicast interface');return;}await new Promise(resolve=>sender.bind(0,resolve));sender.setMulticastInterface(address);sender.setMulticastLoopback(true);
 const pending=discover({hostId,timeoutMs:250});await new Promise(resolve=>setTimeout(resolve,30));
 await new Promise(resolve=>sender.send(announcement(hostId,23456,['192.168.7.8']),5353,'224.0.0.251',()=>resolve()));const urls=await pending;
 assert.deepEqual(urls,['https://192.168.7.8:23456/mcp']);
});
test('Windows identity creation preserves atomic file durability without directory handles',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lan-windows-'));try{const store=identityStore(dir,{platform:'win32'});const identity=store.create();assert.deepEqual(store.load(),identity);assert.deepEqual(fs.readdirSync(dir),['lan-identity.json']);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('corrupted identity leaves host service available with an actionable reset',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lan-corrupt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'lan-identity.json'),'bad');const lan=createLanService({stateDirectory:dir,getAddresses:()=>['192.168.1.9'],callTool:()=>{},disposeOwner:()=>{}});t.after(()=>lan.close());assert.equal(lan.status().identityError,true);assert.equal(lan.status().enabled,false);await assert.rejects(lan.action({action:'enable'}),{status:409});const state=await lan.action({action:'reset-certificate'});assert.equal(state.identityError,false);assert.match(state.hostId,/^[a-f0-9]{64}$/);});
test('multihomed multicast waits for each send before changing the outgoing interface',async()=>{
 const {multicastSender}=require('../src/server/mcp/lan-discovery');const seen=[],pending=[];let current;
 const send=multicastSender({setMulticastInterface(address){current=address;},send(_packet,_port,_group,callback){pending.push(()=>{seen.push(current);callback();});}});
 const first=send(Buffer.alloc(0),['192.168.3.32','172.23.160.1']);const second=send(Buffer.alloc(0),['192.168.3.32']);await Promise.resolve();assert.equal(pending.length,1);pending.shift()();assert.equal(pending.length,1);pending.shift()();await first;await Promise.resolve();pending.shift()();await second;assert.deepEqual(seen,['192.168.3.32','172.23.160.1','192.168.3.32']);
});
