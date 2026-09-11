#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MAX_DATA_URL_BYTES = 800_000;
const DEFAULT_RPC_TIMEOUT_MS = 45_000;
const CLOSE_TIMEOUT_MS = 1_000;
const KILL_TIMEOUT_MS = 500;
const MIME_PREFIXES = Object.freeze({
  'image/png': 'data:image/png;base64,',
  'image/jpeg': 'data:image/jpeg;base64,',
  'image/webp': 'data:image/webp;base64,',
});
const MIN_DATA_URL_PREFIX_BYTES = Math.min(
  ...Object.values(MIME_PREFIXES).map(prefix => Buffer.byteLength(prefix, 'utf8')),
);
const MAX_LINE_BYTES = 16 * 1024 * 1024;

const USAGE = `Usage: node upload-image.cjs --bridge /abs/configured/client.js --host-id HEX64 --client NAME --session-key KEY --document-id ID --file /abs/image.png --request-id ID`;

class UploadImageError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'UploadImageError';
    this.code = code;
  }
}

function fail(code, message = code) {
  return new UploadImageError(code, message);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function parseArgs(argv = []) {
  const options = {};
  const names = new Map([
    ['--bridge', 'bridge'],
    ['--host-id', 'hostId'],
    ['--client', 'client'],
    ['--session-key', 'sessionKey'],
    ['--document-id', 'documentId'],
    ['--file', 'file'],
    ['--request-id', 'requestId'],
  ]);

  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') throw fail('INVALID_ARGUMENTS', USAGE);
    const name = names.get(flag);
    if (!name || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw fail('INVALID_ARGUMENTS', 'Unknown or incomplete option.');
    }
    if (Object.hasOwn(options, name)) throw fail('INVALID_ARGUMENTS', 'Duplicate option.');
    options[name] = argv[index + 1];
    index += 1;
  }

  for (const name of names.values()) {
    if (!isNonEmptyString(options[name])) throw fail('INVALID_ARGUMENTS', `--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required.`);
  }
  if (!/^[a-f\d]{64}$/i.test(options.hostId)) throw fail('INVALID_HOST_ID', '--host-id must be a 64-character hexadecimal host identity.');
  if (!path.isAbsolute(options.bridge)) throw fail('INVALID_BRIDGE', '--bridge must be an absolute path.');
  if (!path.isAbsolute(options.file)) throw fail('INVALID_FILE', '--file must be an absolute path.');
  if (!isRegularFile(options.bridge)) throw fail('INVALID_BRIDGE', '--bridge must name an existing regular file.');
  if (!isRegularFile(options.file)) throw fail('INVALID_FILE', '--file must name an existing regular file.');
  if (options.client.length > 120) throw fail('INVALID_ARGUMENTS', '--client is too long.');
  if (options.sessionKey.length > 128) throw fail('INVALID_ARGUMENTS', '--session-key is too long.');
  if (options.documentId.length > 256) throw fail('INVALID_ARGUMENTS', '--document-id is too long.');
  if (options.requestId.length > 128) throw fail('INVALID_ARGUMENTS', '--request-id is too long.');
  return options;
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

function assertDataUrlSize(byteLength, mimeType) {
  const prefix = MIME_PREFIXES[mimeType];
  if (!prefix || !Number.isSafeInteger(byteLength) || byteLength < 0) throw fail('INVALID_IMAGE', 'The image file is invalid.');
  if (Buffer.byteLength(prefix, 'utf8') + base64Length(byteLength) > MAX_DATA_URL_BYTES) {
    throw fail('IMAGE_TOO_LARGE', 'The image Data URL exceeds the 800000-byte limit.');
  }
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail('INVALID_IMAGE', 'The image file has an unsupported format.');
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length >= pngSignature.length && buffer.subarray(0, pngSignature.length).equals(pngSignature)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  throw fail('INVALID_IMAGE', 'The image file has an unsupported format.');
}

function readImageSource(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw fail('INVALID_FILE', '--file must name an existing regular file.');
  }
  if (!stat.isFile()) throw fail('INVALID_FILE', '--file must name an existing regular file.');
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw fail('INVALID_FILE', 'The image file size is invalid.');

  // Do this check from stat information first so an obviously oversized file
  // is rejected before its bytes are read into memory.
  if (base64Length(stat.size) + MIN_DATA_URL_PREFIX_BYTES > MAX_DATA_URL_BYTES) {
    throw fail('IMAGE_TOO_LARGE', 'The image Data URL exceeds the 800000-byte limit.');
  }

  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    throw fail('INVALID_FILE', 'The image file could not be read.');
  }
  const mimeType = detectImageMime(data);
  assertDataUrlSize(data.length, mimeType);
  const prefix = MIME_PREFIXES[mimeType];
  const source = prefix + data.toString('base64');
  if (Buffer.byteLength(source, 'utf8') > MAX_DATA_URL_BYTES) throw fail('IMAGE_TOO_LARGE', 'The image Data URL exceeds the 800000-byte limit.');
  const name = path.basename(filePath);
  if (!name || name === '.' || name === path.sep || name.length > 200) throw fail('INVALID_FILE_NAME', 'The image file name is invalid.');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return Object.freeze({ name, mimeType, bytes: data.length, sha256, source });
}

function safeCode(value, fallback = 'MCP_ERROR') {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function protocolError(code = 'MCP_ERROR') {
  return fail(safeCode(code), 'The PenEcho bridge returned an error.');
}

function responseResult(response) {
  if (!response || typeof response !== 'object') throw fail('INVALID_BRIDGE_RESPONSE', 'The PenEcho bridge returned an invalid response.');
  if (response.error) throw protocolError(response.error.code);
  if (!response.result || typeof response.result !== 'object') throw fail('INVALID_BRIDGE_RESPONSE', 'The PenEcho bridge returned an invalid response.');
  if (response.result.isError) {
    const structured = response.result.structuredContent;
    throw protocolError(structured?.error?.code || structured?.code || 'MCP_TOOL_ERROR');
  }
  return response.result;
}

function structuredContent(response, label) {
  const result = responseResult(response);
  if (!Object.hasOwn(result, 'structuredContent') || result.structuredContent === undefined || result.structuredContent === null) {
    throw fail('INVALID_TOOL_RESULT', `${label} did not return structuredContent.`);
  }
  return result.structuredContent;
}

function sessionIdFromStart(response, expectedDocumentId) {
  const value = structuredContent(response, 'penecho_start_session');
  if (!isNonEmptyString(value.sessionId)) throw fail('INVALID_SESSION_RESULT', 'penecho_start_session did not return a sessionId.');
  if (value.documentId !== expectedDocumentId) throw fail('INVALID_SESSION_RESULT', 'penecho_start_session returned the wrong document.');
  return value.sessionId;
}

const UPLOAD_RESULT_FIELDS = Object.freeze(['assetId', 'source', 'name', 'mediaType', 'bytes', 'width', 'height', 'documentId', 'revision', 'reused']);

function uploadMetadata(response, expected) {
  const value = structuredContent(response, 'penecho_upload_image');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_UPLOAD_RESULT', 'penecho_upload_image returned invalid metadata.');
  const assetSource = typeof value.source === 'string' && /^penecho-asset:[a-f0-9]{64}$/.test(value.source) ? value.source : null;
  if (!assetSource || value.documentId !== expected.documentId) throw fail('INVALID_UPLOAD_RESULT', 'penecho_upload_image returned an unverified asset.');
  const assetId = assetSource.slice('penecho-asset:'.length);
  if (assetId !== expected.sha256 || value.assetId !== assetId || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 200 || value.name.includes('\0') || value.mediaType !== expected.mimeType || value.bytes !== expected.bytes) {
    throw fail('INVALID_UPLOAD_RESULT', 'penecho_upload_image returned mismatched metadata.');
  }
  for (const field of ['width', 'height', 'revision']) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 0)) throw fail('INVALID_UPLOAD_RESULT', 'penecho_upload_image returned invalid metadata.');
  }
  if (value.reused !== undefined && typeof value.reused !== 'boolean') throw fail('INVALID_UPLOAD_RESULT', 'penecho_upload_image returned invalid metadata.');
  return Object.fromEntries(UPLOAD_RESULT_FIELDS.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
}

function childIsAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function waitForChild(child, timeoutMs) {
  if (!childIsAlive(child)) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      child.removeListener('close', finish);
      child.removeListener('error', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
  });
}

async function closeChild(child) {
  if (!child) return;
  if (childIsAlive(child)) {
    try { child.stdin?.end(); } catch {}
    await waitForChild(child, CLOSE_TIMEOUT_MS);
  }
  if (childIsAlive(child)) {
    try { child.kill('SIGTERM'); } catch {}
    await waitForChild(child, KILL_TIMEOUT_MS);
  }
  if (childIsAlive(child)) {
    try { child.kill('SIGKILL'); } catch {}
    await waitForChild(child, KILL_TIMEOUT_MS);
  }
}

class StdioRpc {
  constructor(child, { timeoutMs = DEFAULT_RPC_TIMEOUT_MS, maxLineBytes = MAX_LINE_BYTES } = {}) {
    if (!child?.stdin || !child?.stdout || typeof child.once !== 'function') throw fail('BRIDGE_START_FAILED', 'The PenEcho bridge could not be started.');
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.buffer = '';
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    child.stdin.on('error', () => this.rejectAll('BRIDGE_CLOSED'));
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', chunk => this.onData(chunk));
    child.once('exit', () => this.rejectAll('BRIDGE_EXITED'));
    child.once('error', () => this.rejectAll('BRIDGE_START_FAILED'));
  }

  rejectAll(code) {
    if (this.closed && this.pending.size === 0) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(fail(code, 'The PenEcho bridge closed before completing the request.'));
    }
    this.pending.clear();
    this.closed = true;
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      this.rejectAll('BRIDGE_OUTPUT_TOO_LARGE');
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.rejectAll('INVALID_BRIDGE_RESPONSE');
        return;
      }
      if (!message || typeof message !== 'object' || !Object.hasOwn(message, 'id')) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  write(message) {
    if (this.closed || !childIsAlive(this.child)) throw fail('BRIDGE_CLOSED', 'The PenEcho bridge is closed.');
    let line;
    try { line = `${JSON.stringify(message)}\n`; } catch { throw fail('INVALID_REQUEST', 'The MCP request could not be encoded.'); }
    try {
      this.child.stdin.write(line);
    } catch {
      throw fail('BRIDGE_CLOSED', 'The PenEcho bridge is closed.');
    }
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  request(method, params) {
    if (this.closed) return Promise.reject(fail('BRIDGE_CLOSED', 'The PenEcho bridge is closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail('BRIDGE_TIMEOUT', 'The PenEcho bridge did not respond before the deadline.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.rejectAll('BRIDGE_CLOSED');
  }
}

function errorText(error) {
  if (error instanceof UploadImageError) return `${error.message} (${safeCode(error.code, 'UPLOAD_ERROR')})`;
  return 'The image upload could not be completed.';
}

function writeError(output, error) {
  if (!output?.write) return;
  try { output.write(`${errorText(error)}\n`); } catch {}
}

async function main(argv = process.argv.slice(2), runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const stderr = runtime.stderr || process.stderr;
  let child;
  let rpc;
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }

    const image = readImageSource(options.file);
    const spawnProcess = runtime.spawn || defaultSpawn;
    const env = runtime.env ? { ...runtime.env } : process.env;
    child = spawnProcess(process.execPath, [options.bridge, '--host-id', options.hostId], {
      cwd: runtime.cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    rpc = new StdioRpc(child, { timeoutMs: runtime.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS });

    const initialized = await rpc.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'penecho-image-upload', version: '1.0.0' },
    });
    responseResult(initialized);
    rpc.notify('notifications/initialized');

    const started = await rpc.request('tools/call', {
      name: 'penecho_start_session',
      arguments: {
        client: options.client,
        sessionKey: options.sessionKey,
        documentId: options.documentId,
        title: 'Image upload',
        restore: false,
      },
    });
    const sessionId = sessionIdFromStart(started, options.documentId);
    const uploaded = await rpc.request('tools/call', {
      name: 'penecho_upload_image',
      arguments: {
        sessionId,
        requestId: options.requestId,
        name: image.name,
        source: image.source,
      },
    });
    const result = uploadMetadata(uploaded, { documentId:options.documentId, name:image.name, mimeType:image.mimeType, bytes:image.bytes, sha256:image.sha256 });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    writeError(stderr, error);
    return 1;
  } finally {
    rpc?.close();
    await closeChild(child);
  }
}

module.exports = {
  CLOSE_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  MAX_DATA_URL_BYTES,
  MCP_PROTOCOL_VERSION,
  MIME_PREFIXES,
  StdioRpc,
  UploadImageError,
  assertDataUrlSize,
  closeChild,
  detectImageMime,
  main,
  parseArgs,
  readImageSource,
  sessionIdFromStart,
  uploadMetadata,
};

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  }, error => {
    writeError(process.stderr, error);
    process.exitCode = 1;
  });
}
