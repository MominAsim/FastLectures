"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const GUIDANCE_IDS = Object.freeze(["visual-explorer", "general-html", "math-2d", "physics-2d", "math-3d"]);
const cache = new Map();
const ROUTING = `Choose by the requested result. Understanding, learning, explanation, analysis, and organization use visual-explorer. New UI pages, product previews, ordinary HTML tools, interaction-first simulations, and live data use general-html; a new page does not automatically use Visual Explorer. Existing Canvas/page edits preserve their current source and style. Bare function graphs use penecho_plot. Load a science supplement only when the requested result needs calibrated mathematical geometry/curves (math-2d), physical simulation (physics-2d), or spatial 3-D mathematics (math-3d). A technical explanation containing formulas, matrices, or complexity notation alone stays in visual-explorer; it does not require a science renderer. Load only the closest needed supplement using penecho_get_guidance({id}). Guidance already read at the same version/hash does not need another read. Do not load science guidance for unrelated work.`;
const DELIVERY = `## Public source and delivery
Create one complete responsive HTML/CSS/SVG document with minimal JavaScript and a concise title using penecho_present_widget. Keep a stable artifactId when revising. relativeTo must be an artifactId already returned in this session, never an objectId or guessed title; omit it for independent work and let the host place it. Use penecho_list_files and penecho_read_file to discover and read the returned virtual source path; virtual paths are not host filesystem paths. Use penecho_patch_file with that exact path, contentHash and a strict unified diff for existing source edits. Keep major HTML elements, CSS declarations and JavaScript statements on stable separate lines. After initial render and meaningful layout changes, post {type:"penecho-widget-updated"} to the parent, never every frame.
Use penecho_draw for simple native nodes/text, penecho_plot for bare functions, and penecho_edit_canvas for supported geometry edits with the current baseRevision. Do not add internal creation fields or use tools absent from the advertised schema. Keep ordinary updates capture:false. When pixel evidence is needed, combine presentation with capture:true; use penecho_capture_widget or penecho_capture_canvas only for a bounded unresolved visual question. Never claim verification without returned pixels. Preserve artifact identity, placement, user edits, and unread feedback. Finish when the requested answer is complete, readable and usable. After the initial check, edit only for a data/logic error, missing requirement, broken interaction or unreadable essential content. Minor spacing, label shifts and optional polish do not justify another read/patch/capture cycle unless requested.`;

function getAuthoringGuidance(id) {
  if (!GUIDANCE_IDS.includes(id)) throw new RangeError(`Unknown authoring guidance: ${String(id)}.`);
  if (cache.has(id)) return cache.get(id);
  let document;
  if (id === "visual-explorer") {
    const contract = fs.readFileSync(path.join(__dirname, "../canvas-agent/visual-explorer-contract.md"), "utf8");
    const start = contract.indexOf("Do not start from visual decoration.");
    const end = contract.indexOf("## PenEcho Agent source and invocation");
    if (start < 0 || end <= start) throw new Error("Visual Explorer design contract boundaries are missing.");
    document = `# Visual Explorer authoring guidance\n\n${ROUTING}\n\n${contract.slice(start, end)}## Technical evidence quality\nState the assumptions beside conditional formulas. Use a worked numerical example or a calibrated chart when comparing quantities; never substitute an arbitrary curve for the claimed mechanism. If a figure is only schematic, label that limit clearly and do not attach quantitative conclusions to its shape.\n\n${DELIVERY}`;
  } else if (id === "general-html") {
    const contract = fs.readFileSync(path.join(__dirname, "../canvas-agent/general-html-contract.md"), "utf8");
    const section = (start, end) => {
      const first = contract.indexOf(start), last = end ? contract.indexOf(end, first) : contract.length;
      if (first < 0 || last <= first) throw new Error("General HTML contract boundaries are missing.");
      return contract.slice(first, last).trim();
    };
    const authoring = section("The visible Widget must answer visually.", "## Canvas relationship");
    const relationship = section("Treat the Canvas as an existing document.", "Before adding a standalone Widget");
    const runtime = section("## Runtime safety", "## Refinement");
    document = `# General HTML authoring guidance\n\n${ROUTING}\n\n## Authoring contract\nCreate one complete responsive HTML document through penecho_present_widget with a concise title, complete html with inline CSS and necessary JavaScript, a stable artifactId, and dimensions selected for the actual content. HTML is the canonical source. Do not minify. Keep major HTML elements, CSS declarations, and JavaScript statements on stable separate lines so later source diffs stay small. Use only fields in the public tool schema.\n\n${authoring}\n\n## Canvas relationship\n${relationship}\n\nFor actual product UI pages, preserve the target product's styling, page background, typography, responsive structure, and actual local interactions. Deliver one complete scrollable page as one Widget. Do not wrap a product page in an explanatory infographic. Use desktop page size or explicit mobile dimensions, never both a preset and dimensions. Use native labeled controls, keyboard access, visible focus, and readable text. Filters, tabs and toggles work locally without model calls. Only explicit AI requests use data-penecho-action and a bounded data-penecho-prompt; label them as requests.\n\n${runtime}\n\nThe host's Widget sandbox and Content Security Policy remain authoritative. Guidance does not enable blocked capabilities or resources; use the allowed public runtime and show a useful fallback when a resource cannot load.\n\n## Refinement\nFor an existing Widget, use penecho_list_files and penecho_read_file to read the exact virtual HTML source covering the requested change. Combine all known edits into one coherent multi-hunk penecho_patch_file patch when practical. Supply the returned contentHash and strict unified-diff headers matching the returned virtual path. Preserve unrelated content, established style and live geometry. Never use physical host paths. Do not publish a timed scaffold or repeatedly re-read after a successful patch. Reuse the returned current hash and source evidence if sufficient; read again only for incomplete source, SOURCE_CONFLICT, or a real patch mismatch. Retry an unknown outcome with identical arguments and requestId; a source conflict needs a fresh read and new requestId. Routine refinements need no intermediate capture; take one final capture only when pixel evidence matters, and another only for a concrete unresolved defect. Fix evidenced defects and stop when complete.\n\n${DELIVERY}`;
  } else {
    // Scientific evidence, markers and verified examples remain byte-for-byte
    // sourced from the same contracts as the built-in authoring path.
    document = fs.readFileSync(path.join(__dirname, `../canvas-agent/visual-skills/${id}.md`), "utf8");
  }
  const hash = crypto.createHash("sha256").update(document).digest("hex");
  const result = Object.freeze({ id, version:"1", hash, document });
  cache.set(id, result);
  return result;
}

module.exports = { GUIDANCE_IDS, ROUTING, getAuthoringGuidance };
