"use strict";

const { TOOLS } = require("./schema.js");
const { PUBLIC_INSTRUCTIONS } = require("./guidance.js");

const DISCOVERY_URI = "fastlectures://guidance/discovery";
const SKILL_URI = "fastlectures://guidance/skill";
const DISCOVERY_INSTRUCTIONS = `Read resources/read ${DISCOVERY_URI} for live tools and skill discovery.`;
const RESOURCES = [
  { uri:DISCOVERY_URI, name:"fastlectures_discovery", title:"FastLectures live capability discovery", description:"Read this resource for current tools and live guidance, including when tools are absent; resources/list is not tools/list.", mimeType:"text/markdown" },
  { uri:SKILL_URI, name:"fastlectures_skill", title:"FastLectures live workspace skill guidance", description:"Current FastLectures, echo, canvas and 画布 workspace invocation and safe session workflow.", mimeType:"text/markdown" },
];

function readResource(uri, prompts) {
  if (typeof uri !== "string" || !RESOURCES.some(resource => resource.uri === uri)) {
    throw Object.assign(new Error("Unknown FastLectures resource URI."), { code:-32602 });
  }
  const text = uri === SKILL_URI
    ? `# FastLectures / echo / 画布 guidance v2 (local skill is a static bootstrap)

${PUBLIC_INSTRUCTIONS}`
    : `# FastLectures discovery

Use tools/list for all tools and schemas, tools/call to invoke; prompts/list and prompts/get for workflows; resources/list and resources/read for guidance; follow nextCursor. Resources are not tools. For stale client catalogs, refresh or reconnect. Local skills are not automatically overwritten. Common tools: start_session, present_widget, read_file, patch_file, edit_canvas, inbox. All other tools remain directly callable. Read fastlectures_get_guidance only for the relevant task; brief is default, detail:full retains complete guidance.

${TOOLS.map(tool => `- ${tool.name}`).join("\n")}

Prompts: ${prompts.map(prompt=>prompt.name).join(", ")}`;

  return { contents:[{ uri, mimeType:"text/markdown", text }] };
}

module.exports = { DISCOVERY_URI, SKILL_URI, DISCOVERY_INSTRUCTIONS, RESOURCES, readResource };
