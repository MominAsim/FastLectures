#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const https = require("node:https");
const net = require("node:net");

const MAX_INCOMING_BYTES = 12 * 1024 * 1024;
const MAX_OUTGOING_BYTES = 3 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
// The LAN service currently permits eight active calls per paired client;
// keeping the adapter at that bound avoids avoidable 429 responses while
// remaining well below the protocol's sixteen-call safety ceiling.
const MAX_CONCURRENT_REQUESTS = 8;
const PAIRING_TIMEOUT_MS = 2 * 60 * 1000;
const PAIR_POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_SESSION_ID_BYTES = 1024;
const DEFAULT_NAME = "Codex";

const REMOTE_USAGE = `Usage:
  node remote-client.js --host-id <64hex> [--remote https://<private-IP>:<port>/mcp] --fingerprint <64hex> --invitation <64hex> [--name Codex]

Options:
  --host-id <hex>       Stable host identity, equal to the certificate fingerprint
  --remote <url>         Optional fallback HTTPS private-IP MCP endpoint ending in /mcp
  --fingerprint <hex>   SHA-256 fingerprint of the pinned leaf certificate
  --invitation <hex>    Secret 64-hex connection key from PenEcho
  --name <name>         Client display name (default: Codex)
  -h, --help             Show this help on stderr
`;

function remoteError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function isHex64(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizeFingerprint(value, label = "certificate fingerprint") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!isHex64(normalized)) throw remoteError("invalid_argument", `${label} must be exactly 64 hexadecimal characters.`);
  return normalized;
}

function normalizeInvitation(value) {
  return normalizeFingerprint(value, "invitation");
}

function normalizeName(value) {
  const name = String(value ?? DEFAULT_NAME).trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw remoteError("invalid_argument", "name must be a printable value up to 100 characters.");
  return name;
}

function normalizeMappedIPv4(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!value.startsWith("::ffff:")) return null;
  const mapped = value.slice("::ffff:".length);
  return net.isIP(mapped) === 4 ? mapped : null;
}

function isPrivateIPv4(hostname) {
  const value = normalizeMappedIPv4(hostname) || String(hostname || "").replace(/^\[|\]$/g, "");
  if (net.isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  const [first, second] = octets;
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isPrivateIPv6(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(value) !== 6) return false;
  if (value === "::1") return true;
  // IPv6 unique-local addresses are fc00::/7. Link-local addresses are
  // intentionally excluded because they require an interface scope.
  return value.startsWith("fc") || value.startsWith("fd");
}

function isAllowedRemoteHost(hostname) {
  return isPrivateIPv4(hostname) || isPrivateIPv6(hostname);
}

function unbracketHost(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "");
}

function validateRemoteUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw remoteError("invalid_url", "remote must be a valid HTTPS private-IP URL ending in /mcp."); }
  if (url.protocol !== "https:") throw remoteError("invalid_url", "remote must use HTTPS.");
  if (url.username || url.password) throw remoteError("invalid_url", "remote must not include userinfo.");
  if (url.hash) throw remoteError("invalid_url", "remote must not include a fragment.");
  if (url.search) throw remoteError("invalid_url", "remote must not include a query string.");
  if (url.pathname !== "/mcp") throw remoteError("invalid_url", "remote must end in /mcp.");
  if (!isAllowedRemoteHost(url.hostname)) throw remoteError("invalid_url", "remote must use a private or loopback IP address.");
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) throw remoteError("invalid_url", "remote has an invalid port.");
  return url;
}

function pathUrl(remoteUrl, pathname) {
  const url = new URL(remoteUrl.toString());
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

function peerFingerprint(socket) {
  const certificate = socket?.getPeerCertificate?.(true);
  if (!certificate || !certificate.raw) throw remoteError("tls_peer_missing", "Remote MCP did not provide a peer certificate.");
  return crypto.createHash("sha256").update(Buffer.from(certificate.raw)).digest("hex");
}

function verifyPeerFingerprint(socket, expectedFingerprint) {
  const expected = normalizeFingerprint(expectedFingerprint);
  const actual = peerFingerprint(socket);
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  if (expectedBytes.length !== actualBytes.length || !crypto.timingSafeEqual(expectedBytes, actualBytes)) {
    throw remoteError("tls_pin_mismatch", "Remote MCP certificate pin verification failed.");
  }
  return actual;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.code === "remote_aborted";
}

function abortError() {
  const error = remoteError("remote_aborted", "Remote MCP request cancelled.");
  error.name = "AbortError";
  return error;
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

/**
 * Make one HTTPS request with certificate pinning.
 *
 * `https.request` is intentionally not ended until secureConnect has fired and
 * the raw peer certificate has matched. This makes a wrong pin fail before
 * request headers, Authorization, or body bytes are written to the socket.
 */
function pinnedRequest({url, method = "POST", headers = {}, body = Buffer.alloc(0), fingerprint, signal, timeoutMs = REQUEST_TIMEOUT_MS}) {
  const target = url instanceof URL ? url : new URL(String(url));
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  const expectedFingerprint = normalizeFingerprint(fingerprint);
  if (payload.length > MAX_OUTGOING_BYTES) return Promise.reject(remoteError("request_too_large", "Remote MCP request is too large."));
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let request = null;
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (request && !request.destroyed) request.destroy();
      reject(error);
    };
    const onAbort = () => fail(abortError());
    if (signal) signal.addEventListener("abort", onAbort, {once:true});

    const requestHeaders = {
      host: target.host,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": String(payload.length),
      ...headers,
    };
    try {
      request = https.request({
        protocol: "https:",
        hostname: unbracketHost(target.hostname),
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers: requestHeaders,
        // The endpoint uses a generated self-signed certificate. Exact leaf
        // pinning below is the sole trust decision; there is no unpinned mode.
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        agent: false,
        servername: undefined,
      });
      request.once("socket", socket => {
        socket.once("secureConnect", () => {
          if (settled) return;
          try {
            verifyPeerFingerprint(socket, expectedFingerprint);
            request.end(payload);
          } catch (error) {
            fail(error);
          }
        });
        socket.once("error", fail);
      });
      request.once("response", response => {
        const chunks = [];
        let size = 0;
        response.on("data", chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            fail(remoteError("response_too_large", "Remote MCP response is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", fail);
        response.once("aborted", () => fail(remoteError("remote_response", "Remote MCP response was interrupted.")));
        response.once("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({statusCode:response.statusCode || 0, headers:response.headers, body:Buffer.concat(chunks)});
        });
      });
      request.once("error", fail);
      timer = setTimeout(() => fail(remoteError("remote_timeout", "Remote MCP request timed out.")), timeoutMs);
    } catch (error) {
      fail(error);
    }
  });
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function parseJsonResponse(response, context = "Remote MCP request") {
  const status = Number(response?.statusCode || 0);
  if (status === 401) throw remoteError("remote_auth", `${context} authorization failed. Reconnect using the configured connection key.`, status);
  if (status === 403) {
    const bodyHint = response?.body?.toString("utf8", 0, 256) || "";
    if (/blocked/i.test(bodyHint) && /pairing/i.test(context)) throw remoteError("pair_blocked", "Pairing is blocked.", status);
    throw remoteError("remote_auth", `${context} authorization failed. Reconnect using the configured connection key.`, status);
  }
  if (status === 404 && /pairing status/i.test(context)) throw remoteError("pair_expired", "Pairing request expired.", status);
  if (status < 200 || status >= 300) throw remoteError("remote_http", `${context} failed (HTTP ${status || "unknown"}).`, status);
  if (!response?.body?.length) {
    if (status === 202) return null;
    throw remoteError("remote_non_json", `${context} returned an empty response.`);
  }
  const contentType = String(headerValue(response.headers, "content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("json")) throw remoteError("remote_non_json", `${context} returned a non-JSON response.`);
  try { return JSON.parse(response.body.toString("utf8")); }
  catch { throw remoteError("remote_non_json", `${context} returned invalid JSON.`); }
}

function requestJson({url, fingerprint, payload, token, sessionId, signal, request = pinnedRequest, context = "Remote MCP request"}) {
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > MAX_OUTGOING_BYTES) return Promise.reject(remoteError("request_too_large", "Remote MCP request is too large."));
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return Promise.resolve().then(() => request({url, method:"POST", headers, body, fingerprint, signal})).then(response => ({
    value:parseJsonResponse(response, context),
    response,
  }));
}

function safeNetworkMessage(error) {
  if (error?.code === "remote_network") return "No reachable PenEcho host was discovered. Keep PenEcho running with MCP and LAN access enabled on the same network; check firewall and multicast discovery settings, or refresh the configured fallback address from the host.";
  if (["remote_timeout", "pair_timeout", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(error?.code)) return "Remote MCP connection timed out. Keep PenEcho running with MCP and LAN access enabled; check the host address, network connection, and firewall, then retry.";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code)) return "Could not reach the PenEcho MCP host. Keep PenEcho running with MCP and LAN access enabled on the same network; check the host address and firewall, then retry.";
  return "";
}

function safeProtocolError(id, error) {
  const code = error?.code === "remote_auth" ? -32001 : error?.code === "remote_aborted" ? -32800 : -32000;
  let message = safeNetworkMessage(error) || "Remote MCP request failed.";
  if (error?.code === "remote_auth") message = "Remote MCP authorization is no longer valid. Reconnect using the configured connection key.";
  else if (error?.code === "key_rejected") message = "PenEcho rejected the connection key; check the configured key and connection settings.";
  else if (error?.code === "tls_pin_mismatch" || error?.code === "tls_peer_missing") message = "Remote MCP certificate pin verification failed. If the host identity was reset, copy a new trusted setup prompt.";
  else if (error?.code === "request_too_large") message = "Remote MCP request is too large.";
  else if (error?.code === "response_too_large") message = "Remote MCP response is too large.";
  else if (error?.code === "remote_non_json") message = "Remote MCP returned a non-JSON response.";
  else if (error?.code === "remote_aborted") message = "Remote MCP request cancelled.";
  return {jsonrpc:"2.0", id:id ?? null, error:{code, message}};
}

function safePairingMessage(error) {
  const networkMessage = safeNetworkMessage(error);
  if (networkMessage) return networkMessage;
  if (error?.code === "tls_pin_mismatch" || error?.code === "tls_peer_missing") return "TLS certificate pin verification failed; if the host identity was reset, copy a new trusted setup prompt from PenEcho.";
  if (error?.code === "remote_auth") return "Connection authorization failed; check the configured connection key in PenEcho.";
  if (error?.code === "key_rejected") return "PenEcho rejected the connection key; check the configured key and connection settings.";
  if (error?.code === "pair_rejected") return "This older PenEcho host rejected legacy pairing.";
  if (error?.code === "pair_blocked") return "This older PenEcho host blocked legacy pairing.";
  if (error?.code === "pair_expired") return "Legacy pairing expired on this older PenEcho host.";
  if (error?.code === "remote_aborted") return "Connection cancelled.";
  return "Could not connect to the remote MCP endpoint; check that PenEcho is enabled and try again.";
}

function delayWithSignal(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, {once:true});
    if (signal?.aborted) onAbort();
  });
}

function parseArgs(argv = []) {
  const result = {help:false, remote:"", "host-id":"", fingerprint:"", invitation:"", name:DEFAULT_NAME};
  if (argv.some(argument => argument === "--help" || argument === "-h")) return {...result, help:true};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (["--remote", "--host-id", "--fingerprint", "--invitation", "--name"].includes(argument)) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw remoteError("invalid_argument", `${argument} requires a value.`);
      result[argument.slice(2)] = argv[++index];
      continue;
    }
    const match = argument.match(/^(--remote|--host-id|--fingerprint|--invitation|--name)=(.*)$/);
    if (match) { result[match[1].slice(2)] = match[2]; continue; }
    throw remoteError("invalid_argument", `Unknown option ${argument}.`);
  }
  if (result.help) return result;
  result.remote = result.remote ? validateRemoteUrl(result.remote) : null;
  if (!result.remote && !result["host-id"]) throw remoteError("invalid_argument", "Provide --host-id or --remote.");
  result.fingerprint = normalizeFingerprint(result.fingerprint);
  if (result["host-id"] && normalizeFingerprint(result["host-id"], "host-id") !== result.fingerprint) throw remoteError("invalid_argument", "host-id must equal the pinned certificate fingerprint.");
  result.invitation = normalizeInvitation(result.invitation);
  result.name = normalizeName(result.name);
  return result;
}

class RemoteMcpClient {
  constructor({remoteUrl, remote, hostId, discover, fingerprint, invitation, name = DEFAULT_NAME, input = process.stdin, output = process.stdout, errorOutput = process.stderr, request = pinnedRequest, clientId, idleTimeoutMs = 60000, connectionTimeoutMs = 120000, retryDelayMs = 250} = {}) {
    this.remoteUrl = remoteUrl || remote ? validateRemoteUrl(remoteUrl || remote) : null;
    this.hostId = hostId ? normalizeFingerprint(hostId, "host-id") : "";
    if (!this.remoteUrl && !this.hostId) throw remoteError("invalid_argument", "Provide --host-id or --remote.");
    this.discover = discover || (options => require("./lan-discovery.js").discover(options));
    this.recovery = null;
    this.generation = 0;
    this.initializeMessage = null;
    this.fingerprint = normalizeFingerprint(fingerprint);
    if (this.hostId && this.hostId !== this.fingerprint) throw remoteError("invalid_argument", "host-id must equal the pinned certificate fingerprint.");
    this.invitation = normalizeInvitation(invitation);
    this.name = normalizeName(name);
    this.clientId = clientId || crypto.randomUUID();
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.request = request;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.queueBytes = 0;
    this.active = 0;
    this.requestControllers = new Set();
    this.pending = new Map();
    this.sessionId = "";
    this.token = "";
    this.authFailed = false;
    this.started = false;
    this.closed = false;
    this.exitCode = 0;
    this.abortController = new AbortController();
    this.pairTimer = null;
    this.leaseSeconds = 0;
    this.heartbeatTimer = null;
    this.heartbeatController = null;
    this.leasedConnection = null;
    this.idleSuspend = false;
    this.suspended = true;
    this.idleTimer = null;
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.pairController = null;
    this.suspendController = null;
    this.recoveryController = null;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.onData = chunk => this.receive(chunk);
    this.onEnd = () => this.close(0);
    this.onError = () => this.close(1);
  }

  start() {
    if (this.started) return this.done;
    this.started = true;
    this.input.on?.("data", this.onData);
    this.input.once?.("end", this.onEnd);
    this.input.once?.("error", this.onError);
    this.input.resume?.();
    return this.done;
  }

  writeErrorLine(message) {
    if (!this.errorOutput?.write) return;
    this.errorOutput.write(`PenEcho remote MCP: ${String(message).slice(0, 500)}\n`);
  }

  send(value) {
    if (this.closed) return;
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_INCOMING_BYTES) return;
    this.output.write(line);
  }

  failPairing(error) {
    if (this.closed) return;
    if (!isAbortError(error)) this.writeErrorLine(safePairingMessage(error));
    for (const item of this.queue) {
      if (!item.notification && !item.cancelled) this.send(safeProtocolError(item.id, error));
      if (this.pending.get(requestKey(item.id)) === item) this.pending.delete(requestKey(item.id));
    }
    this.queue = [];
    this.queueBytes = 0;
    this.suspended = true;
    this.stopHeartbeat();
  }

  async pair({existingToken = "", existingSessionId = "", timeoutMs = PAIRING_TIMEOUT_MS} = {}) {
    const controller = new AbortController();
    this.pairController = controller;
    const signal = controller.signal;
    const onAbort = () => controller.abort();
    this.abortController.signal.addEventListener("abort", onAbort, {once:true});
    if (this.abortController.signal.aborted) controller.abort();
    this.pairTimedOut = false;
    const deadline = Date.now() + timeoutMs;
    this.pairTimer = setTimeout(() => {
      this.pairTimedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let candidates = [];
      if (this.hostId) {
        try { candidates = await this.discover({hostId:this.hostId, signal, timeoutMs:5000}); }
        catch (error) { if (isAbortError(error) || signal.aborted) throw abortError(); }
      }
      if (signal.aborted) throw abortError();
      candidates = [...new Set([...candidates, ...(this.remoteUrl ? [this.remoteUrl.toString()] : [])])].slice(0, 8);
      let lastError = remoteError("remote_network", "No reachable PenEcho host was discovered.");
      for (const candidate of candidates) {
        if (signal.aborted) throw abortError();
        try { this.remoteUrl = validateRemoteUrl(candidate); }
        catch { continue; }
        try {
          if (existingToken) {
            try {
              const probe = await requestJson({url:this.leaseSeconds ? pathUrl(this.remoteUrl, "/heartbeat") : this.remoteUrl, fingerprint:this.fingerprint,
                payload:this.leaseSeconds ? {} : {jsonrpc:"2.0",id:"penecho-reconnect-probe",method:"ping"},
                token:existingToken, sessionId:existingSessionId, signal, request:this.request});
              if (!this.leaseSeconds && (probe.value?.jsonrpc !== "2.0" || probe.value?.id !== "penecho-reconnect-probe" || !probe.value?.result)) throw remoteError("remote_protocol", "Remote MCP reconnection probe failed.");
              if (this.leaseSeconds) this.leasedConnection = {url:this.remoteUrl, token:existingToken};
              return existingToken;
            } catch (error) {
              if (error?.code !== "remote_auth") throw error;
            }
          }
          return await this.pairAttempt(signal, deadline);
        }
        catch (error) {
          lastError = error;
          if (!this.isRecoverable(error)) throw error;
        }
      }
      throw lastError;
    }
    catch (error) {
      if (this.pairTimedOut) throw remoteError("pair_timeout", "Pairing timed out.");
      throw error;
    }
    finally {
      clearTimeout(this.pairTimer);
      this.pairTimer = null;
      this.pairController = null;
      this.abortController.signal.removeEventListener("abort", onAbort);
    }
  }

  async pairAttempt(signal, deadline) {
    const pairResponse = await requestJson({
      url:pathUrl(this.remoteUrl, "/pair"),
      fingerprint:this.fingerprint,
      payload:{invitation:this.invitation,clientId:this.clientId,name:this.name},
      signal,
      request:this.request,
      context:"Remote MCP pairing",
    }).catch(error => {
      if (error?.code === "remote_auth") throw remoteError("key_rejected", "PenEcho rejected the configured connection key.", error.status);
      throw error;
    });
    const initial = pairResponse?.value;
    if (!initial || typeof initial !== "object" || Array.isArray(initial)) throw remoteError("pair_response", "Remote MCP pairing returned an invalid response.");
    if (initial.status === "approved") return this.acceptPairing(initial);
    if (initial.status !== "pending" || typeof initial.requestId !== "string" || !initial.requestId || !isHex64(initial.pollToken) || typeof initial.code !== "string" || !/^\d{4,12}$/.test(initial.code)) {
      if (initial.status === "rejected") throw remoteError("pair_rejected", "Pairing was rejected.");
      if (initial.status === "block" || initial.status === "blocked") throw remoteError("pair_blocked", "Pairing is blocked.");
      if (initial.status === "expired") throw remoteError("pair_expired", "Pairing request expired.");
      throw remoteError("pair_response", "Remote MCP pairing returned an invalid response.");
    }
    const requestId = initial.requestId, pollToken = initial.pollToken;
    this.writeErrorLine(`This older PenEcho host requires legacy pairing. Pairing code: ${initial.code}. Waiting for approval...`);
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await delayWithSignal(Math.min(PAIR_POLL_INTERVAL_MS, remaining), signal);
      const pollResponse = await requestJson({
        url:pathUrl(this.remoteUrl, "/pair/status"),
        fingerprint:this.fingerprint,
        payload:{requestId,pollToken},
        signal,
        request:this.request,
        context:"Remote MCP pairing status",
      });
      const status = pollResponse?.value;
      if (!status || typeof status !== "object" || Array.isArray(status)) throw remoteError("pair_response", "Remote MCP pairing returned an invalid response.");
      if (status.status === "approved") return this.acceptPairing(status);
      if (status.status === "rejected") throw remoteError("pair_rejected", "Pairing was rejected.");
      if (status.status === "block" || status.status === "blocked") throw remoteError("pair_blocked", "Pairing is blocked.");
      if (status.status === "expired") throw remoteError("pair_expired", "Pairing request expired.");
      if (status.status !== "pending") throw remoteError("pair_response", "Remote MCP pairing returned an invalid status.");
    }
    throw remoteError("pair_timeout", "Pairing timed out.");
  }

  acceptPairing(value) {
    const token = this.requireToken(value.token);
    this.leaseSeconds = typeof value.leaseSeconds === "number" && Number.isFinite(value.leaseSeconds) && value.leaseSeconds > 0 ? value.leaseSeconds : 0;
    this.idleSuspend = value.idleSuspend === true;
    this.leasedConnection = this.leaseSeconds ? {url:this.remoteUrl, token} : null;
    return token;
  }

  stopHeartbeat() {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatController?.abort();
    this.heartbeatController = null;
  }

  async lifecycleRequest(path, connection, controller, timeoutMs) {
    let timer, onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(abortError());
      controller.signal.addEventListener("abort", onAbort, {once:true});
      if (controller.signal.aborted) onAbort();
    });
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(remoteError("remote_timeout", "Remote MCP lifecycle request timed out."));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([requestJson({url:pathUrl(connection.url, path), fingerprint:this.fingerprint,
        payload:{}, token:connection.token, signal:controller.signal, request:this.request}), timeout, aborted]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  scheduleHeartbeat() {
    if (this.closed || this.suspended || this.recovery || (!this.active && !this.queue.length) || !this.token || !this.leaseSeconds || this.heartbeatTimer || this.heartbeatController) return;
    const generation = this.generation;
    const interval = Math.max(10, Math.min(2147483647, this.leaseSeconds * 1000 / 3));
    this.heartbeatTimer = setTimeout(async () => {
      this.heartbeatTimer = null;
      const controller = new AbortController();
      this.heartbeatController = controller;
      try {
        await this.lifecycleRequest("/heartbeat", {url:this.remoteUrl, token:this.token}, controller, Math.min(10000, interval));
      } catch (error) {
        if (!this.closed && generation === this.generation && !isAbortError(error)) {
          if (![429, 503].includes(error?.status)) {
            this.suspended = true;
            if (error?.code === "remote_auth") this.token = "";
            // An idle transport never reconnects on its own. Demand drives recovery.
            if (this.queue.length) this.pump();
          }
        }
      } finally {
        if (this.heartbeatController === controller) this.heartbeatController = null;
        this.scheduleHeartbeat();
      }
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  requireToken(value) {
    if (typeof value !== "string" || !isHex64(value)) throw remoteError("pair_response", "Remote MCP pairing returned an invalid token.");
    return value;
  }

  receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > MAX_INCOMING_BYTES) {
          this.buffer = Buffer.alloc(0);
          this.send({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Request is too large."}});
        }
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      const trimmed = line.length && line[line.length - 1] === 13 ? line.subarray(0, line.length - 1) : line;
      if (!trimmed.length) continue;
      if (trimmed.length > MAX_INCOMING_BYTES) {
        this.send({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Request is too large."}});
        continue;
      }
      let message;
      try { message = JSON.parse(trimmed.toString("utf8")); }
      catch { this.send({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}}); continue; }
      this.enqueue(message, trimmed);
    }
  }

  enqueue(message, raw) {
    if (message && typeof message === "object" && !Array.isArray(message) && message.jsonrpc === "2.0" && message.method === "notifications/cancelled") {
      this.cancel(message.params?.requestId);
      return;
    }
    const hasId = message && typeof message === "object" && !Array.isArray(message) && Object.prototype.hasOwnProperty.call(message, "id");
    const id = hasId ? message.id : null;
    const notification = !hasId;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (hasId && id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id)))) {
      if (!notification) this.send({jsonrpc:"2.0",id:id ?? null,error:{code:-32600,message:"Invalid Request"}});
      else this.send({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid Request"}});
      return;
    }
    const bytes = raw.length;
    if (bytes > MAX_OUTGOING_BYTES) {
      if (!notification) this.send({jsonrpc:"2.0",id,error:{code:-32600,message:"Request is too large."}});
      return;
    }
    if (this.authFailed) {
      if (!notification) this.send(safeProtocolError(id, remoteError("remote_auth", "Remote MCP authorization is no longer valid.")));
      return;
    }
    if (this.queueBytes + bytes > MAX_INCOMING_BYTES) {
      if (!notification) this.send({jsonrpc:"2.0",id,error:{code:-32000,message:"Remote MCP request queue is full."}});
      return;
    }
    const item = {message, id, notification, bytes, cancelled:false, controller:null};
    this.queue.push(item);
    this.queueBytes += bytes;
    if (!notification) this.pending.set(requestKey(id), item);
    this.pump();
  }

  cancel(id) {
    if (id === undefined) return;
    const item = this.pending.get(requestKey(id));
    if (!item) return;
    item.cancelled = true;
    this.pending.delete(requestKey(id));
    if (item.controller) {
      item.controller.abort();
      return;
    }
    const index = this.queue.indexOf(item);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.queueBytes -= item.bytes;
      if (!this.queue.length) {
        this.recoveryController?.abort();
        this.pairController?.abort();
      }
    }
  }

  cancelIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdle() {
    if (this.closed || this.active || this.queue.length || this.recovery || this.suspended || this.idleTimer) return;
    this.stopHeartbeat();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.closed || this.active || this.queue.length || this.recovery) return;
      this.suspended = true;
      if (!this.idleSuspend || !this.token) return;
      // Serialize parking and reactivation, so a new request cannot race suspend.
      this.recovery = this.lifecycleRequest("/suspend", {url:this.remoteUrl, token:this.token}, this.suspendController = new AbortController(), 1000)
        .catch(error => { if (error?.code === "remote_auth") this.token = ""; })
        .finally(() => { this.suspendController = null; this.recovery = null; this.pump(); });
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  pump() {
    if (this.closed || this.recovery) return;
    if (!this.queue.length) { this.scheduleIdle(); return; }
    this.cancelIdleTimer();
    if (!this.token || this.suspended) { this.recover(); return; }
    while (!this.closed && this.token && !this.suspended && this.active < MAX_CONCURRENT_REQUESTS && this.queue.length) {
      const item = this.queue.shift();
      this.queueBytes -= item.bytes;
      if (item.cancelled) continue;
      item.retrying = false;
      this.forward(item);
    }
    this.scheduleHeartbeat();
  }

  forward(item) {
    this.active++;
    const generation = this.generation;
    const sessionId = this.sessionId;
    const controller = new AbortController();
    item.controller = controller;
    this.requestControllers.add(controller);
    requestJson({
      url:this.remoteUrl,
      fingerprint:this.fingerprint,
      payload:item.message,
      token:this.token,
      sessionId,
      signal:controller.signal,
      request:this.request,
      context:"Remote MCP request",
    }).then(result => {
      if (this.closed || item.cancelled) return;
      const header = headerValue(result.response?.headers, "mcp-session-id");
      if (typeof header === "string" && Buffer.byteLength(header) <= MAX_SESSION_ID_BYTES && !/[\u0000-\u001f\u007f]/.test(header)) this.sessionId = header;
      if (this.closed || item.cancelled || item.notification) return;
      const value = result.value;
      if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") throw remoteError("remote_protocol", "Remote MCP returned an invalid JSON-RPC response.");
      if (value.id !== item.id) throw remoteError("remote_protocol", "Remote MCP returned a mismatched response ID.");
      if (item.message.method === "initialize" && value.result) this.initializeMessage = item.message;
      this.send(value);
    }).catch(error => {
      if (this.closed || isAbortError(error)) return;
      if (error?.status === 404 && sessionId) {
        error = remoteError("remote_session_lost", "Remote MCP session expired.", 404);
        if (generation === this.generation) {
          this.sessionId = "";
          this.needsInitialize = Boolean(this.initializeMessage);
        }
      }
      if (this.isRecoverable(error)) {
        const safeReplay = [429, 503].includes(error?.status) || error?.code === "remote_auth" || error?.code === "remote_session_lost" || error?.code === "ECONNREFUSED" ||
          ["initialize", "ping", "tools/list", "resources/list", "resources/templates/list", "prompts/list", "prompts/get", "resources/read"].includes(item.message.method);
        if (!item.cancelled && safeReplay && (item.retries || 0) < 2) {
          item.retries = (item.retries || 0) + 1;
          item.retrying = true;
          item.controller = null;
          this.queue.push(item);
          this.queueBytes += item.bytes;
        } else if (!item.notification && !item.cancelled) {
          this.send({jsonrpc:"2.0",id:item.id,error:{code:-32000,message:"Remote MCP connection was interrupted. This request was not replayed; its outcome may be unknown. Retry after checking whether it completed."}});
        }
        if (generation === this.generation) {
          this.suspended = true;
          this.stopHeartbeat();
          if (error?.code === "remote_auth") this.token = "";
        }
        return;
      }
      if (!item.notification) this.send(safeProtocolError(item.id, error));
    }).finally(() => {
      this.requestControllers.delete(controller);
      if (!item.retrying && this.pending.get(requestKey(item.id)) === item) this.pending.delete(requestKey(item.id));
      this.active--;
      this.pump();
    });
  }

  isRecoverable(error) {
    return [429, 503].includes(error?.status) || ["remote_auth", "remote_session_lost", "remote_network", "remote_timeout", "remote_response", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code);
  }

  recover() {
    if (this.closed || this.recovery || !this.queue.length) return this.recovery;
    this.stopHeartbeat();
    this.cancelIdleTimer();
    this.generation++;
    const controller = new AbortController();
    this.recoveryController = controller;
    this.recovery = (async () => {
      let lastError;
      const deadline = Date.now() + this.connectionTimeoutMs;
      for (let attempt = 0; Date.now() < deadline; attempt++) {
        if (this.closed || !this.queue.length) return;
        if (attempt) await delayWithSignal(Math.min(this.retryDelayMs * 2 ** Math.min(attempt - 1, 4), 2000, deadline - Date.now()), controller.signal);
        if (this.closed || !this.queue.length) return;
        if (Date.now() >= deadline) break;
        const previousToken = this.token;
        const previousSession = this.sessionId;
        try {
          this.clientId = crypto.randomUUID();
          const token = await this.pair({existingToken:previousToken, existingSessionId:previousSession, timeoutMs:Math.min(PAIRING_TIMEOUT_MS, deadline - Date.now())});
          if (this.closed) return;
          this.token = token;
          if (token !== previousToken) {
            this.sessionId = "";
            this.needsInitialize = Boolean(this.initializeMessage);
          }
          if (this.needsInitialize) {
            const result = await requestJson({url:this.remoteUrl, fingerprint:this.fingerprint, payload:this.initializeMessage, token, signal:this.abortController.signal, request:this.request});
            if (!result.value?.result || result.value.id !== this.initializeMessage.id) throw remoteError("remote_protocol", "Remote MCP reinitialization failed.");
            const header = headerValue(result.response.headers, "mcp-session-id");
            if (typeof header === "string" && Buffer.byteLength(header) <= MAX_SESSION_ID_BYTES && !/[\u0000-\u001f\u007f]/.test(header)) this.sessionId = header;
            await requestJson({url:this.remoteUrl, fingerprint:this.fingerprint, payload:{jsonrpc:"2.0",method:"notifications/initialized"}, token, sessionId:this.sessionId, signal:this.abortController.signal, request:this.request});
            this.needsInitialize = false;
          }
          this.suspended = false;
          return;
        } catch (error) {
          lastError = error;
          if (error?.code === "remote_auth") this.token = "";
          if (!this.isRecoverable(error)) throw error;
        }
      }
      throw lastError || remoteError("remote_timeout", "Remote MCP connection timed out.");
    })().catch(error => { if (!isAbortError(error)) this.failPairing(error); }).finally(() => {
      this.recoveryController = null;
      this.recovery = null;
      this.pump();
    });
    return this.recovery;
  }

  close(code = 0) {
    if (this.closed) return this.done;
    this.closed = true;
    this.exitCode = code;
    this.cancelIdleTimer();
    this.stopHeartbeat();
    this.recoveryController?.abort();
    this.suspendController?.abort();
    this.suspendController = null;
    this.abortController.abort();
    if (this.pairTimer) clearTimeout(this.pairTimer);
    this.pairTimer = null;
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
    this.pending.clear();
    this.input.off?.("data", this.onData);
    this.input.off?.("end", this.onEnd);
    this.input.off?.("error", this.onError);
    this.queue = [];
    this.queueBytes = 0;
    const connection = this.leasedConnection;
    this.leasedConnection = null;
    const cleanup = connection ? this.lifecycleRequest("/disconnect", connection, new AbortController(), 1000) : Promise.resolve();
    void cleanup.catch(() => {}).finally(() => this.resolveDone({code:this.exitCode}));
    return this.done;
  }
}

async function main(argv = process.argv.slice(2), options = {}) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) {
    (options.errorOutput || process.stderr).write(`PenEcho remote MCP: ${String(error?.message || "Invalid arguments").slice(0, 500)}\n${REMOTE_USAGE}`);
    return 1;
  }
  if (args.help) {
    (options.errorOutput || process.stderr).write(REMOTE_USAGE);
    return 0;
  }
  const client = new RemoteMcpClient({remoteUrl:args.remote, hostId:args["host-id"], discover:options.discover, fingerprint:args.fingerprint, invitation:args.invitation, name:args.name, input:options.input, output:options.output, errorOutput:options.errorOutput, request:options.request, clientId:options.clientId});
  const onInterrupt = () => { void client.close(130); };
  const onTerminate = () => { void client.close(143); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try { return (await client.start()).code; }
  finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (require.main === module) {
  main().then(code => { if (code) process.exitCode = code; }).catch(error => {
    process.stderr.write(`PenEcho remote MCP: ${safePairingMessage(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_NAME,
  MAX_CONCURRENT_REQUESTS,
  MAX_INCOMING_BYTES,
  MAX_OUTGOING_BYTES,
  MAX_RESPONSE_BYTES,
  PAIRING_TIMEOUT_MS,
  PAIR_POLL_INTERVAL_MS,
  REMOTE_USAGE,
  RemoteMcpClient,
  isAllowedRemoteHost,
  isPrivateIPv4,
  isPrivateIPv6,
  main,
  normalizeFingerprint,
  normalizeInvitation,
  parseArgs,
  parseJsonResponse,
  pathUrl,
  pinnedRequest,
  requestPinned: pinnedRequest,
  peerFingerprint,
  requestJson,
  safeProtocolError,
  validateRemoteUrl,
  verifyPeerFingerprint,
};
