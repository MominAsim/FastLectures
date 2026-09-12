"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const GUIDANCE_IDS = Object.freeze(["visual-explorer", "general-html", "math-2d", "physics-2d", "math-3d"]);
const cache = new Map();
// Keep route selection sourced from the same 1.2.0 contract as visual design.
const visualExplorerContract = fs.readFileSync(path.join(__dirname, "../canvas-agent/visual-explorer-contract.md"), "utf8");
const selectionParagraph = visualExplorerContract.split(/\r?\n\r?\n/).find(paragraph => paragraph.startsWith("Visual Explorer is the default route"));
if (!selectionParagraph) throw new Error("Visual Explorer selection contract is missing.");
const VISUAL_EXPLORER_SELECTION = selectionParagraph.replace('host-native `canvas_create` `type:"plot"`', '`penecho_plot`');
const CANVAS_RENDERING_ROUTING = `Choose the rendering tool by the requested result, existing Canvas content and editing needs; a diagram type or chat source language alone does not select HTML. ${VISUAL_EXPLORER_SELECTION} When that route fits, use penecho_present_widget with an internal HTML/CSS/SVG container, including for static visuals. Use penecho_draw for simple native marks or explicitly requested native drawing, penecho_plot for bare function graphs, and edit existing objects in their current form. When the user requests both a rendered Canvas diagram and Mermaid/PlantUML chat source, provide both and keep them consistent; select the Canvas representation by the task. A chat instruction such as "do not return HTML" does not prohibit an internal Widget container and does not require one. Source-only requests do not require a Canvas artifact. Respect an explicit ban on using HTML/Widgets for implementation. Choose general-html guidance for product UI. Before authoring a Visual Explorer, read penecho_get_guidance({id:"visual-explorer"}) unless its current design contract is already in context; one read provides the complete design requirements. For a large Widget, first create a small coherent usable version, then complete the same artifact with focused source patches. Do not delay the first useful Canvas result to finish every detail. This is not a timed placeholder: the first version must already communicate the main result, and the remaining requested content must still be completed.`;
const ROUTING = `${VISUAL_EXPLORER_SELECTION} Choose by the requested result. New UI pages, product previews, ordinary HTML tools, interaction-first simulations, and live data use general-html; a new page does not automatically use Visual Explorer. Existing Canvas/page edits preserve their current source and style. Bare function graphs use penecho_plot. Load a science supplement only when the requested result needs calibrated mathematical geometry/curves (math-2d), physical simulation (physics-2d), or spatial 3-D mathematics (math-3d). A technical explanation containing formulas, matrices, or complexity notation alone stays in visual-explorer; it does not require a science renderer. Load only the closest needed supplement using penecho_get_guidance({id}). Guidance already read at the same version/hash does not need another read. Do not load science guidance for unrelated work.`;
const DELIVERY = `## Public source and delivery
Create one complete responsive HTML/CSS/SVG document with minimal JavaScript and a concise title using penecho_present_widget. New Widgets use the host available unobscured viewport. Default/page sizing takes its aspect ratio; explicit dimensions and other presets are preferred CSS content dimensions capped independently to the available width and height, not Canvas world coordinates. Read the returned actual viewport. Upload authorized local PNG/JPEG/WebP images with penecho_upload_image, then use its returned penecho-asset:<sha256> source directly in img src or CSS url(). These document-owned immutable attachments are saved with the Canvas; find existing references in assets/index.json. Use penecho_place_image for a separate Canvas image. The file upload helper reads and encodes local bytes outside model context. Do not patch binary bytes into virtual text files. HTTPS and embedded Data URLs also work; file: paths and penecho-ref object references are not resolved inside Widget HTML. Keep the canonical HTML on stable asset references when patching. Author the HTML root with width:100% and min-width:0, responsive columns with media or container queries, readable normal CSS font sizes, and vertical scrolling for excess content. Never fix the root to a pixel width or use whole-page transform/zoom to squeeze content. Source updates preserve existing artifact geometry. intent:inspect renders the exact requested viewport temporarily without a Canvas object. Keep a stable artifactId when revising. relativeTo must be an artifactId already returned in this session, never an objectId or guessed title; omit it for independent work and let the host place it. Use penecho_list_files and penecho_read_file to discover and read the returned virtual source path; virtual paths are not host filesystem paths. Use penecho_patch_file with that exact path, contentHash and a strict unified diff for existing source edits. Keep major HTML elements, CSS declarations and JavaScript statements on stable separate lines. After initial render and meaningful layout changes, post {type:"penecho-widget-updated"} to the parent, never every frame.
Use penecho_draw for simple native nodes/text, penecho_plot for bare functions, and penecho_edit_canvas for supported geometry edits with the current baseRevision. Do not add internal creation fields or use tools absent from the advertised schema. Keep ordinary updates capture:false. When pixel evidence is needed, combine presentation with capture:true; use penecho_capture_canvas only for a bounded unresolved visual question. Never claim verification without returned pixels. Preserve artifact identity, placement, user edits, and unread feedback. Finish when the requested answer is complete, readable and usable. After the initial check, edit only for a data/logic error, missing requirement, broken interaction or unreadable essential content. Minor spacing, label shifts and optional polish do not justify another read/patch/capture cycle unless requested.`;

function getFullGuidance(id) {
  if (!GUIDANCE_IDS.includes(id)) throw new RangeError(`Unknown authoring guidance: ${String(id)}.`);
  if (cache.has(id)) return cache.get(id);
  let document;
  if (id === "visual-explorer") {
    const contract = visualExplorerContract;
    const start = contract.indexOf("Do not start from visual decoration.");
    const end = contract.indexOf("## PenEcho Agent source and invocation");
    if (start < 0 || end <= start) throw new Error("Visual Explorer design contract boundaries are missing.");
    document = `# Visual Explorer authoring guidance\n\n${ROUTING}\n\n${CANVAS_RENDERING_ROUTING}\n\n${contract.slice(start, end)}## Final Visual Explorer review\nCheck composition-wide typography against the design contract: font family, scale, weight, line height, and casing must form a coordinated hierarchy. Correct a concrete mismatch found in rendered evidence before delivery; do not skip this design check merely because the document is runnable.\n\n## Technical evidence quality\nState the assumptions beside conditional formulas. Use a worked numerical example or a calibrated chart when comparing quantities; never substitute an arbitrary curve for the claimed mechanism. If a figure is only schematic, label that limit clearly and do not attach quantitative conclusions to its shape.\n\n${DELIVERY}`;
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
    document = `# General HTML authoring guidance\n\n${ROUTING}\n\n${CANVAS_RENDERING_ROUTING}\n\n## Authoring contract\nCreate one complete responsive HTML document through penecho_present_widget with a concise title, complete html with inline CSS and necessary JavaScript, a stable artifactId, and optional preferred display dimensions selected for the content. HTML is the canonical source. Do not minify. Keep major HTML elements, CSS declarations, and JavaScript statements on stable separate lines so later source diffs stay small. Use only fields in the public tool schema.\n\n${authoring}\n\n## Canvas relationship\n${relationship}\n\nFor actual product UI pages, preserve the target product's styling, page background, typography, responsive structure, and actual local interactions. Deliver one complete scrollable page as one Widget. Do not wrap a product page in an explanatory infographic. Use default/page sizing for the available viewport or explicit preferred mobile dimensions, never both a preset and dimensions. Use native labeled controls, keyboard access, visible focus, and readable text. Filters, tabs and toggles work locally without model calls. Only explicit AI requests use data-penecho-action and a bounded data-penecho-prompt; label them as requests.\n\n${runtime}\n\nThe host's Widget sandbox and Content Security Policy remain authoritative. Guidance does not enable blocked capabilities or resources; use the allowed public runtime and show a useful fallback when a resource cannot load.\n\n## Refinement\nFor an existing Widget, use penecho_list_files and penecho_read_file to read the exact virtual HTML source covering the requested change. Combine all known edits into one coherent multi-hunk penecho_patch_file patch when practical. Supply the returned contentHash and strict unified-diff headers matching the returned virtual path. Preserve unrelated content, established style and live geometry. Never use physical host paths. Do not publish a timed scaffold or repeatedly re-read after a successful patch. Reuse the returned current hash and source evidence if sufficient; read again only for incomplete source, SOURCE_CONFLICT, or a real patch mismatch. Retry an unknown outcome with identical arguments and requestId; a source conflict needs a fresh read and new requestId. Routine refinements need no intermediate capture; take one final capture only when pixel evidence matters, and another only for a concrete unresolved defect. Fix evidenced defects and stop when complete.\n\n${DELIVERY}`;
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

function getAuthoringGuidance(id, detail = "brief") {
  const full=getFullGuidance(id);
  if(detail === "full")return full;
  if(detail !== "brief")throw new RangeError("Unknown guidance detail.");
  // The default read must deliver the canonical design contract, not an
  // independent summary that silently weakens visual quality. Loading remains
  // on demand; existing explicit brief callers receive the same requirements.
  if(id === "visual-explorer")return {...full,detail:"brief",fullHash:full.hash};
  const document = {
    "general-html":"Build the requested real product UI with working local interactions, responsive layout and readable normal CSS type. Use width:100%, min-width:0, media/container queries and vertical scrolling; never shrink a whole page with transform/zoom. Keep source on stable separate lines and reuse uploaded asset references. Preserve geometry when editing.",
    "math-2d":"Use calibrated coordinates and consistent units for mathematical geometry/curves. Load full guidance before implementing unfamiliar renderer APIs; verify formulas, domains, axes and labels.",
    "physics-2d":"Use consistent physical units, bounded time steps and explicit controls. Load full guidance for simulation APIs and examples; verify initial conditions and conservation assumptions.",
    "math-3d":"Use calibrated 3D coordinates with readable axes and camera controls. Load full guidance for renderer contracts/examples; verify geometry and projection.",
  }[id];
  return {id,version:"2",hash:crypto.createHash("sha256").update(document).digest("hex"),detail:"brief",fullHash:full.hash,document};
}

module.exports = { GUIDANCE_IDS, ROUTING, CANVAS_RENDERING_ROUTING, VISUAL_EXPLORER_SELECTION, getAuthoringGuidance };
