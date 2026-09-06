"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { WebSocket } = require("ws");
const { safeTraceValue } = require("../src/server/mcp/request-trace.js");
const { createMcpService } = require("../src/server/mcp/service.js");

const temporaryDirectories = [];
after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive:true, force:true }); });

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penecho-mcp-trace-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(server.address()); });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function openCanvas(port, respond) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mcp/canvas`, { headers:{ "x-test-browser":"allowed" } });
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify({ type:"hello", canvasId:"canvas-a", title:"Trace canvas" })));
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.type === "ready") { ws.off("error", reject); resolve(ws); return; }
      if (message.type !== "call") return;
      const reply = respond(message);
      ws.send(JSON.stringify({ type:"result", requestId:message.requestId, ...reply }));
    });
  });
}

function traces(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes:true })
    .filter(entry => entry.isDirectory())
    .map(entry => JSON.parse(fs.readFileSync(path.join(directory, entry.name, "trace.json"), "utf8")));
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for MCP request trace.");
}

test("disabled MCP request tracing creates no directory or serialized payload", async () => {
  const directory = tempDirectory(), traceDirectory = path.join(directory, "logs", "mcp-requests"), server = http.createServer();
  const options = {
    server,
    authorizeBrowser:() => null,
    requestTraceEnabled:false,
  };
  Object.defineProperty(options, "requestTraceDirectory", { get:() => { throw new Error("disabled tracing inspected its directory"); } });
  Object.defineProperty(options, "requestTraceLimit", { get:() => { throw new Error("disabled tracing inspected its limit"); } });
  const service = createMcpService(options);
  let payloadReads = 0;
  const untouchedInput = {};
  Object.defineProperty(untouchedInput, "secret", { enumerable:true, get:() => { payloadReads += 1; return "must-not-be-read"; } });
  await assert.rejects(service.callTool("invalid-owner", "penecho_list_canvases", untouchedInput), error => error.code === "invalid_owner");
  assert.equal(payloadReads, 0);
  const input = {};
  Object.defineProperty(input, "toJSON", { enumerable:false, value:() => { throw new Error("disabled tracing serialized the payload"); } });
  await service.callTool(crypto.randomUUID(), "penecho_list_canvases", input);
  assert.equal(fs.existsSync(traceDirectory), false);
  await service.close();
});

test("MCP trace sanitization bounds malformed nested input", () => {
  const input = { password:"nested-secret-value", image:{ mimeType:"image/png", data:"A".repeat(2_000) }, items:[] };
  let cursor = input;
  for (let index = 0; index < 1_000; index++) {
    cursor.next = { [`field-${index}-${"x".repeat(200)}`]:"value" };
    cursor = cursor.next;
    input.items.push({ index, text:"y".repeat(1_000) });
  }
  cursor.loop = input;
  const safe = safeTraceValue(input), serialized = JSON.stringify(safe);
  assert.equal(serialized.includes("nested-secret-value"), false);
  assert.equal(serialized.includes("A".repeat(100)), false);
  assert.equal(serialized.length < 100_000, true);
  assert.equal(safe.items.length, 33);
  assert.match(serialized, /truncated|omitted|limit reached|maximum depth/);
});

test("MCP trace filesystem and logger failures never change tool behavior", async () => {
  const directory = tempDirectory(), traceDirectory = path.join(directory, "trace-path"), server = http.createServer();
  fs.writeFileSync(traceDirectory, "blocks trace directory creation");
  const service = createMcpService({
    server,
    authorizeBrowser:() => null,
    requestTraceEnabled:true,
    requestTraceDirectory:traceDirectory,
    requestTraceLimit:1,
    logger:() => { throw new Error("logger unavailable"); },
  });
  const result = await service.callTool(crypto.randomUUID(), "penecho_list_canvases", {});
  assert.deepEqual(result.canvases, []);
  assert.equal(fs.readFileSync(traceDirectory, "utf8"), "blocks trace directory creation");
  await service.close();
});

test("enabled MCP request tracing records browser RPC timing, queued application, and redacts image and secret bodies", async () => {
  const directory = tempDirectory(), traceDirectory = path.join(directory, "logs", "mcp-requests"), legacyDirectory = path.join(directory, "logs", "requests");
  fs.mkdirSync(legacyDirectory, { recursive:true });
  fs.writeFileSync(path.join(legacyDirectory, "keep.txt"), "canvas agent trace area");
  const server = http.createServer(), service = createMcpService({
    server,
    authorizeBrowser:req => req.headers["x-test-browser"] === "allowed" ? null : "Forbidden",
    requestTraceEnabled:true,
    requestTraceDirectory:traceDirectory,
    requestTraceLimit:20,
  });
  const address = await listen(server), ws = await openCanvas(address.port, message => {
    if (message.name === "mcp_start_session") return { ok:true, result:{ sessionId:message.arguments.sessionId, boardObjectId:"board-object", revision:1 } };
    if (message.name === "mcp_update_session") return { ok:true, result:{ applied:true, visible:false, revision:2 } };
    if (message.name === "mcp_capture_widget") return { ok:true, result:{ dataUrl:"data:image/png;base64,AQID", mediaType:"image/png", width:1, height:1, revision:3, runtimeDiagnostics:{ authorization:"Bearer browser-secret-token" } } };
    return { ok:false, error:"unexpected browser call" };
  });
  const ownerId = crypto.randomUUID();
  const started = await service.callTool(ownerId, "penecho_start_session", { canvasId:"canvas-a", instanceId:service.instanceId, title:"authorization=client-secret-value" });
  const queued = await service.callTool(ownerId, "penecho_update_session", { sessionId:started.sessionId, summary:"Bearer update-secret-token" });
  assert.equal(queued.applied, false);
  assert.equal(queued.accepted, true);
  const updateTrace = await waitFor(() => traces(traceDirectory).find(trace => trace.request.tool === "penecho_update_session" && trace.queuedUpdate?.state === "applied"));
  assert.equal(updateTrace.outcome.applied, false);
  assert.equal(updateTrace.queuedUpdate.applied, true);
  assert.equal(updateTrace.queuedUpdate.visible, false);
  assert.equal(updateTrace.browserInteractions[0].name, "mcp_update_session");
  assert.equal(updateTrace.browserInteractions[0].status, "completed");
  assert.equal(typeof updateTrace.browserInteractions[0].durationMs, "number");
  assert.equal(typeof updateTrace.durationMs, "number");

  await service.callTool(ownerId, "penecho_capture_widget", { sessionId:started.sessionId, artifactId:"artifact-a" });
  const captureTrace = traces(traceDirectory).find(trace => trace.request.tool === "penecho_capture_widget");
  assert.equal(captureTrace.status, "completed");
  assert.equal(captureTrace.browserInteractions[0].result.dataUrl, "<encoded image omitted>");
  assert.equal(captureTrace.outcome.image.data, "<encoded image omitted>");
  const serialized = JSON.stringify(traces(traceDirectory));
  assert.equal(serialized.includes("client-secret-value"), false);
  assert.equal(serialized.includes("update-secret-token"), false);
  assert.equal(serialized.includes("browser-secret-token"), false);
  assert.equal(serialized.includes("data:image/png;base64,AQID"), false);
  assert.equal(fs.readFileSync(path.join(legacyDirectory, "keep.txt"), "utf8"), "canvas agent trace area");
  assert.deepEqual(fs.readdirSync(legacyDirectory), ["keep.txt"]);

  ws.close();
  await service.close();
  await closeServer(server);
});

test("closing the MCP service finalizes a still-queued update trace as failed", async () => {
  const directory = tempDirectory(), traceDirectory = path.join(directory, "logs", "mcp-requests"), server = http.createServer();
  const service = createMcpService({
    server,
    authorizeBrowser:req => req.headers["x-test-browser"] === "allowed" ? null : "Forbidden",
    requestTraceEnabled:true,
    requestTraceDirectory:traceDirectory,
    requestTraceLimit:10,
  });
  const address = await listen(server);
  await openCanvas(address.port, message => {
    if (message.name === "mcp_start_session") return { ok:true, result:{ sessionId:message.arguments.sessionId, boardObjectId:"board-object", revision:1 } };
    return { ok:true, result:{ applied:true, visible:true, revision:2 } };
  });
  const ownerId = crypto.randomUUID(), started = await service.callTool(ownerId, "penecho_start_session", { canvasId:"canvas-a", instanceId:service.instanceId, title:"Closing trace" });
  await service.callTool(ownerId, "penecho_update_session", { sessionId:started.sessionId, summary:"Still queued" });
  await service.close();
  const updateTrace = traces(traceDirectory).find(trace => trace.request.tool === "penecho_update_session");
  assert.equal(updateTrace.status, "completed");
  assert.equal(updateTrace.outcome.applied, false);
  assert.equal(updateTrace.queuedUpdate.state, "failed");
  assert.match(updateTrace.queuedUpdate.error, /service closed/i);
  await closeServer(server);
});

test("MCP request tracing records failures without changing errors and prunes only its own bounded directory", async () => {
  const directory = tempDirectory(), traceDirectory = path.join(directory, "logs", "mcp-requests"), server = http.createServer();
  const service = createMcpService({
    server,
    authorizeBrowser:req => req.headers["x-test-browser"] === "allowed" ? null : "Forbidden",
    requestTraceEnabled:true,
    requestTraceDirectory:traceDirectory,
    requestTraceLimit:2,
    logger:() => { throw new Error("logger unavailable"); },
  });
  const address = await listen(server), ws = await openCanvas(address.port, message => {
    if (message.name === "mcp_start_session") return { ok:true, result:{ sessionId:message.arguments.sessionId, boardObjectId:"board-object", revision:1 } };
    if (message.name === "mcp_update_session") return { ok:false, error:"apiKey=queued-update-secret" };
    if (message.name === "mcp_present_widget") return { ok:false, error:"apiKey=browser-failure-secret" };
    return { ok:true, result:{ applied:true, visible:true, revision:2 } };
  });
  const ownerId = crypto.randomUUID(), started = await service.callTool(ownerId, "penecho_start_session", { canvasId:"canvas-a", instanceId:service.instanceId, title:"Failure trace" });
  await service.callTool(ownerId, "penecho_update_session", { sessionId:started.sessionId, summary:"Queued failure" });
  const queuedFailure = await waitFor(() => traces(traceDirectory).find(trace => trace.request.tool === "penecho_update_session" && trace.queuedUpdate?.state === "failed"));
  assert.equal(queuedFailure.outcome.applied, false);
  assert.equal(queuedFailure.queuedUpdate.applied, false);
  assert.equal(JSON.stringify(queuedFailure).includes("queued-update-secret"), false);
  await assert.rejects(
    service.callTool(ownerId, "penecho_present_widget", { sessionId:started.sessionId, artifactId:"artifact-a", title:"Failure", html:`<img src="data:image/png;base64,${"A".repeat(600)}">` }),
    error => error.code === "canvas_call_failed" && error.message.includes("browser-failure-secret"),
  );
  const failedTrace = traces(traceDirectory).find(trace => trace.request.tool === "penecho_present_widget");
  assert.equal(failedTrace.status, "failed");
  assert.equal(failedTrace.browserInteractions[0].status, "failed");
  assert.equal(JSON.stringify(failedTrace).includes("browser-failure-secret"), false);
  assert.equal(JSON.stringify(failedTrace).includes("A".repeat(100)), false);

  await new Promise(resolve => setTimeout(resolve, 2));
  await service.callTool(ownerId, "penecho_list_canvases", {});
  await new Promise(resolve => setTimeout(resolve, 2));
  await service.callTool(ownerId, "penecho_list_canvases", {});
  const retained = traces(traceDirectory);
  assert.equal(retained.length, 2);
  assert.equal(retained.every(trace => trace.kind === "mcp-request"), true);

  ws.close();
  await service.close();
  await closeServer(server);
});
