"use strict";
const https = require('node:https');
const os = require('node:os');
const net = require('node:net');
const {identityStore}=require('./lan-identity.js');
const {createAnnouncer}=require('./lan-discovery.js');
const crypto = require('node:crypto');
const {createLanCertificate} = require('./lan-certificate.js');
const {INSTRUCTIONS,PROMPTS,PROTOCOL_VERSION,promptResult,captureToolResult} = require('./stdio.js');
const {RESOURCES,readResource}=require('./resources.js');
const {TOOLS,validateToolArguments} = require('./schema.js');
const {getAuthoringGuidance} = require('./authoring-guidance.js');
const normal = value => ({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const normalize = address => String(address || '').replace(/^::ffff:/,'');
function isPrivateAddress(address) {
  const a = normalize(address);
  return net.isIPv4(a) && (/^10\.\d+\.\d+\.\d+$/.test(a) || /^192\.168\.\d+\.\d+$/.test(a) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(a));
}
function lanAddresses() { return [...new Set(Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && isPrivateAddress(a.address)).map(a => a.address))]; }
const error = (message,status=400) => Object.assign(new Error(message),{status});
const equal = (a,b) => { if(typeof a !== 'string' || typeof b !== 'string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && crypto.timingSafeEqual(x,y); };
function send(res,status,value) { if (res.destroyed) return; res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(JSON.stringify(value)); }
async function read(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw error('Use application/json.',415);
  const chunks=[]; let length=0;
  for await (const chunk of req) { length+=chunk.length; if(length>3*1024*1024) throw error('Request too large.',413); chunks.push(chunk); }
  try {const body=JSON.parse(Buffer.concat(chunks)); if (!body || typeof body!=='object' || Array.isArray(body)) throw 0; return body;} catch {throw error('Invalid JSON object.');}
}
function createLanService({callTool,disposeOwner,onChange=()=>{},getAddresses=lanAddresses,canEnable=()=>true,stateDirectory,announce=createAnnouncer,now=Date.now}) {
  const store=identityStore(stateDirectory);
  let identity=null,identityError=null;try{identity=store.load();}catch(e){identityError=e;}
  let announcer=null;
  let server=null, certificate=identity, addresses=[], invitation=identity?.invitation || '', timer=null, generation=0, transition=Promise.resolve();
  const clients=new Map(),parked=new Map(),rates=new Map(),controllers=new Set(),sockets=new Set();
  const leaseSeconds=120;
  function removeClient(client) {clients.delete(client.id);parked.delete(client.id);disposeOwner(client.ownerId);notify();}
  function parkClient(client) {
    clients.delete(client.id);client.parkedAt=now();parked.set(client.id,client);
    while(parked.size>128)removeClient(parked.values().next().value);
    notify();
  }
  function pruneClients() {for(const client of parked.values())if(!client.active && now()-client.parkedAt>=30*60*1000)removeClient(client);for(const client of clients.values())if(!client.active && now()-client.lastSeen>=leaseSeconds*1000)removeClient(client);}
  const notify=()=>onChange();
  function prune() { pruneClients();const time=Date.now(); for(const [id,r] of rates) if(time-r.at>60000) rates.delete(id); }
  function status() {return {enabled:!!server?.address(),urls:server?.address() ? addresses.map(a=>`https://${a}:${server.address()?.port}/mcp`) : [],identityError:!!identityError,hostId:certificate?.fingerprint || '',fingerprint:certificate?.fingerprint || '',invitation,clients:[...clients.values()].map(({id,name,address})=>({id,name,address}))};}
  async function rpc(body,client,signal) {
    const id=body.id;
    if(body.jsonrpc!=='2.0' || typeof body.method!=='string' || (id!==undefined && typeof id!=='string' && typeof id!=='number')) return {jsonrpc:'2.0',id:id??null,error:{code:-32600,message:'Invalid Request'}};
    const result=value=>({jsonrpc:'2.0',id,result:value});
    if(id===undefined) return null;
    if(body.method==='initialize') {client.initialized=true;return result({protocolVersion:PROTOCOL_VERSION,capabilities:{tools:{listChanged:false},prompts:{listChanged:false},resources:{subscribe:false,listChanged:false}},serverInfo:{name:'PenEcho',version:'1.0.0'},instructions:INSTRUCTIONS});}
    if(!client.initialized) return {jsonrpc:'2.0',id,error:{code:-32002,message:'Initialize first.'}};
    if(body.method==='ping')return result({});
    if(body.method==='tools/list')return result({tools:TOOLS});
    if(body.method==='prompts/list')return result({prompts:PROMPTS});
    if(body.method==='resources/list')return result({resources:RESOURCES});
    if(body.method==='resources/templates/list')return result({resourceTemplates:[]});
    if(body.method==='resources/read') {try{return result(readResource(body.params?.uri,PROMPTS));}catch(e){return {jsonrpc:'2.0',id,error:{code:e.code || -32602,message:e.message}};}}
    if(body.method==='prompts/get') {try{return result(promptResult(body.params?.name,body.params?.arguments || {}));}catch(e){return {jsonrpc:'2.0',id,error:{code:-32602,message:e.message}};}}
    if(body.method!=='tools/call')return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};
    try {
      const name=body.params?.name,args=body.params?.arguments ?? {};
      const value=name==='penecho_get_guidance' ? getAuthoringGuidance(validateToolArguments(name,args).id) : await callTool(client.ownerId,name,args,{signal});
      return result(value?.image ? captureToolResult(value) : normal(value));
    }catch(e){return result({...normal({code:e.code || 'mcp_error',message:e.message}),isError:true});}
  }
  async function handle(req,res) {
    let controller,client,clientCounted=false;
    try {
      addresses=getAddresses().filter(isPrivateAddress);
      const address=normalize(req.socket.remoteAddress);
      if(!(isPrivateAddress(address)||address==='127.0.0.1') || req.headers.origin !== undefined || !addresses.some(a=>req.headers.host===`${a}:${server?.address()?.port}`)) throw error('Forbidden',403);
      if(req.method!=='POST') throw error('Method Not Allowed',405);
      let rate=rates.get(address); if(!rate || Date.now()-rate.at>60000) {if(rates.size>=256)throw error('Busy',429);rates.set(address,rate={at:Date.now(),count:0});} if(++rate.count>240)throw error('Rate limit',429);
      const pathname=new URL(req.url,'https://localhost').pathname;
      if(!['/pair','/mcp','/heartbeat','/disconnect','/suspend'].includes(pathname))throw error('Not found',404);
      pruneClients();
      if(pathname!=='/pair') {client=[...clients.values(),...parked.values()].find(c=>equal(req.headers.authorization,`Bearer ${c.token}`));if(!client)throw error('Unauthorized',401);if(parked.has(client.id)&&['/mcp','/heartbeat'].includes(pathname)){if(clients.size>=16)throw error('Client limit',429);parked.delete(client.id);clients.set(client.id,client);notify();}client.lastSeen=now();if(client.active>=8)throw error('Client busy',429);client.active++;clientCounted=true;}
      if(controllers.size>=32)throw error('Busy',429);
      controller=new AbortController();controllers.add(controller);res.once('close',()=>controller.abort());
      const epoch=generation,body=await read(req); if(epoch!==generation)throw error('Disabled',503);
      if(pathname==='/suspend'){if(client.active>1)throw error('Client busy',429);parkClient(client);return send(res,200,{suspended:true});}
      if(pathname==='/heartbeat')return send(res,200,{leaseSeconds});
      if(pathname==='/disconnect'){removeClient(client);return send(res,200,{disconnected:true});}
      if(pathname==='/pair') {
        if(!equal(body.invitation,invitation))throw error('Invalid invitation',403);
        if(typeof body.clientId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientId)||typeof body.name!=='string'||!body.name.trim()||body.name.length>100)throw error('Invalid client');
        // The setup secret authorizes a new runtime bearer; public identity alone never does.
        if(clients.has(body.clientId)||parked.has(body.clientId))throw error('Client already connected',409);
        if(clients.size>=16)throw error('Client limit',429);
        const token=crypto.randomBytes(32).toString('hex');
        clients.set(body.clientId,{id:body.clientId,name:body.name.trim(),address,token,ownerId:crypto.randomUUID(),initialized:false,active:0,lastSeen:now()});
        notify();return send(res,200,{status:'approved',token,leaseSeconds,idleSuspend:true});
      }
      const value=await rpc(body,client,controller.signal);if(epoch!==generation){disposeOwner(client.ownerId);return;}return value===null ? (res.writeHead(202),res.end()) : send(res,200,value);
    }catch(e){send(res,e.status||500,{error:e.message || 'Request failed'});}finally{if(controller)controllers.delete(controller);if(clientCounted){client.active--;client.lastSeen=now();}}
  }
  async function disable() { generation++;const old=server;server=null;clearInterval(timer);timer=null;for(const c of controllers)c.abort();controllers.clear();for(const c of [...clients.values(),...parked.values()])disposeOwner(c.ownerId);clients.clear();parked.clear();rates.clear();announcer?.close();announcer=null;for(const s of sockets)s.destroy();sockets.clear();if(old)await new Promise(resolve=>old.close(resolve));notify(); }
  async function performAction(body) {
    if(body.action==='reset-certificate'){const enabled=!!server;await disable();identity=store.create();identityError=null;certificate=identity;invitation=identity.invitation;notify();return enabled?performAction({action:'enable'}):status();}
    if(body.action==='disable'){await disable();return status();}
    if(body.action==='enable') {
      if(server)return status();if(!canEnable())throw error('Enable MCP on a Canvas first.',409);
      addresses=getAddresses().filter(isPrivateAddress);if(!addresses.length)throw error('No private LAN address found. Connect this computer to Wi-Fi or Ethernet.',409);
      if(identityError)throw error('Stored LAN identity is invalid. Reset the certificate to reconnect.',409);
      if(!identity)identity=store.create();certificate=identity;invitation=identity.invitation;
      const enableEpoch=generation;
      server=https.createServer({...certificate,minVersion:'TLSv1.2'},handle);server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=64;
      server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
      try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});}catch(e){await disable();throw e;}
      if(enableEpoch!==generation || !canEnable()) {await disable();throw error('LAN enable was cancelled',409);}
      announcer=announce({hostId:certificate.fingerprint,port:server.address().port,getAddresses:()=>getAddresses().filter(isPrivateAddress),onError:()=>{}});
      timer=setInterval(()=>{prune();const next=getAddresses().filter(isPrivateAddress);if(JSON.stringify(next)!==JSON.stringify(addresses)){addresses=next;notify();}},10000);timer.unref();notify();return status();
    }
    throw error('Invalid action');
  }
  function enqueue(operation) {
    const pending=transition.then(operation);
    transition=pending.catch(()=>{});
    return pending;
  }
  function revokeImmediately() {generation++;for(const controller of controllers)controller.abort();}
  function action(body) {
    if(['disable','reset-certificate'].includes(body?.action))revokeImmediately();
    return enqueue(()=>performAction(body));
  }
  function close() {revokeImmediately();return enqueue(disable);}
  return {action,status,close};
}
module.exports={createLanService,createLanCertificate,isPrivateAddress,lanAddresses};
