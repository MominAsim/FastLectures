# MCP presentation and attention

PenEcho is a shared work surface. A session carries status; an artifact carries
something useful to understand, compare, review, or keep. New sessions create no
progress Widget. Existing saved progress boards remain editable and compatible.

## Shared visual authority

MCP `penecho_visual_explorer` uses the same design section of
`src/server/canvas-agent/visual-explorer-contract.md` as PenEcho Agent. The MCP
adapter adds purpose, delivery, sizing, and feedback rules; it does not fork the
Agent's visual design principles or expose its internal tools.

Design source map:

- Session progress → `penecho_design/penecho-design-language.html`, Agent activity
  example (`activity-status`, one-line progress): metadata belongs in the existing
  compact session controls, not a large permanent Canvas progress board.
- Show new content → incumbent MCP control, existing secondary compact action:
  user navigation pauses following; explicit Show resumes it.
- Preview content → existing Canvas Widget document and sandbox contract:
  author typography and product styling belong inside the responsive document.
- New geometry policy → this document: content footprint sizes and semantic
  placement extend Canvas behavior; they introduce no new chrome/component skin.

## Purposes and size

`presentation.intent`: explain, deliver, compare, review, inspect.
`role`: primary, supporting, alternative. `attention`: quiet, normal, request.
An optional `relativeTo` references an artifact in the same session; `relation`
requests below or beside. Missing or deleted references fail before mutation.
A review normally requests attention; supporting/alternative work is quiet.
Inspect is always temporary and requires capture, never user attention.

| Size | Width | Height | Typical use |
| --- | ---: | ---: | --- |
| base | 480 | 360 | One concise explanation or choice |
| wide | 992 | 360 | Horizontal comparison or process |
| tall | 480 | 752 | Sequential explanation or compact page |
| large | 992 | 752 | Interactive analysis |
| page | 1200 | 800 | Desktop page design |

The first four sizes share a 32-unit gap and a 480×360 base footprint.
`page` is an explicit page-design viewport, not a requirement to fit page designs
into a small information card. Explicit width/height remain available for exact
rendering tests and legacy clients, but cannot accompany a named size. Updating
HTML preserves the existing geometry and content viewport; geometry changes use
the revision-aware Canvas edit operation. Native drawings keep natural bounds.

## Placement and attention

The initial artifact anchors near the center of the current visible work area,
with top breathing room. Parked documents use their saved viewport. Ordinary
new work flows down. Related comparison work is beside its reference only when
the pair has sufficient viewport width; it otherwise flows below. Collision
search skips downward over real objects and ink. Prior objects never move.

The existing view queue batches attention. Quiet content causes no camera work.
When a group would become unreadably small, review requests precede primary work
and only one relevant object is framed; remaining content stays accessible via
Show new content. Already visible readable work does not cause camera movement.
User navigation and interaction still suspend following.

## Temporary render inspection

Inspect creates a bounded, noninteractive offscreen Widget in a session-owned
transient registry. It uses the same host origin validation, renderer, load wait,
snapshot request, and compressed capture policy as permanent Widgets. It never
enters Canvas object arrays, undo, session artifacts, feedback history, or saves.
Only host readiness, document updates, diagnostics and capture replies are
accepted; interaction and action messages from temporary content are ignored.
Cleanup unmounts the Widget and releases the registry entry on success, failure,
cancellation, or disconnect. The result is ephemeral pixel evidence, with no
persistent object ID. To show a reviewed design to the user, publish it separately
with review or deliver intent.

## Feedback and costs

Opt-in Widget actions already queue an instruction for the owning conversation.
The existing inbox shows queued, received, working, done, error and cancelled.
Read is not acknowledgment; acknowledgement is not automatic client wake-up.
User choice controls must describe a real action supported by this pull loop.

No per-token updates, mandatory progress visual, screenshot heartbeat, or second
model call is introduced. Ordinary presentation remains screenshot-free. Inspect
returns its bounded image in the same call and is not persisted.

Local 071 owns this implementation. Cloud MCP discovery remains capability-gated
by the existing local-only policy; this change does not enable remote MCP routing
or synchronize a Cloud mirror implicitly.
