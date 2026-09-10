---
name: penecho-mcp
description: Use PenEcho's HTTPS MCP service for persistent Canvas documents, useful UI previews, diagrams, plots, virtual source edits, and bounded user feedback. Use for explicit visual-workspace requests naming penecho, echo, canvas or 画布. For PenEcho engineering, also apply the project's engineering guidance.
metadata:
  short-description: Useful Canvas interaction with economical MCP calls
---

# PenEcho MCP

PenEcho is an optional shared work surface for an external AI client. It does
not grant general browser automation, host filesystem access, or access to
another Canvas. AI clients normally use a small stdio CLI that connects directly to HTTPS MCP. Continue the primary task during outages.

Use this bridge when the user explicitly asks for a visual workspace with
“penecho”, “echo”, “canvas” or “画布”, including “echo一下这个想法”,
“penecho一下文件夹的架构” and “把你要做的修改放到canvas”. Discover the
exact opted-in connection, then present or edit the requested material through
the existing penecho_* tools. Ordinary shell echo commands and unrelated canvas
mentions are not triggers. These phrases guide an active client; they do not
wake a stopped client or install/configure the bridge. For folder architecture,
read only files authorized through the client’s existing tools; MCP virtual
files do not grant host filesystem access.

## Setup and stable conversation routing

Configure only when asked. PenEcho starts HTTPS with the application; browsers explicitly opt in. Import the host trust bundle once with discover.js --import (no --client). Configure the AI's standard stdio entry to Node + client.js --host-id. Shared credentials and endpoints live in ~/.penecho/mcp/hosts/<hostId> on macOS and %USERPROFILE%\.penecho\mcp\hosts\<hostId> on Windows. The CLI tries its last successful IP and port (or the supplied initial IP on first connection), freshly read shared cache, then one-shot discovery; it never rewrites AI configuration during reconnect. No gateway, daemon or background discovery loop is needed. Preserve unrelated client settings and verify actual tools after configuration reload. The CLI loads the host CA directly; never disable TLS or print secrets.

The CLI stays alive while the AI host keeps stdin open. Idle for 30 minutes releases only the HTTP session; pending work prevents idle release. The next request tries the known IP/port again; if it fails, reread the shared cache, and if missing or unreachable, discover the authenticated host and update the cache. Do not configure --idle-exit-ms for normal use. EOF/signals shut down the child. Preserve client/sessionKey/documentId in conversation context across process restarts; MCP transport IDs and PIDs are not conversation identities. A running CLI restores its remembered document after HTTP reinitialization; after a fresh process, explicitly call start_session with the retained binding. Retry ambiguous mutations only with their original idempotency requestId after checking actual state.

1. Start with required title, a stable client name and unique sessionKey per conversation. Direct HTTP permits omitting instanceId/canvasId to choose the latest registered opted-in browser for a new conversation. Use exact discovered IDs for an explicit connection target.
2. Retain sessionId/documentId and reuse client/sessionKey across turns/reconnects. Old conversations restore their original document; closed saved documents can reopen in the background. restore defaults true, but only DOCUMENT_NOT_FOUND permits a new replacement. Permission/storage errors must not be treated as missing. restore:false disables replacement; show defaults false. New unbound conversations get a named new document.
3. For “current canvas”, “this canvas”, “当前画布”, “这个画布” or current selection, use target:"current" without documentId. Read files and revision before editing. If already bound elsewhere, use a distinct stable attachment sessionKey and retain both handles. Never silently redirect the old handle.
4. Find saved copies with penecho_find_canvases on an exact opted-in connection. Resolve storage ambiguity with an exact locator. penecho_open_canvas requires requestId and either create:true or documentId/locator; show:true requires intent to change the visible document.

Local, LAN and account-authorized Linked Device browsers use the existing opt-in and document ownership rules. Disconnection/opt-out revokes the live connection, not the saved document. Restore transport initialization and the same conversation binding after reconnecting. Shared host credentials and an HTTP transport session do not replace conversation ownership. Do not kill unrelated processes or take over another task's browser to repair connectivity. PenEcho does not wake a stopped client.

## One-shot invocation

When the user asks to work visually, discover the PenEcho MCP server and its deferred tools through tool search. Read penecho://guidance/discovery with resources/read for current discovery instructions. Use tools/list for all current tools and input schemas, prompts/list then prompts/get for workflows, and resources/list then resources/read for live resources; follow nextCursor pagination. Read penecho://guidance/skill for the latest workspace guidance and penecho_get_guidance only for relevant authoring instructions. An empty resource list is not an empty tool list. Installed skill files are static bootstraps; ordinary server upgrades require rediscovering live catalogs, not reinstalling the CLI or rewriting the connection.

One-shot examples (one trigger phrase per example):
- Use PenEcho to draw a simple flowchart.
- Echo this idea as a diagram.
- Show this architecture on a canvas.
- 在画布上比较这两个方案。
- Use a spatial workspace to explain this process.

Complete the requested visual work and return; one-shot does not mean close the Canvas or terminate the shared-with-this-conversation CLI. Preserve the binding for a later turn. No idle polling, mandatory progress board, or unrelated visual output.

## Choose a result worth showing

With a selected live Canvas, use it by default for UI design/review so the user
can try the result. Show one coherent preview, not speculative alternatives.
For comparisons, plans, relationships or simulations, choose the smallest visual
that helps the user decide or understand. Reuse task data and existing artifacts;
never invent numbers or paste a whole transcript onto the Canvas.

Short facts, routine code edits and unchanged status need no visual. Keep the
first useful output fast. Use update_session for meaningful public findings,
blockers or completion, batching related facts. No decorative progress board,
per-token/per-tool updates, tool-count quota, timer, heartbeat or idle polling.
Never expose private chain-of-thought, secrets or raw unrelated user data.

Choose the cheapest suitable tool:

- `penecho_present_widget`: real HTML/CSS/SVG UI, local interactions or a substantial
  explanation. Keep artifactId stable; an update replaces source in place.
- `penecho_draw`: simple native text, nodes, connectors or paths. Up to 24 items
  with stable IDs; nodes can omit local positions. Use from/to for connectors.
  Each call replaces the complete item list, so retain wanted IDs. Native text
  stays editable; rasterized shapes/paths are movable images, not vector handles
  or eraser-layer strokes. Do not reuse an ID for a different object type.
- `penecho_plot`: a bounded function expression such as sin(x) or x^2, not sampled
  points or JavaScript. Sampling and rendering are local. It creates a movable
  image, not an interactive iframe or editable vector plot.

## Readable presentation and real interaction

Use presentation intent explain/deliver/compare/review; role primary/supporting/
alternative controls hierarchy. Review requests attention; supporting/alternative
work is normally quiet. relativeTo references a stable artifact in this session;
relation below/beside controls placement. Compare defaults beside when space fits.

When dimensions and size are omitted, new Widgets and plots default to page 1200×800.
Creation size presets: base 480×360 (one compact idea), wide 992×360, tall 480×752,
large 992×752, page 1200×800 (desktop UI). Use explicit width/height for an exact
mobile viewport; never combine dimensions with a preset. Widget dimensions are
300–4096 wide, 200–4096 high. Draw uses natural bounds. Plot is capped at 1600×1200.
Source updates preserve user position and size; later resizing uses edit_canvas
with current baseRevision. Omit presentation when retaining existing semantics.

Preserve the target product's styling, page background and actual interactions;
do not wrap a page design in an infographic card. For explanations, use clear
hierarchy, concise labels, meaningful diagrams/tables and semantic color. Judge
text at the displayed scale: reflow, simplify repetition or focus one result
before shrinking fonts. Avoid clipped controls and page-wide horizontal overflow.
Use labeled native buttons/inputs, visible keyboard focus and meaningful states.

Filters, tabs, sorting and toggles run locally without model calls. An explicit
AI request may use a button with data-penecho-action="choose" (or another short
action ID) and a bounded data-penecho-prompt. Only a trusted click queues the
prompt, exact object ID and owning conversation in the pull inbox. It does not
serialize arbitrary forms/passwords, invoke a model or grant external approval.
Label these as requests and explain that the client reads them when active.
Do not imply instant AI execution or create fake controls.

PenEcho owns placement and camera framing. It batches new-content attention,
pauses following during user interaction, and offers Show new content to resume.
Updating a stable artifact does not force camera movement. Do not recreate it to
steal focus or shrink the entire Canvas to fit distant work. Inspect can return
bounded attention metadata; it is not a screenshot or proof of readable pixels.

## Verification with bounded cost

Ordinary presentation uses capture:false. For first UI review or a meaningful
layout change, combine present_widget with capture:true at basic quality, read
the returned image, and fix material defects. Stop once the requested answer is
complete, readable and usable. Do not begin another read/patch/capture cycle for
minor spacing, label shifts or optional cosmetic polish unless requested. Data
errors, missing requirements, unreadable essential content and broken interaction
remain reasons to continue. Reuse that evidence; request detail
only for an unresolved visual question. Do not screenshot unchanged progress or
every minor edit. A local screenshot does not call a model, but reading its image
may consume image-input tokens. Never claim exact token savings from image bytes.

Widget intent inspect requires capture:true and creates an ephemeral offscreen
render, not a Canvas object. Use it only when a temporary check is useful; to
show the result to the user, deliver it. capture_widget captures an existing
Widget; draw/plot can combine capture:true. capture_canvas captures existing
visible content (viewport/canvas/selection/region/object). Hidden content returns
CANVAS_NOT_VISIBLE; never show it implicitly. Only returned pixels with
pixelVerified:true are pixel evidence; inspect or accepted/queued is not.

Load full authoring guidance only when needed with penecho_get_guidance({id}).
Use visual-explorer for understanding, learning, explanations, analysis and
organization; use general-html for new UI pages, product previews and ordinary
interactive tools. New UI pages do not automatically use Visual Explorer.
Existing page edits preserve their source and styling. Bare functions use plot.
Load a science supplement only for calibrated mathematical geometry/curves
(math-2d), physical simulation (physics-2d), or spatial 3-D mathematics (math-3d).
Formulas, matrices, or complexity notation alone do not require a science
renderer. Load only the closest needed supplement. Each document includes its version and
content hash; reuse unchanged guidance rather than repeatedly loading it. This
read-only tool needs no Canvas connection and works with tools-only clients.
The optional penecho_visual_explorer prompt remains available through prompts/get.

## Feedback and inbox are separate

Before revising an existing design, read_feedback for the same session with an
independent after cursor. Start returns the baseline even without a progress
board. Never overwrite unread history with a later presentation feedbackCursor.
Feedback reads return bounded changeCount/nextCursor/hasMore/truncated metadata
and, by default when changes exist, one compressed current screenshot including
nearby user layers. There are no public text/kind/entries feedback fields.
Draft keystrokes do not count; reads never clear Canvas dirty state or another
reader's history. Read the image, process the page, then advance to nextCursor
while hasMore. On capture/interpretation failure retry the same cursor; report
truncated history. capture:false is metadata-only. Basic feedback is bounded to
1024 long edge, 520,000 pixels, 700 KiB encoded, preferring WebP over PNG fallback.
A vague mark is not approval for destructive or external action.

read_messages is a pull inbox. Read at active-work checkpoints and once before
yielding for a displayed choice; deduplicate instruction IDs and preserve its
own cursor. Reading does not acknowledge or wake a stopped client. Acknowledge
explicitly with done/error after a quick action; received/working are useful for
longer waits, not three mandatory sequential calls. Batch IDs sharing a status.
Cancelled instructions must not execute. End with status waiting for user input,
done for completed work, or error when blocked; no idle polling.

## Virtual files and safe edits

list_files/read_file expose bounded virtual public paths, never physical files.
File pagination, feedback cursors and inbox cursors are independent. Read before
patching; keep contentHash and send one strict unified diff with exact
--- a/<path> and +++ b/<path> headers and fuzz zero. Patches cannot create/delete/
rename files. SOURCE_CONFLICT needs a fresh read and new requestId; unknown
outcomes retry identical arguments and the same requestId. Reads/patches cap at
800,000 UTF-8 bytes. Keep context.md concise: goal, decisions, next step; it is
user-editable and also informs the internal Agent. runtime/viewport.json and
runtime/selection.json are current context, not source to rewrite.

edit_canvas supplies bounded idempotent text creation, move, resize, delete,
erase_ink, draw_ink, image replacement and explicit show. Move/resize/delete/erase/draw_ink/replace
require current baseRevision to protect newer user work. Source edits do not
change geometry. Image replacement accepts bounded data URLs or authorized
same-document penecho-ref references, never arbitrary network fetching. Preserve
user edits, artifact identities and unread feedback. A removed artifact must not
be silently recreated under its old ID.

For freehand annotation use penecho_edit_canvas action:"draw_ink" with the current baseRevision and strokes:[{color:"#E63946",width:6,points:[{x:120,y:140},{x:220,y:140}]}]. Coordinates and width are Canvas world units. Choose any explicit #RRGGBB color; each stroke is an open round brush polyline (repeat the first point to close a circle; add separate strokes for arrowheads; use a wider stroke for an underline/highlight). Ink may overlap existing content intentionally. Limits: 1–16 strokes, 1–256 points per stroke, 1024 points total, width 1–64; all points fit a 2048 × 2048 region and the brush radius stays inside the Canvas. The operation preserves the user’s brush selection and creates one undoable edit. Background documents reject before mutation: use show only when making that document visible is intended, reread its revision, then draw. Retry the same requestId only with identical arguments.
