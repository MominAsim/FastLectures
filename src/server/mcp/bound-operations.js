"use strict";

const crypto = require("node:crypto");
const { applyPatch, parsePatch } = require("diff");
const { MAX_FILE_BYTES, McpBridgeError, validateToolArguments } = require("./schema.js");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_FEEDBACK_CAPTURE_BYTES = 700 * 1024;
const MAX_FEEDBACK_CAPTURE_EDGE = 1024;
const MAX_FEEDBACK_CAPTURE_PIXELS = 520_000;
const INSPECT_CAPTURE_POLICIES = Object.freeze({
  basic:Object.freeze({maxLongEdge:1_024,maxPixels:520_000,maxBytes:700 * 1_024}),
  detail:Object.freeze({maxLongEdge:1_440,maxPixels:1_800_000,maxBytes:1_200 * 1_024}),
});
const MAX_MUTATION_REQUESTS = 32;
const MAX_UNRESOLVED_PATCHES = 4;

function bridgeError(code, message, status = 400) { return new McpBridgeError(code, message, status); }

function appliedCaptureFailure(error, applied, callOptions) {
  // Generic browser failures also include revoked sessions and cancellation. Only
  // recognize the known capture-readiness failure, never arbitrary browser text.
  const readinessFailure = ["WIDGET_READY_TIMEOUT", "WIDGET_CAPTURE_TIMEOUT"].includes(error?.code)
    || error?.code === "CANVAS_TOOL_FAILED"
      && error.message === "A live widget could not be captured. Wait for it to finish loading and try again.";
  const transportFailure = ["canvas_timeout", "canvas_busy", "canvas_disconnected", "canvas_send_failed"].includes(error?.code);
  const hiddenDocument = error?.code === "CANVAS_NOT_VISIBLE";
  if (callOptions.signal?.aborted || (!readinessFailure && !transportFailure && !hiddenDocument)) throw error;
  return {
    ...applied,
    captureFailure:{
      code:error.code,
      message:hiddenDocument
        ? "The artifact was applied in its background Canvas. Explicitly show that session's Canvas before capturing the existing artifact; do not recreate it."
        : "The artifact was applied, but its screenshot is unavailable. Wait for the Canvas to be ready, then capture the existing artifact without recreating it.",
      retryTool:applied.kind ? "penecho_capture_canvas" : "penecho_capture_widget",
      retryArguments:applied.kind ? {sessionId:applied.sessionId,target:"canvas"} : {sessionId:applied.sessionId,artifactId:applied.artifactId},
    },
  };
}

function safeString(value, max, label) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw bridgeError("invalid_browser_message", `${label} is invalid.`, 400);
  return value;
}

function safeJsonValue(value, label, maximumBytes = MAX_FILE_BYTES) {
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, "utf8") > maximumBytes) throw new Error();
    return JSON.parse(json);
  } catch { throw bridgeError("invalid_browser_result", `The PenEcho canvas returned an invalid or oversized ${label}.`, 502); }
}

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

function mutationSignature(args) {
  return crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

function patchParseDiagnostic(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const bounded = (value, minimum = 1) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= MAX_FILE_BYTES ? number : null;
  };
  let match = /^Added line count did not match for hunk at line (\d+)$/.exec(message);
  if (match) {
    const line = bounded(match[1]);
    if (line !== null) return `Added line count did not match for hunk at line ${line}.`;
  }
  match = /^Removed line count did not match for hunk at line (\d+)$/.exec(message);
  if (match) {
    const line = bounded(match[1]);
    if (line !== null) return `Removed line count did not match for hunk at line ${line}.`;
  }
  match = /^Hunk at line (\d+) has more lines than expected \(expected (\d+) old lines and (\d+) new lines\)$/.exec(message);
  if (match) {
    const line = bounded(match[1]), oldLines = bounded(match[2],0), newLines = bounded(match[3],0);
    if (line !== null && oldLines !== null && newLines !== null) return `Hunk at line ${line} has more lines than expected (expected ${oldLines} old lines and ${newLines} new lines).`;
  }
  match = /^Hunk at line (\d+) contained invalid line /.exec(message);
  if (match) {
    const line = bounded(match[1]);
    if (line !== null) return `Hunk at line ${line} contains an invalid line.`;
  }
  return "patch must be a valid unified diff.";
}

function patchVirtualFile(source, patchText, virtualPath) {
  const fileName = virtualPath.replace(/^\/+/, "");
  let parsed;
  try { parsed = parsePatch(patchText); }
  catch (error) { throw bridgeError("invalid_patch", patchParseDiagnostic(error), 400); }
  if (parsed.length !== 1 || parsed[0].oldFileName !== `a/${fileName}` || parsed[0].newFileName !== `b/${fileName}` || !parsed[0].hunks.length) {
    throw bridgeError("invalid_patch", `patch must modify exactly --- a/${fileName} and +++ b/${fileName}.`, 400);
  }
  const content = applyPatch(source, parsed[0], { fuzzFactor:0 });
  if (content === false) throw bridgeError("PATCH_CONFLICT", "The patch no longer applies exactly. Re-read the virtual file and create a new patch and requestId.", 409);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw bridgeError("patch_too_large", "The patched content exceeds the 800,000-byte limit.", 413);
  return content;
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

function extractCapture(result, maximumBytes = MAX_CAPTURE_BYTES, label = "widget") {
  const source = typeof result?.dataUrl === "string" ? result.dataUrl : typeof result?.imageUrl === "string" ? result.imageUrl : "";
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(source);
  if (!match) throw bridgeError("invalid_capture", "The PenEcho canvas returned an unsupported capture.", 502);
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > maximumBytes || data.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) throw bridgeError("capture_too_large", `The PenEcho ${label} capture is invalid or too large.`, 413);
  return { mimeType:result?.mediaType && result.mediaType === match[1] ? result.mediaType : match[1], data:match[2], bytes:data.length };
}

const BOUND_CANVAS_TOOL_NAMES = Object.freeze(["penecho_list_files", "penecho_read_file", "penecho_read_messages", "penecho_ack_messages", "penecho_patch_file", "penecho_edit_canvas", "penecho_capture_canvas", "penecho_present_widget", "penecho_draw", "penecho_plot", "penecho_capture_widget", "penecho_read_feedback", "penecho_inspect_session"]);

// Shared document operations. The caller owns authentication and session lifecycle.
async function executeBoundCanvasTool({name,args,session,canvasCall,flushUpdate = async () => {},sessionSnapshot = session => ({sessionId:session.id}),callOptions = {}}) {
  if (!BOUND_CANVAS_TOOL_NAMES.includes(name)) throw bridgeError("tool_not_found", "Unknown bound Canvas tool.", 404);
  args = validateToolArguments(name, args);
  if (args.sessionId !== session.id) throw bridgeError("session_mismatch", "The tool must target its bound Canvas session.", 409);
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
    let captured;
    try { captured = await canvasCall(session.connection, "mcp_capture_widget", {
      sessionId:session.id,
      artifactId:args.artifactId,
      ...(args.quality === undefined ? {} : {quality:args.quality}),
    }, callOptions); }
    catch (error) { return appliedCaptureFailure(error, presentation, callOptions); }
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
    let captured;
    try { captured = await canvasCall(session.connection, "mcp_capture_primitives", { sessionId:session.id, artifactId:args.artifactId }, callOptions); }
    catch (error) { return appliedCaptureFailure(error, applied, callOptions); }
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
}

module.exports = { BOUND_CANVAS_TOOL_NAMES, executeBoundCanvasTool, MAX_CAPTURE_BYTES, MAX_MUTATION_REQUESTS, safeString, safeJsonValue, browserSessionProgress, publicVirtualResult, mutationSignature, patchVirtualFile, browserRevision, browserCursor, browserObject, browserMetadata, browserArtifactResult, browserPrimitiveCaptureMetadata, browserCanvasCaptureMetadata, browserFeedbackBounds, browserFeedbackResult, browserFeedbackCaptureMetadata };
