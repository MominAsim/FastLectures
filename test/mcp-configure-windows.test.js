"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Run the production launch resolvers as Windows without spawning any process.
function fixture(t, respond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penecho-mcp-windows-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const calls = [], cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports:{} }, localRequire = createRequire(filename);
    cache.set(filename, module.exports);
    const requireMock = name => {
      if (name === "node:child_process") return { execFile(command, args, options, callback) {
        const call = { command, args:Array.from(args), options };
        calls.push(call);
        respond(call, callback);
      } };
      if (name === "../../providers/codex-cli.js" || name === "../../providers/claude-cli.js") return load(localRequire.resolve(name));
      return localRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      require:requireMock, module, exports:module.exports,
      process:{ platform:"win32", execPath:process.execPath, env:process.env },
      Buffer, setTimeout, clearTimeout,
    }, { filename });
    cache.set(filename, module.exports);
    return module.exports;
  }
  const api = load(path.join(__dirname, "../src/server/mcp/configure.js"));
  const file = relative => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive:true });
    fs.writeFileSync(filename, "");
    return filename;
  };
  return { api, calls, root, file };
}

const launch = {
  command:'C:\\Program Files\\PenEcho & Tools\\PenEcho.exe',
  args:['C:\\Users\\用户\\stdio.js', '--state-dir', 'C:\\space & %PATH% ! ^ ( )\\', 'literal "quote"'],
  env:{ ELECTRON_RUN_AS_NODE:"1", EXACT:'space & %PATH% ! ^ "quoted"' },
};
const missingEntry = (call, callback) => callback(call.args.includes("get") ? new Error("not configured") : null, "", "");

for (const client of ["codex", "claude"]) {
  test(`${client} npm Windows wrapper configures with literal arguments through Node`, async t => {
    const { api, calls, root, file } = fixture(t, missingEntry);
    const wrapper = file(`${client}.cmd`);
    const script = file(client === "codex" ? "node_modules/@openai/codex/bin/codex.js" : "node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs");
    const env = { PATH:"test-path", HOME:root };
    const result = await api.configureClient(client, launch, { candidates:[{ executable:wrapper }], rootDirectory:root, env });
    assert.equal(result.configured, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [script, "mcp", "get", "penecho"]);
    assert.deepEqual(calls[1].args, [script, ...api.configurationArguments(client, launch)]);
    for (const call of calls) {
      assert.equal(call.command, process.execPath);
      assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(call.options.env.HOME, root);
      assert.equal(call.options.cwd, root);
      assert.equal(call.options.timeout, 20_000);
      assert.equal(call.options.shell, undefined);
      assert.equal(call.options.windowsHide, true);
    }
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  });
}

test("Windows inspection resolves Claude native payload and Codex npm payload without writes", async t => {
  const { api, calls, file } = fixture(t, (call, callback) => callback(null, "entry", ""));
  const codex = file("codex.cmd"), claude = file("claude.cmd");
  const script = file("node_modules/@openai/codex/bin/codex.js");
  const native = file("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  const result = await api.inspectConfiguredClients({ candidates:{ codex:[{ executable:codex }], claude:[{ executable:claude }] } });
  assert.deepEqual(Array.from(result), ["codex", "claude"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.find(call => call.command === process.execPath).args, [script, "mcp", "get", "penecho"]);
  assert.deepEqual(calls.find(call => call.command === native).args, ["mcp", "get", "penecho"]);
  assert.ok(calls.every(call => call.options.timeout === 1_000 && !call.options.shell));
});

test("unsupported Windows wrapper falls back to native candidate and preserves existing entry", async t => {
  const { api, calls, file } = fixture(t, (call, callback) => callback(null, "entry", ""));
  const wrapper = file("unsupported/codex.cmd"), native = file("managed/codex.exe");
  const result = await api.configureClient("codex", launch, { candidates:[{ executable:wrapper }, { executable:native }] });
  assert.equal(result.existing, true);
  assert.equal(result.configured, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, native);
  assert.deepEqual(calls[0].args, ["mcp", "get", "penecho"]);
});

test("unsupported Windows wrapper fails without invoking a shell", async t => {
  const { api, calls, file } = fixture(t, () => assert.fail("must not execute wrapper"));
  const result = await api.configureClient("codex", launch, { candidates:[{ executable:file("codex.bat") }] });
  assert.equal(result.configured, false);
  assert.match(result.error, /Windows batch wrappers are unsupported/);
  assert.equal(calls.length, 0);
});
