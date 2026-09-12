# Agent 时序图回归：证据与修复验收

状态：代码修复和针对性自动化测试已完成，真实模型与应用效果验收进行中；不能据此宣称版本可发布。

## 基准与要求

用户确认 1.2.0 没有此问题，且效果满意。以该版本的可视化行为作为质量基准，优化不能以降低图文解释、Widget 渲染质量或增加无效往返为代价。

原始请求：不要只返回源代码；请先在 Canvas 上以图文结合的方式创建并展示渲染后的时序图，再在聊天中返回可编辑的 Mermaid 或 PlantUML 源码，不要返回 HTML。

## 已确认的证据

- `origin/main` 的 1.2.0（84d4f8d）首次系统提示注入完整 Visual Explorer 合约，包含响应式 HTML/CSS/SVG Widget 交付要求。
- `cb22fc4` 将 Agent 切换到共享 MCP 工具和按需指导；schema 适配白名单删除 maxItems/minimum/maximum 等限制，而执行端仍严格校验。
- `974069e` 进一步删除初始 document-tools 提示中的 Widget/native tool 映射及 ROUTING，并将指导默认返回改为 brief。该改动确实削弱了首次工具选择指引；它没有引入 schema 白名单，但继承了该缺陷。
- Windows 已安装 PenEcho 1.3.0，17:22:21 请求实际使用 glm-5.3-flash/xhigh，首先读取 visual-explorer brief，随后公开进度明确说“先在 Canvas 上原生绘制”。因此不能归因为“没有读指导”，也不能声称知道模型内部如何理解“不要返回 HTML”。
- 实际发送给模型的 draw.items 只有 array/items，没有 24 项限制，strokeWidth 只有 number，没有 1..12。拒绝中存在笼统 items is invalid，无法指导准确修正。
- 后续快照显示该请求于 17:51:10 取消，共 18 次已计费模型调用、72,764 output tokens；这是后续快照，不与此前 10 次/12 分钟快照混用。本次排查没有中断该用户请求。
- 初始图片只是“你好！”及欢迎答复，没有具体时序图业务主题。不能凭空把某个业务主题当作用户原始题目。

## 修复

1. 在初始 Agent 提示、VE brief/full 和工具描述中恢复复杂/静态图文解释优先 Widget、少量简单标记使用 native draw 的职责。
2. 区分 Canvas 渲染容器与聊天源码语言：同时要求渲染与 Mermaid/PlantUML 时使用内部 Widget 并在聊天交付对应 DSL；仅源码请求不强制创建，明确禁止 HTML 实现仍须遵守。
3. 独立 schema 适配器保留 SDK 可接受结构，将不支持的约束完整写入紧凑 Constraints 注释。MCP 规范验证器仍是唯一执行规则，不放宽验证。
4. 数量/数值报错返回字段、实际数量或数值、允许范围；非法文本/对象仅返回类型，避免回显无关内容。没有用重试熔断器掩盖契约错误。
5. 使用官方限定文件同步更新 Cloud 共享运行时，并将新模块加入同步白名单。

## 已完成验证

- MCP guidance/schema 与真实 Agent document-tools/schema adapter：36/36 通过。
- Canvas Agent 主测试、视觉技能、native capture 合约：98/98 通过。
- Cloud mirror provenance、依赖导入、scoped sync：3/3 通过；hosted Agent/adapter/decision：12/12 通过。
- 实际 adapter 暴露 24 项、stroke 1..12、rect/ellipse 80 条件；安装版 SDK 接受；25 项输入在 browser RPC 前被具体拒绝。
- Astra 主任务集成与测试；请求 Astra/low 子代理实现 schema/诊断和测试，Astra/medium 独立只读审查。工具请求参数指定上述模型，未取得额外实际执行模型元数据。

## 成本与未完成项

恢复限制有输入成本，不能继续沿用删掉限制后得到的 token 节省数字。当前 13 个实际 Agent 工具的 parameters JSON 为 23,293 UTF-8 bytes；这不是 token 数，也不是完整请求长度。

真实测试使用隔离本机服务、原始文字请求、glm-5.3-flash/xhigh、空白测试画布，尚待检查工具选择与实际像素。它没有完整复现 Windows 原会话上下文。Windows 新包、mac 新包及本次完整发布验收尚未完成，已安装 1.3.0 不因本地源码修改自动修复。
