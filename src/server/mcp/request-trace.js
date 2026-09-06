"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ARRAY_ITEMS = 32;
const MAX_BROWSER_INTERACTIONS = 32;
const MAX_OBJECT_KEYS = 64;
const MAX_STRING_CHARS = 8_000;
const MAX_VALUE_CHARS = 64_000;
const MAX_VALUE_NODES = 512;
const SECRET_KEY = /(?:^|[-_])(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|resume[-_]?token|cookie|password|secret)(?:$|[-_])/i;
const SECRET_TEXT = /((?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|resume[-_]?token|cookie|password|secret)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const TRACE_DIRECTORY_NAME = /^\d{13}-[0-9a-f-]{36}$/i;

function redactText(value) {
  return String(value)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "<encoded image omitted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(SECRET_TEXT, "$1<redacted>")
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|resume[-_]?token)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/g, "<redacted-token>");
}

function encodedBody(value, key, parent) {
  if (/^data:[^;,]+;base64,/i.test(value)) return true;
  if (value.length >= 512 && /^[A-Za-z0-9+/=]+$/.test(value)) return true;
  if (/^(?:dataUrl|imageUrl|base64|screenshot)$/i.test(key) && /^[A-Za-z0-9+/=\s]{128,}$/.test(value)) return true;
  return key === "data" && /^image\//i.test(String(parent?.mimeType || parent?.mediaType || ""));
}

function safeTraceValue(value) {
  const seen = new WeakSet();
  let remaining = MAX_VALUE_CHARS, remainingNodes = MAX_VALUE_NODES;

  function visit(item, key = "", parent = null, depth = 0) {
    if (remainingNodes-- <= 0) return "<value limit reached>";
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item === "bigint") return String(item);
    if (typeof item === "string") {
      if (encodedBody(item, key, parent)) return "<encoded image omitted>";
      const redacted = redactText(item), limit = Math.max(0, Math.min(MAX_STRING_CHARS, remaining));
      remaining -= Math.min(redacted.length, limit);
      return redacted.length > limit ? `${redacted.slice(0, limit)}\n…[truncated]` : redacted;
    }
    if (typeof item !== "object") return String(item);
    if (item instanceof Error) return visit({ name:item.name, code:item.code, message:item.message }, key, parent, depth);
    if (depth >= 8) return "<maximum depth reached>";
    if (seen.has(item)) return "<circular reference>";
    seen.add(item);
    if (Array.isArray(item)) {
      const output = item.slice(0, MAX_ARRAY_ITEMS).map(entry => visit(entry, "", item, depth + 1));
      if (item.length > MAX_ARRAY_ITEMS) output.push(`<${item.length - MAX_ARRAY_ITEMS} items omitted>`);
      return output;
    }
    const output = {}, keys = Object.keys(item);
    for (const [index, name] of keys.slice(0, MAX_OBJECT_KEYS).entries()) {
      const secret = SECRET_KEY.test(name), safeName = secret ? `<secret field ${index + 1}>` : redactText(name).slice(0, 128);
      output[safeName] = secret ? "<redacted>" : visit(item[name], name, item, depth + 1);
    }
    if (keys.length > MAX_OBJECT_KEYS) output.traceFieldsOmitted = keys.length - MAX_OBJECT_KEYS;
    return output;
  }

  try { return visit(value); }
  catch (error) { return { serializationError:redactText(String(error?.message || "Could not serialize trace value.")).slice(0, 1_000) }; }
}

function isoTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function createMcpRequestTracer({ requestTraceDirectory, requestTraceLimit = 100, logger = () => {}, now = () => Date.now(), createRequestId = () => crypto.randomUUID() }) {
  if (!path.isAbsolute(requestTraceDirectory)) throw new TypeError("requestTraceDirectory must be an absolute path.");
  if (!Number.isInteger(requestTraceLimit) || requestTraceLimit < 1 || requestTraceLimit > 1_000) throw new TypeError("requestTraceLimit must be an integer between 1 and 1000.");
  const root = path.resolve(requestTraceDirectory);
  let lastDirectoryTimestamp = 0;

  function report(error, requestId) {
    try { logger({ type:"mcp-request-trace-error", requestId, errorCode:String(error?.code || "write_failed").slice(0, 80) }); } catch {}
  }

  function write(trace) {
    try {
      trace.data.updatedAt = isoTime(now());
      fs.writeFileSync(path.join(trace.directory, "trace.json"), JSON.stringify(trace.data, null, 2), { encoding:"utf8", mode:0o600 });
    } catch (error) { report(error, trace.data.requestId); }
  }

  function prune(requestId) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes:true })
        .filter(entry => entry.isDirectory() && TRACE_DIRECTORY_NAME.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries.slice(0, Math.max(0, entries.length - requestTraceLimit))) {
        const target = path.resolve(root, entry.name);
        if (path.dirname(target) === root) fs.rmSync(target, { recursive:true, force:true });
      }
    } catch (error) { report(error, requestId); }
  }

  function begin({ ownerId, name, arguments:argumentsValue }) {
    const startedAt = now(), requestId = createRequestId(), directoryTimestamp = Math.max(startedAt, lastDirectoryTimestamp + 1), directory = path.join(root, `${directoryTimestamp}-${requestId}`);
    lastDirectoryTimestamp = directoryTimestamp;
    const trace = {
      directory,
      data:{
        schemaVersion:1,
        kind:"mcp-request",
        requestId,
        startedAt:isoTime(startedAt),
        updatedAt:isoTime(startedAt),
        completedAt:null,
        durationMs:null,
        status:"running",
        request:{ ownerId:safeTraceValue(ownerId), tool:safeTraceValue(name), arguments:safeTraceValue(argumentsValue) },
        browserInteractions:[],
        outcome:null,
        error:null,
      },
    };
    try {
      fs.mkdirSync(directory, { recursive:true, mode:0o700 });
      write(trace);
      prune(requestId);
    } catch (error) { report(error, requestId); }
    return trace;
  }

  function browserStarted(trace, { requestId, name, arguments:argumentsValue, requestedAt }) {
    if (!trace) return null;
    const interaction = {
      requestId,
      name,
      requestedAt:isoTime(requestedAt),
      completedAt:null,
      durationMs:null,
      status:"pending",
      arguments:safeTraceValue(argumentsValue),
      result:null,
      error:null,
    };
    if (trace.data.browserInteractions.length >= MAX_BROWSER_INTERACTIONS) trace.data.browserInteractions.shift();
    trace.data.browserInteractions.push(interaction);
    return interaction;
  }

  function browserCompleted(trace, interaction, { result, timing }) {
    if (!trace || !interaction) return;
    interaction.completedAt = isoTime(timing.completedAt);
    interaction.durationMs = timing.durationMs;
    interaction.status = "completed";
    interaction.result = safeTraceValue(result);
  }

  function browserFailed(trace, interaction, error, completedAt = now()) {
    if (!trace || !interaction) return;
    interaction.completedAt = isoTime(completedAt);
    interaction.durationMs = Math.max(0, completedAt - new Date(interaction.requestedAt).getTime());
    interaction.status = "failed";
    interaction.error = safeTraceValue(error);
  }

  function queuedUpdateOutcome(trace, state, details) {
    if (!trace) return;
    trace.data.queuedUpdate = { state, recordedAt:isoTime(now()), ...safeTraceValue(details) };
    write(trace);
  }

  function complete(trace, result) {
    if (!trace) return;
    const completedAt = now();
    trace.data.status = "completed";
    trace.data.completedAt = isoTime(completedAt);
    trace.data.durationMs = Math.max(0, completedAt - new Date(trace.data.startedAt).getTime());
    trace.data.outcome = safeTraceValue(result);
    write(trace);
  }

  function fail(trace, error) {
    if (!trace) return;
    const completedAt = now();
    trace.data.status = "failed";
    trace.data.completedAt = isoTime(completedAt);
    trace.data.durationMs = Math.max(0, completedAt - new Date(trace.data.startedAt).getTime());
    trace.data.error = safeTraceValue(error);
    write(trace);
  }

  return { begin, browserCompleted, browserFailed, browserStarted, complete, fail, queuedUpdateOutcome };
}

module.exports = { createMcpRequestTracer, safeTraceValue };
