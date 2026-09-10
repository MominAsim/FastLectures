"use strict";

const { TOOLS } = require("./schema.js");
const { WORKSPACE_INSTRUCTIONS } = require("./guidance.js");

const DISCOVERY_URI = "penecho://guidance/discovery";
const SKILL_URI = "penecho://guidance/skill";
const DISCOVERY_INSTRUCTIONS = `Read resources/read ${DISCOVERY_URI} for live tools and skill discovery.`;
const RESOURCES = [
  { uri:DISCOVERY_URI, name:"penecho_discovery", title:"PenEcho live capability discovery", description:"Read this resource for current tools and live guidance, including when tools are absent; resources/list is not tools/list.", mimeType:"text/markdown" },
  { uri:SKILL_URI, name:"penecho_skill", title:"PenEcho live workspace skill guidance", description:"Current PenEcho, echo, canvas and 画布 workspace invocation and safe session workflow.", mimeType:"text/markdown" },
];

function readResource(uri, prompts) {
  if (typeof uri !== "string" || !RESOURCES.some(resource => resource.uri === uri)) {
    throw Object.assign(new Error("Unknown PenEcho resource URI."), { code:-32602 });
  }
  const text = uri === SKILL_URI
    ? `# PenEcho live workspace guidance\n\nUse PenEcho as a spatial workspace for visual explanations, architectures and proposed changes.\n\n- Use PenEcho to explain this idea.\n- Echo this folder’s architecture.\n- Put the proposed changes on canvas.\n- 在画布上解释这个方案。\n\n${WORKSPACE_INSTRUCTIONS}\n\n${DISCOVERY_INSTRUCTIONS}\n\nAn installed local skill is a static bootstrap; reading this live resource provides current guidance but does not overwrite the installed skill file.`
    : `# PenEcho capability discovery\n\nresources/list discovers resources, not tools. If PenEcho tools are absent from your client, refresh tool discovery or reconnect; the resource itself does not execute tools. Call tools/list for current tool names, descriptions and input schemas, prompts/list then prompts/get for current workflows, and resources/list then resources/read for current guidance. Follow nextCursor with cursor on list responses until complete. Read ${SKILL_URI} for the current workspace skill. Use tools/call with name penecho_get_guidance and arguments matching its current tools/list schema for task-specific authoring guidance.\n\nThe connection bridge forwards MCP protocol requests transparently; newly supported server tools, prompts and resources need no remote connection configuration rewrite. Clients that cache discovery may require a tool refresh or reconnect after a server update. Unsupported protocol methods still return Method not found. Local installed skill files remain static bootstraps and are not automatically overwritten. resources/templates/list is empty because these resources use fixed URIs.\n\nCurrent tools (derived from this server's registry):\n${TOOLS.map(tool => `- ${tool.name}`).join("\n")}\n\nCurrent prompts (derived from this server's registry):\n${prompts.map(prompt => `- ${prompt.name}`).join("\n")}`;
  return { contents:[{ uri, mimeType:"text/markdown", text }] };
}

module.exports = { DISCOVERY_URI, SKILL_URI, DISCOVERY_INSTRUCTIONS, RESOURCES, readResource };
