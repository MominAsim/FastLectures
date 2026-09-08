# MCP workspace actions and compact Recent work footer

The MCP tab now has a compact action row: Follow latest (off by default) and Close all. Follow responds only to content-producing MCP operations, coalesces to the latest document and updated content region, and defers during editing, active navigation, navigation lock, modal UI and queued work. It frames same-document updates as well as updates after switching documents; source patches resolve their object bounds and multi-object artifacts use combined bounds. Close all snapshots open MCP documents, uses the existing unsaved transition, stops on cancel/error, and preserves saved library entries.

The footer becomes one action rail: New / Close on the left, Library on the right. Full meanings remain in accessible names and tooltips; Chinese uses 新建 / 关闭 / 画布库. Opening/error status expands only when required.

## Design source map

- Fixed sidebar footer → penecho_design/penecho-design-language.html #buttons compact Ghost and popover footer example → one quiet action rail, shared 28px controls, compact 12.5/500 text, native focus and disabled behavior.
- MCP follow → #buttons Toolbar selected state → aria-pressed toggle with existing semantic tint; content-sized label to avoid icon-width clipping.
- MCP Close all → #buttons compact Ghost → secondary action; disabled when no open MCP documents or closing.
- Footer hierarchy → #typography control label and metadata → shortened contextual labels, preserved full accessible names, 8px rail inset, no second oversized library row.

## Verification

Computer Use on a separate localhost origin (not the user's original work): desktop 1667px and narrow 390px. Footer measured 45px high, same-line controls; English and Chinese labels checked. Follow switched A→B after background content update; locked navigation retained B while A updated, unlocking resumed A. Temporary viewport restored.

Found during real follow test: background Widgets disappeared on activation. Runtime records contained empty optional copyText/copyLabel, rejected by validation on restore. Normalize stored records and repair older records during Show. Regression uses real widgetRecord/restoreWidgets rather than identity mocks.

Automated: 24 canvas-documents tests and 6 workspace action tests pass. MCP runtime/schema/stdio relevant suites pass (stdio requires loopback permission). No production deployment. Electron, Safari and Firefox full visual matrix is not claimed.

Final live verification: repaired background Widget mounted and rendered its HTML after switching (Fit all brought its stored geometry into view). Close all closed blank A, paused on dirty B; Cancel preserved B. Repeating Close all → Save as and close completed, left an empty canvas and disabled Close all. Enter on the Library footer action opened the local library with the saved canvas retained. User's original IP-origin work was not closed. That earlier verification covered document switching only. The subsequent Follow latest extension now frames the latest updated content, including background documents after activation; its new browser verification is tracked separately below.

Primary Astra handled UI, integration and Computer Use. Delegated requested Astra/low handled the bounded record-normalization fix, and requested Luna/max added action boundary tests; actual worker backend metadata was not exposed.

## Follow latest content-region extension

Follow now carries the latest update bounds alongside the document ID. After an asynchronous switch it checks interaction guards again, uses the latest pending region, and cancels older automatic reveals for that document. Wheel and trackpad navigation reuse existing completion callbacks to resume pending follow. No new polling or rendering scheduler was added. Missing geometry and context-only patches preserve the document view.

Source changes are in 071 and public/app.js is generated with scripts/build-client.js. This extension is not deployed or synchronized to the Cloud mirror.

Verification for the extension: MCP/document/navigation/follow-region suites pass; the navigation cooldown test also passes. Generated bundle syntax and generator freshness checks pass. The broader ui-controls suite reports 105 passes and 8 failures in existing source/CSS expectation checks (save signature, connection presets, lock styling, save feedback, Studio layout, launcher styling, title bar and navigator metadata); those unrelated contracts were not rewritten for this change. A fresh localhost test page successfully loads the generated client. Live MCP follow verification remains incomplete: automatic approval review rejected enabling the temporary test page's MCP connection as an additional settings change; user authorization was requested and the unconnected test tab was closed.

The primary task implemented and reviewed the behavior. Tests were delegated with requested gpt-5.6-luna / max; the tool exposed the requested configuration, not independent backend model metadata.
