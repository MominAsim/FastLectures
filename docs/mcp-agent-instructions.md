# Instructions for an LLM configuring PenEcho MCP / 让 LLM 配置 PenEcho MCP

This file contains a copy-pastable prompt for zcode, Kimi, or another LLM that is
asked to configure a local PenEcho MCP client. Replace `ABS_ROOT` before handing
it over. The prompt asks the other LLM to inspect the client's official
documentation and current configuration instead of guessing its syntax.

本文包含一段可直接交给 zcode、Kimi 或其他 LLM 的提示词，用于配置本地 PenEcho MCP
客户端。交给它之前请替换 `ABS_ROOT`。提示词要求对方检查客户端官方文档和当前配置，
避免猜测配置语法。

## Copy-paste prompt (English) / 可复制提示词（英文）

~~~text
Configure a local MCP server for PenEcho for this user.

Context:
- PenEcho bridge root: ABS_ROOT
- The installed command is `penecho mcp`. The portable direct launch is `node "ABS_ROOT/src/server/mcp/stdio.js"`.
- The bridge is local stdio. It can start before the app, discovers all live per-user PenEcho instance records in the same state directory, and keeps dynamic HTTP/WebSocket ports and secrets internal. Generated launch config intentionally omits the volatile instance ID.

Procedure:
1. Inspect the official MCP configuration documentation/help for this exact client and inspect the current MCP configuration before editing it. Use the client's real syntax and current version. Preserve all unrelated servers and settings.
2. Use the absolute bridge path exactly as supplied. Do not replace it with a tilde, a relative path, a guessed checkout, a URL, or a dynamic port.
3. If PenEcho Desktop Settings/status provides a generated launch entry, prefer that generated command and environment. Desktop may use Electron with `ELECTRON_RUN_AS_NODE=1`; copy the generated executable, args, and environment exactly. Do not assume a global Node executable when the generated entry exists. The generated entry has no volatile instance selector, so do not add one.
   If the installed `penecho` binary is on PATH and the client accepts a command plus args, `penecho` with args `["mcp"]` is also documented. Otherwise use the absolute direct form above.
4. For Codex, the verified direct command form is:
   `codex mcp add penecho -- node "ABS_ROOT/src/server/mcp/stdio.js"`
5. For Claude Code, the verified direct command form is:
   `claude mcp add --transport stdio --scope user penecho -- node "ABS_ROOT/src/server/mcp/stdio.js"`
6. Do not invent CLI flags for zcode or another client whose syntax you have not verified. If its syntax is unknown, inspect its official docs/help and make the smallest documented config change. Do not switch to an unrelated client or provider.
7. Do not print, echo, copy, or include API keys, OAuth tokens, cookies, private config values, or other credentials in your response, logs, or examples.
8. PenEcho Configure checks whether a `penecho` entry already exists and uses a safe fallback without replacing it automatically. Restart the MCP client only if its documented behavior requires it or its tool list is cached. Then verify that a server named `penecho` is discovered, its tool list loads, and its live `tools/list` schemas are the authority for calls. Preserve unrelated servers.
9. Before targeting a Canvas, tell the user to open PenEcho Settings → MCP service and enable the current Canvas. A closed Canvas or disconnected instance is unavailable.
10. Call `penecho_list_canvases` and use only the exact connected, enabled `instanceId` and `canvasId` returned by that call. Never invent IDs, target an arbitrary Canvas by title, or target another instance.

Tool contract:
- `penecho_list_canvases`: discover connected, explicitly enabled Canvases.
- `penecho_open_canvas`: `{instanceId,canvasId,requestId}` plus exclusive `create:true`, or `documentId`, `locator`, or both for exact saved-copy verification; `show` defaults false. `documentId` is independent from the bridge `canvasId`; only explicit `show:true` changes the current view.
- `penecho_find_canvases`: `{instanceId,canvasId,documentId?}` returns only authorized candidates and per-provider statuses from that exact connection. Do not guess across hosts.
- `penecho_start_session`: `{instanceId,canvasId,title,target?,documentId?,takeover?,client?,sessionKey?}`. Retain its `sessionId`; the browser session mapping owns every later document route. Server session keys remain owner-scoped, while browser reconnect bindings use the exact client plus key.
- `penecho_list_files` and `penecho_read_file` expose bounded virtual public source, never physical filesystem paths. `context.md` is user-editable document context and PenEcho appends it to the internal Agent's local user turn. `penecho_patch_file` requires a prior read hash, one exact `--- a/<path>` / `+++ b/<path>` unified diff, and requestId; on `SOURCE_CONFLICT` re-read and use a new requestId, while an unknown outcome is retried with the same ID.
- `penecho_edit_canvas` uses strict action-specific fields. Move, resize, delete, erase, and replace require the current `baseRevision` so newer user work is not overwritten; create_text and show do not. Image replacement accepts only a bounded data URL or a same-document `penecho-ref:objects/<encoded-id>/image`; arbitrary fetches are unavailable. Source and geometry edits are separate.
- `penecho_capture_canvas`: `{sessionId,target?,objectId?,region?,quality?}` explicitly captures bounded existing visible Canvas content. Target defaults to `viewport`; `object` requires `objectId`, `region` requires `{x,y,w,h}`, and quality is `basic|detail`. A background document returns `CANVAS_NOT_VISIBLE` with document/retry details and is never shown implicitly.
- `penecho_read_messages` is a bounded pull inbox. Reading never claims receipt or wakes the client; use `penecho_ack_messages` explicitly with `received|working|done|error`.
- `penecho_update_session`: `{sessionId, title?, status?, summary?, steps?, events?}`; `sessionId` plus at least one other update field is required. `status` is `working|waiting|done|error`; `summary` is at most 2,000 characters; `steps` use `{id,label,status?}`, at most 24, with labels at most 160 characters and step status `pending|working|done|error`; `events` use `{id,text,kind?}`, at most 20, with text at most 500 characters and kind `progress|evidence|info|warning|error`. The acknowledgement is `{accepted:true,applied:false,pixelVerified:false,queuedAt,sessionId}`; inspect the session for application state.
- `penecho_present_widget`: `{sessionId, artifactId, title, html, width?, height?, capture?, quality?, presentation?}`. Presentation uses exact optional `intent`, `role`, `size`, `relativeTo`, `relation`, and `attention`. Widget/plot sizes `base|wide|tall|large|page` map to 480×360, 992×360, 480×752, 992×752, and 1200×800. Relation requires `relativeTo`; compare defaults beside. Keep `artifactId` stable and omit presentation on source-only updates to preserve presentation. Widget-only inspect requires `capture:true` and returns one ephemeral pixel-verified render without `objectId` or a second capture call. Explicit dimensions cannot accompany an explicit size. Ordinary presentation remains screenshot-free.
- `penecho_capture_widget`: `{sessionId, artifactId, quality?}` where quality is `basic|detail`; capture the existing Widget on demand with the bounded Widget runtime.
- `penecho_read_feedback`: `{sessionId, after?, limit?, capture?}`. `after` is a non-negative integer; `limit` is 1–50 and defaults to 20; `capture` defaults to `true`, and `capture:false` is metadata-only. The public result is compact: `{sessionId,after,nextCursor,latestCursor,hasMore,truncated,hasFeedback,changeCount,pixelVerified,image?,...}`. It intentionally returns no public `entries`, feedback `kind`, or text fields. With changes and the default capture, it returns one current screenshot containing nearby Canvas design and all user layers, including text-only feedback. Empty results and `capture:false` return no screenshot. The screenshot uses Canvas Agent basic policy: max edge 1024, max 520,000 pixels, WebP quality 0.72, and max 700 KiB; it auto-shrinks when needed. It is current visual context, never OCR or a historical screenshot. Example: `{"sessionId":"<returned sessionId>","after":12,"limit":20,"capture":true}`.
- `penecho_inspect_session` and `penecho_close_session`: `{sessionId}`. Inspect exposes `render.state` `queued|applied|accepted|error` plus application/visibility state; it does not prove painted pixels.

Operating workflow:
- Plan: use exact IDs and one unique session per coherent conversation. If multiple valid sessions or Canvases could be the target, ask one pointed question rather than guessing.
- Preview: with a selected valid connection, proactively present useful UI choices, previews, or a visual explanation when the user benefits. Skip decorative updates for routine edits. A preview button opts into the pull inbox only with `data-penecho-action="choose"` and a bounded `data-penecho-prompt`; its trusted click queues text plus the exact object/session/client/key. It does not invoke a model, serialize general forms or passwords, or grant approval. Read and acknowledge it explicitly.
- Feedback: before a design revision, read feedback for the same session. Keep an independent unread cursor. Process the current page before calling again with `after:nextCursor`, and continue until `hasMore:false`. Spatial pagination may return fewer changes than `limit` to keep distant remarks readable. A failed capture must be retried with the same `after`; do not advance the cursor.
- Revise and verify: extract concrete changes from the current screenshot, but treat vague handwriting as feedback rather than consent or approval for an external or irreversible action. Use stable artifact IDs and ordinary `capture:false`; capture only when visual evidence is needed. A later presentation `feedbackCursor` must not replace an unread cursor.
- Presentation: use intent and role to express purpose and hierarchy, and place only relative to a stable artifact. Interaction must change useful local content or use the opted-in inbox choice contract; never show fake controls or claim arbitrary Widget callbacks.
- Explain/compare may use Visual Explorer infographic structure. Review/deliver of a real page must preserve the product UI, page background, and local interactions rather than add an explanatory wrapper. Inspect faithfully renders supplied HTML at its requested viewport without redesign or labels; use page 1200×800 or explicit mobile dimensions.
- Wait: use `status:"waiting"` while awaiting the user, approval, or later feedback; use `status:"done"` only when complete. There is no automatic wake-up for a stopped client and no tight polling loop. `truncated:true` means retained feedback history is incomplete.
- Feedback reads do not consume input, clear Canvas dirty state, or acknowledge another reader. If a Canvas disconnects, report it, rediscover exact live IDs, and start a fresh session; never silently retarget another Canvas.

Skill and prompt semantics:
- Installing the portable PenEcho workflow skill only influences context when the client loads that skill. Installation alone does not guarantee loading into an existing conversation; follow the client’s reload behavior. It does not edit client configuration or activate the opt-in Widget inbox controls by itself.
- The stdio server already returns `initialize.instructions` with bridge workflow guidance. The client controls whether it adopts, displays, or merges those instructions.
- MCP prompts are user-selected templates. `prompts/list` and `prompts/get` expose Visual Explorer, explain selection, revise feedback, and resume document; the server never selects one automatically.

Privacy and limits:
- Publish only concise public plans, decisions, evidence, and results. Never publish private chain-of-thought, hidden deliberation, credentials, or unrelated raw user data.
- Screenshot generation and encoding are local operations and do not call a model, but an image returned to and read by a model may consume image-input tokens.
- The bridge is local stdio, not full browser automation. Do not expose its dynamic port or add remote transport settings. Keep the primary task moving if visual capture is unavailable.

Report only:
- what client configuration was inspected and changed (without secrets),
- whether `penecho` and its tools were discovered,
- whether the user still needs to enable a Canvas and provide exact IDs,
- concise verification evidence and any remaining limitation.
~~~

## 可复制提示词（中文）

~~~text
请为当前用户配置本地 PenEcho MCP 服务器。

上下文：
- PenEcho 桥接根目录：ABS_ROOT
- 已实现的安装命令是 `penecho mcp`；可移植的直接启动命令是 `node "ABS_ROOT/src/server/mcp/stdio.js"`。
- 桥接是本地 stdio 进程，可以先于应用启动；它会发现同一 state directory 下当前用户的所有存活 PenEcho 实例记录，并将动态 HTTP/WebSocket 端口和 secret 保持在内部。生成的启动配置会刻意省略易变化的 instance ID。

执行步骤：
1. 先查看当前客户端版本对应的官方 MCP 配置文档/帮助，并读取当前 MCP 配置，再进行编辑。使用客户端真实版本支持的语法，保留所有无关服务器和设置。
2. 严格使用给定的绝对桥接路径。不要换成波浪号、相对路径、猜测的 checkout、URL 或动态端口。
3. 如果 PenEcho Desktop Settings/status 提供生成的启动条目，优先使用生成的命令和环境。桌面可能使用带 `ELECTRON_RUN_AS_NODE=1` 的 Electron；请逐字复制生成的 Electron 可执行文件、参数和环境。生成条目不含易变化的 instance selector，不要自行添加。
   如果已安装的 `penecho` 在 PATH 中且客户端支持 command 加 args，也可以使用 `penecho` 加 `["mcp"]` 作为文档化启动方式；否则使用上面的绝对直接形式。
4. Codex 已核对的直接命令形式是：
   `codex mcp add penecho -- node "ABS_ROOT/src/server/mcp/stdio.js"`
5. Claude Code 已核对的直接命令形式是：
   `claude mcp add --transport stdio --scope user penecho -- node "ABS_ROOT/src/server/mcp/stdio.js"`
6. 对于未核对过的 zcode 或其他客户端，不要发明 CLI 参数。语法不明确时，先检查其官方文档/帮助，再做最小的文档化配置修改。不要切换到无关客户端或 provider。
7. 不要在回复、日志或示例中打印、回显、复制或包含 API key、OAuth token、cookie、私有配置值或其他凭据。
8. PenEcho 的 Configure 会先检查是否已有 `penecho` 条目，并使用 safe fallback，不会自动替换已有条目。只有在官方行为要求或工具列表有缓存时才重启 MCP 客户端。然后确认名为 `penecho` 的服务器已发现、工具列表可以加载，并以其实时 `tools/list` schema 作为调用依据。保留无关服务器。
9. 在访问 Canvas 前，告诉用户进入 PenEcho 设置 → MCP 服务并启用当前 Canvas。已关闭 Canvas 或已断开的实例不可用。
10. 调用 `penecho_list_canvases`，只使用该调用返回的准确、已连接且已启用的 `instanceId` 和 `canvasId`。绝不要编造 ID、按标题访问任意 Canvas 或访问其他实例。

工具契约：
- `penecho_list_canvases`：发现已连接且显式启用的 Canvas。
- `penecho_open_canvas`：`{instanceId,canvasId,requestId}` 加独占的 `create:true`，或 `documentId`、`locator`、二者组合以验证准确保存副本；`show` 默认 false。`documentId` 与桥接 `canvasId` 独立，只有显式 `show:true` 才切换当前视图。
- `penecho_find_canvases`：`{instanceId,canvasId,documentId?}` 只返回准确连接授权的候选及各提供方状态，不跨主机猜测。
- `penecho_start_session`：`{instanceId,canvasId,title,target?,documentId?,takeover?,client?,sessionKey?}`。保留返回的 `sessionId`；浏览器 session 映射负责所有后续文档路由。server 的 sessionKey 仍按 owner 隔离，浏览器重连绑定使用准确的 client + key。
- `penecho_list_files`、`penecho_read_file` 只暴露有界虚拟公开源码，不暴露物理文件路径。`context.md` 是用户可编辑的文档上下文，PenEcho 会把它附加到内部 Agent 的本地 user turn。`penecho_patch_file` 要求先读取 hash、准确的单文件 unified diff 和 requestId；`SOURCE_CONFLICT` 时重读并换新 requestId，结果未知时用同一 ID 重试。
- `penecho_edit_canvas` 严格按 action 校验字段；移动、缩放、删除、擦除和替换必须携带当前 `baseRevision`，避免覆盖较新的用户内容；create_text 和 show 不需要。替换图片只接受有界 data URL 或同文档 `penecho-ref:objects/<encoded-id>/image`，不允许任意抓取。源码和几何分开编辑。
- `penecho_capture_canvas`：`{sessionId,target?,objectId?,region?,quality?}`，显式捕获有界的现有可见 Canvas 内容。target 默认 `viewport`；`object` 需要 `objectId`，`region` 需要 `{x,y,w,h}`，quality 为 `basic|detail`。后台文档返回带文档/重试 details 的 `CANVAS_NOT_VISIBLE`，不会隐式显示。
- `penecho_read_messages` 是有界拉取 inbox；读取不表示已接收，也不会唤醒客户端。使用 `penecho_ack_messages` 显式回执 `received|working|done|error`。
- `penecho_update_session`：`{sessionId, title?, status?, summary?, steps?, events?}`；除 `sessionId` 外至少要有一个更新字段；`status` 为 `working|waiting|done|error`；`summary` 最长 2,000；`steps` 最多 24 个（label 最长 160，step status 为 `pending|working|done|error`）；`events` 最多 20 个（text 最长 500，kind 为 `progress|evidence|info|warning|error`）。确认结果为 `{accepted:true,applied:false,pixelVerified:false,queuedAt,sessionId}`；使用 inspect 查看应用状态。
- `penecho_present_widget`：`{sessionId, artifactId, title, html, width?, height?, capture?, quality?, presentation?}`。presentation 仅含 `intent`、`role`、`size`、`relativeTo`、`relation`、`attention`。Widget/plot 的 `base|wide|tall|large|page` 对应 480×360、992×360、480×752、992×752、1200×800。relation 需要 `relativeTo`，compare 默认 beside。源码更新保持 artifactId 并省略 presentation 即可保留呈现。仅 Widget 支持 inspect，且需要 `capture:true`；它同次返回无 `objectId` 的临时像素结果，不再二次捕获。显式尺寸不能与显式 size 共用；普通呈现不截图。
- `penecho_capture_widget`：`{sessionId, artifactId, quality?}`，quality 为 `basic|detail`；按需捕获现有 Widget，沿用有界 Widget runtime。
- `penecho_read_feedback`：`{sessionId, after?, limit?, capture?}`。`after` 是非负整数；`limit` 为 1–50，默认 20；`capture` 默认 `true`，`capture:false` 表示仅返回元数据。公共结果为紧凑结构：`{sessionId,after,nextCursor,latestCursor,hasMore,truncated,hasFeedback,changeCount,pixelVerified,image?,...}`；不会返回公共 `entries`、反馈 `kind` 或文本字段。有变化且使用默认 capture 时，返回一张包含附近 Canvas 设计和所有用户图层的当前截图，即使反馈只有文字也是如此。空结果或 `capture:false` 不返回截图。截图沿用 Canvas Agent basic 策略：最大边 1024、最多 520,000 像素、WebP quality 0.72、最多 700 KiB，过大时自动缩小。它是当前视觉上下文，不是 OCR，也不是历史截图。示例：`{"sessionId":"<returned sessionId>","after":12,"limit":20,"capture":true}`。
- `penecho_inspect_session` 和 `penecho_close_session`：`{sessionId}`。Inspect 暴露 `render.state`（`queued|applied|accepted|error`）及应用/可见状态；不证明像素已经绘制。

运行工作流：
- 计划：使用准确 ID，并让每个连贯对话使用一个独立 session。如果多个有效 session 或 Canvas 都可能是目标，先问一个明确问题，不要猜测。
- 预览：已有有效连接且用户能从中受益时，主动提供有用的 UI 选择、预览或视觉解释；普通编辑跳过装饰性更新。预览按钮只有同时带 `data-penecho-action="choose"` 和有界 `data-penecho-prompt` 才进入拉取 inbox；可信点击会排队文本及准确的 object/session/client/key，不会自动调用模型、序列化普通表单或密码，也不代表批准。客户端必须显式读取和确认。
- 反馈：下一次设计修改前，读取同一 session 的反馈。维护独立的未读游标，先处理当前页，再使用 `after:nextCursor` 继续，直到 `hasMore:false`。空间分页可能为了让远处标注可读而少于 `limit` 返回。捕获失败时使用相同的 `after` 重试，不要推进游标。
- 修改与验证：从当前截图提炼明确修改；模糊手写标记只能视为反馈，不能视为对外部或不可逆操作的同意/批准。使用稳定 artifact ID，普通呈现使用 `capture:false`；只有需要视觉证据时才捕获。后续呈现返回的 `feedbackCursor` 不得覆盖未读游标。
- 呈现：使用 intent 和 role 表达用途及层级，只相对稳定 artifact 排版。交互必须改变有用的本地内容或使用 opt-in inbox 选择协议；不要放假控件，也不要声称任意 Widget callback 能到达客户端。
- Explain/compare 可使用 Visual Explorer 信息图结构。Review/deliver 真实页面时保留产品 UI、页面背景与本地交互，不添加解释性外壳。Inspect 只按请求视口忠实渲染输入 HTML，不改版、不加标签；使用 page 1200×800 或显式移动端尺寸。
- 等待：等待用户、批准或后续反馈时使用 `status:"waiting"`；完成后才使用 `status:"done"`。停止的客户端不会被自动唤醒，也不能紧密轮询。`truncated:true` 表示保留的反馈历史不完整。
- 反馈读取不会消费输入、清除 Canvas dirty 状态或确认其他 reader。如果 Canvas 断开，报告断开，重新发现准确的存活 ID 并建立新 session；绝不静默改指向其他 Canvas。

Skill 与 prompt 的语义：
- 安装便携 PenEcho workflow skill 只会在客户端加载该 skill 时影响上下文；不会激活已运行的对话、修改客户端配置，也不会自行启用 Widget 的 opt-in inbox 控件。
- stdio server 已经在 `initialize.instructions` 中返回桥接工作流指引。客户端自行决定是否采用、显示或合并这些指引。
- MCP prompts 是由用户选择的模板。`prompts/list` 和 `prompts/get` 提供“Visual Explorer”“解释选择”“按反馈修订”“恢复文档”四个模板，server 不会自动选择。

隐私与限制：
- 只发布简洁的公共计划、决策、证据和结果；绝不发布 private chain-of-thought、隐藏推理、凭据或无关用户原始数据。
- 截图生成和编码是本地操作，不会调用模型；但模型接收并读取返回图片时可能消耗 image-input tokens。
- 该桥接是本地 stdio，不是完整浏览器自动化。不要暴露动态端口或添加远程 transport 设置。视觉捕获不可用时继续主要任务。

只报告：
- 检查和修改了哪些客户端配置（不含秘密）；
- 是否发现 `penecho` 及其工具；
- 用户是否仍需启用 Canvas 并提供准确 ID；
- 简洁的验证证据和剩余限制。
~~~

## Optional workflow skill / 可选工作流 skill

If the client supports local skills and the user explicitly requests the PenEcho
workflow skill, verify its skill directory in the client's official docs and
copy the whole folder from `ABS_ROOT/skills/penecho-mcp/`. Kimi and zcode may
use different locations, so consult their current docs. If skill loading is not
supported, ask the LLM to read the absolute `ABS_ROOT/skills/penecho-mcp/SKILL.md`
path directly. Installing the skill only changes context when the client loads
it; it does not edit client configuration, activate a stopped conversation, or
enable opt-in Widget inbox controls by itself. The stdio `initialize.instructions` is already present
and the client controls whether to adopt it. MCP prompts are user-selected
templates; this server exposes visual-explorer, explain-selection, revise-feedback, and resume-document prompts, but never selects one automatically.

如果客户端支持本地 skills 且用户明确需要 PenEcho workflow skill，请先从客户端官方
文档确认 skill 目录，再把 `ABS_ROOT/skills/penecho-mcp/` 整个文件夹复制过去。Kimi
和 zcode 可能使用不同位置，请查阅当前文档。如果不支持加载 skill，请让 LLM 直接读取
绝对路径 `ABS_ROOT/skills/penecho-mcp/SKILL.md`。安装 skill 只有在客户端加载它时才会
改变上下文；不会修改客户端配置、激活已停止的对话或自行启用 Widget inbox 控件。stdio 的
`initialize.instructions` 已经存在，是否采用由客户端决定。MCP prompts 是用户选择的
模板；server 提供Visual Explorer、解释选择、按反馈修订、恢复文档四个 prompt，但不会自动选择。

## Handoff notes / 交接说明

PenEcho automatically places new previews in task regions and batches camera
framing. Reuse stable artifact IDs for updates; do not calculate Canvas coordinates
or send camera instructions. User navigation pauses following until they choose
Show new content.

PenEcho 自动按任务安排新预览，并合并调整视野。更新时复用稳定的 artifact ID，
无需计算画布坐标或发送镜头指令。用户操作视野后暂停跟随，可点击“查看新内容”恢复。

The configuring LLM should stop at the client-configuration boundary. It may
inspect official client docs, read and edit the client's MCP entry, restart that
client when required, discover tools, and list available Canvases. Starting the
stdio bridge before the app is allowed; starting the full PenEcho app/service as
a side effect is not. It must not expose the hidden dynamic port, broaden a
Canvas target without explicit MCP-page enablement, or silently retarget after a
disconnect. If it needs user feedback, mark the session `waiting`; mark it
`done` only after the requested work is complete.

负责配置的 LLM 应在客户端配置边界停止。它可以检查客户端官方文档、读取和修改 MCP
条目、按需重启客户端、发现工具并列出 Canvas。可以先启动 stdio 桥接再启动应用；不得
把启动完整 PenEcho 应用/服务作为本配置副作用，不得暴露隐藏动态端口，不得在没有 MCP
页面明确启用时扩大 Canvas 目标，也不得在断开后静默改指向。需要用户反馈时将 session
标记为 `waiting`；只有请求工作完成后才标记为 `done`。


For lightweight text, nodes, connectors or paths use `penecho_draw`; for a function
expression use `penecho_plot`. Both optionally combine presentation with bounded
capture. Read the portable skill for full-snapshot replacement and native-object
limits; retain stable artifact/element IDs and leave Canvas placement to PenEcho.

Existing artifact updates preserve the user’s position and size. `width` / `height` apply when creating a Widget; use `penecho_edit_canvas` with the current revision for explicit resizing. Only a new, unbound conversation gets its own Canvas by default, even when the visible Canvas is empty. Give the Canvas a concise descriptive name through `title`. Retain the returned `sessionId` and `documentId` across turns and reconnects; already bound conversations continue on that Canvas. Explicit requests to continue on the current Canvas use `target:"current"`.


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

### Editing the currently visible Canvas / 修改当前画布

For “current canvas”, “this canvas”, “当前画布”, “这个画布”, or the current
selection, call `penecho_start_session` with `target:"current"` on the exact
opted-in connection, without `documentId`. Do not create/open a Canvas first.
Read existing files and revision, then edit using the returned sessionId. The
session stays bound to that document after navigation. If an existing conversation
key is bound elsewhere, use a distinct stable attachment sessionKey and retain
both handles; never silently redirect an old session. Ordinary new work keeps
its per-conversation document behavior. Ask only if the intended connection is
ambiguous.

用户要求整理或修改“当前画布”时，直接以 `target:"current"` 绑定用户正在查看的画布，
先读取已有内容再修改，不创建或打开新画布。绑定后保持文档不变；如果同一对话原本绑定了
别的文档，使用独立且稳定的附加 sessionKey，并保留原会话句柄。

For freehand annotation use penecho_edit_canvas action:"draw_ink" with the current baseRevision and strokes:[{color:"#E63946",width:6,points:[{x:120,y:140},{x:220,y:140}]}]. Coordinates and width are Canvas world units. Choose any explicit #RRGGBB color; each stroke is an open round brush polyline (repeat the first point to close a circle; add separate strokes for arrowheads; use a wider stroke for an underline/highlight). Ink may overlap existing content intentionally. Limits: 1–16 strokes, 1–256 points per stroke, 1024 points total, width 1–64; all points fit a 2048 × 2048 region and the brush radius stays inside the Canvas. The operation preserves the user’s brush selection and creates one undoable edit. Background documents reject before mutation: use show only when making that document visible is intended, reread its revision, then draw. Retry the same requestId only with identical arguments.


## Shared on-demand authoring guidance

Use `penecho_get_guidance` for `visual-explorer`, `general-html`, `math-2d`, `physics-2d`, or `math-3d` when relevant. This returns the same design document, version, and hash as PenEcho Agent. UI pages and live tools use General HTML; explanation and analysis use Visual Explorer. The full documents are not loaded into routine requests. Scientific HTML with one supported `penecho-visual-skill` marker uses the shared scientific Widget runtime. Professional Diagram and private-plugin source authoring are unavailable; saved content remains readable.
