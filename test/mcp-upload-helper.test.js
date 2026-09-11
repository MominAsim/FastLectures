'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  MAX_DATA_URL_BYTES,
  MCP_PROTOCOL_VERSION,
  main,
  parseArgs,
} = require('../skills/penecho-mcp/scripts/upload-image.cjs');

const HOST_ID = 'a'.repeat(64);
const SESSION_KEY = 'session-key-that-must-stay-off-the-command-line';

const BRIDGE_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const logPath = process.env.UPLOAD_IMAGE_TEST_LOG;
const mode = process.env.UPLOAD_IMAGE_TEST_MODE || 'success';
function record(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\n'); }
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\n'); }
record({ type:'start', pid:process.pid, argv:process.argv.slice(2) });
let buffer = '';
let boundDocumentId = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).replace(/\r$/, '');
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    record({ type:'message', message });
    if (message.method === 'initialize') {
      reply(message.id, { protocolVersion: ${JSON.stringify(MCP_PROTOCOL_VERSION)} });
      continue;
    }
    if (message.method !== 'tools/call') continue;
    const name = message.params && message.params.name;
    const args = message.params && message.params.arguments || {};
    if (name === 'penecho_start_session') {
      if (mode === 'start-error') {
        reply(message.id, { isError:true, structuredContent:{ error:{ code:'SENSITIVE_FAILURE', message:'full private bridge diagnostic', secret:process.env.UPLOAD_IMAGE_TEST_SECRET } } });
      } else {
        boundDocumentId = args.documentId;
        reply(message.id, { structuredContent:{ sessionId:'session-test', documentId:mode === 'wrong-start-document' ? 'other-document' : args.documentId } });
      }
    } else if (name === 'penecho_upload_image') {
      if (mode === 'hang-upload') continue;
      const source = String(args.source || ''), comma = source.indexOf(','), mediaType = source.slice(5, source.indexOf(';'));
      const bytes = Buffer.from(source.slice(comma + 1), 'base64');
      const assetId = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      reply(message.id, { structuredContent:{ uploaded:true, assetId, source:'penecho-asset:'+assetId, name:mode === 'different-name' ? 'stored-image.png' : args.name, mediaType, bytes:bytes.length, width:1, height:1, documentId:mode === 'wrong-upload-document' ? 'other-document' : boundDocumentId, revision:7, secret:'do-not-forward' } });
    }
  }
});
process.stdin.on('end', () => {
  record({ type:'stdin-end' });
  if (mode === 'hang-upload') setInterval(() => {}, 1000);
  else process.exit(0);
});`;

function capture() {
  const chunks = [];
  return { write(value) { chunks.push(String(value)); return true; }, text() { return chunks.join(''); } };
}

function temporaryFixture(t, { mode = 'success', bytes, name = 'image.bin', secret = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'penecho-upload-test-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const bridge = path.join(directory, 'bridge.cjs');
  const file = path.join(directory, name);
  const log = path.join(directory, 'events.jsonl');
  fs.writeFileSync(bridge, BRIDGE_SOURCE, { mode:0o700 });
  fs.writeFileSync(file, bytes || Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]));
  return { directory, bridge, file, log, env:{ ...process.env, UPLOAD_IMAGE_TEST_LOG:log, UPLOAD_IMAGE_TEST_MODE:mode, UPLOAD_IMAGE_TEST_SECRET:secret } };
}

function readEvents(log) {
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function argsFor(fixture, options = {}) {
  const requestId = options.requestId === undefined ? 'upload-request-1' : options.requestId;
  const documentId = Object.hasOwn(options, 'documentId') ? options.documentId : 'document-1';
  const documentArguments = documentId === undefined ? [] : ['--document-id', documentId];
  return [
    '--bridge', fixture.bridge,
    '--host-id', HOST_ID,
    '--client', 'Test client',
    '--session-key', SESSION_KEY,
    ...documentArguments,
    '--file', fixture.file,
    '--request-id', requestId,
  ];
}

async function run(fixture, t, extra = {}) {
  const stdout = capture();
  const stderr = capture();
  const status = await main(argsFor(fixture, extra), { stdout, stderr, env:fixture.env, ...extra.runtime });
  return { status, stdout:stdout.text(), stderr:stderr.text() };
}

test('uploads PNG, JPEG, and WebP by magic regardless of file suffix', async t => {
  const cases = [
    { name:'photo.jpg', bytes:Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10]) , prefix:'data:image/jpeg;base64,' },
    { name:'photo.png.disabled', bytes:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x01]), prefix:'data:image/png;base64,' },
    { name:'photo.dat', bytes:Buffer.from('RIFF\x18\x00\x00\x00WEBPpayload', 'binary'), prefix:'data:image/webp;base64,' },
  ];
  for (const item of cases) {
    const fixture = temporaryFixture(t, item);
    const result = await run(fixture, t);
    assert.equal(result.status, 0, result.stderr);
    const assetId = crypto.createHash('sha256').update(item.bytes).digest('hex');
    assert.deepEqual(JSON.parse(result.stdout), { assetId, source:'penecho-asset:'+assetId, name:item.name, mediaType:item.prefix.slice(5, item.prefix.indexOf(';')), bytes:item.bytes.length, width:1, height:1, documentId:'document-1', revision:7 });
    assert.equal(result.stderr, '');
    const events = readEvents(fixture.log);
    const start = events.find(event => event.type === 'start');
    assert.deepEqual(start.argv, ['--host-id', HOST_ID]);
    assert.equal(start.argv.includes(SESSION_KEY), false);
    const messages = events.filter(event => event.type === 'message').map(event => event.message);
    assert.deepEqual(messages.map(message => message.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    assert.equal(messages[0].params.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(messages[2].params, { name:'penecho_start_session', arguments:{ client:'Test client', sessionKey:SESSION_KEY, documentId:'document-1', title:'Image upload', restore:false } });
    const upload = messages[3].params.arguments;
    assert.deepEqual({ sessionId:upload.sessionId, requestId:upload.requestId, name:upload.name }, { sessionId:'session-test', requestId:'upload-request-1', name:item.name });
    assert.equal(upload.source, item.prefix + item.bytes.toString('base64'));
  }
});

test('requires an explicit document id and refuses directories before bridge startup', async t => {
  const fixture = temporaryFixture(t);
  const missingDocument = await run(fixture, t, { documentId:undefined });
  assert.equal(missingDocument.status, 1);
  assert.match(missingDocument.stderr, /document-id is required/);
  assert.equal(fs.existsSync(fixture.log), false);

  const directory = fs.mkdtempSync(path.join(fixture.directory, 'input-directory-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const stdout = capture();
  const stderr = capture();
  const status = await main([
    '--bridge', fixture.bridge, '--host-id', HOST_ID, '--client', 'Test client',
    '--session-key', SESSION_KEY, '--document-id', 'document-1', '--file', directory, '--request-id', 'request-2',
  ], { stdout, stderr, env:fixture.env });
  assert.equal(status, 1);
  assert.match(stderr.text(), /regular file/);
  assert.equal(fs.existsSync(fixture.log), false);
});

test('rejects unsupported magic and Data URLs over 800000 bytes without starting the bridge', async t => {
  const unsupported = temporaryFixture(t, { bytes:Buffer.from('not-an-image'), name:'image.png' });
  const unsupportedResult = await run(unsupported, t);
  assert.equal(unsupportedResult.status, 1);
  assert.match(unsupportedResult.stderr, /unsupported format/);
  assert.equal(fs.existsSync(unsupported.log), false);

  const oversized = temporaryFixture(t, {
    bytes:Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(600_000)]),
    name:'large.bin',
  });
  const oversizedResult = await run(oversized, t);
  assert.equal(oversizedResult.status, 1);
  assert.match(oversizedResult.stderr, new RegExp(String(MAX_DATA_URL_BYTES)));
  assert.equal(fs.existsSync(oversized.log), false);
});

test('sanitizes tool errors and terminates only the owned bridge process', async t => {
  const secret = 'bridge-secret-that-must-not-be-printed';
  const fixture = temporaryFixture(t, { mode:'start-error', secret });
  const result = await run(fixture, t);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stderr.includes('full private bridge diagnostic'), false);
  const pid = readEvents(fixture.log).find(event => event.type === 'start').pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('verifies document binding before and after the upload mutation', async t => {
  const wrongStart = temporaryFixture(t, { mode:'wrong-start-document' });
  const startResult = await run(wrongStart, t);
  assert.equal(startResult.status, 1);
  assert.match(startResult.stderr, /wrong document/);
  assert.equal(readEvents(wrongStart.log).filter(event => event.type === 'message').filter(event => event.message.method === 'tools/call').length, 1);

  const wrongUpload = temporaryFixture(t, { mode:'wrong-upload-document' });
  const uploadResult = await run(wrongUpload, t);
  assert.equal(uploadResult.status, 1);
  assert.match(uploadResult.stderr, /unverified asset/);
  assert.equal(uploadResult.stdout, '');
});

test('accepts a server canonical name for a duplicate image and keeps output bounded', async t => {
  const fixture = temporaryFixture(t, { mode:'different-name', name:'second-copy.bin' });
  const result = await run(fixture, t);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.name, 'stored-image.png');
  assert.equal(Object.hasOwn(output, 'secret'), false);
});

test('bounds bridge waits and cleans up after a timed out upload', async t => {
  const fixture = temporaryFixture(t, { mode:'hang-upload' });
  const started = Date.now();
  const result = await run(fixture, t, { runtime:{ rpcTimeoutMs:50 } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deadline/);
  assert.ok(Date.now() - started < 2_000);
  const pid = readEvents(fixture.log).find(event => event.type === 'start').pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('parseArgs rejects a non-hex host id without exposing argument values', () => {
  assert.throws(() => parseArgs([
    '--bridge','/tmp/client.js', '--host-id','secret-value', '--client','Test client', '--session-key',SESSION_KEY,
    '--document-id','document-1', '--file','/tmp/image.png', '--request-id','request-1',
  ]), /hexadecimal/);
});
