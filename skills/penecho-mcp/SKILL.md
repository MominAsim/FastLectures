---
name: penecho-mcp
description: Create, read, or edit PenEcho canvases, including following the user's drawings and notes.
---

Use connected tools; search only missing deferred tools. Bind once with start_session; retain sessionId/documentId and stable client/sessionKey. Use target:current for the user's current Canvas.

Follow live schemas; get_guidance only for the needed topic. Keep artifact IDs. Read source/contentHash before patching. Retry uncertain writes with identical arguments/requestId. Capture when visual evidence is needed; combine final mutation and completion. Inbox reads do not acknowledge.

For authorized local images, use [upload helper](scripts/upload-image.cjs) so Base64 stays out of context.
