"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const https = require("node:https");
const {PassThrough, Writable} = require("node:stream");
const {test} = require("node:test");
const {createLanCertificate} = require("../src/server/mcp/lan-certificate.js");
const {
  MAX_CONCURRENT_REQUESTS,
  RemoteMcpClient,
  pinnedRequest,
  safeProtocolError,
  validateRemoteUrl,
} = require("../src/server/mcp/remote-client.js");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function outputCollector() {
  const lines = [], waiters = [];
  const output = new Writable({write(chunk, encoding, callback) {
    lines.push(...chunk.toString().split("\n").filter(Boolean));
    while (waiters.length && lines.length) waiters.shift()(JSON.parse(lines.shift()));
    callback();
  }});
  return {output, lines, next:() => lines.length ? Promise.resolve(JSON.parse(lines.shift())) : new Promise(resolve => waiters.push(resolve))};
}

function errorCollector() {
  let value = "";
  return {stream:new Writable({write(chunk, encoding, callback) { value += chunk.toString(); callback(); }}), get value() { return value; }};
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("network failures expose fixed actionable diagnostics on protocol and stderr without secrets", () => {
  for (const code of ["remote_network", "remote_timeout", "pair_timeout", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]) {
    const secret = "private-connection-key-and-address";
    const error = Object.assign(new Error(secret), {code});
    const result = safeProtocolError(42, error);
    assert.equal(result.id, 42);
    assert.equal(result.error.code, -32000);
    assert.match(result.error.message, /PenEcho.*running.*MCP and LAN access enabled/);
    assert.match(result.error.message, /firewall/);
    if (code === "remote_network") assert.match(result.error.message, /discovery.*fallback address/);
    if (["remote_timeout", "pair_timeout", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)) assert.match(result.error.message, /timed out/);
    assert.equal(result.error.message.includes(secret), false);
    const errors = errorCollector();
    const client = new RemoteMcpClient({hostId:"a".repeat(64),fingerprint:"a".repeat(64),invitation:"b".repeat(64),input:new PassThrough(),output:outputCollector().output,errorOutput:errors.stream});
    client.failPairing(error);
    assert.equal(errors.value, `PenEcho remote MCP: ${result.error.message}\n`);
  }
  assert.equal(safeProtocolError(1, Object.assign(new Error("secret"), {code:"secret-code"})).error.message, "Remote MCP request failed.");
});

test("empty or failed discovery returns actionable diagnostics for queued initialization", async () => {
  for (const discoveryFails of [false, true]) {
    const input = new PassThrough(), errors = errorCollector(), collected = outputCollector();
    const client = new RemoteMcpClient({hostId:"a".repeat(64),fingerprint:"a".repeat(64),invitation:"b".repeat(64),input,output:collected.output,errorOutput:errors.stream,
      connectionTimeoutMs:50, retryDelayMs:10,
      discover:async () => { if (discoveryFails) throw new Error("private-discovery-details"); return []; },
      request:async () => { assert.fail("no discovered host must not receive a request"); }});
    const done = client.start();
    input.write(`${JSON.stringify({jsonrpc:"2.0",id:7,method:"initialize",params:{}})}\n`);
    const result = await collected.next();
    assert.equal(client.closed, false);
    input.end();
    assert.deepEqual(await done, {code:0});
    assert.equal(result.id, 7);
    assert.match(result.error.message, /No reachable PenEcho host.*MCP and LAN.*firewall.*discovery.*fallback address/);
    assert.equal(errors.value, `PenEcho remote MCP: ${result.error.message}\n`);
    assert.doesNotMatch(errors.value, /private-discovery-details/);
    assert.equal(client.pairTimer, null);
  }
});

test("remote URLs require HTTPS, /mcp, and private or loopback IP literals", () => {
  assert.equal(validateRemoteUrl("https://127.0.0.1:3888/mcp").pathname, "/mcp");
  assert.equal(validateRemoteUrl("https://[fd12::1]:3888/mcp").hostname, "[fd12::1]");
  for (const value of [
    "http://127.0.0.1:3888/mcp",
    "https://8.8.8.8:3888/mcp",
    "https://127.0.0.1:3888/other",
    "https://127.0.0.1:3888/mcp?token=secret",
    "https://user:pass@127.0.0.1:3888/mcp",
    "https://127.0.0.1:3888/mcp#fragment",
  ]) assert.throws(() => validateRemoteUrl(value), /remote/i);
});

test("pinned TLS sends no HTTP request when the certificate pin is wrong", async t => {
  const certificate = createLanCertificate();
  let requests = 0;
  const server = https.createServer({...certificate, minVersion:"TLSv1.2"}, (req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify({ok:true}));
    });
  });
  const address = await listen(server);
  t.after(() => close(server));
  const url = validateRemoteUrl(`https://127.0.0.1:${address.port}/mcp`);
  const response = await pinnedRequest({url, fingerprint:certificate.fingerprint, headers:{authorization:"Bearer secret-token"}, body:Buffer.from(JSON.stringify({secret:"request-body"}))});
  assert.equal(response.statusCode, 200);
  assert.equal(requests, 1);
  await assert.rejects(pinnedRequest({url, fingerprint:"0".repeat(64), headers:{authorization:"Bearer should-not-arrive"}, body:Buffer.from(JSON.stringify({secret:"should-not-arrive"}))}), {code:"tls_pin_mismatch"});
  assert.equal(requests, 1, "wrong pin must fail before an HTTP request is written");
});

test("stdio input waits for pairing, preserves IDs, suppresses notifications, and polls with stable secrets", async t => {
  const certificate = createLanCertificate();
  const invitation = "1".repeat(64), token = "2".repeat(64), pollToken = "3".repeat(64), requestId = crypto.randomUUID();
  let polls = 0, pairBody, calls = 0, notificationCalls = 0;
  const server = https.createServer({...certificate, minVersion:"TLSv1.2"}, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks));
      res.setHeader("content-type", "application/json");
      if (req.url === "/pair") {
        pairBody = body;
        return res.end(JSON.stringify({status:"pending",requestId,pollToken,code:"123456"}));
      }
      if (req.url === "/pair/status") {
        assert.equal(body.requestId, requestId);
        assert.equal(body.pollToken, pollToken);
        polls++;
        return res.end(JSON.stringify(polls >= 3 ? {status:"approved",token} : {status:"pending"}));
      }
      if (req.url === "/mcp") {
        assert.equal(req.headers.authorization, `Bearer ${token}`);
        calls++;
        if (body.id === undefined) notificationCalls++;
        res.setHeader("MCP-Session-Id", "session-1");
        return res.end(JSON.stringify(body.id === undefined ? null : {jsonrpc:"2.0",id:body.id,result:{ok:true}}));
      }
      res.writeHead(404).end();
    });
  });
  const address = await listen(server);
  t.after(() => close(server));
  const input = new PassThrough(), collected = outputCollector(), errors = errorCollector();
  const client = new RemoteMcpClient({remoteUrl:`https://127.0.0.1:${address.port}/mcp`, fingerprint:certificate.fingerprint, invitation, input, output:collected.output, errorOutput:errors.stream, clientId:crypto.randomUUID()});
  const done = client.start();
  input.write("not-json\n");
  input.write(`${JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})}\n`);
  input.write(`${JSON.stringify({jsonrpc:"2.0",id:17,method:"initialize",params:{}})}\n`);
  const parseError = await collected.next();
  assert.equal(parseError.error.code, -32700);
  const response = await collected.next();
  assert.equal(response.id, 17);
  assert.deepEqual(response.result, {ok:true});
  input.end();
  assert.deepEqual(await done, {code:0});
  assert.equal(pairBody.invitation, invitation);
  assert.equal(pairBody.name, "Codex");
  assert.ok(polls >= 3);
  assert.equal(calls, 2);
  assert.equal(notificationCalls, 1);
  assert.match(errors.value, /Pairing code: 123456/);
  assert.equal(errors.value.includes(invitation), false);
  assert.equal(errors.value.includes(token), false);
});

test("stdin EOF cancels pending pairing without leaving a timer or request", async () => {
  const input = new PassThrough(), collected = outputCollector(), errors = errorCollector();
  let aborted = false;
  const request = ({signal}) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("cancelled"), {name:"AbortError",code:"remote_aborted"})); }, {once:true});
  });
  const client = new RemoteMcpClient({remoteUrl:"https://127.0.0.1:3888/mcp", fingerprint:"a".repeat(64), invitation:"b".repeat(64), input, output:collected.output, errorOutput:errors.stream, request});
  const done = client.start();
  sendInput(input, 1);
  await delay(10);
  input.end();
  assert.deepEqual(await done, {code:0});
  assert.equal(aborted, true);
});

test("remote forwarding never exceeds its bounded concurrency", async () => {
  const input = new PassThrough(), collected = outputCollector(), errors = errorCollector();
  let active = 0, maximum = 0;
  const request = ({url, signal, body}) => {
    const parsed = JSON.parse(body);
    if (url.pathname === "/pair") return Promise.resolve({statusCode:200,headers:{"content-type":"application/json"},body:Buffer.from(JSON.stringify({status:"approved",token:"c".repeat(64)}))});
    if (url.pathname !== "/mcp") return Promise.reject(new Error("unexpected path"));
    active++; maximum = Math.max(maximum, active);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        active--;
        resolve({statusCode:200,headers:{"content-type":"application/json"},body:Buffer.from(JSON.stringify({jsonrpc:"2.0",id:parsed.id,result:{ok:true}}))});
      }, 15);
      signal.addEventListener("abort", () => { clearTimeout(timer); active--; reject(Object.assign(new Error("cancelled"), {name:"AbortError",code:"remote_aborted"})); }, {once:true});
    });
  };
  const client = new RemoteMcpClient({remoteUrl:"https://127.0.0.1:3888/mcp", fingerprint:"d".repeat(64), invitation:"e".repeat(64), input, output:collected.output, errorOutput:errors.stream, request});
  const done = client.start();
  for (let id = 0; id < MAX_CONCURRENT_REQUESTS * 2; id++) input.write(`${JSON.stringify({jsonrpc:"2.0",id,method:"ping"})}\n`);
  for (let id = 0; id < MAX_CONCURRENT_REQUESTS * 2; id++) await collected.next();
  input.end();
  assert.deepEqual(await done, {code:0});
  assert.ok(maximum <= MAX_CONCURRENT_REQUESTS);
});

test("notifications/cancelled aborts an in-flight request locally", async () => {
  const input = new PassThrough(), collected = outputCollector(), errors = errorCollector();
  let aborted = false, calls = 0;
  const request = ({url, signal}) => {
    if (url.pathname === "/pair") return Promise.resolve({statusCode:200,headers:{"content-type":"application/json"},body:Buffer.from(JSON.stringify({status:"approved",token:"f".repeat(64)}))});
    calls++;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("cancelled"), {name:"AbortError",code:"remote_aborted"})); }, {once:true});
    });
  };
  const client = new RemoteMcpClient({remoteUrl:"https://127.0.0.1:3888/mcp", fingerprint:"a".repeat(64), invitation:"b".repeat(64), input, output:collected.output, errorOutput:errors.stream, request});
  const done = client.start();
  input.write(`${JSON.stringify({jsonrpc:"2.0",id:44,method:"tools/call",params:{}})}\n`);
  await delay(10);
  input.write(`${JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:44}})}\n`);
  await delay(10);
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(collected.lines.length, 0);
  input.end();
  assert.deepEqual(await done, {code:0});
});

const jsonResponse = value => ({statusCode:200,headers:{"content-type":"application/json"},body:Buffer.from(JSON.stringify(value))});
const sendInput = (input, id, method = "ping", params) => input.write(`${JSON.stringify({jsonrpc:"2.0",id,method,params})}\n`);

test("host discovery replaces stale URL and reconnects after actual server restart on a new port", async t => {
  const certificate = createLanCertificate();
  let pairs = 0, initializes = 0, currentToken = "";
  const handler = (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks));
      res.setHeader("content-type", "application/json");
      if (req.url === "/pair") { pairs++; currentToken = crypto.randomBytes(32).toString("hex"); return res.end(JSON.stringify({status:"approved",token:currentToken})); }
      if (!currentToken || req.headers.authorization !== `Bearer ${currentToken}`) { res.statusCode = 401; return res.end(JSON.stringify({error:"unauthorized"})); }
      if (body.method === "initialize") initializes++;
      res.end(JSON.stringify(body.id === undefined ? null : {jsonrpc:"2.0",id:body.id,result:{ok:true}}));
    });
  };
  let server = https.createServer(certificate, handler);
  let address = await listen(server);
  let current = `https://127.0.0.1:${address.port}/mcp`, discoveries = 0;
  const input = new PassThrough(), collected = outputCollector();
  const client = new RemoteMcpClient({remote:"https://127.0.0.1:1/mcp",hostId:certificate.fingerprint,fingerprint:certificate.fingerprint,invitation:"b".repeat(64),input,output:collected.output,errorOutput:errorCollector().stream,discover:async () => { discoveries++; return [current]; }});
  t.after(async () => { client.close(); await close(server); });
  client.start();
  sendInput(input, 1, "initialize", {protocolVersion:"2025-03-26"});
  assert.equal((await collected.next()).id, 1);
  await close(server);
  currentToken = "";
  server = https.createServer(certificate, handler);
  address = await listen(server);
  current = `https://127.0.0.1:${address.port}/mcp`;
  sendInput(input, 2, "tools/call", {name:"mutation"});
  assert.equal((await collected.next()).result.ok, true);
  sendInput(input, 3);
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(pairs, 2);
  assert.equal(initializes, 2);
  assert.equal(discoveries, 2);
});

test("concurrent definite authorization rejections coalesce recovery and transparently retry", async t => {
  const input = new PassThrough(), collected = outputCollector();
  let discoveries = 0, pairs = 0, releaseDiscovery;
  const mutations = [];
  const client = new RemoteMcpClient({hostId:"a".repeat(64),fingerprint:"a".repeat(64),invitation:"b".repeat(64),input,output:collected.output,errorOutput:errorCollector().stream,
    discover:async () => { discoveries++; if (discoveries === 2) await new Promise(resolve => { releaseDiscovery = resolve; }); return ["https://127.0.0.1:3888/mcp"]; },
    request:async ({url,body}) => {
      if (url.pathname === "/pair") { pairs++; return jsonResponse({status:"approved",token:"c".repeat(64)}); }
      const message = JSON.parse(body);
      if (message.method === "tools/call") { mutations.push(message.id); if (pairs === 1) return {statusCode:401,body:Buffer.from("unauthorized")}; }
      return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
    }});
  t.after(() => client.close());
  client.start();
  sendInput(input, 1, "tools/call"); sendInput(input, 2, "tools/call");
  await waitUntil(() => releaseDiscovery);
  assert.deepEqual(collected.lines, []);
  sendInput(input, 3);
  assert.equal(discoveries, 2);
  releaseDiscovery();
  const responses = await Promise.all([collected.next(), collected.next(), collected.next()]);
  assert.ok(responses.every(response => response.result.ok));
  assert.deepEqual(responses.map(response => response.id).sort(), [1, 2, 3]);
  assert.deepEqual(mutations, [1, 2, 1, 2]);
  assert.equal(pairs, 2);
});

test("discovered identity reset fails before invitation or HTTP headers leave adapter", async t => {
  const certificate = createLanCertificate();
  let requests = 0;
  const server = https.createServer(certificate, (req, res) => { requests++; res.end(); });
  const address = await listen(server);
  t.after(() => close(server));
  const input = new PassThrough(), errors = errorCollector();
  const client = new RemoteMcpClient({hostId:"a".repeat(64),fingerprint:"a".repeat(64),invitation:"b".repeat(64),input,output:outputCollector().output,errorOutput:errors.stream,discover:async () => [`https://127.0.0.1:${address.port}/mcp`]});
  client.start();
  sendInput(input, 1);
  await waitUntil(() => errors.value);
  await client.close();
  assert.equal(requests, 0);
  assert.match(errors.value, /identity was reset/);
});

test("EOF aborts discovery and clears pairing deadline", async () => {
  const input = new PassThrough();
  let aborted = false;
  const client = new RemoteMcpClient({hostId:"a".repeat(64),fingerprint:"a".repeat(64),invitation:"b".repeat(64),input,output:outputCollector().output,errorOutput:errorCollector().stream,
    discover:({signal}) => new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), {name:"AbortError"})); }, {once:true}))});
  const done = client.start();
  sendInput(input, 1);
  await delay(10);
  input.end();
  assert.deepEqual(await done, {code:0});
  assert.equal(aborted, true);
  assert.equal(client.pairTimer, null);
});

test("host-id must match exact configured pin and URL-only arguments remain compatible", () => {
  const {parseArgs} = require("../src/server/mcp/remote-client.js");
  const flags = ["--fingerprint", "a".repeat(64), "--invitation", "b".repeat(64)];
  assert.throws(() => parseArgs(["--host-id", "c".repeat(64), ...flags]), /must equal/);
  assert.equal(parseArgs(["--host-id", "a".repeat(64), ...flags]).remote, null);
  assert.equal(parseArgs(["--remote", "https://127.0.0.1:3888/mcp", ...flags]).remote.port, "3888");
});

test("transient same-server disconnect preserves authorization when repeated pairing would conflict", async t => {
  const certificate = createLanCertificate(), token = "c".repeat(64);
  let pairs = 0, mutations = 0, initializes = 0, probes = 0;
  const server = https.createServer(certificate, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks));
      res.setHeader("content-type", "application/json");
      if (req.url === "/pair") {
        pairs++;
        if (pairs > 1) { res.statusCode = 409; return res.end(JSON.stringify({error:"Client already paired or pending"})); }
        return res.end(JSON.stringify({status:"approved",token}));
      }
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (body.method === "initialize") initializes++;
      if (body.id === "penecho-reconnect-probe") probes++;
      if (body.method === "tools/call" && body.params?.name === "disconnect") {
        mutations++;
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify(body.id === undefined ? null : {jsonrpc:"2.0",id:body.id,result:{ok:true}}));
    });
  });
  const address = await listen(server);
  const input = new PassThrough(), collected = outputCollector();
  const client = new RemoteMcpClient({hostId:certificate.fingerprint,fingerprint:certificate.fingerprint,invitation:"b".repeat(64),input,output:collected.output,errorOutput:errorCollector().stream,discover:async () => [`https://127.0.0.1:${address.port}/mcp`]});
  t.after(async () => { client.close(); await close(server); });
  client.start();
  sendInput(input, 1, "initialize", {protocolVersion:"2025-03-26"});
  assert.equal((await collected.next()).id, 1);
  sendInput(input, 2, "tools/call", {name:"disconnect"});
  assert.match((await collected.next()).error.message, /not replayed/);
  sendInput(input, 3, "tools/call", {name:"read"});
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(pairs, 1);
  assert.equal(mutations, 1);
  assert.equal(initializes, 1, "retained authorization preserves initialized session");
  assert.equal(probes, 1);
});

test("key-auth connection and restart authenticate immediately without status polling or approval", async t => {
  const input = new PassThrough(), collected = outputCollector(), errors = errorCollector();
  const invitation = "b".repeat(64), pairBodies = [], paths = [];
  let expired = false;
  const client = new RemoteMcpClient({hostId:"a".repeat(64),fingerprint:"a".repeat(64),invitation,input,output:collected.output,errorOutput:errors.stream,
    discover:async () => ["https://127.0.0.1:3888/mcp"],
    request:async ({url,body}) => {
      paths.push(url.pathname);
      const message = JSON.parse(body);
      if (url.pathname === "/pair") { pairBodies.push(message); expired = false; return jsonResponse({status:"approved",token:"c".repeat(64)}); }
      if (expired) return {statusCode:401,body:Buffer.from("unauthorized")};
      return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
    }});
  t.after(() => client.close());
  client.start();
  sendInput(input, 1, "initialize", {});
  assert.equal((await collected.next()).id, 1);
  expired = true;
  sendInput(input, 2, "tools/call", {name:"write"});
  assert.equal((await collected.next()).result.ok, true);
  sendInput(input, 3);
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(pairBodies.length, 2);
  assert.ok(pairBodies.every(body => body.invitation === invitation));
  assert.notEqual(pairBodies[0].clientId, pairBodies[1].clientId);
  assert.equal(paths.includes("/pair/status"), false);
  assert.doesNotMatch(errors.value, /approval|approve|pairing code|allow/i);
  assert.equal(errors.value.includes(invitation), false);
});

test("wrong connection key fails once without retrying candidates or leaking secrets", async () => {
  const input = new PassThrough(), errors = errorCollector(), collected = outputCollector();
  const invitation = "b".repeat(64);
  let requests = 0;
  const client = new RemoteMcpClient({hostId:"a".repeat(64),fingerprint:"a".repeat(64),invitation,input,output:collected.output,errorOutput:errors.stream,
    discover:async () => ["https://127.0.0.1:3888/mcp", "https://127.0.0.1:3999/mcp"],
    request:async () => { requests++; return {statusCode:403,body:Buffer.from(JSON.stringify({error:`Rejected ${invitation}`}))}; }});
  const done = client.start();
  sendInput(input, 1);
  assert.equal((await collected.next()).error.code, -32000);
  assert.equal(client.closed, false);
  input.end();
  assert.deepEqual(await done, {code:0});
  assert.equal(requests, 1);
  assert.match(errors.value, /rejected the connection key/i);
  assert.doesNotMatch(errors.value, /approve|allow/i);
  assert.equal(errors.value.includes(invitation), false);
  assert.equal(collected.lines.join("").includes(invitation), false);
  assert.equal(client.pairTimer, null);
});

test("remote bridge forwards new discovery methods and refreshed catalogs without configuration changes",async t=>{
  const input=new PassThrough(),collected=outputCollector();let revision=1;
  const client=new RemoteMcpClient({remoteUrl:"https://127.0.0.1:3888/mcp",fingerprint:"a".repeat(64),invitation:"b".repeat(64),input,output:collected.output,errorOutput:errorCollector().stream,
    request:async({url,body})=>{
      if(url.pathname==="/pair")return jsonResponse({status:"approved",token:"c".repeat(64)});
      const message=JSON.parse(body);
      return jsonResponse({jsonrpc:"2.0",id:message.id,result:{method:message.method,params:message.params,revision}});
    }});
  t.after(()=>client.close());client.start();
  for(const [index,method] of ['initialize','resources/list','resources/read','resources/templates/list','prompts/list','tools/list','future/catalog'].entries()){
    const params={uri:'penecho://guidance/discovery'};
    sendInput(input,index+1,method,params);
    const response=await collected.next();
    assert.deepEqual(response.result,{method,params,revision:1});
  }
  revision=2;sendInput(input,8,'tools/list',{});
  assert.equal((await collected.next()).result.revision,2);
});

async function waitUntil(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for lifecycle state");
    await delay(5);
  }
}

function lifecycleClient(request) {
  return new RemoteMcpClient({remoteUrl:"https://127.0.0.1:3888/mcp",fingerprint:"a".repeat(64),invitation:"b".repeat(64),
    input:new PassThrough(),output:outputCollector().output,errorOutput:errorCollector().stream,request,connectionTimeoutMs:500,retryDelayMs:10});
}


test("start stays offline until demand, then idle suspend and reactivation retain session", async t => {
  const paths = [], sessions = [];
  const collected = outputCollector();
  let suspends = 0;
  const client = lifecycleClient(async ({url,body,headers}) => {
    paths.push(url.pathname);
    if (url.pathname === "/pair") return jsonResponse({status:"approved",token:"c".repeat(64),leaseSeconds:120,idleSuspend:true});
    if (url.pathname === "/suspend") suspends++;
    if (url.pathname !== "/mcp") { assert.deepEqual(JSON.parse(body), {}); return jsonResponse({ok:true}); }
    const message = JSON.parse(body);
    sessions.push(headers["mcp-session-id"]);
    return {...jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}}),headers:{"mcp-session-id":"preserved-session"}};
  });
  client.output = collected.output;
  client.idleTimeoutMs = 25;
  t.after(() => client.close());
  const done = client.start();
  await delay(40);
  assert.deepEqual(paths, []);
  sendInput(client.input, 1, "initialize", {});
  assert.equal((await collected.next()).id, 1);
  await waitUntil(() => suspends === 1 && !client.recovery);
  assert.equal(client.suspended, true);
  assert.equal(client.heartbeatTimer, null);
  const count = paths.length;
  await delay(80);
  assert.equal(paths.length, count);
  sendInput(client.input, 2, "tools/call", {name:"write"});
  assert.equal((await collected.next()).id, 2);
  assert.deepEqual(paths, ["/pair", "/mcp", "/suspend", "/heartbeat", "/mcp"]);
  assert.deepEqual(sessions, [undefined, "preserved-session"]);
  client.input.end();
  assert.deepEqual(await done, {code:0});
  assert.equal(paths.at(-1), "/disconnect");
  assert.equal(client.idleTimer, null);
});

test("legacy hosts connect lazily and receive no lease lifecycle requests", async t => {
  const paths = [], collected = outputCollector();
  const client = lifecycleClient(async ({url,body}) => {
    paths.push(url.pathname);
    if (url.pathname === "/pair") return jsonResponse({status:"approved",token:"c".repeat(64)});
    const message = JSON.parse(body);
    return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start();
  sendInput(client.input, 1);
  await collected.next();
  await client.close();
  assert.deepEqual(paths, ["/pair", "/mcp"]);
});

test("active heartbeat failure stays offline until next request then recovers lease", async t => {
  let pairs = 0, beats = 0, release;
  const collected = outputCollector();
  const client = lifecycleClient(async ({url,body}) => {
    if (url.pathname === "/pair") return jsonResponse({status:"approved",token:(++pairs === 1 ? "c" : "d").repeat(64),leaseSeconds:pairs === 1 ? 0.06 : 120});
    if (url.pathname === "/heartbeat") { beats++; return {statusCode:401,body:Buffer.from("unauthorized")}; }
    if (url.pathname === "/mcp") {
      const message = JSON.parse(body);
      if (message.id === 1) await new Promise(resolve => { release = resolve; });
      return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
    }
    return jsonResponse({ok:true});
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start();
  sendInput(client.input, 1);
  await waitUntil(() => beats === 1);
  release();
  assert.equal((await collected.next()).id, 1);
  await delay(80);
  assert.equal(pairs, 1);
  assert.equal(beats, 1);
  assert.equal(client.heartbeatTimer, null);
  assert.deepEqual(collected.lines, []);
  sendInput(client.input, 2);
  assert.equal((await collected.next()).id, 2);
  assert.equal(pairs, 2);
  assert.equal(client.leaseSeconds, 120);
});

test("close aborts outstanding heartbeat and waits for bounded independent disconnect", async t => {
  let heartbeatSignal, disconnectSignal;
  const client = lifecycleClient(({url,signal}) => {
    if (url.pathname === "/pair") return Promise.resolve(jsonResponse({status:"approved",token:"c".repeat(64),leaseSeconds:0.3}));
    if (url.pathname === "/heartbeat") heartbeatSignal = signal;
    if (url.pathname === "/disconnect") disconnectSignal = signal;
    return new Promise(() => {});
  });
  t.after(() => client.close());
  client.start();
  sendInput(client.input, 1);
  await waitUntil(() => heartbeatSignal);
  const done = client.close();
  await waitUntil(() => disconnectSignal);
  assert.equal(heartbeatSignal.aborted, true);
  assert.equal(disconnectSignal.aborted, false);
  assert.equal(client.abortController.signal.aborted, true);
  assert.deepEqual(await done, {code:0});
  assert.equal(disconnectSignal.aborted, true);
  assert.equal(client.heartbeatTimer, null);
  assert.equal(client.heartbeatController, null);
});

test("busy or unreachable wakeups back off before dispatch without surfacing transient failure", async t => {
  const collected = outputCollector();
  let beats = 0, calls = 0, pairs = 0;
  const client = lifecycleClient(async ({url,body}) => {
    if (url.pathname === "/pair") { pairs++; return jsonResponse({status:"approved",token:"c".repeat(64),leaseSeconds:120,idleSuspend:true}); }
    if (url.pathname === "/heartbeat") {
      if (++beats === 1) return {statusCode:429,body:Buffer.from("busy")};
      if (beats === 2) throw Object.assign(new Error("reset"), {code:"ECONNRESET"});
    }
    if (url.pathname === "/mcp") { calls++; const message = JSON.parse(body); return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}}); }
    return jsonResponse({ok:true});
  });
  client.output = collected.output;
  client.idleTimeoutMs = 10;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1); await collected.next();
  await waitUntil(() => client.suspended && !client.recovery);
  sendInput(client.input, 2, "tools/call", {name:"write"});
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(beats, 3);
  assert.equal(calls, 2);
  assert.equal(pairs, 1);
  assert.deepEqual(collected.lines, []);
});

test("genuine connection outage fails current request but later demand can succeed", async t => {
  let online = false, pairs = 0;
  const collected = outputCollector();
  const client = lifecycleClient(async ({url,body}) => {
    if (!online) throw Object.assign(new Error("offline"), {code:"ECONNREFUSED"});
    if (url.pathname === "/pair") { pairs++; return jsonResponse({status:"approved",token:"c".repeat(64)}); }
    const message = JSON.parse(body); return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1);
  assert.ok((await collected.next()).error);
  assert.equal(client.closed, false);
  assert.equal(client.abortController.signal.aborted, false);
  online = true;
  sendInput(client.input, 2);
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(pairs, 1);
});

test("cancelled queued wakeup is not dispatched after the connection returns", async t => {
  let release, calls = 0;
  const collected = outputCollector();
  const client = lifecycleClient(async ({url,body}) => {
    if (url.pathname === "/pair") { await new Promise(resolve => { release = resolve; }); return jsonResponse({status:"approved",token:"c".repeat(64)}); }
    calls++; const message = JSON.parse(body); return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1, "tools/call");
  await waitUntil(() => release);
  client.input.write(`${JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:1}})}\n`);
  release();
  await waitUntil(() => !client.recovery);
  assert.equal(calls, 0);
  assert.deepEqual(collected.lines, []);
  assert.equal(client.pending.size, 0);
});

test("uncertain read-only discovery retries while uncertain tool mutations never replay", async t => {
  const counts = new Map(), collected = outputCollector();
  const client = lifecycleClient(async ({url,body}) => {
    if (url.pathname === "/pair") return jsonResponse({status:"approved",token:"c".repeat(64)});
    const message = JSON.parse(body);
    counts.set(message.id, (counts.get(message.id) || 0) + 1);
    if ([1, 2].includes(message.id) && counts.get(message.id) === 1) throw Object.assign(new Error("reset"), {code:"ECONNRESET"});
    return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1, "tools/list");
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(counts.get(1), 2);
  sendInput(client.input, 2, "tools/call", {name:"write"});
  assert.match((await collected.next()).error.message, /not replayed.*outcome may be unknown/);
  await delay(40);
  assert.equal(counts.get(2), 1);
  assert.equal(client.recovery, null);
  assert.deepEqual(collected.lines, []);
});

test("demand during suspend waits for parking before a single reactivation", async t => {
  let releaseSuspend, suspends = 0, beats = 0;
  const paths = [], collected = outputCollector();
  const client = lifecycleClient(async ({url,body}) => {
    paths.push(url.pathname);
    if (url.pathname === "/pair") return jsonResponse({status:"approved",token:"c".repeat(64),leaseSeconds:120,idleSuspend:true});
    if (url.pathname === "/suspend") { suspends++; await new Promise(resolve => { releaseSuspend = resolve; }); }
    if (url.pathname === "/heartbeat") beats++;
    if (url.pathname === "/mcp") { const message = JSON.parse(body); return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}}); }
    return jsonResponse({ok:true});
  });
  client.output = collected.output;
  client.idleTimeoutMs = 10;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1); await collected.next();
  await waitUntil(() => releaseSuspend);
  sendInput(client.input, 2); sendInput(client.input, 3);
  await delay(10);
  assert.equal(beats, 0);
  assert.equal(paths.filter(path => path === "/mcp").length, 1);
  releaseSuspend();
  assert.ok((await collected.next()).result.ok);
  assert.ok((await collected.next()).result.ok);
  assert.equal(beats, 1);
  assert.equal(suspends, 1);
});

test("HTTP404 for an established session reinitializes and retries definite rejection", async t => {
  let expired = false, initializes = 0, calls = 0;
  const collected = outputCollector();
  const client = lifecycleClient(async ({url,headers,body}) => {
    if (url.pathname === "/pair") return jsonResponse({status:"approved",token:"c".repeat(64),leaseSeconds:120});
    if (url.pathname !== "/mcp") return jsonResponse({ok:true});
    const message = JSON.parse(body);
    if (expired && headers["mcp-session-id"]) return {statusCode:404,body:Buffer.from("session expired")};
    if (message.method === "initialize") {
      assert.equal(headers["mcp-session-id"], undefined);
      initializes++; expired = false;
    }
    if (message.method === "tools/call") calls++;
    return {...jsonResponse(message.id === undefined ? null : {jsonrpc:"2.0",id:message.id,result:{ok:true}}),headers:{"mcp-session-id":`session-${initializes}`}};
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1, "initialize", {}); await collected.next();
  expired = true;
  sendInput(client.input, 2, "tools/call", {name:"write"});
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(initializes, 2);
  assert.equal(calls, 1);
  assert.equal(client.sessionId, "session-2");
});

test("HTTP404 without a session header remains a normal endpoint error", async t => {
  let calls = 0;
  const collected = outputCollector();
  const client = lifecycleClient(async ({url}) => {
    if (url.pathname === "/pair") return jsonResponse({status:"approved",token:"c".repeat(64)});
    calls++; return {statusCode:404,body:Buffer.from("missing endpoint")};
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1);
  assert.ok((await collected.next()).error);
  assert.equal(calls, 1);
});

test("demand recovery survives more than three transient connection failures", async t => {
  let attempts = 0;
  const collected = outputCollector();
  const client = lifecycleClient(async ({url,body}) => {
    if (url.pathname === "/pair") {
      if (++attempts <= 4) throw Object.assign(new Error("restarting"), {code:"ECONNREFUSED"});
      return jsonResponse({status:"approved",token:"c".repeat(64)});
    }
    const message = JSON.parse(body); return jsonResponse({jsonrpc:"2.0",id:message.id,result:{ok:true}});
  });
  client.output = collected.output;
  t.after(() => client.close());
  client.start(); sendInput(client.input, 1, "tools/call", {name:"write"});
  assert.equal((await collected.next()).result.ok, true);
  assert.equal(attempts, 5);
  assert.deepEqual(collected.lines, []);
});
