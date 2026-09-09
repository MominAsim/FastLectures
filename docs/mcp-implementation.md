# PenEcho MCP 实现与验收

入口为 **设置 → MCP 服务**。本机客户端通过稳定的 stdio 启动配置连接；桥接按需发现同一状态目录中的存活实例，端口和凭据留在内部。无需单独发布 MCP 包或注册服务。

使用说明见 [设置文档](mcp-setup.md)，给其他 LLM 的中英文安装提示词见 [配置指引](mcp-agent-instructions.md)，便携工作流见 [penecho-mcp skill](../skills/penecho-mcp/SKILL.md)。设置页面也可以直接复制配置、指引、skill 和文档。

## 工作方式

- 每个外部会话绑定明确的实例、已启用画布和独立 session。启动只建立 session 元数据，不强制创建进度板，`boardObjectId` 可以为 null。同一会话的作品使用稳定 artifact ID 原位更新。
- 外部 AI 主动提交公开的计划、决策摘要、进展、证据和结果。MCP 不会自动读取客户端中的所有对话，也不展示隐藏推理。
- 有意义的进度在服务端合并后推送，并立即返回入队确认。普通更新不调用模型、不截图、不重建 iframe；没有默认进度板或周期心跳。inspect_session 报告应用状态，截图才提供像素证据。
- HTML/SVG 流程图和交互 UI 使用现有 Widget 沙箱。MCP 预览保留代码指定的字号、背景和表单结构。连续改源码和尺寸后，截图等待当前文档加载和真实视口尺寸就绪。
- `penecho_present_widget` 的 `capture:true` 把呈现和截图合为一次工具调用；其他呈现默认不截图。截图只包含该会话自己的预览，并沿用压缩与尺寸上限。
- 关闭画布、切换画布或关闭开关会撤销连接并取消排队操作；画布上的已有作品保留。Codex/Claude 自动配置检查已有条目，无法安全添加时保留原配置并提供手动路径。

## 设计来源映射

来源为 `/Users/heack/workspace/penecho_design/penecho-design-language.html`，通过当前 Canvas 已有组件、样式和行为实现。

| 项目区域 | 目录章节或示例 | 应用规则 |
| --- | --- | --- |
| 设置左栏与 MCP 内容页 | `#complete-settings-pages`；Settings XL / nav-content | 沿用双区设置窗口、单一内容滚动区和选中栏目状态 |
| 配置、复制、检查、定位按钮 | `#buttons` | 复用现有 primary/secondary、compact 控件；只有配置动作使用主按钮 |
| 画布访问开关与客户端选择 | 设置页现有 switch / field 示例 | 原生 switch ARIA、共享 thumb 结构、关联 label，产品代码持有交互 |
| 会话列表 | Settings AI & connections 的行结构 | 标题与辅助状态在左，单个定位动作在右；长标题换行 |
| 手动配置和说明 | 设置内容页 disclosure 示例 | 次要内容按需展开；长路径换行，保持可复制的完整值 |
| 自动配置反馈 | 状态示例 success/error/loading、连接编辑器 footer-status | 紧随动作显示持久结果、下一步与 busy 状态；保留布局与独立复制反馈 |
| 画布 MCP 访问提示 | `.viewer-notice` 可交互页面状态示例、secondary compact 按钮 | 画布右下角持续显示开放、会话、修改中或断开状态，点击进入 MCP 设置；细边框标记画布开放范围，实际修改时短暂柔光；沿用 --pe-accent，避让 Agent/Navigator 和窄屏浮动入口，尊重减少动态效果设置 |

新增 CSS 限于布局、配置文本换行和会话行，未引入新设计 token。Session 状态是可选的紧凑公共投影，不要求在用户 Canvas 上创建内容文档。

## 验收记录

使用隔离状态目录和 Electron 配置，无模型请求，无真实客户端配置修改。

- 63 项针对性测试通过，覆盖 stdio 协议、先于应用启动、多实例发现、身份与会话隔离、取消与关闭、更新合并、截图返回、CLI 入口、Canvas 更新和快照生命周期。
- 桌面 Forge 打包检查通过，确认 MCP 后端、skill、两份设置文档被保留，其余开发文档仍被排除。npm dry-run 包清单也包含这些运行资源。
- 浏览器验收通过：两个并行会话、步骤更新、同一预览原位修改、独立截图、合并呈现截图、inspect、关闭与撤权。表单结构保留，390px 截图通过像素回归，16px authored 字号与响应式视口一致。
- 设置页检查 1440px、700px、中英文、200% 缩放，以及展开手动配置后的长路径。受检区域没有横向溢出，已查看实际截图。
- 简单表单的一次验收样例：进度入队确认约 0–2ms，单独截图 68ms，更新并截图 53ms。计时经过毫秒取整，包含本地桥接往返，不包含外部模型生成或客户端工具调度；不能据此推导所有页面都快于 Playwright。
- 较广的 `test/ui-controls.test.js` 为 112/113。未通过的是现有连接名称正则断言：期望旧的 API/CLI 名称表达式，当前连接实现包含其他任务的变化；本次没有改变该行为或弱化断言。
- Impeccable 静态检测因本机缺少解析依赖降级到正则模式，报告现有样式告警。该结果未替代浏览器视觉检查。
- 验收实例已经关闭，最后使用的监听端口已确认释放。

### 局域网地址访问回归

配置加载曾只接受 loopback，导致同一电脑通过自身 `192.168.x.x` 地址打开时返回 403，三个配置按钮变灰。现在浏览器配置与画布连接接受本机网卡的精确地址，仍检查页面访问授权；其他设备不能管理本机 AI 客户端，私有 RPC 继续仅接受 loopback 和实例凭据。

配置请求沿用页面认证头。加载失败原因独立显示，不会被“已复制”覆盖；检查连接可以重试，旧后端缺少 MCP 路由时提示重启服务。画布访问开关关闭时仍可配置客户端。

- 15 项 MCP 回归测试通过，覆盖本机与其他设备、认证拒绝、私有 RPC 边界、配置加载失败与重试。
- 隔离浏览器通过本机局域网地址验收：开关关闭时配置可用、错误可见、复制后错误保留、重试恢复，以及完整会话、预览、截图和撤权流程。

自动配置另有独立结果区，紧随按钮：立即显示处理中，明确区分已保存、已有配置但未验证、失败及网络结果不确定。已有条目不冒充已验证成功；复制不会覆盖结果。网络中断时提示先检查客户端条目，避免把可能已经写入的配置误报为未保存。该前端反馈由主任务直接实现；使用受控响应验收各状态，不修改真实客户端配置。

当前范围是本机 MCP 与 Widget 预览；没有实现 Cloud MCP 路由、任意网页导航或完整浏览器自动化。协议与 UI 已联合验收，尚未用真实 Codex、Claude、Kimi 或 ZCode 会话逐一完成客户端实测。没有发布或推送。

### 用户画布反馈

`penecho_read_feedback` 默认返回压缩截图及简洁的游标、hasFeedback/changeCount，不再公开文字/笔画/图片分类条目。内部分别在文字确认、笔画结束和图片导入完成时记录区域，最多保留 200 条，不清空内置 dirty。Session 建立时记录反馈基线，即使没有进度板；present 返回应用后的 feedbackCursor，但不会重置会话已保留的未读反馈。客户端处理后再保存 nextCursor；失败可用同一游标重试。

截图包含新增 dirty 附近的当前设计和用户层，使用 120 个画布单位的边距；相距过远的标注自动分批，不受用户后来平移视野的影响。当前笔画未结束时拒绝截图，避免读取半截标注；没有反馈或 capture:false 时不截图。它不是历史快照或 OCR。后续修改前先读反馈，不自动唤醒停止工作的客户端。

已参考主 Canvas AI 的 planViewportImage/prepareOutboundAtlas（有界画幅、服务端无损 WebP）；MCP 直接复用已有 Canvas Agent 的 canvasAgentCapture/canvasAgentCompressedCanvas，有明确传输预算，避免重复服务端编码。basic 策略为最长边 1024、总像素 520000、WebP 初始质量 .72、编码图像最多 700 KiB（base64 前）；超限继续降采样，PNG 回退也受同一上限约束。服务端再次检查字节与尺寸。

本轮 32 项针对性测试通过，覆盖浏览器、传输、独立游标、呈现后基线、PNG 回退和超限失败。隔离局域网 Electron 验收实际文字、笔画、图片输入及默认截图，文字样本 856×606、14620 字节；这些是单次样本，不是性能保证。截图位于 `/var/folders/wq/vmfzmn0j33199mp1lzkmgs080000gn/T/penecho-mcp-browser-eRn8Hb`，已人工查看；全部测试端口已释放。

MCP 状态入口上移，避让新缩放工具条；宽、窄、200% 缩放和 Agent 展开时已检查可见性。技能补充主动提供有用预览、方案选择与图文解释，稳定更新作品，普通呈现不截图；选择仍通过聊天或原生 Canvas 标注表达，Widget 按钮尚无 MCP 回传事件。自动任务排版与成组视野已实现，见下节。

主任务负责架构、UI、集成与最终 review；后端/CLI/打包委派请求使用 Sol/high，文档/便携 skill 委派请求使用 Luna/max。已检查实际代码和验证结果，运行工具未独立提供子代理实际模型身份证据。

## MCP request logging

MCP interactions with third-party clients use the existing Settings request-recording switch (`PENECHO_REQUEST_TRACE`). When enabled, records live under `logs/mcp-requests`, parallel to AI request records under `logs/requests`. With the desktop state directory this is `~/.penecho/logs/mcp-requests`; `~/.penecho/mcp/instances` contains connection-discovery records, not interaction logs. The switch follows the existing system-settings restart behavior. Disabled recording does not collect request payloads or create trace files.

Interaction logs group calls by external session, preserving complete incoming arguments, returned text, browser RPCs, errors, timings, and asynchronous queued-update outcomes. Long text and source bodies are retained without the diagnostic summary's truncation. Images and screenshots are also saved as real binary files that can be opened directly. Credential redaction remains enabled. Existing historical logs cannot recover text or image bodies that were previously omitted; full records begin with calls handled by the updated service.

Each `session-<hash>` directory has identifying metadata in `session.json` and timestamped `request-<timestamp>-<hash>` call directories. Read `request.json` / `response.json` (or their `.txt` copies) for full payloads; `trace.json` remains a compact timing/status summary. `*-source-*.html` / `.txt` contain source bodies, `*-image-*` files contain decoded image bytes, and `*-images.json` maps those image artifacts. Original data URLs/base64 remain in the full payload. Browser RPC files use `browser-N-` prefixes; failures use `error` files and queued updates use `queued-outcome` files.

Session keys and returned session IDs are scoped to the external client owner; discovery calls without a session are grouped separately for that owner. The configured retention count (`PENECHO_REQUEST_TRACE_LIMIT`) applies to session directories, preserving running calls and pending queued updates until completion. Legacy per-request directories and unrelated files are left untouched. Files are private to the local user and logging failures do not change tool results.

## Canvas live access indicator (2026-09-07)

The bottom-right control distinguishes opted-in waiting, bound sessions (client names/count), actual browser mutation, and unexpected disconnect. Clicking opens MCP Settings, where session rows include the last applied update time and access can be closed. The subtle boundary follows the available Canvas area; only start/update/present/close mutations trigger a short glow. Read, feedback and capture calls do not. The working label ends immediately on completion; the glow fades after 650 ms, without continuous animation or model calls.

The backend sends native WebSocket ping every 15 seconds, terminating connections with no pong for 45 seconds at the next interval. Browser JSON heartbeat is negotiated with `ready.heartbeat:true`; legacy servers remain compatible. Visible tabs detect stale responses, with visibility-resume grace for throttled background timers. Disconnect, canvas changes and service close clear timers and revoke session bindings.

Astra implemented and reviewed UI/integration; the backend worker was requested as Sol/high. 24 focused tests cover status semantics, heartbeat failure/cleanup and legacy compatibility. The isolated LAN Electron harness additionally verifies real in-flight mutation, session return, unexpected socket close, narrow/zoom/Agent-panel layouts and user-feedback capture. In-flight capture briefly holds the test browser's hash dependency to photograph the real pending operation. No production instance was restarted. Screenshots: `/var/folders/wq/vmfzmn0j33199mp1lzkmgs080000gn/T/penecho-mcp-browser-axEOFu`.

## PenEcho-owned task layout and camera

New MCP sessions reserve placement state without requiring a session board. New artifacts occupy stable rows in their task area. Placement checks other task areas, existing objects and ink; previous objects and user positions are never repacked. Existing preview updates retain location. Exhausted space returns an actionable error instead of overlapping content. Camera batching waits for a short quiet interval and the mutation queue to finish; only new objects trigger it. Large distant batches are offered one task at a time; very small automatic fitting is deferred for explicit inspection. Pointer/wheel interaction, active editing, hidden pages and navigation lock preserve user camera ownership. The Show new content action frames pending items, and Settings Show frames the whole task. Disconnect clears the owned timer and pending targets.

Design-source map: pending-content control → penecho-design-language.html compact secondary button / status examples → reuse existing Canvas MCP status area and wrap at narrow widths; no new panel. Work areas use session placement metadata and existing Canvas placement/framing primitives. Preplanned absolute creation avoids a duplicate global occupancy scan. No extra model calls or automatic screenshots are needed.

Root implemented and reviewed this UI work without delegation. Focused browser/runtime/compression tests pass (24 tests); isolated LAN acceptance covers three-preview placement, user camera pause, explicit resume, two sessions, narrow/zoom button usability and existing feedback capture. Existing saved canvases are not retroactively reorganized; newly started sessions use this layout. Reopen the updated Canvas and reconnect after preserving current work.

## Lightweight native MCP artifacts

At that stage, adding `penecho_draw` and `penecho_plot` brought the bridge to ten
public tools. The browser-owned
`mcp-primitives.js` prepares bounded native text/image records, lays out nodes and
resolves connector IDs, then commits one history transaction after checking the
current Canvas revision and execution. Shape/path images are not Widgets or user
ink tiles; they have no vector handles. Text remains directly editable. Plotting
reuses `compileExpression` and `plotObjectImage`; only MCP provides the internal
view override, leaving existing Main Canvas AI plot defaults unchanged.

Draw batches are complete snapshots of one session-owned artifact. Stable item
IDs preserve identities; omitted owned elements are removed, and unrelated Canvas
objects remain intact. User-moved node frames persist through source updates.
Connectors resolve at application time, not continuously during user drags.
Cached unchanged text and image content avoids redundant rendering/encoding.
Artifacts remain ordinary saved Canvas records; session source/update bindings
have the same connection lifetime as other MCP artifacts.

Both new tools optionally use `capture:true`, calling the existing basic Canvas
capture/compression path with a bounded region around owned objects. The image
can contain overlapping user material; capture does not consume feedback. Output
application succeeds before a separate optional capture, so a capture error can
leave the artifact applied; retry the same stable artifact IDs. No model calls
or automatic screenshots occur during ordinary drawing.

Design mapping: Canvas-generated content → existing native text/image/plot
primitives; Settings guidance → existing MCP settings help paragraph in the
canonical settings page pattern. No new workbench controls or style system were
introduced. Automatic grouping and camera ownership reuse the existing MCP queue.

Verification: 35 frontend/primitive/compression/settings/build-structure checks
and 13 backend/schema/stdio checks passed. Isolated LAN Electron E2E covered
labeled rectangles/ellipses, native text, arrows and paths, stable replacement,
restricted expression rejection, function capture, Undo/Redo, zero new iframes,
user feedback isolation and existing responsive/settings behavior. Evidence:
`/var/folders/wq/vmfzmn0j33199mp1lzkmgs080000gn/T/penecho-mcp-browser-okBxLN`.
Single-run measured update after content reuse: 16 ms (prior diagnostic run
2032 ms); drawing plus capture 232 ms; plot plus capture 35 ms. These samples
are not general performance guarantees. The isolated test instance was closed.
Root handled UI, native integration and acceptance. Backend was delegated with
requested Sol/high; actual provider/model identity was not independently verified.

## Persistent multi-document MCP server v1 (2026-09-07)

The public server now separates the opted-in bridge connection (`canvasId`) from
the persistent work document (`documentId`). `penecho_open_canvas` and
`penecho_find_canvases` are routed only through the exact active connection named
by `instanceId` and `canvasId`; the server does not search another host.
`penecho_open_canvas` requires an idempotency key and defaults `show` to false, so
opening or creating a document does not steal the current view. Provider
ambiguity, availability, and cross-storage errors can return bounded structured
details through HTTP and stdio error results.

`penecho_start_session` accepts optional `documentId` and `takeover`, and forwards
the exact optional client and session key. The browser-issued session ID remains
the routing authority for every later tool call. The server snapshot stores the
actual `documentId` only when the browser returns one, preserving compatibility
with older runtimes. Server session-key isolation remains owner-scoped; the
browser persists reconnect bindings for the exact client/key pair.

Virtual source tools never touch Node's filesystem APIs. Listing and reading are
browser operations over public Canvas virtual files. Patch requests are limited
to 800,000 bytes, reject traversal/backslash/NUL paths, and parse exactly one
existing-file unified diff whose headers match the requested virtual path.
`diff.applyPatch` runs with fuzz factor zero. The server reads browser-owned
source through `mcp_prepare_patch`, verifies the caller's content hash, and sends
the complete replacement plus expected hash to `mcp_apply_patch`. A bounded
per-session request map returns completed retries before a new preparatory read;
after an unknown apply outcome it resends the same final mutation and request ID.
`SOURCE_CONFLICT` instructs the client to read again and use a new request ID.
Patch preparation also carries the request ID and expected hash. A browser-held
successful receipt can return `alreadyApplied` plus the original result before a
source reread, recovering a response lost after the browser committed the edit.

Canvas edits use strict action-specific arguments. Image replacement accepts a
bounded PNG/JPEG/WebP data URL or `penecho-ref:objects/<encoded-id>/image`, which
the browser resolves only inside the bound document. Source replacement and
geometry edits are distinct operations. Move, resize, delete, erase, and replace
also require a current base revision, preventing a stale client from overwriting
newer user work. The inbox is pull-based:
`penecho_read_messages` never means receipt, and `penecho_ack_messages` explicitly
records received/working/done/error for named request IDs. There is no push wake,
automatic polling, Git integration, history API, or playback API in this version.

`penecho_capture_canvas` is the explicit bounded screenshot path for existing
Canvas content. It supports canvas, viewport, selection, region, and object
targets with basic/detail quality, validates the returned image MIME type,
dimensions, encoded byte count, and revision, and reports `pixelVerified:true`
only after an actual image result. A background document returns structured
`CANVAS_NOT_VISIBLE` retry details and is never shown as a capture side effect.
The stdio adapter emits the image as MCP image content.

The browser's opt-in Widget choice contract uses only buttons carrying
`data-penecho-action="choose"` plus bounded `data-penecho-prompt`. A trusted
click queues text, `source:"widget"`, and the exact object/session/client/key in
the pull inbox. It does not invoke a model, serialize arbitrary forms or
passwords, or authorize an external action. Status still moves only through
explicit received/working/done/error acknowledgements. The virtual `context.md`
is user-editable document context and is appended to the internal PenEcho
Agent's local user turn.

The stdio server advertises four user-selected prompts through `prompts/list`
and `prompts/get`: Visual Explorer, explain selection, revise feedback, and resume document.
Initialization guidance states that cursors remain independent, visible document
changes require explicit show, read-before-patch is mandatory, and the primary
task continues when the optional bridge is unavailable.

## Presentation protocol

Widget, drawing, and plot calls accept an optional exact-key `presentation`
object. The server validates and normalizes intent (`explain|deliver|compare|review|inspect`),
role (`primary|supporting|alternative`), relative artifact placement, and attention.
Widget/plot size presets resolve server-side to base 480×360, wide 992×360, tall
480×752, large 992×752, or page 1200×800 before browser dispatch. Legacy explicit
dimensions remain supported and cannot be combined with an explicitly supplied
size. Drawings reject size and use natural scene bounds. Omitting presentation
leaves it absent so a stable artifact source update preserves prior presentation.

Widget-only inspect requires `capture:true`. The browser renders at the requested
viewport, compresses under the existing basic/detail policies, and returns the
capture in the same `mcp_present_widget` result with `ephemeral:true` and no
`objectId`. The server checks MIME/bytes, quality dimensions and pixels, viewport
metadata when supplied, revision, ephemeral state, and the absence of objectId;
it returns `applied:true`, `pixelVerified:true`, and never issues a second capture.
Normal presentation remains persistent and screenshot-free unless capture is
explicitly requested. Returned presentation and optional viewport metadata make
the result reviewable without changing built-in Agent authoring contracts.

The MCP Visual Explorer prompt slices the shared built-in design prose and adds
only external delivery guidance: meaningful intent and hierarchy, stable updates,
the size matrix, useful interaction, no fake callback controls, and explicit
pull-inbox read/ack behavior. It does not alter the built-in Agent contract or
auto-select a prompt, create a progress board, poll, or wake a stopped client.


### Lightweight spatial progress and visual guidance / 轻量空间进展与视觉指导

Keep the first useful output fast: no required plan, prompt retrieval or capture
before it. Send short public findings, decisions, blockers and completion through
`penecho_update_session` at natural work boundaries only when useful information
changed. There is no timer, tool-count quota or idle heartbeat. Read/ack inbox
messages at these checkpoints when awaiting input or working interactively.
Routine progress requires no generated diagram or screenshot. Reuse existing
useful previews and stable artifact IDs; create spatial explanations when they
help the task. Honor a quieter cadence requested by the user.

`initialize.instructions` and Widget tool guidance include compact Visual
Explorer principles. The optional `penecho_visual_explorer` prompt provides the
full shared design sections with MCP-specific delivery, loaded once when needed
for substantial visual authoring. New/reused session responses repeat only the
short workflow reminder; ordinary updates do not repeat these instructions.
Clients control prompt loading and tool execution. Existing clients need to
refresh/reconnect to receive changed initialization instructions/tool metadata;
this change does not wake stopped conversations or guarantee compliance.

首个有效输出不等待计划、完整规范或截图。只在发现、决策、阻塞、完成等自然节点且确有
新信息时发送简短进展，不设置周期、工具数量配额或空闲心跳。普通进展不
生成图或截图。复用有用的已有成果，必要时再制作空间图解。Visual Explorer 完整设计规范
通过可选 prompt 按需读取一次，默认仅附简短原则。客户端刷新连接后获得新指引；MCP
无法强制客户端执行或唤醒已停止的会话。
