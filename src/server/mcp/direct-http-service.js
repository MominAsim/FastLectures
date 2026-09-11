"use strict";
const https = require('node:https');
const {listenMcp} = require('./listen.js');
const crypto = require('node:crypto');
const {loadDirectHttpIdentity, createDirectHttpLeaf, resetDirectHttpIdentity} = require('./direct-http-identity.js');
const {lanAddresses, isPrivateAddress} = require('./network-addresses.js');
const {createAnnouncer} = require('./lan-discovery.js');
const {INSTRUCTIONS, PROMPTS, PROTOCOL_VERSION, promptResult, captureToolResult} = require('./stdio.js');
const {TOOLS, validateToolArguments} = require('./schema.js');
const {RESOURCES, readResource} = require('./resources.js');
const {getAuthoringGuidance} = require('./authoring-guidance.js');
const normal = value => ({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const fault = (status, message) => Object.assign(new Error(message), {status});
const keyOf = id => `${typeof id}:${id}`;
function send(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff', ...headers});
  res.end(value === undefined ? undefined : JSON.stringify(value));
}
function createDirectHttpService({preferredPort=3922,getHostnames=()=>{const host=require('node:os').hostname().toLowerCase().replace(/\.$/,'');return host.endsWith('.local')?[host]:[host,host+'.local'];},stateDirectory, callTool, disposeOwner, getAddresses = lanAddresses, announce = createAnnouncer, now = Date.now, onChange = () => {}, sessionIdleMs = 30 * 60 * 1000, maxSessions = 256, maxSessionRequests = 8, maxRequests = 32}) {
  if(!Number.isInteger(preferredPort)||preferredPort<0||preferredPort>65535)throw new TypeError('Invalid preferred MCP port');
  const hostnames=[...new Set(getHostnames())].filter(host=>typeof host==='string'&&/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.local)?$/i.test(host)).map(host=>host.toLowerCase());
  let identity, server, announcer, timer, startedAt, addresses = [], transition = Promise.resolve(), active = 0;
  const sessions = new Map(), sockets = new Set();
  const limits = {sessions:maxSessions,requestsPerSession:maxSessionRequests,requests:maxRequests,tcpConnections:512};
  const timeouts = {sessionIdleMs,pressureIdleMs:60000,keepAliveMs:5000,headersMs:10000,requestUploadMs:15000};
  const notify = () => { try { onChange(); } catch {} };
  const currentAddresses = () => [...new Set(getAddresses().filter(isPrivateAddress))].sort();
  function refresh() {
    const next = currentAddresses();
    if (JSON.stringify(next) !== JSON.stringify(addresses)) {
      if (server) server.setSecureContext(createDirectHttpLeaf(identity, next, hostnames));
      addresses = next; notify();
    }
  }
  function remove(session) {
    if (!sessions.delete(session.id)) return;
    for (const pending of session.pending.values()) pending.abort();
    try { Promise.resolve(disposeOwner(session.ownerId)).catch(() => {}); } catch {}
    notify();
  }
  function prune() { for (const s of sessions.values()) if (!s.active && now() - s.lastSeen >= sessionIdleMs) remove(s); }
  function status() {
    if (server?.listening) { refresh(); prune(); }
    const port = server?.address()?.port;
    return {enabled:!!port, preferredUrl:port&&hostnames.length?`https://${hostnames[0]}:${port}/mcp`:'', urls:port ? addresses.map(a => `https://${a}:${port}/mcp`) : [], localUrl:port ? `https://127.0.0.1:${port}/mcp` : '', hostId:identity?.hostId || '', certificatePem:identity?.certificatePem || '', accessToken:identity?.accessToken || '', startedAt:startedAt || null, sessionCount:sessions.size,limits:{...limits},timeouts:{...timeouts}};
  }
  function toolFailure(error) {
    const redact = value => String(value).split(identity.accessToken).join('[redacted]').split(identity.key).join('[redacted]').replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted]');
    const failure = {code:redact(error.code || 'mcp_error').slice(0,80),message:redact(error.message || 'Tool failed').slice(0,1000)};
    // Walk a bounded plain JSON subset: details can guide recovery without carrying secrets or huge data.
    let budget = 8192;
    const clean = (value, depth = 0) => {
      if (budget <= 0 || depth > 6) return '[truncated]';
      if (value === null || typeof value === 'boolean' || typeof value === 'number') { budget -= 16; return value; }
      if (typeof value === 'string') { const text = redact(value).slice(0, Math.min(2000,budget)); budget -= text.length; return text; }
      if (!value || typeof value !== 'object') return undefined;
      const output = Array.isArray(value) ? [] : {};
      for (const key of Object.keys(value).slice(0,64)) {
        if (budget <= 0) break;
        const safeKey = redact(key).slice(0,120); budget -= safeKey.length;
        if (/token|secret|password|authorization|private.?key/i.test(key)) output[safeKey] = '[redacted]';
        else Object.defineProperty(output,safeKey,{value:clean(value[key],depth + 1),enumerable:true,configurable:true,writable:true});
      }
      return output;
    };
    if (error.details !== undefined) { try { failure.details = clean(error.details); if (Buffer.byteLength(JSON.stringify(failure.details) || '') > 16384) failure.details = '[truncated]'; } catch { failure.details = '[unavailable]'; } }
    return failure;
  }
  async function rpc(body, session, signal) {
    const result = value => ({jsonrpc:'2.0',id:body.id,result:value});
    const error = (code, message) => ({jsonrpc:'2.0',id:body.id,error:{code,message}});
    switch (body.method) {
      case 'initialize': return result({protocolVersion:PROTOCOL_VERSION,capabilities:{tools:{listChanged:false},prompts:{listChanged:false},resources:{subscribe:false,listChanged:false}},serverInfo:{name:'PenEcho',version:'1.0.0'},instructions:INSTRUCTIONS});
      case 'ping': return result({});
      case 'tools/list': return result({tools:TOOLS});
      case 'prompts/list': return result({prompts:PROMPTS});
      case 'resources/list': return result({resources:RESOURCES});
      case 'resources/templates/list': return result({resourceTemplates:[]});
      case 'prompts/get': try { return result(promptResult(body.params?.name, body.params?.arguments || {})); } catch (e) { return error(-32602,e.message); }
      case 'resources/read': try { return result(readResource(body.params?.uri,PROMPTS)); } catch (e) { return error(e.code || -32602,e.message); }
      case 'tools/call': {
        try {
          const name = body.params?.name, args = body.params?.arguments ?? {};
          if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return error(-32602,'Invalid params');
          const value = name === 'penecho_get_guidance' ? getAuthoringGuidance(validateToolArguments(name,args).id) : await callTool(session.ownerId,name,args,{signal});
          return result(value?.image ? captureToolResult(value) : normal(value));
        } catch (e) { return result({...normal(toolFailure(e)),isError:true}); }
      }
      default: return error(-32601,'Method not found');
    }
  }
  async function handle(req, res) {
    let session, counted = false, pendingKey;
    try {
      refresh(); prune();
      const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/,'');
      const port = server.address().port;
      const hosts = new Set(['localhost','127.0.0.1',...hostnames,...addresses].map(a => `${a}:${port}`));
      if (!(address === '127.0.0.1' || isPrivateAddress(address)) || !hosts.has(String(req.headers.host||'').toLowerCase())) throw fault(403,'Forbidden');
      if (req.headers.origin !== undefined) {
        let origin; try { origin = new URL(req.headers.origin); } catch { throw fault(403,'Forbidden'); }
        if (origin.origin !== req.headers.origin || origin.protocol !== 'https:' || !hosts.has(origin.host)) throw fault(403,'Forbidden');
      }
      const expected = Buffer.from(`Bearer ${identity.accessToken}`), supplied = Buffer.from(req.headers.authorization || '');
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied,expected)) throw fault(401,'Unauthorized');
      if (req.url === '/status' && req.method === 'GET') return send(res,200,{hostId:identity.hostId,startedAt,sessionCount:sessions.size,protocolVersion:PROTOCOL_VERSION,limits:{...limits},timeouts:{...timeouts}});
      if (req.url !== '/mcp') throw fault(404,'Not found');
      if (!['POST','DELETE'].includes(req.method)) return send(res,405,{error:'Method Not Allowed'},{allow:'POST, DELETE'});
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId !== undefined) {
        session = sessions.get(sessionId);
        if (!session) throw fault(404,'Session not found');
        session.lastSeen = now();
      }
      if (req.method === 'DELETE') {
        if (req.headers['mcp-protocol-version'] !== undefined && req.headers['mcp-protocol-version'] !== PROTOCOL_VERSION) throw fault(400,'Unsupported MCP protocol version');
        if (!session) throw fault(400,'Mcp-Session-Id is required');
        remove(session); return send(res,200,{});
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fault(415,'Use application/json');
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 3 * 1024 * 1024) throw fault(413,'Request too large'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw fault(400,'Invalid JSON'); }
      if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || (body.id !== undefined && typeof body.id !== 'string' && !(typeof body.id === 'number' && Number.isFinite(body.id)))) return send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}});
      if (body.method !== 'initialize' && req.headers['mcp-protocol-version'] !== undefined && req.headers['mcp-protocol-version'] !== PROTOCOL_VERSION) throw fault(400,'Unsupported MCP protocol version');
      if (body.method === 'initialize') {
        if (session || body.id === undefined) throw fault(400,'Invalid initialize');
        if (active >= maxRequests) throw fault(429,'Busy');
        if (sessions.size >= maxSessions) {
          const idle = [...sessions.values()].filter(s => !s.active && !s.pending.size && now() - s.lastSeen >= 60000).sort((a,b) => a.lastSeen-b.lastSeen)[0];
          if (!idle) throw fault(429,'Session limit');
          remove(idle);
        }
        session = {id:crypto.randomBytes(32).toString('hex'),ownerId:crypto.randomUUID(),lastSeen:now(),active:0,pending:new Map()};
        sessions.set(session.id,session); notify();
      } else if (!session) throw fault(400,'Mcp-Session-Id is required');
      if (!sessions.has(session.id)) throw fault(404,'Session not found');
      if (body.id === undefined) {
        if (body.method === 'notifications/cancelled') session.pending.get(keyOf(body.params?.requestId))?.abort();
        return send(res,202);
      }
      if (active >= maxRequests || session.active >= maxSessionRequests) throw fault(429,'Busy');
      active++; session.active++; counted = true;
      pendingKey = keyOf(body.id);
      if (session.pending.has(pendingKey)) { pendingKey = undefined; throw fault(409,'Request ID already active'); }
      const controller = new AbortController(); session.pending.set(pendingKey,controller);
      const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({jsonrpc:'2.0',id:body.id,error:{code:-32800,message:'Request cancelled'}}), {once:true}));
      // Keep the slot occupied until the operation settles, even when cancellation wins.
      const operation = rpc(body,session,controller.signal);
      const response = await Promise.race([operation,cancelled]);
      send(res,200,response,{'mcp-session-id':session.id});
      await operation;
    } catch (e) { send(res,e.status || 500,{error:e.status ? e.message : 'MCP request failed'}); }
    finally {
      if (pendingKey && session) session.pending.delete(pendingKey);
      if (counted) { active--; if (session) { session.active--; session.lastSeen = now(); } }
    }
  }
  async function stop() {
    clearInterval(timer); timer = null;
    const old = server; server = null; startedAt = null;
    try { await announcer?.close(); } catch {} announcer = null;
    for (const session of sessions.values()) remove(session);
    for (const socket of sockets) socket.destroy(); sockets.clear();
    if (old) await new Promise(resolve => old.close(resolve));
    notify();
  }
  function enqueue(fn) { const result = transition.then(fn); transition = result.catch(() => {}); return result; }
  async function performStart() {
    if (server?.listening) return status();
    try {
      identity = loadDirectHttpIdentity(stateDirectory); addresses = currentAddresses();
      server = https.createServer({...createDirectHttpLeaf(identity,addresses,hostnames),minVersion:'TLSv1.2'},handle);
      server.requestTimeout = timeouts.requestUploadMs; server.headersTimeout = timeouts.headersMs; server.keepAliveTimeout = timeouts.keepAliveMs; server.maxConnections = limits.tcpConnections;
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      await listenMcp(server, preferredPort);
      startedAt = now();
      announcer = announce({hostId:identity.hostId,port:server.address().port,getAddresses:() => { refresh(); return addresses; },onError:() => {}});
      timer = setInterval(() => { try { refresh(); prune(); } catch {} },10000); timer.unref(); notify();
      return status();
    } catch (e) { await stop(); throw e; }
  }
  function start() { return enqueue(performStart); }
  function reset() { return enqueue(async () => {
    await stop();
    identity = resetDirectHttpIdentity(stateDirectory);
    return performStart();
  }); }
  return {start,reset,close:() => enqueue(stop),status};
}
module.exports = {createDirectHttpService};
