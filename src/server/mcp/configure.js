"use strict";

const { execFile } = require("node:child_process");
const os = require("node:os");
const { cliCandidates } = require("../../providers/cli-discovery.js");
const { McpBridgeError } = require("./schema.js");

const MAX_OUTPUT_BYTES = 64 * 1024;
const CONFIGURE_TIMEOUT_MS = 20_000;
const CLIENT_INSPECTION_TIMEOUT_MS = 1_000;
const MAX_INSPECTION_CANDIDATES = 2;

function configurationArguments(client, launch) {
  const envArgs = Object.entries(launch.env || {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  if (client === "codex") return ["mcp", "add", ...envArgs, "penecho", "--", launch.command, ...launch.args];
  if (client === "claude") return ["mcp", "add", "--transport", "stdio", "--scope", "user", ...envArgs, "penecho", "--", launch.command, ...launch.args];
  throw new McpBridgeError("invalid_client", "Choose Codex or Claude.", 400);
}

function executeFile(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd:options.cwd,
      env:options.env,
      timeout:options.timeout === undefined ? CONFIGURE_TIMEOUT_MS : options.timeout,
      maxBuffer:MAX_OUTPUT_BYTES,
      windowsHide:true,
    }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
  });
}

function boundedInspectionRun(runner, executable, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("MCP client inspection timed out."), { code:"ETIMEDOUT" })), timeoutMs);
    Promise.resolve().then(() => runner(executable, args, options)).then(
      result => { clearTimeout(timer); resolve(result); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

async function inspectConfiguredClients(options = {}) {
  const runner = options.executeFile || executeFile;
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, CLIENT_INSPECTION_TIMEOUT_MS)
    : CLIENT_INSPECTION_TIMEOUT_MS;
  const inspect = async client => {
    const provider = `${client}-cli`;
    const injected = options.candidates && !Array.isArray(options.candidates) ? options.candidates[client] : options.candidates;
    const candidates = (injected || cliCandidates(provider, {
      env:options.env || process.env,
      home:options.home || os.homedir(),
      stateDir:options.stateDirectory,
    })).slice(0, MAX_INSPECTION_CANDIDATES);
    for (const candidate of candidates) {
      try {
        await boundedInspectionRun(runner, candidate.executable, ["mcp", "get", "penecho"], {
          cwd:options.rootDirectory,
          env:options.env || process.env,
          timeout:timeoutMs,
        }, timeoutMs);
        return client;
      } catch {}
    }
    return null;
  };
  return (await Promise.all(["codex", "claude"].map(inspect))).filter(Boolean);
}

async function configureClient(client, launch, options = {}) {
  const provider = client === "codex" ? "codex-cli" : client === "claude" ? "claude-cli" : "";
  if (!provider) throw new McpBridgeError("invalid_client", "Choose Codex or Claude.", 400);
  const candidates = options.candidates || cliCandidates(provider, {
    env:options.env || process.env,
    home:options.home || os.homedir(),
    stateDir:options.stateDirectory,
  });
  if (!candidates.length) return {
    configured:false,
    client,
    error:`${client === "codex" ? "Codex" : "Claude"} CLI was not found. Install or repair its official CLI, then try again.`,
    command:launch,
  };
  const args = configurationArguments(client, launch), inspectArgs = ["mcp", "get", "penecho"], runner = options.executeFile || executeFile;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      try {
        await runner(candidate.executable, inspectArgs, { cwd:options.rootDirectory, env:options.env || process.env });
        return {
          configured:false,
          client,
          existing:true,
          error:`A PenEcho MCP entry already exists in ${client === "codex" ? "Codex" : "Claude"}. Remove that entry in the client, then try automatic configuration again.`,
          command:launch,
        };
      } catch {}
      await runner(candidate.executable, args, { cwd:options.rootDirectory, env:options.env || process.env });
      return { configured:true, client };
    } catch (error) { lastError = error; }
  }
  const detail = String(lastError?.stderr || lastError?.stdout || lastError?.message || "Configuration failed").trim().slice(0, 800);
  return { configured:false, client, error:detail || "The client could not save the PenEcho MCP configuration.", command:launch };
}

module.exports = {
  CLIENT_INSPECTION_TIMEOUT_MS,
  CONFIGURE_TIMEOUT_MS,
  MAX_INSPECTION_CANDIDATES,
  configurationArguments,
  configureClient,
  inspectConfiguredClients,
};
