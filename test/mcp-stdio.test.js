"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const { recordsDirectory, writeRecord } = require("../src/server/mcp/records.js");
const { PROTOCOL_VERSION, PenEchoStdioServer } = require("../src/server/mcp/stdio.js");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) { return new Promise(resolve => server.close(resolve)); }

function outputReader(stream) {
  let buffer = "";
  const queue = [], waiters = [];
  stream.on("data", chunk => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"), line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const value = JSON.parse(line), waiter = waiters.shift();
      if (waiter) waiter(value); else queue.push(value);
    }
  });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
}

test("stdio MCP negotiates 2025-11-25, lists tools, emits image blocks, and keeps one owner id", async () => {
  const secret = crypto.randomBytes(32).toString("hex"), instanceId = crypto.randomUUID(), owners = [];
  const httpServer = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers["x-penecho-mcp-instance"], instanceId);
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      owners.push(body.ownerId);
      if (body.name === "penecho_inspect_session") return;
      let result = { instanceId, canvases:[{canvasId:"canvas-a",instanceId,title:"Board"}] };
      if (body.name === "penecho_start_session") result = {sessionId:"session-a",boardObjectId:"board-object",revision:1};
      if (body.name === "penecho_capture_widget") result = { sessionId:"session-a", artifactId:"chart", image:{mimeType:"image/png",data:"AQID",bytes:3},width:10,height:20 };
      if (body.name === "penecho_present_widget") result = { sessionId:"session-a", artifactId:"combined", objectId:"object-a", image:{mimeType:"image/png",data:"BAUG",bytes:3},width:30,height:40 };
      if (body.name === "penecho_draw") result = { sessionId:"session-a", artifactId:"drawing", objectId:"draw-a", objectIds:["draw-a"], kind:"drawing", applied:true, pixelVerified:true, image:{mimeType:"image/webp",data:"CgsM",bytes:3},width:16,height:12 };
      if (body.name === "penecho_plot") result = { sessionId:"session-a", artifactId:"plot", objectId:"plot-a", objectIds:["plot-a"], kind:"plot", applied:true, pixelVerified:false };
      if (body.name === "penecho_read_feedback") result = { sessionId:"session-a", after:0, nextCursor:1, latestCursor:1, hasMore:false, truncated:false, hasFeedback:true, changeCount:1, image:{mimeType:"image/webp",data:"BwgJ",bytes:3},pixelVerified:true,width:12,height:8 };
      const bytes = Buffer.from(JSON.stringify({ result }));
      res.writeHead(200, {"content-type":"application/json","content-length":bytes.length}).end(bytes);
    });
  });
  const address = await listen(httpServer), input = new PassThrough(), output = new PassThrough(), next = outputReader(output);
  const stdio = new PenEchoStdioServer({ input, output, record:{ instanceId, secret, port:address.port, host:"127.0.0.1" } }).start();
  const send = value => input.write(`${JSON.stringify(value)}\n`);
  send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:PROTOCOL_VERSION,capabilities:{},clientInfo:{name:"test",version:"1"}}});
  const initialized = await next();
  assert.equal(initialized.result.protocolVersion, PROTOCOL_VERSION);
  assert.match(initialized.result.instructions, /Never send private chain-of-thought/);
  assert.match(initialized.result.instructions, /preserve the unread cursor/);
  assert.match(initialized.result.instructions, /proactively present useful UI previews/);
  assert.match(initialized.result.instructions, /skip decorative output and routine edits/);
  assert.match(initialized.result.instructions, /capture:false for ordinary presentation/);
  assert.match(initialized.result.instructions, /image-input tokens/);
  assert.match(initialized.result.instructions, /penecho_draw for native Canvas text/);
  assert.match(initialized.result.instructions, /not iframe Widgets/);
  send({jsonrpc:"2.0",method:"notifications/initialized"});
  send({jsonrpc:"2.0",id:2,method:"tools/list",params:{}});
  const listedTools = await next();
  assert.deepEqual(listedTools.result.tools.map(tool => tool.name), ["penecho_list_canvases","penecho_start_session","penecho_update_session","penecho_present_widget","penecho_capture_widget","penecho_draw","penecho_plot","penecho_read_feedback","penecho_inspect_session","penecho_close_session"]);
  send({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"penecho_list_canvases",arguments:{}}});
  const canvases = await next();
  assert.equal(canvases.result.structuredContent.canvases[0].canvasId, "canvas-a");
  send({jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"penecho_start_session",arguments:{canvasId:"canvas-a",instanceId,title:"Work"}}});
  const started = await next();
  assert.equal(started.result.structuredContent.sessionId, "session-a");
  send({jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"penecho_capture_widget",arguments:{sessionId:"session-a",artifactId:"chart",quality:"detail"}}});
  const capture = await next();
  assert.deepEqual(capture.result.content[0], {type:"image",data:"AQID",mimeType:"image/png"});
  assert.deepEqual(capture.result.structuredContent.image, {mimeType:"image/png",bytes:3});
  assert.equal(capture.result.structuredContent.image.data, undefined);
  send({jsonrpc:"2.0",id:6,method:"tools/call",params:{name:"penecho_present_widget",arguments:{sessionId:"session-a",artifactId:"combined",title:"Combined",html:"<p>Combined</p>",capture:true,quality:"basic"}}});
  const combined = await next();
  assert.deepEqual(combined.result.content[0], {type:"image",data:"BAUG",mimeType:"image/png"});
  assert.equal(combined.result.structuredContent.objectId, "object-a");
  assert.equal(combined.result.structuredContent.image.data, undefined);
  send({jsonrpc:"2.0",id:9,method:"tools/call",params:{name:"penecho_draw",arguments:{sessionId:"session-a",artifactId:"drawing",title:"Drawing",items:[{id:"n",type:"rect"}],capture:true}}});
  const drawing = await next();
  assert.deepEqual(drawing.result.content[0], {type:"image",data:"CgsM",mimeType:"image/webp"});
  assert.deepEqual(drawing.result.structuredContent.objectIds, ["draw-a"]);
  assert.equal(drawing.result.structuredContent.kind, "drawing");
  assert.equal(drawing.result.structuredContent.image.data, undefined);
  send({jsonrpc:"2.0",id:10,method:"tools/call",params:{name:"penecho_plot",arguments:{sessionId:"session-a",artifactId:"plot",title:"Plot",expression:"x*x"}}});
  const plot = await next();
  assert.deepEqual(plot.result.structuredContent.objectIds, ["plot-a"]);
  assert.equal(plot.result.structuredContent.kind, "plot");
  assert.equal(plot.result.content[0].type, "text");
  send({jsonrpc:"2.0",id:7,method:"tools/call",params:{name:"penecho_read_feedback",arguments:{sessionId:"session-a"}}});
  const feedback = await next();
  assert.deepEqual(feedback.result.content[0], {type:"image",data:"BwgJ",mimeType:"image/webp"});
  assert.equal(feedback.result.structuredContent.entries, undefined);
  assert.equal(feedback.result.structuredContent.hasFeedback, true);
  assert.equal(feedback.result.structuredContent.changeCount, 1);
  assert.equal(feedback.result.structuredContent.pixelVerified, true);
  assert.equal(feedback.result.structuredContent.image.data, undefined);
  assert.equal(owners.length, 7);
  assert.equal(new Set(owners).size, 1);
  send({jsonrpc:"2.0",id:8,method:"tools/call",params:{name:"penecho_inspect_session",arguments:{sessionId:"session-a"}}});
  send({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:8,reason:"test"}});
  const cancelled = await next();
  assert.deepEqual(cancelled, {jsonrpc:"2.0",id:8,error:{code:-32800,message:"Request cancelled"}});
  stdio.close();
  input.end();
  await close(httpServer);
});

test("stdio framing rejects malformed JSON without writing logs around protocol messages", async () => {
  const input = new PassThrough(), output = new PassThrough(), next = outputReader(output);
  const stdio = new PenEchoStdioServer({ input, output, record:{instanceId:crypto.randomUUID(),secret:crypto.randomBytes(32).toString("hex"),port:1,host:"127.0.0.1"} }).start();
  input.write("{broken}\n");
  const response = await next();
  assert.deepEqual(response, {jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}});
  stdio.close();
});

test("stdio starts before PenEcho, discovers multiple live instances, and pins sessions to the selected instance", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "penecho-stdio-discovery-"));
  const input = new PassThrough(), output = new PassThrough(), next = outputReader(output);
  const stdio = new PenEchoStdioServer({ input, output, stateDirectory }).start();
  const send = value => input.write(`${JSON.stringify(value)}\n`);
  send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:PROTOCOL_VERSION,capabilities:{},clientInfo:{name:"test",version:"1"}}});
  assert.equal((await next()).result.protocolVersion, PROTOCOL_VERSION);
  send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"penecho_list_canvases",arguments:{}}});
  assert.deepEqual((await next()).result.structuredContent, {canvases:[]});

  const requests = [[], []], servers = [], records = [];
  for (let index = 0; index < 2; index++) {
    const instanceId = crypto.randomUUID(), secret = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests[index].push(body);
        let result = {instanceId,canvases:[{canvasId:`canvas-${index}`,instanceId,title:`Board ${index}`}]};
        if (body.name === "penecho_start_session") result = {sessionId:`session-${index}`,boardObjectId:`object-${index}`,revision:1};
        if (body.name === "penecho_update_session") result = {accepted:true,applied:false,pixelVerified:false};
        const bytes = Buffer.from(JSON.stringify({result}));
        res.writeHead(200,{"content-type":"application/json","content-length":bytes.length}).end(bytes);
      });
    });
    const address = await listen(server);
    servers.push(server);
    records.push({version:1,instanceId,pid:process.pid,host:"127.0.0.1",port:address.port,secret,rootDirectory:process.cwd(),startedAt:Date.now()+index});
    writeRecord(recordsDirectory(stateDirectory), records[index]);
  }
  send({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"penecho_list_canvases",arguments:{}}});
  const discovered = await next();
  assert.deepEqual(discovered.result.structuredContent.canvases.map(item => item.canvasId).sort(), ["canvas-0","canvas-1"]);
  send({jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"penecho_start_session",arguments:{canvasId:"canvas-1",instanceId:records[1].instanceId,title:"Pinned"}}});
  assert.equal((await next()).result.structuredContent.sessionId, "session-1");
  send({jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"penecho_update_session",arguments:{sessionId:"session-1",summary:"Exact instance"}}});
  assert.equal((await next()).result.structuredContent.applied, false);
  assert.equal(requests[0].some(item => item.name === "penecho_update_session"), false);
  assert.equal(requests[1].some(item => item.name === "penecho_update_session"), true);
  stdio.close();
  input.end();
  for (const server of servers) await close(server);
  fs.rmSync(stateDirectory, {recursive:true,force:true});
});

test("penecho mcp enters stdio directly without an app banner or model preflight", {timeout:5_000}, async () => {
  assert.match(require("../src/cli/main.js").helpText(), /penecho mcp \[--state-directory DIR\]/);
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "penecho-cli-mcp-"));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../cli.js"), "mcp", "--state-directory", stateDirectory], {
    cwd:path.resolve(__dirname, ".."),
    env:{...process.env},
    stdio:["pipe", "pipe", "pipe"],
  });
  const next = outputReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({code,signal}));
  });
  try {
    child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:PROTOCOL_VERSION,capabilities:{},clientInfo:{name:"entry-test",version:"1"}}})}\n`);
    const initialized = await next();
    assert.equal(initialized.result.protocolVersion, PROTOCOL_VERSION);
    child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})}\n`);
    const tools = await next();
    assert.equal(tools.result.tools.some(tool => tool.name === "penecho_list_canvases"), true);
    child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"penecho_list_canvases",arguments:{}}})}\n`);
    assert.deepEqual((await next()).result.structuredContent, {canvases:[]});
    child.stdin.end();
    const result = await exit;
    assert.deepEqual(result, {code:0,signal:null});
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    fs.rmSync(stateDirectory, {recursive:true,force:true});
  }
});
