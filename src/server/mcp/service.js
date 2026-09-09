"use strict";

const crypto = require("node:crypto");
const { createRemoteMcpChannels } = require("./remote.js");
const net = require("node:net");
const path = require("node:path");
const { applyPatch, parsePatch } = require("diff");
const { WebSocket, WebSocketServer } = require("ws");
const { configureClient, inspectConfiguredClients: defaultInspectConfiguredClients } = require("./configure.js");
const { SESSION_INSTRUCTIONS } = require("./guidance.js");
const { registryStateDirectory, recordsDirectory, removeRecord, writeRecord } = require("./records.js");
const { createMcpRequestTracer } = require("./request-trace.js");
const { MAX_EVENTS_PER_UPDATE, MAX_FILE_BYTES, McpBridgeError, validateToolArguments } = require("./schema.js");

const MAX_HTTP_BODY_BYTES = 3 * 1024 * 1024;
const MAX_WS_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_FEEDBACK_CAPTURE_BYTES = 700 * 1024;
const MAX_FEEDBACK_CAPTURE_EDGE = 1024;
const MAX_FEEDBACK_CAPTURE_PIXELS = 520_000;
const INSPECT_CAPTURE_POLICIES = Object.freeze({
  basic:Object.freeze({maxLongEdge:1_024,maxPixels:520_000,maxBytes:700 * 1_024}),
  detail:Object.freeze({maxLongEdge:1_440,maxPixels:1_800_000,maxBytes:1_200 * 1_024}),
});
const MAX_CANVASES = 32;
const MAX_SESSIONS = 64;
const MAX_OWNER_SESSIONS = 16;
const MAX_PENDING_CALLS = 128;
const CALL_TIMEOUT_MS = 45_000;
const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const UPDATE_DELAY_MS = 100;
const LOST_SESSION_TTL_MS = 60_000;
const MAX_PENDING_UPDATE_TRACES = 16;
const MAX_MUTATION_REQUESTS = 32;
const MAX_UNRESOLVED_PATCHES = 4;

function bridgeError(code, message, status = 400) {
  return new McpBridgeError(code, message, status);
}

function normalizedAddress(address) {
  const value = String(address || "").trim().toLowerCase().split("%", 1)[0];
  if (value.startsWith("::ffff:") && net.isIP(value.slice(7)) === 4) return value.slice(7);
  return value;
}

function isLoopback(address) {
  const value = normalizedAddress(address);
  return value === "::1" || value === "127.0.0.1" || value.startsWith("127.");
}

function sendJson(res, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type":"application/json; charset=utf-8",
    "content-length":data.length,
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
  });
  res.end(data);
}

function readJson(req, maximum = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maximum) {
        fail(bridgeError("request_too_large", "Request body is too large.", 413));
        req.resume();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
        resolve(parsed);
      } catch { reject(bridgeError("invalid_json", "Request body must be valid JSON.", 400)); }
    });
    req.on("error", fail);
  });
}

function safeString(value, max, label) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw bridgeError("invalid_browser_message", `${label} is invalid.`, 400);
  return value;
}

function authorizationMatches(header, secret) {
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(String(header || ""));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function serializeError(error) {
  return { code:String(error?.code || "mcp_bridge_error").slice(0, 80), message:String(error?.message || "PenEcho MCP request failed.").slice(0, 1_000), ...(error?.details === undefined ? {} : {details:error.details}) };
}

function safeJsonValue(value, label, maximumBytes = MAX_FILE_BYTES) {
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, "utf8") > maximumBytes) throw new Error();
    return JSON.parse(json);
  } catch { throw bridgeError("invalid_browser_result", `The PenEcho canvas returned an invalid or oversized ${label}.`, 502); }
}

// The persisted workspace retains up to 40 events (more than one update).
// Validate this response independently of the smaller per-update input limit.
function browserSessionProgress(value) {
  const progress = safeJsonValue(value, "session progress", 1_048_576);
  const invalid = () => { throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid session progress.", 502); };
  const string = (value, maximum, empty = false) => typeof value === "string" && value.length <= maximum && (empty || value.length > 0);
  if (!progress || typeof progress !== "object" || Array.isArray(progress)
    || !string(progress.title, 120, true) || !string(progress.summary, 4000, true)
    || !["working", "waiting", "done", "error"].includes(progress.status)
    || !Array.isArray(progress.steps) || progress.steps.length > 24
    || !Array.isArray(progress.events) || progress.events.length > 40) invalid();
  const steps = progress.steps.map(step => {
    if (!step || !string(step.id, 128) || !string(step.label, 160)
      || step.status !== undefined && !["pending", "working", "done", "error"].includes(step.status)) invalid();
    return {id:step.id,label:step.label,...(step.status === undefined ? {} : {status:step.status})};
  });
  const events = progress.events.map(event => {
    if (!event || !string(event.id, 128) || !string(event.text, 4000)
      || event.kind !== undefined && !["progress", "evidence", "info", "warning", "error"].includes(event.kind)) invalid();
    return {id:event.id,text:event.text,...(event.kind === undefined ? {} : {kind:event.kind})};
  });
  return {title:progress.title,status:progress.status,summary:progress.summary,steps,events};
}

function publicVirtualResult(value, label) {
  const cloned = safeJsonValue(value, label);
  const privatePathKeys = new Set(["absolutePath", "physicalPath", "hostPath", "filesystemPath", "localPath"]);
  const scrub = item => {
    if (Array.isArray(item)) return item.map(scrub);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !privatePathKeys.has(key)).map(([key, nested]) => [key, scrub(nested)]));
  };
  return scrub(cloned);
}

function safeErrorDetails(value) {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, "utf8") > 64 * 1024) return undefined;
    return JSON.parse(json);
  } catch { return undefined; }
}

function mutationSignature(args) {
  return crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

function patchVirtualFile(source, patchText, virtualPath) {
  const fileName = virtualPath.replace(/^\/+/, "");
  let parsed;
  try { parsed = parsePatch(patchText); }
  catch { throw bridgeError("invalid_patch", "patch must be a valid unified diff.", 400); }
  if (parsed.length !== 1 || parsed[0].oldFileName !== `a/${fileName}` || parsed[0].newFileName !== `b/${fileName}` || !parsed[0].hunks.length) {
    throw bridgeError("invalid_patch", `patch must modify exactly --- a/${fileName} and +++ b/${fileName}.`, 400);
  }
  const content = applyPatch(source, parsed[0], { fuzzFactor:0 });
  if (content === false) throw bridgeError("PATCH_CONFLICT", "The patch no longer applies exactly. Re-read the virtual file and create a new patch and requestId.", 409);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw bridgeError("patch_too_large", "The patched content exceeds the 800,000-byte limit.", 413);
  return content;
}

function publicCanvas(connection, instanceId) {
  return { canvasId:connection.canvasId, instanceId, title:connection.title, connectedAt:connection.connectedAt };
}

function browserRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid revision.", 502);
  return value;
}

function browserCursor(value, label = "feedback cursor") {
  if (!Number.isSafeInteger(value) || value < 0) throw bridgeError("invalid_browser_result", `The PenEcho canvas returned an invalid ${label}.`, 502);
  return value;
}

function browserObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bridgeError("invalid_browser_result", `The PenEcho canvas returned an invalid ${label}.`, 502);
  return value;
}

function browserMetadata(result) {
  const output = {};
  if (typeof result?.browserElapsedMs === "number" && Number.isFinite(result.browserElapsedMs) && result.browserElapsedMs >= 0 && result.browserElapsedMs <= 600_000) output.browserElapsedMs = result.browserElapsedMs;
  let remaining = 64 * 1024;
  for (const key of ["runtimeDiagnostics", "viewport", "mapping"]) {
    if (result?.[key] === undefined) continue;
    try {
      const json = JSON.stringify(result[key]);
      if (json && Buffer.byteLength(json, "utf8") <= remaining) {
        output[key] = JSON.parse(json);
        remaining -= Buffer.byteLength(json, "utf8");
      } else output.metadataTruncated = true;
    } catch { output.metadataTruncated = true; }
  }
  return output;
}

function browserArtifactResult(result, artifactId, kind) {
  browserObject(result, `${kind} result`);
  if (result.artifactId !== artifactId) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned a mismatched artifact.", 502);
  if (result.kind !== kind) throw bridgeError("invalid_browser_result", `The PenEcho canvas returned an invalid ${kind} artifact kind.`, 502);
  if (!Array.isArray(result.objectIds) || !result.objectIds.length || result.objectIds.length > 24) {
    throw bridgeError("invalid_browser_result", `The PenEcho canvas returned invalid ${kind} object ids.`, 502);
  }
  const objectIds = result.objectIds.map((value, index) => {
    if (typeof value !== "string" || !value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw bridgeError("invalid_browser_result", `The PenEcho canvas returned an invalid ${kind} object id at index ${index}.`, 502);
    }
    return value;
  });
  if (new Set(objectIds).size !== objectIds.length) throw bridgeError("invalid_browser_result", `The PenEcho canvas returned duplicate ${kind} object ids.`, 502);
  if (kind === "plot" && objectIds.length !== 1) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned more than one plot object.", 502);
  if (result.objectId !== undefined && result.objectId !== objectIds[0]) throw bridgeError("invalid_browser_result", `The PenEcho canvas returned a mismatched primary ${kind} object id.`, 502);
  return {
    artifactId,
    objectIds,
    objectId:objectIds[0],
    kind,
    revision:browserRevision(result.revision),
    feedbackCursor:browserCursor(result.feedbackCursor),
  };
}

function browserPrimitiveCaptureMetadata(result, image, artifactId) {
  if (result?.artifactId !== artifactId) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned a mismatched primitive capture artifact.", 502);
  const width = result?.width, height = result?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid primitive screenshot dimensions.", 502);
  }
  if (width > MAX_FEEDBACK_CAPTURE_EDGE || height > MAX_FEEDBACK_CAPTURE_EDGE || width * height > MAX_FEEDBACK_CAPTURE_PIXELS) {
    throw bridgeError("capture_too_large", "The PenEcho primitive screenshot exceeds the safe image dimensions.", 413);
  }
  if (result.encodedBytes !== undefined && (!Number.isSafeInteger(result.encodedBytes) || result.encodedBytes !== image.bytes)) {
    throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid primitive screenshot byte metadata.", 502);
  }
  return {
    width,
    height,
    ...(result.encodedBytes === undefined ? {} : { encodedBytes:result.encodedBytes }),
    ...(result.revision === undefined ? {} : { captureRevision:browserRevision(result.revision) }),
  };
}

function browserCanvasCaptureMetadata(result, image) {
  const width = result?.width, height = result?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || width > 16_384 || !Number.isSafeInteger(height) || height <= 0 || height > 16_384) {
    throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid Canvas screenshot dimensions.", 502);
  }
  if (!Number.isSafeInteger(result.encodedBytes) || result.encodedBytes <= 0 || result.encodedBytes !== image.bytes) {
    throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid Canvas screenshot byte metadata.", 502);
  }
  return { width, height, encodedBytes:result.encodedBytes, revision:browserRevision(result.revision) };
}

function browserFeedbackBounds(value, label) {
  browserObject(value, label);
  const output = {};
  for (const key of ["x", "y", "w", "h"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 1_000_000_000 || (key === "w" || key === "h") && number < 0) {
      throw bridgeError("invalid_browser_result", `The PenEcho canvas returned invalid ${label}.`, 502);
    }
    output[key] = number;
  }
  return output;
}

function browserFeedbackResult(result, sessionId, requestedAfter, limit) {
  browserObject(result, "feedback result");
  if (result.sessionId !== sessionId) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned mismatched feedback.", 502);
  const after = browserCursor(result.after, "feedback after cursor");
  if (requestedAfter !== undefined && after < requestedAfter) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned feedback from before the requested cursor.", 502);
  const nextCursor = browserCursor(result.nextCursor, "next feedback cursor");
  const latestCursor = browserCursor(result.latestCursor, "latest feedback cursor");
  if (nextCursor < after || nextCursor > latestCursor || typeof result.hasMore !== "boolean" || typeof result.truncated !== "boolean" || !Array.isArray(result.entries) || result.entries.length > limit) {
    throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid bounded feedback.", 502);
  }
  if (result.hasMore !== (nextCursor < latestCursor)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an inconsistent feedback continuation state.", 502);
  let previousCursor = after;
  const entries = result.entries.map((entry, index) => {
    browserObject(entry, `feedback entry ${index}`);
    const cursor = browserCursor(entry.cursor, `feedback entry ${index} cursor`);
    if (cursor <= previousCursor || cursor > nextCursor) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned feedback entries out of cursor order.", 502);
    previousCursor = cursor;
    if (!new Set(["text", "image", "stroke"]).has(entry.kind)) throw bridgeError("invalid_browser_result", `The PenEcho canvas returned an invalid feedback entry ${index}.`, 502);
    const output = {
      cursor,
      kind:entry.kind,
      bounds:browserFeedbackBounds(entry.bounds, `feedback entry ${index} bounds`),
      createdAt:browserCursor(entry.createdAt, `feedback entry ${index} timestamp`),
    };
    if (entry.objectId !== undefined) output.objectId = safeString(entry.objectId, 128, `feedback entry ${index} objectId`);
    if (entry.text !== undefined) {
      if (typeof entry.text !== "string" || entry.text.length > 4_000) throw bridgeError("invalid_browser_result", `The PenEcho canvas returned invalid feedback entry ${index} text.`, 502);
      output.text = entry.text;
    }
    if (entry.textTruncated !== undefined) {
      if (typeof entry.textTruncated !== "boolean") throw bridgeError("invalid_browser_result", `The PenEcho canvas returned invalid feedback entry ${index} truncation state.`, 502);
      output.textTruncated = entry.textTruncated;
    }
    return output;
  });
  if (entries.length && nextCursor !== entries.at(-1).cursor) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid next feedback cursor.", 502);
  if (!entries.length && nextCursor !== after) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid empty feedback cursor.", 502);
  const output = { sessionId, after, nextCursor, latestCursor, hasMore:result.hasMore, truncated:result.truncated, entries };
  if (result.visualContext !== undefined) {
    if (!["current-user-layer-regions", "current-canvas-with-nearby-design"].includes(result.visualContext)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid feedback visual context.", 502);
    output.visualContext = result.visualContext;
  }
  return output;
}

function browserFeedbackCaptureMetadata(result, image) {
  const width = result.width, height = result.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid feedback screenshot dimensions. Refresh the PenEcho Canvas and try again.", 502);
  }
  if (width > MAX_FEEDBACK_CAPTURE_EDGE || height > MAX_FEEDBACK_CAPTURE_EDGE || width * height > MAX_FEEDBACK_CAPTURE_PIXELS) {
    throw bridgeError("capture_too_large", "The PenEcho feedback screenshot exceeds the safe image dimensions.", 413);
  }
  const output = { width, height };
  if (result.encodedBytes !== undefined) {
    if (!Number.isSafeInteger(result.encodedBytes) || result.encodedBytes <= 0 || result.encodedBytes !== image.bytes) {
      throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid feedback screenshot byte metadata. Refresh the PenEcho Canvas and try again.", 502);
    }
    output.encodedBytes = result.encodedBytes;
  }
  if (result.logicalRegion !== undefined) {
    browserObject(result.logicalRegion, "feedback screenshot logical region");
    const logicalRegion = {};
    for (const key of ["x", "y", "width", "height"]) {
      const number = result.logicalRegion[key];
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1_000_000_000 || (key === "width" || key === "height") && number === 0) {
        throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid feedback screenshot logical region.", 502);
      }
      logicalRegion[key] = number;
    }
    output.logicalRegion = logicalRegion;
  }
  if (result.compression !== undefined) {
    browserObject(result.compression, "feedback screenshot compression metadata");
    const allowed = new Set(["policy", "format", "quality", "maxBytes", "automatic"]);
    for (const key of Object.keys(result.compression)) {
      if (!allowed.has(key)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned unsafe feedback screenshot compression metadata.", 502);
    }
    const compression = {};
    if (result.compression.policy !== undefined) {
      if (typeof result.compression.policy !== "string" || !result.compression.policy || result.compression.policy.length > 128 || /[\u0000-\u001f\u007f]/.test(result.compression.policy)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid feedback screenshot compression metadata.", 502);
      compression.policy = result.compression.policy;
    }
    if (result.compression.format !== undefined) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(result.compression.format) || result.compression.format !== image.mimeType) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid feedback screenshot compression metadata.", 502);
      compression.format = result.compression.format;
    }
    if (result.compression.quality !== undefined) {
      if (result.compression.quality !== null && (typeof result.compression.quality !== "number" || !Number.isFinite(result.compression.quality) || result.compression.quality < 0 || result.compression.quality > 1)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid feedback screenshot compression metadata.", 502);
      compression.quality = result.compression.quality;
    }
    if (result.compression.maxBytes !== undefined) {
      if (!Number.isSafeInteger(result.compression.maxBytes) || result.compression.maxBytes <= 0 || result.compression.maxBytes > MAX_FEEDBACK_CAPTURE_BYTES) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid feedback screenshot compression metadata.", 502);
      compression.maxBytes = result.compression.maxBytes;
    }
    if (result.compression.automatic !== undefined) {
      if (typeof result.compression.automatic !== "boolean") throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid feedback screenshot compression metadata.", 502);
      compression.automatic = result.compression.automatic;
    }
    output.compression = compression;
  }
  return output;
}

function createMcpService(options) {
  if (!options?.server || typeof options.server.on !== "function") throw new TypeError("createMcpService requires an HTTP server.");
  if (typeof options.authorizeBrowser !== "function") throw new TypeError("createMcpService requires authorizeBrowser(req).");
  if (options.isLocalBrowserAddress !== undefined && typeof options.isLocalBrowserAddress !== "function") throw new TypeError("isLocalBrowserAddress must be a function.");
  if (options.inspectConfiguredClients !== undefined && typeof options.inspectConfiguredClients !== "function") throw new TypeError("inspectConfiguredClients must be a function.");
  const heartbeatIntervalMs = options.heartbeatIntervalMs === undefined ? HEARTBEAT_INTERVAL_MS : options.heartbeatIntervalMs;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs === undefined ? HEARTBEAT_TIMEOUT_MS : options.heartbeatTimeoutMs;
  if (typeof heartbeatIntervalMs !== "number" || !Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) throw new TypeError("heartbeatIntervalMs must be positive.");
  if (typeof heartbeatTimeoutMs !== "number" || !Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0 || heartbeatTimeoutMs < heartbeatIntervalMs) throw new TypeError("heartbeatTimeoutMs must be positive and at least heartbeatIntervalMs.");
  const server = options.server, authorizeBrowser = options.authorizeBrowser, rootDirectory = path.resolve(options.rootDirectory || process.cwd());
  const isLocalBrowserAddress = options.isLocalBrowserAddress;
  const inspectConfiguredClients = options.inspectConfiguredClients || defaultInspectConfiguredClients;
  const stateDirectory = options.stateDirectory ? path.resolve(options.stateDirectory) : undefined;
  const registryDirectory = options.registryStateDirectory ? path.resolve(options.registryStateDirectory) : registryStateDirectory();
  const directory = recordsDirectory(registryDirectory), instanceId = crypto.randomUUID(), secret = crypto.randomBytes(32).toString("hex");
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const requestTracer = options.requestTraceEnabled === true ? createMcpRequestTracer({
    requestTraceDirectory:options.requestTraceDirectory,
    requestTraceLimit:options.requestTraceLimit,
    logger,
  }) : null;
  const stdioPath = path.resolve(__dirname, "stdio.js");
  const defaultLaunch = {
    command:process.execPath,
    args:[stdioPath, "--state-directory", registryDirectory],
    ...((process.versions.electron || /electron(?:\.exe)?$/i.test(path.basename(process.execPath))) ? { env:{ ELECTRON_RUN_AS_NODE:"1" } } : {}),
  };
  const launchValue = typeof options.launch === "function" ? options.launch({ instanceId, stdioPath, stateDirectory:registryDirectory }) : options.launch;
  const launch = launchValue && typeof launchValue.command === "string" && Array.isArray(launchValue.args)
    ? { command:launchValue.command, args:launchValue.args.map(String), ...(launchValue.env && typeof launchValue.env === "object" ? { env:Object.fromEntries(Object.entries(launchValue.env).map(([key, value]) => [String(key), String(value)])) } : {}) }
    : defaultLaunch;
  const wss = new WebSocketServer({ noServer:true, maxPayload:MAX_WS_FRAME_BYTES, perMessageDeflate:false });
  const canvases = new Map(), connections = new Set(), sessions = new Map(), sessionKeys = new Map();
  let record = null, closed = false;

  function log(event) { try { logger(event); } catch {} }

  async function browserAuthorization(req) {
    try { return await authorizeBrowser(req); }
    catch { return "Forbidden"; }
  }

  function browserAddressAllowed(address) {
    const normalized = normalizedAddress(address);
    if (isLoopback(normalized)) return true;
    if (!isLocalBrowserAddress) return false;
    try { return isLocalBrowserAddress(normalized) === true; }
    catch { return false; }
  }

  function localHostRequired() {
    return bridgeError("local_host_required", "Open this PenEcho canvas on the same computer to use the local MCP service.", 403);
  }

  function rejectUpgrade(socket, error = bridgeError("forbidden", "Forbidden", 403)) {
    if (socket.destroyed) return;
    const payload = Buffer.from(JSON.stringify({ error:serializeError(error) }));
    const status = error.status || 403;
    const reason = status === 503 ? "Service Unavailable" : "Forbidden";
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${payload.length}\r\n\r\n`);
    socket.write(payload);
    socket.destroy();
  }

  const upgrade = async (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return; }
    if (pathname !== "/api/mcp/canvas") return;
    if (closed) return rejectUpgrade(socket, bridgeError("service_closed", "The PenEcho MCP service is closed.", 503));
    if (await browserAuthorization(req)) return rejectUpgrade(socket);
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  };
  server.on("upgrade", upgrade);

  function rejectPending(connection, error) {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
    }
    connection.pending.clear();
  }

  function markDisconnected(connection) {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.helloTimer);
    connections.delete(connection);
    if (connection.canvasId && canvases.get(connection.canvasId) === connection) canvases.delete(connection.canvasId);
    rejectPending(connection, bridgeError("canvas_disconnected", "The selected PenEcho canvas disconnected.", 409));
    for (const session of sessions.values()) if (session.connection === connection) {
      clearTimeout(session.updateTimer);
      session.updateTimer = null;
      for (const trace of session.pendingUpdateTraces) requestTracer?.queuedUpdateOutcome(trace, "failed", { applied:false, error:"The selected PenEcho canvas disconnected." });
      session.pendingUpdateTraces = [];
      session.lost = true;
      session.render = { state:"error", applied:false, pixelVerified:false, error:"The selected PenEcho canvas disconnected.", at:Date.now() };
      session.lostTimer = setTimeout(() => {
        if (sessions.get(session.id) !== session || !session.lost) return;
        sessions.delete(session.id);
        if (session.sessionKey) sessionKeys.delete(`${session.ownerId}\0${session.sessionKey}`);
      }, LOST_SESSION_TTL_MS);
      session.lostTimer.unref?.();
    }
  }

  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    for (const connection of connections) {
      if (connection.closed || !connection.canvasId) continue;
      if (now - connection.lastPong >= heartbeatTimeoutMs) {
        connection.ws.terminate();
        continue;
      }
      if (connection.ws.readyState === WebSocket.OPEN) {
        try { connection.ws.ping(); }
        catch { connection.ws.terminate(); }
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  wss.on("connection", ws => {
    if (connections.size >= MAX_CANVASES) return ws.close(1013, "Too many canvases");
    const connection = { ws, canvasId:null, title:null, connectedAt:Date.now(), lastPong:Date.now(), closed:false, pending:new Map(), openRequests:new Map(), helloTimer:null, nextSlot:0 };
    connections.add(connection);
    connection.helloTimer = setTimeout(() => ws.close(1008, "Canvas hello required"), HELLO_TIMEOUT_MS);
    connection.helloTimer.unref?.();
    ws.on("message", raw => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return ws.close(1007, "Invalid JSON"); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return ws.close(1008, "Invalid message");
      if (!connection.canvasId) {
        if (message.type !== "hello") return ws.close(1008, "Canvas hello required");
        try {
          connection.canvasId = safeString(message.canvasId, 128, "canvasId");
          connection.title = safeString(message.title, 200, "title");
        } catch { return ws.close(1008, "Invalid canvas hello"); }
        clearTimeout(connection.helloTimer);
        const previous = canvases.get(connection.canvasId);
        canvases.set(connection.canvasId, connection);
        if (previous && previous !== connection) { markDisconnected(previous); previous.ws.close(4001, "Canvas connection replaced"); }
        ws.send(JSON.stringify({ type:"ready", heartbeat:true, canvasId:connection.canvasId, instanceId }));
        return;
      }
      if (message.type === "ping") {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:"pong" }));
        return;
      }
      if (message.type !== "result" || typeof message.requestId !== "string") return ws.close(1008, "Invalid result");
      const pending = connection.pending.get(message.requestId);
      if (!pending) return;
      connection.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.ok === true) pending.resolve(message.result === undefined ? null : message.result);
      else {
        const browserCode = typeof message.error?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(message.error.code) ? message.error.code : "canvas_call_failed";
        const error = bridgeError(browserCode, typeof message.error === "string" ? message.error.slice(0, 1_000) : String(message.error?.message || "The PenEcho canvas rejected the request.").slice(0, 1_000), browserCode === "SOURCE_CONFLICT" ? 409 : 502);
        const details = safeErrorDetails(message.error?.details);
        if (details !== undefined) error.details = details;
        pending.reject(error);
      }
    });
    ws.on("pong", () => { connection.lastPong = Date.now(); });
    ws.on("close", () => markDisconnected(connection));
    ws.on("error", error => log({ type:"mcp-canvas-socket-error", errorCode:String(error?.code || "socket_error").slice(0, 80) }));
  });

  function canvasCall(connection, name, argumentsValue, optionsValue = {}) {
    const requestId = crypto.randomUUID(), requestedAt = Date.now();
    const traces = requestTracer ? (Array.isArray(optionsValue.requestTraces) ? optionsValue.requestTraces : optionsValue.requestTrace ? [optionsValue.requestTrace] : []) : [];
    const interactions = traces.map(trace => requestTracer.browserStarted(trace, { requestId, name, arguments:argumentsValue, requestedAt }));
    const failed = error => {
      for (let index = 0; index < traces.length; index++) requestTracer.browserFailed(traces[index], interactions[index], error);
      return Promise.reject(error);
    };
    if (!connection || connection.closed || connection.ws.readyState !== WebSocket.OPEN) return failed(bridgeError("canvas_disconnected", "The selected PenEcho canvas is unavailable.", 409));
    if (connection.pending.size >= MAX_PENDING_CALLS) return failed(bridgeError("canvas_busy", "The selected PenEcho canvas has too many pending requests.", 429));
    return new Promise((resolve, reject) => {
      const finish = result => {
        const completedAt = Date.now();
        resolve({ result, timing:{ requestedAt, completedAt, durationMs:completedAt - requestedAt } });
      };
      const timer = setTimeout(() => {
        connection.pending.delete(requestId);
        cleanup();
        try { connection.ws.send(JSON.stringify({ type:"cancel", requestId })); } catch {}
        reject(bridgeError("canvas_timeout", "The PenEcho canvas did not respond in time.", 504));
      }, optionsValue.timeoutMs || CALL_TIMEOUT_MS);
      timer.unref?.();
      const abort = () => {
        connection.pending.delete(requestId);
        clearTimeout(timer);
        try { connection.ws.send(JSON.stringify({ type:"cancel", requestId })); } catch {}
        reject(bridgeError("request_cancelled", "The MCP request was cancelled.", 499));
      };
      const cleanup = () => optionsValue.signal?.removeEventListener("abort", abort);
      if (optionsValue.signal?.aborted) return abort();
      optionsValue.signal?.addEventListener("abort", abort, { once:true });
      connection.pending.set(requestId, { resolve:finish, reject, timer, cleanup });
      try { connection.ws.send(JSON.stringify({ type:"call", requestId, name, arguments:argumentsValue })); }
      catch (error) {
        connection.pending.delete(requestId);
        clearTimeout(timer);
        cleanup();
        reject(bridgeError("canvas_send_failed", String(error?.message || "Could not contact the PenEcho canvas."), 502));
      }
    }).then(value => {
      for (let index = 0; index < traces.length; index++) requestTracer.browserCompleted(traces[index], interactions[index], value);
      return value;
    }, error => {
      for (let index = 0; index < traces.length; index++) requestTracer.browserFailed(traces[index], interactions[index], error);
      throw error;
    });
  }

  function ownedSession(ownerId, sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) throw bridgeError("session_not_found", "This MCP connection does not own that PenEcho session.", 404);
    if (session.lost || session.connection.closed) throw bridgeError("canvas_disconnected", "The PenEcho canvas bound to this session disconnected. Start a new session after reconnecting.", 409);
    return session;
  }

  function dispatchUpdate(session) {
    clearTimeout(session.updateTimer);
    session.updateTimer = null;
    const payload = session.pendingUpdate, renderSequence = session.pendingRenderSequence, queuedAt = session.pendingQueuedAt, requestTraces = session.pendingUpdateTraces;
    session.pendingUpdate = null;
    session.pendingUpdateTraces = [];
    if (!payload || session.lost) return session.updateChain;
    const task = session.updateChain.then(async () => {
      const { result, timing } = await canvasCall(session.connection, "mcp_update_session", { sessionId:session.id, ...payload }, { requestTraces });
      browserObject(result, "session update result");
      const revision = browserRevision(result.revision), applied = result.applied === true, visible = result.visible === true;
      if (session.renderSequence === renderSequence) session.render = { state:applied ? "applied" : "accepted", applied, visible, pixelVerified:false, queuedAt, ...timing, revision };
      for (const trace of requestTraces) requestTracer?.queuedUpdateOutcome(trace, applied ? "applied" : "accepted", { applied, visible, revision, timing });
    });
    session.updateChain = task.catch(error => {
      if (session.renderSequence === renderSequence) session.render = { state:"error", applied:false, pixelVerified:false, queuedAt, at:Date.now(), error:String(error?.message || "Progress application failed").slice(0, 500) };
      for (const trace of requestTraces) requestTracer?.queuedUpdateOutcome(trace, "failed", { applied:false, error });
    });
    return session.updateChain;
  }

  function enqueueUpdate(session, update, requestTrace) {
    const queuedAt = Date.now(), sequence = ++session.renderSequence;
    session.pendingRenderSequence = sequence;
    session.pendingQueuedAt = queuedAt;
    session.render = { state:"queued", applied:false, pixelVerified:false, queuedAt };
    session.pendingUpdate ||= {};
    for (const key of ["title", "status", "summary", "steps"]) if (update[key] !== undefined) session.pendingUpdate[key] = update[key];
    if (update.events) {
      const events = [...(session.pendingUpdate.events || []), ...update.events];
      session.pendingUpdate.events = events.slice(-MAX_EVENTS_PER_UPDATE);
    }
    if (requestTrace) {
      if (session.pendingUpdateTraces.length >= MAX_PENDING_UPDATE_TRACES) {
        const omitted = session.pendingUpdateTraces.shift();
        requestTracer?.queuedUpdateOutcome(omitted, "tracking-limited", { applied:false, queued:true });
      }
      session.pendingUpdateTraces.push(requestTrace);
    }
    if (!session.updateTimer) {
      session.updateTimer = setTimeout(() => { void dispatchUpdate(session); }, UPDATE_DELAY_MS);
      session.updateTimer.unref?.();
    }
  }

  async function flushUpdate(session) {
    if (session.pendingUpdate) dispatchUpdate(session);
    await session.updateChain;
  }

  function sessionSnapshot(session) {
    return {
      sessionId:session.id,
      canvasId:session.canvasId,
      ...(session.documentId === undefined ? {} : {documentId:session.documentId}),
      instanceId,
      slotIndex:session.slotIndex,
      title:session.title,
      status:session.status,
      summary:session.summary,
      steps:session.steps,
      events:session.events,
      ...(session.feedbackCursor === undefined ? {} : {feedbackCursor:session.feedbackCursor}),
      createdAt:session.createdAt,
      updatedAt:session.updatedAt,
      render:session.render,
    };
  }

  async function executeCallTool(ownerId, name, input, callOptions = {}) {
    if (typeof ownerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) throw bridgeError("invalid_owner", "MCP owner id is invalid.");
    const args = validateToolArguments(name, input);
    if (name === "penecho_list_canvases") return { instanceId, canvases:[...canvases.values()].filter(item => item.canvasId && !item.closed).map(item => publicCanvas(item, instanceId)) };
    if (name === "penecho_open_canvas" || name === "penecho_find_canvases") {
      if (args.instanceId !== instanceId) throw bridgeError("instance_mismatch", "The selected PenEcho instance is no longer active. List canvases again.", 409);
      const connection = canvases.get(args.canvasId);
      if (!connection || connection.closed) throw bridgeError("canvas_not_found", "The selected PenEcho canvas is not connected or has not opted in.", 404);
      let openEntry, browserArgs = args;
      if (name === "penecho_open_canvas") {
        // The browser also caches open receipts before a session exists. Scope
        // its request ID as well as our cache key to the calling MCP owner.
        const requestKey = crypto.createHash("sha256").update(`${ownerId}\0${args.requestId}`).digest("hex");
        browserArgs = {...args,requestId:requestKey};
        const signature = mutationSignature(args), prior = connection.openRequests.get(requestKey);
        if (prior && prior.signature !== signature) throw bridgeError("REQUEST_ID_CONFLICT", "requestId was already used with different open arguments. Use a new requestId.", 409);
        if (prior?.response) return {...prior.response,reused:true};
        if (!prior && connection.openRequests.size >= MAX_MUTATION_REQUESTS) {
          const completed = [...connection.openRequests].find(([, value]) => value.response);
          if (completed) connection.openRequests.delete(completed[0]);
          else throw bridgeError("request_limit", "Too many unresolved open request IDs are retained for this connection.", 429);
        }
        openEntry = prior || {signature};
        connection.openRequests.set(requestKey, openEntry);
      }
      const { result, timing } = await canvasCall(connection, name === "penecho_open_canvas" ? "mcp_open_canvas" : "mcp_find_canvases", browserArgs, callOptions);
      browserObject(result, name === "penecho_open_canvas" ? "open canvas result" : "canvas candidates result");
      if (name === "penecho_find_canvases") return { ...safeJsonValue(result, "canvas candidates"), timing };
      const documentId = safeString(result.documentId, 256, "documentId"), title = safeString(result.title, 200, "title");
      if (typeof result.active !== "boolean") throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid active state.", 502);
      let resultLocator;
      if (result.locator !== undefined) {
        browserObject(result.locator, "document locator");
        if (!["device", "server", "cloud"].includes(result.locator.location)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid document locator.", 502);
        resultLocator = {location:result.locator.location,id:safeString(result.locator.id, 512, "locator.id")};
      }
      const response = {documentId,title,active:result.active,...(resultLocator ? {locator:resultLocator} : {}),timing};
      openEntry.response = response;
      return response;
    }
    if (name === "penecho_start_session") {
      if (args.instanceId !== instanceId) throw bridgeError("instance_mismatch", "The selected PenEcho instance is no longer active. List canvases again.", 409);
      const connection = canvases.get(args.canvasId);
      if (!connection || connection.closed) throw bridgeError("canvas_not_found", "The selected PenEcho canvas is not connected or has not opted in.", 404);
      if (args.sessionKey) {
        const existingId = sessionKeys.get(`${ownerId}\0${args.sessionKey}`), existing = sessions.get(existingId);
        if (existing) {
          if (existing.lost) {
            clearTimeout(existing.lostTimer);
            sessions.delete(existing.id);
            sessionKeys.delete(`${ownerId}\0${args.sessionKey}`);
          } else {
            if (existing.canvasId !== args.canvasId || existing.connection !== connection || args.documentId !== undefined && existing.documentId !== args.documentId) throw bridgeError("session_key_conflict", "That session key is already bound to another canvas document.", 409);
            if (args.target === "current") {
              const {result} = await canvasCall(connection, "mcp_start_session", {sessionId:existing.id, slotIndex:existing.slotIndex, title:existing.title, target:"current", ...(args.client ? {client:args.client} : {}), sessionKey:args.sessionKey}, callOptions);
              browserObject(result, "session result");
              if (result.sessionId !== existing.id || !existing.documentId || result.documentId !== existing.documentId) throw bridgeError("session_key_conflict", "That session key is bound to another Canvas. Use a distinct attachment sessionKey.", 409);
            }
            return { ...sessionSnapshot(existing), instructions:SESSION_INSTRUCTIONS, reused:true };
          }
        }
      }
      if (sessions.size >= MAX_SESSIONS || [...sessions.values()].filter(item => item.ownerId === ownerId).length >= MAX_OWNER_SESSIONS) throw bridgeError("session_limit", "Too many PenEcho MCP sessions are open.", 429);
      const sessionId = crypto.randomUUID(), slotIndex = connection.nextSlot++;
      const { result, timing } = await canvasCall(connection, "mcp_start_session", { sessionId, slotIndex, title:args.title, ...(args.target ? {target:args.target} : {}), ...(args.documentId ? {documentId:args.documentId} : {}), ...(args.takeover === undefined ? {} : {takeover:args.takeover}), ...(args.client ? {client:args.client} : {}), ...(args.sessionKey ? {sessionKey:args.sessionKey} : {}) }, callOptions);
      browserObject(result, "session result");
      if (result.sessionId !== sessionId) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned a mismatched session.", 502);
      const boardObjectId = result.boardObjectId == null ? null : safeString(result.boardObjectId, 128, "boardObjectId"), revision = browserRevision(result.revision);
      const feedbackCursor = result.feedbackCursor === undefined ? undefined : browserCursor(result.feedbackCursor);
      const documentId = result.documentId === undefined && args.target !== "current" ? undefined : safeString(result.documentId, 256, "documentId");
      const progress = result.progress === undefined ? {} : browserSessionProgress(result.progress);
      const now = Date.now(), session = {
        id:sessionId, ownerId, connection, canvasId:args.canvasId, documentId, slotIndex, sessionKey:args.sessionKey,
        title:args.title, status:"working", summary:"", steps:[], events:[], ...progress, feedbackCursor, createdAt:now, updatedAt:now,
        render:{ state:"applied", applied:true, pixelVerified:false, ...timing, revision }, pendingUpdate:null, pendingUpdateTraces:[], pendingQueuedAt:0, pendingRenderSequence:0, renderSequence:0, updateChain:Promise.resolve(), updateTimer:null, lost:false, lostTimer:null, mutationRequests:new Map(),
      };
      sessions.set(sessionId, session);
      if (args.sessionKey) sessionKeys.set(`${ownerId}\0${args.sessionKey}`, sessionId);
      return { ...sessionSnapshot(session), boardObjectId, revision, instructions:SESSION_INSTRUCTIONS };
    }
    const session = ownedSession(ownerId, args.sessionId);
    if (name === "penecho_list_files" || name === "penecho_read_file" || name === "penecho_read_messages" || name === "penecho_ack_messages") {
      const operation = ({penecho_list_files:"mcp_list_files",penecho_read_file:"mcp_read_file",penecho_read_messages:"mcp_read_messages",penecho_ack_messages:"mcp_ack_messages"})[name];
      const { result, timing } = await canvasCall(session.connection, operation, args, callOptions);
      browserObject(result, `${name} result`);
      if (result.sessionId !== undefined && result.sessionId !== session.id) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned a mismatched session result.", 502);
      if (name === "penecho_list_files") for (const key of ["files", "entries"]) if (result[key] !== undefined && (!Array.isArray(result[key]) || result[key].length > args.limit)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid bounded virtual file list.", 502);
      if (name === "penecho_read_messages") for (const key of ["messages", "entries"]) if (result[key] !== undefined && (!Array.isArray(result[key]) || result[key].length > args.limit)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid bounded message list.", 502);
      if (name === "penecho_ack_messages" && result.acknowledged !== undefined && (!Array.isArray(result.acknowledged) || result.acknowledged.length > args.ids.length)) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid acknowledgement result.", 502);
      if (name === "penecho_read_file") {
        if (typeof result.content !== "string" || Buffer.byteLength(result.content, "utf8") > MAX_FILE_BYTES || typeof result.contentHash !== "string" || !result.contentHash || result.contentHash.length > 256) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid virtual file content.", 502);
      }
      return {...publicVirtualResult(result, name === "penecho_read_file" ? "virtual file" : "bounded result"),timing};
    }
    if (name === "penecho_patch_file") {
      const signature = mutationSignature(args), prior = session.mutationRequests.get(args.requestId);
      if (prior && prior.signature !== signature) throw bridgeError("REQUEST_ID_CONFLICT", "requestId was already used with different patch arguments. Use a new requestId.", 409);
      if (prior?.response) return {...prior.response,reused:true};
      if (prior && !prior.applyArguments) throw bridgeError("REQUEST_IN_PROGRESS", "The patch request is still being prepared. Retry the same requestId shortly.", 409);
      let entry = prior;
      if (!entry) {
        if ([...session.mutationRequests.values()].filter(value => !value.response).length >= MAX_UNRESOLVED_PATCHES) throw bridgeError("request_limit", "Too many unresolved mutation outcomes are retained for this session. Resolve or retry them before starting another patch.", 429);
        if (session.mutationRequests.size >= MAX_MUTATION_REQUESTS) {
          const completed = [...session.mutationRequests].find(([, value]) => value.response);
          if (completed) session.mutationRequests.delete(completed[0]);
          else throw bridgeError("request_limit", "Too many unresolved mutation request IDs are retained for this session.", 429);
        }
        entry = {signature};
        session.mutationRequests.set(args.requestId, entry);
        try {
          const prepared = await canvasCall(session.connection, "mcp_prepare_patch", {sessionId:session.id,path:args.path,requestId:args.requestId,expectedHash:args.contentHash}, callOptions);
          browserObject(prepared.result, "patch source");
          if (prepared.result.alreadyApplied === true) {
            browserObject(prepared.result.result, "recovered patch result");
            const response = {...safeJsonValue(prepared.result.result, "recovered patch result"),timing:prepared.timing,reused:true};
            entry.response = response;
            return response;
          }
          if (prepared.result.alreadyApplied !== undefined && prepared.result.alreadyApplied !== false) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid patch receipt state.", 502);
          if (typeof prepared.result.content !== "string" || Buffer.byteLength(prepared.result.content, "utf8") > MAX_FILE_BYTES || typeof prepared.result.contentHash !== "string" || !prepared.result.contentHash || prepared.result.contentHash.length > 256) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned invalid patch source content.", 502);
          if (prepared.result.contentHash !== args.contentHash) {
            const error = bridgeError("SOURCE_CONFLICT", "The virtual source changed. Re-read it, create a new patch, and use a new requestId.", 409);
            error.details = {currentContentHash:prepared.result.contentHash,retry:"read-before-patch"};
            throw error;
          }
          entry.applyArguments = {sessionId:session.id,path:args.path,content:patchVirtualFile(prepared.result.content,args.patch,args.path),expectedHash:args.contentHash,requestId:args.requestId};
        } catch (error) {
          session.mutationRequests.delete(args.requestId);
          throw error;
        }
      }
      try {
        const applied = await canvasCall(session.connection, "mcp_apply_patch", entry.applyArguments, callOptions);
        browserObject(applied.result, "patch result");
        const response = {...safeJsonValue(applied.result, "patch result"),timing:applied.timing};
        entry.response = response;
        return response;
      } catch (error) {
        if (error?.code === "SOURCE_CONFLICT" || error?.code === "invalid_browser_result") session.mutationRequests.delete(args.requestId);
        throw error;
      }
    }
    if (name === "penecho_edit_canvas") {
      const signature = mutationSignature(args), prior = session.mutationRequests.get(args.requestId);
      if (prior && prior.signature !== signature) throw bridgeError("REQUEST_ID_CONFLICT", "requestId was already used with different mutation arguments. Use a new requestId.", 409);
      if (prior?.response) return {...prior.response,reused:true};
      if (!prior && [...session.mutationRequests.values()].filter(value => !value.response).length >= MAX_UNRESOLVED_PATCHES) throw bridgeError("request_limit", "Too many unresolved mutation outcomes are retained for this session. Resolve or retry them before starting another edit.", 429);
      if (!prior && session.mutationRequests.size >= MAX_MUTATION_REQUESTS) {
        const completed = [...session.mutationRequests].find(([, value]) => value.response);
        if (completed) session.mutationRequests.delete(completed[0]);
        else throw bridgeError("request_limit", "Too many unresolved mutation request IDs are retained for this session.", 429);
      }
      const entry = prior || {signature};
      session.mutationRequests.set(args.requestId, entry);
      const applied = await canvasCall(session.connection, "mcp_edit_canvas", args, callOptions);
      browserObject(applied.result, "canvas edit result");
      const response = {...safeJsonValue(applied.result, "canvas edit result"),timing:applied.timing};
      entry.response = response;
      return response;
    }
    if (name === "penecho_capture_canvas") {
      await flushUpdate(session);
      const { result, timing } = await canvasCall(session.connection, "mcp_capture_canvas", args, callOptions);
      browserObject(result, "Canvas capture result");
      const image = extractCapture(result, MAX_CAPTURE_BYTES, "Canvas");
      return {
        sessionId:session.id,
        target:args.target,
        image,
        pixelVerified:true,
        ...browserCanvasCaptureMetadata(result, image),
        timing,
        ...browserMetadata(result),
      };
    }
    if (name === "penecho_update_session") {
      for (const key of ["title", "status", "summary", "steps"]) if (args[key] !== undefined) session[key] = args[key];
      if (args.events) session.events = [...session.events, ...args.events].slice(-500);
      session.updatedAt = Date.now();
      enqueueUpdate(session, args, callOptions.requestTrace);
      return { accepted:true, applied:false, pixelVerified:false, queuedAt:session.updatedAt, sessionId:session.id };
    }
    if (name === "penecho_present_widget") {
      await flushUpdate(session);
      const presentationArgs = {
        sessionId:args.sessionId,
        artifactId:args.artifactId,
        title:args.title,
        html:args.html,
        width:args.width,
        height:args.height,
        ...(args.presentation === undefined ? {} : {presentation:args.presentation}),
      };
      const inspect = args.presentation?.intent === "inspect";
      if (inspect) {
        presentationArgs.capture = true;
        presentationArgs.quality = args.quality || "basic";
      }
      const { result, timing } = await canvasCall(session.connection, "mcp_present_widget", presentationArgs, callOptions);
      browserObject(result, "widget result");
      if (result.artifactId !== args.artifactId) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned a mismatched artifact.", 502);
      if (inspect) {
        if (result.ephemeral !== true || result.objectId !== undefined) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned an invalid ephemeral inspection result.", 502);
        const quality = args.quality || "basic", policy = INSPECT_CAPTURE_POLICIES[quality];
        const image = extractCapture(result, policy.maxBytes, "inspection");
        const width = Number.isSafeInteger(result.width) && result.width > 0 && result.width <= 16_384 ? result.width : undefined;
        const height = Number.isSafeInteger(result.height) && result.height > 0 && result.height <= 16_384 ? result.height : undefined;
        if (!width || !height) throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid inspection screenshot dimensions.", 502);
        if (width > policy.maxLongEdge || height > policy.maxLongEdge || width * height > policy.maxPixels) throw bridgeError("capture_too_large", "The PenEcho inspection screenshot exceeds the requested quality bounds.", 413);
        if (!Number.isSafeInteger(result.encodedBytes) || result.encodedBytes !== image.bytes) throw bridgeError("invalid_capture", "The PenEcho canvas returned invalid inspection screenshot byte metadata.", 502);
        if (result.viewport !== undefined) {
          browserObject(result.viewport, "inspection viewport");
          if (result.viewport.width !== args.width || result.viewport.height !== args.height) throw bridgeError("invalid_browser_result", "The PenEcho canvas returned a mismatched inspection viewport.", 502);
        }
        return {
          sessionId:session.id,
          artifactId:args.artifactId,
          presentation:args.presentation,
          image,
          width,
          height,
          encodedBytes:result.encodedBytes,
          revision:browserRevision(result.revision),
          ephemeral:true,
          applied:true,
          pixelVerified:true,
          timing,
          ...browserMetadata(result),
        };
      }
      const presentation = { sessionId:session.id, artifactId:args.artifactId, objectId:safeString(result.objectId, 128, "objectId"), revision:browserRevision(result.revision), ...(result.feedbackCursor === undefined ? {} : {feedbackCursor:browserCursor(result.feedbackCursor)}), ...(args.presentation === undefined ? {} : {presentation:args.presentation}), applied:true, pixelVerified:false, timing, ...browserMetadata(result) };
      if (args.capture !== true) return presentation;
      const captured = await canvasCall(session.connection, "mcp_capture_widget", {
        sessionId:session.id,
        artifactId:args.artifactId,
        ...(args.quality === undefined ? {} : {quality:args.quality}),
      }, callOptions);
      browserObject(captured.result, "capture result");
      const image = extractCapture(captured.result);
      const width = Number.isSafeInteger(captured.result.width) && captured.result.width > 0 && captured.result.width <= 16_384 ? captured.result.width : undefined;
      const height = Number.isSafeInteger(captured.result.height) && captured.result.height > 0 && captured.result.height <= 16_384 ? captured.result.height : undefined;
      const captureRevision = captured.result.revision === undefined ? undefined : browserRevision(captured.result.revision);
      return {
        ...presentation,
        image,
        pixelVerified:true,
        ...(width ? {width} : {}),
        ...(height ? {height} : {}),
        ...(captureRevision === undefined ? {} : {captureRevision}),
        timing:{
          requestedAt:timing.requestedAt,
          completedAt:captured.timing.completedAt,
          durationMs:captured.timing.completedAt - timing.requestedAt,
          present:timing,
          capture:captured.timing,
        },
        presentationMetadata:browserMetadata(result),
        ...browserMetadata(captured.result),
      };
    }
    if (name === "penecho_draw" || name === "penecho_plot") {
      await flushUpdate(session);
      const kind = name === "penecho_draw" ? "drawing" : "plot";
      const { capture, ...artifactArgs } = args;
      const { result, timing } = await canvasCall(session.connection, name === "penecho_draw" ? "mcp_draw" : "mcp_plot", artifactArgs, callOptions);
      const artifact = browserArtifactResult(result, args.artifactId, kind);
      const applied = { sessionId:session.id, ...artifact, ...(args.presentation === undefined ? {} : {presentation:args.presentation}), applied:true, pixelVerified:false, timing, ...browserMetadata(result) };
      if (capture !== true) return applied;
      const captured = await canvasCall(session.connection, "mcp_capture_primitives", { sessionId:session.id, artifactId:args.artifactId }, callOptions);
      browserObject(captured.result, "primitive capture result");
      const image = extractCapture(captured.result, MAX_FEEDBACK_CAPTURE_BYTES, "primitive");
      return {
        ...applied,
        image,
        pixelVerified:true,
        ...browserPrimitiveCaptureMetadata(captured.result, image, args.artifactId),
        timing:{
          requestedAt:timing.requestedAt,
          completedAt:captured.timing.completedAt,
          durationMs:captured.timing.completedAt - timing.requestedAt,
          apply:timing,
          capture:captured.timing,
        },
        applicationMetadata:browserMetadata(result),
        ...browserMetadata(captured.result),
      };
    }
    if (name === "penecho_capture_widget") {
      await flushUpdate(session);
      const { result, timing } = await canvasCall(session.connection, "mcp_capture_widget", args, callOptions);
      browserObject(result, "capture result");
      const image = extractCapture(result);
      const width = Number.isSafeInteger(result.width) && result.width > 0 && result.width <= 16_384 ? result.width : undefined;
      const height = Number.isSafeInteger(result.height) && result.height > 0 && result.height <= 16_384 ? result.height : undefined;
      return { sessionId:session.id, artifactId:args.artifactId, image, pixelVerified:true, ...(width ? {width} : {}), ...(height ? {height} : {}), ...(result.revision === undefined ? {} : {revision:browserRevision(result.revision)}), timing, ...browserMetadata(result) };
    }
    if (name === "penecho_read_feedback") {
      const { result, timing } = await canvasCall(session.connection, "mcp_read_feedback", args, callOptions);
      const feedback = browserFeedbackResult(result, session.id, args.after, args.limit);
      const entries = feedback.entries, changeCount = entries.length;
      const summary = {
        sessionId:feedback.sessionId,
        after:feedback.after,
        nextCursor:feedback.nextCursor,
        latestCursor:feedback.latestCursor,
        hasMore:feedback.hasMore,
        truncated:feedback.truncated,
        hasFeedback:changeCount > 0,
        changeCount,
      };
      const source = typeof result?.dataUrl === "string" ? result.dataUrl : typeof result?.imageUrl === "string" ? result.imageUrl : "";
      if (args.capture !== true || changeCount === 0) return { ...summary, pixelVerified:false, timing };
      if (!source) throw bridgeError("feedback_capture_required", "PenEcho found feedback but did not return the requested screenshot. Refresh the PenEcho Canvas and try again.", 502);
      const image = extractCapture(result, MAX_FEEDBACK_CAPTURE_BYTES, "feedback");
      const metadata = browserFeedbackCaptureMetadata(result, image);
      return { ...summary, image, pixelVerified:true, ...metadata, timing };
    }
    if (name === "penecho_inspect_session") {
      await flushUpdate(session);
      const { result, timing } = await canvasCall(session.connection, "mcp_inspect_session", args, callOptions);
      return { ...sessionSnapshot(session), browser:result, timing };
    }
    if (name === "penecho_close_session") {
      await flushUpdate(session);
      const { result, timing } = await canvasCall(session.connection, "mcp_close_session", args, callOptions);
      sessions.delete(session.id);
      if (session.sessionKey) sessionKeys.delete(`${ownerId}\0${session.sessionKey}`);
      return { sessionId:session.id, closed:true, revision:result?.revision, timing };
    }
    throw bridgeError("tool_not_found", "Unknown PenEcho MCP tool.", 404);
  }

  async function callTool(ownerId, name, input, callOptions = {}) {
    if (!requestTracer) return executeCallTool(ownerId, name, input, callOptions);
    const requestTrace = requestTracer.begin({ ownerId, name, arguments:input });
    try {
      const result = await executeCallTool(ownerId, name, input, { ...callOptions, requestTrace });
      requestTracer.complete(requestTrace, result);
      return result;
    } catch (error) {
      requestTracer.fail(requestTrace, error);
      throw error;
    }
  }

  function extractCapture(result, maximumBytes = MAX_CAPTURE_BYTES, label = "widget") {
    const source = typeof result?.dataUrl === "string" ? result.dataUrl : typeof result?.imageUrl === "string" ? result.imageUrl : "";
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(source);
    if (!match) throw bridgeError("invalid_capture", "The PenEcho canvas returned an unsupported capture.", 502);
    const data = Buffer.from(match[2], "base64");
    if (!data.length || data.length > maximumBytes || data.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) throw bridgeError("capture_too_large", `The PenEcho ${label} capture is invalid or too large.`, 413);
    return { mimeType:result?.mediaType && result.mediaType === match[1] ? result.mediaType : match[1], data:match[2], bytes:data.length };
  }

  const remoteChannels = createRemoteMcpChannels({ attach:ws => wss.emit("connection", ws) });

  function statusPayload(canConfigureLocalClients = true) {
    return {
      enabled:Boolean(record),
      connectedCanvases:[...canvases.values()].filter(item => item.canvasId && !item.closed).length,
      instanceId,
      canConfigureLocalClients,
      config:canConfigureLocalClients ? launch : null,
      instructions:"Add this stdio command to an MCP client. Open a local PenEcho canvas and explicitly enable its MCP connection before listing canvases.",
    };
  }

  async function handleHttp(req, res, suppliedUrl) {
    let url;
    try { url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, "http://localhost"); } catch { return false; }
    if (!["/api/mcp/status", "/api/mcp/configure", "/api/mcp/rpc"].includes(url.pathname)) return false;
    try {
      if (url.pathname === "/api/mcp/rpc") {
        if (req.method !== "POST") throw bridgeError("method_not_allowed", "Method Not Allowed", 405);
        if (!isLoopback(req.socket.remoteAddress) || req.headers.origin || !authorizationMatches(req.headers.authorization, secret)
          || req.headers["x-penecho-mcp-instance"] !== instanceId) throw bridgeError("forbidden", "Forbidden", 403);
        if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw bridgeError("unsupported_media_type", "Use application/json.", 415);
        const body = await readJson(req), ownerId = body?.ownerId;
        if (body?.operation === "list_canvases") return sendJson(res, 200, { result:await callTool(ownerId, "penecho_list_canvases", {}, { signal:requestSignal(req, res) }) }), true;
        if (body?.operation !== "call" || typeof body.name !== "string") throw bridgeError("invalid_operation", "MCP bridge operation is invalid.", 400);
        return sendJson(res, 200, { result:await callTool(ownerId, body.name, body.arguments, { signal:requestSignal(req, res) }) }), true;
      }
      if (!["GET", "POST"].includes(req.method) || url.pathname === "/api/mcp/configure" && req.method !== "POST") throw bridgeError("method_not_allowed", "Method Not Allowed", 405);
      const canConfigureLocalClients = browserAddressAllowed(req.socket.remoteAddress);
      if (url.pathname === "/api/mcp/configure" && !canConfigureLocalClients) throw localHostRequired();
      if (await browserAuthorization(req)) throw bridgeError("forbidden", "Forbidden", 403);
      if (url.pathname === "/api/mcp/status") {
        const payload = statusPayload(canConfigureLocalClients);
        if (canConfigureLocalClients && url.searchParams.get("inspectClients") === "1") payload.configuredClients = await inspectConfiguredClients({ rootDirectory, stateDirectory });
        return sendJson(res, 200, payload), true;
      }
      if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw bridgeError("unsupported_media_type", "Use application/json.", 415);
      const body = await readJson(req, 4 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "client")) throw bridgeError("invalid_client", "Choose Codex or Claude.", 400);
      const result = await configureClient(body.client, launch, { rootDirectory, stateDirectory });
      return sendJson(res, result.configured ? 200 : 422, result), true;
    } catch (error) {
      const normalized = error instanceof McpBridgeError ? error : bridgeError("mcp_bridge_error", "PenEcho MCP request failed.", 500);
      log({ type:"mcp-http-error", path:url.pathname, errorCode:normalized.code });
      if (!res.headersSent) sendJson(res, normalized.status || 500, { error:serializeError(normalized) });
      else res.destroy();
      return true;
    }
  }

  function requestSignal(req, res) {
    const controller = new AbortController(), abort = () => controller.abort();
    req.once("aborted", abort);
    req.once("close", () => { if (!req.complete) abort(); });
    res.once("close", () => { if (!res.writableEnded) abort(); });
    return controller.signal;
  }

  function register(address) {
    if (closed) throw new Error("PenEcho MCP service is closed.");
    const port = typeof address === "object" && address ? Number(address.port) : Number(address);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PenEcho MCP requires a listening TCP address.");
    if (record) removeRecord(directory, record);
    record = { instanceId, pid:process.pid, host:"127.0.0.1", port, secret, rootDirectory, startedAt:Date.now() };
    writeRecord(directory, record);
    return statusPayload();
  }

  async function close() {
    if (closed) return;
    closed = true;
    remoteChannels.close();
    clearInterval(heartbeatTimer);
    server.off("upgrade", upgrade);
    if (record) { try { removeRecord(directory, record); } catch (error) { log({ type:"mcp-record-cleanup-error", errorCode:String(error?.code || "cleanup_failed").slice(0, 80) }); } }
    record = null;
    for (const session of sessions.values()) {
      clearTimeout(session.updateTimer);
      clearTimeout(session.lostTimer);
      for (const trace of session.pendingUpdateTraces) requestTracer?.queuedUpdateOutcome(trace, "failed", { applied:false, error:"The PenEcho MCP service closed before the queued update was applied." });
      session.pendingUpdateTraces = [];
    }
    sessions.clear();
    sessionKeys.clear();
    for (const connection of connections) {
      rejectPending(connection, bridgeError("service_closed", "The PenEcho MCP service closed.", 503));
      connection.ws.terminate();
    }
    connections.clear();
    canvases.clear();
    await new Promise(resolve => wss.close(resolve));
  }

  return { callTool, close, executeRemote:remoteChannels.execute, closeRemoteChannels:remoteChannels.disconnect, handleHttp, instanceId, listCanvases:() => [...canvases.values()].filter(item => item.canvasId && !item.closed).map(item => publicCanvas(item, instanceId)), register, status:statusPayload };
}

module.exports = { CALL_TIMEOUT_MS, MAX_CAPTURE_BYTES, MAX_HTTP_BODY_BYTES, createMcpService, isLoopback, normalizedAddress };
