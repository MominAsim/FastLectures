"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { GUIDANCE_IDS, getAuthoringGuidance } = require("../src/server/mcp/authoring-guidance.js");
const { TOOLS, validateToolArguments } = require("../src/server/mcp/schema.js");
const { PenEchoStdioServer, INSTRUCTIONS } = require("../src/server/mcp/stdio.js");

const read = file => fs.readFileSync(path.join(__dirname, "../src/server/canvas-agent", file), "utf8");

test("shared guidance preserves the complete authoritative design and scientific documents", () => {
  const contract = read("visual-explorer-contract.md");
  const body = contract.slice(contract.indexOf("Do not start from visual decoration."), contract.indexOf("## PenEcho Agent source and invocation"));
  assert.ok(getAuthoringGuidance("visual-explorer").document.includes(body));
  for (const id of ["math-2d", "physics-2d", "math-3d"]) {
    assert.equal(getAuthoringGuidance(id).document, read(`visual-skills/${id}.md`));
  }
  for (const id of GUIDANCE_IDS) {
    const result = getAuthoringGuidance(id);
    assert.equal(result.id, id);
    assert.equal(result.hash, crypto.createHash("sha256").update(result.document).digest("hex"));
    assert.equal(getAuthoringGuidance(id), result);
    assert.doesNotMatch(result.document, /canvas_create|load_visual_skill|plannedWidget|professional.diagram|private.plugin/i);
  }
  assert.throws(() => getAuthoringGuidance("../private"), RangeError);
});

test("general HTML retains canonical runtime safety and authoring rules", () => {
  const contract = read("general-html-contract.md");
  const general = getAuthoringGuidance("general-html").document;
  const runtime = contract.slice(contract.indexOf("## Runtime safety"), contract.indexOf("## Refinement")).trim();
  assert.ok(general.includes(runtime));
  assert.match(general, /The visible Widget must answer visually/);
  assert.match(general, /Treat the Canvas as an existing document/);
  assert.match(general, /Content Security Policy remain authoritative/);
  assert.match(general, /SOURCE_CONFLICT/);
  assert.doesNotMatch(general, /canvas_inspect|canvas_patch_widget|sourceHash|afterWindows/);
});

test("routing keeps page UI separate and default guidance compact", () => {
  assert.match(getAuthoringGuidance("general-html").document, /new page does not automatically use Visual Explorer/);
  assert.match(getAuthoringGuidance("visual-explorer").document, /Bare function graphs use penecho_plot/);
  assert.match(INSTRUCTIONS, /penecho_get_guidance/);
  assert.ok(INSTRUCTIONS.length < 5000);
  assert.doesNotMatch(INSTRUCTIONS, /## 1. Information Architecture|Verified Manim-Web/);
});

test("guidance is discoverable and validates strict arguments without changing old tool contracts", () => {
  const tool = TOOLS.find(tool => tool.name === "penecho_get_guidance");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties.id.enum, GUIDANCE_IDS);
  for (const id of GUIDANCE_IDS) assert.deepEqual(validateToolArguments(tool.name, {id}), {id});
  for (const args of [{}, {id:"private"}, {id:"visual-explorer",sessionId:"x"}]) {
    assert.throws(() => validateToolArguments(tool.name, args), {code:"invalid_arguments"});
  }
  assert.deepEqual(validateToolArguments("penecho_list_canvases", {}), {});
});

test("stdio returns guidance and legacy prompt without discovery or a live instance", async () => {
  const messages = [];
  const server = new PenEchoStdioServer({output:{write:text => messages.push(JSON.parse(text))}});
  server.records = () => { throw new Error("must not discover instances"); };
  const call = async (method, params) => {
    await server.handle({jsonrpc:"2.0",id:messages.length + 1,method,params});
    return messages.at(-1);
  };
  await call("initialize", {});
  const listed = await call("tools/list", {});
  assert.ok(listed.result.tools.some(tool => tool.name === "penecho_get_guidance"));
  for (const id of GUIDANCE_IDS) {
    const response = await call("tools/call", {name:"penecho_get_guidance",arguments:{id}});
    assert.deepEqual(response.result.structuredContent, getAuthoringGuidance(id));
  }
  const invalid = await call("tools/call", {name:"penecho_get_guidance",arguments:{id:"private"}});
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent.code, "invalid_arguments");
  const prompt = await call("prompts/get", {name:"penecho_visual_explorer",arguments:{}});
  assert.ok(prompt.result.messages[0].content.text.includes(getAuthoringGuidance("visual-explorer").document));
  assert.equal(server.pending.size, 0);
});
