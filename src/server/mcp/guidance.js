"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Keep the design authority shared with the built-in Visual Explorer. Its
// internal canvas_create/load_visual_skill instructions do not apply to MCP.
const contract = fs.readFileSync(path.join(__dirname, "../canvas-agent/visual-explorer-contract.md"), "utf8");
const designStart = contract.indexOf("Do not start from visual decoration.");
const designEnd = contract.indexOf("## PenEcho Agent source and invocation");
if (designStart < 0 || designEnd <= designStart) throw new Error("Visual Explorer design contract boundaries are missing.");
const VISUAL_EXPLORER_DESIGN = contract.slice(designStart, designEnd).trim();

const WORKSPACE_INSTRUCTIONS = `Keep this spatial workspace current without delaying the first useful output. Use penecho_update_session only for compact public findings, decisions, blockers, or completion when something meaningful changed; do not create a progress board, timer, heartbeat, tool-count quota, generated visual, or capture for routine status. Reuse IDs and batch related facts. Present useful diagrams or previews when they help, reusing existing work and stable artifact IDs. Read and explicitly acknowledge inbox messages at natural checkpoints when awaiting input or working interactively; reading never wakes a stopped client. Publish final status before yielding. Never send private chain-of-thought, secrets, or transcripts.`;

const VISUAL_INSTRUCTIONS = `For explanations, follow Visual Explorer: clear information hierarchy, readable typography, concise labels, meaningful diagrams/tables, restrained semantic colors, responsive layout, transparent outer HTML, and no clipping or invented numbers. Preserve requested product styles. Use presentation intent/role to express purpose and hierarchy, choose a size for the content, and keep artifactId stable for updates. Interaction must change useful content or enqueue an explicit opted-in choice; never draw fake controls or claim arbitrary Widget callbacks. The optional penecho_visual_explorer prompt contains the full shared design standard; retrieve it once when needed for substantial visual authoring. Ordinary presentation uses capture:false.`;

const MCP_PRESENTATION_INSTRUCTIONS = `Use presentation.intent explain|deliver|compare|review to state why an artifact is shown, and role primary|supporting|alternative to state its hierarchy. Widget and plot size presets are base 480×360, wide 992×360, tall 480×752, large 992×752, and page 1200×800. Use relativeTo with a stable artifactId for below/beside placement; compare defaults beside. Review requests attention by default, while supporting or alternative artifacts stay quiet unless reviewing. Keep the same artifactId when revising so source updates preserve the user's placement and size. Explain and compare may use Visual Explorer's infographic/comprehension structure. When reviewing or delivering an actual page design, preserve the target product UI, its page background, and real local interactions; do not wrap the page in an explanatory card. Inspect must faithfully render the supplied HTML at the requested viewport without redesign or extra labels; use page 1200×800 or explicit legacy dimensions for a mobile viewport. Use Widget intent inspect only with capture:true for one ephemeral viewport render when pixels are needed before delivery; it creates no Canvas object. Prefer one meaningful interaction over decorative controls. Widget buttons reach the client only when explicitly opted into the pull inbox with data-penecho-action="choose" and a bounded data-penecho-prompt; otherwise they are ordinary local Widget behavior, not MCP callbacks. Read and acknowledge inbox messages explicitly; no click or read automatically wakes a stopped client.`;

// Session start repeats only the compact operational reminder, not design text.
const SESSION_INSTRUCTIONS = WORKSPACE_INSTRUCTIONS;

function visualExplorerPrompt() {
  return `${VISUAL_EXPLORER_DESIGN}\n\n## External MCP delivery\n${SESSION_INSTRUCTIONS}\n\n${MCP_PRESENTATION_INSTRUCTIONS}\n\nCreate responsive HTML/CSS/SVG with minimal JavaScript and present it with penecho_present_widget. For simple native nodes/text use penecho_draw; for bare functions use penecho_plot. Use only tools advertised by this MCP server. Read feedback before replacing an existing artifact; preserve its identity and user placement. Inspect a bounded capture after initial authoring or meaningful layout revisions when visual evidence is needed; correct concrete readability, clipping, and responsive defects. Never claim visual verification without returned pixels.`;
}

module.exports = { MCP_PRESENTATION_INSTRUCTIONS, WORKSPACE_INSTRUCTIONS, VISUAL_INSTRUCTIONS, SESSION_INSTRUCTIONS, visualExplorerPrompt };
