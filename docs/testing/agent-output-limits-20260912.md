# Agent 输出额度遗漏核查 · 2026-09-12

用户已要求主生成额度统一为 64,000；此前漏掉本地 Agent、部分 UAT 模型记录及默认值。

## 两次请求的不同结束点

| 本地请求记录 | 模型入口 | 模型调用 / 工具调用 | 分轮 output tokens | 实际结束 |
|---|---|---|---|---|
| 1789210450612-ed901a81-00a9-43e9-a42a-fa05f101d679 | DeepSeek OpenAI | 1 / 0 | 32,767 | 本地请求32,768，max-tokens，无正文/工具 |
| 1789210766622-9ec7e9d6-7be5-4fb7-8fdd-75829e4496de | DeepSeek Anthropic | 2 / 1 | 6,028 + 16,384 | 读取VE brief成功；第二轮max-tokens，无绘图调用 |

第二次耗时98.779秒。UAT hosted_model_requests两行（10:59:27、10:59:56 UTC）reserved_output_tokens均16,384，output_tokens分别6,028与16,384；对应模型配置max_output_tokens=16,384。本地日志请求32,768，Cloud取较小值，因此本次在16,384就触顶，不能说超过32,000。HTTP200/usage succeeded只表示供应商成功返回并计费，不能代表用户任务完成。以上只检查公开事件、配置和usage，没有读取或保存隐藏推理文本。

## 修复与验证

- 071 `9107c4f`：Agent API profile由32,768改为64,000；真实Harness构造的OpenAI/DeepSeek HTTP请求参数断言为64,000，多种profile包括Anthropic额度断言。Agent主文件88/88通过。
- 071 `4809658`：Main Canvas API默认63,000改为64,000；API/security测试76/76通过。
- Cloud统一服务、配置及管理API的新模型默认64,000；069迁移更新非审核模型的历史16,384/32,768/63,000值，保留独立审核预算及其他显式额度；UAT已执行迁移。
- Cloud额度转发、计价与provider pool测试48/48通过。执行端仍尊重显式模型能力上限，不移除额度验证。
- MCP本身不发起外部客户端的模型请求，不能替外部客户端设置输出预算；这里修改PenEcho自己负责的生成链路。

未声称64000可以保证模型及时执行工具。现有应用/Agent会话可能仍保留旧profile，之前47b安装包不含这次修复；需在更新运行时后检查新的实际outbound参数。没有操作production、没有推送代码。
