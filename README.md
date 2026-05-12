# OpenAPI Proxy

本地 OpenAI Responses API 兼容代理，用于把 Codex/Cursor/ccswitch 发来的 Responses API 请求转换为 DeepSeek Chat Completions 请求。

Local OpenAI Responses API compatible proxy that converts Responses API requests from Codex, Cursor, or ccswitch into DeepSeek Chat Completions requests.

## 中文说明

### 为什么做这个项目

在我的实际使用场景里，各种 AI IDE 中，Codex 执行多段、阻塞式、需要反复调用工具的工作流效果最好。它适合跑“读取上下文 -> 调用工具 -> 等待结果 -> 继续推理 -> 再调用工具”的长链路任务。

不同 IDE 的交互模型有明显差异：

- Windsurf Chat 支持 token 级流式输出，文本会边生成边渲染到对话面板里。
- Cursor Chat 更偏完整 assistant turn 的请求-响应模式，不适合作为底层工作流引擎的实时 relay。
- Codex 的 Responses API 工作流更适合把工具调用、MCP、skills 和多轮阻塞式执行串起来。

所以这个项目的目标不是再做一个通用聊天转发器，而是让 Codex/Cursor/ccswitch 能以 OpenAI Responses API 的形式接入 DeepSeek V4 Pro，把 DeepSeek 的模型能力接到更适合复杂开发工作流的执行层里。

目前优先只接入 DeepSeek V4 Pro，是因为在这类“主持工作流”的场景里，它的规划、工具调用续接、长任务推进能力表现非常强。按我的实际使用感受，它至少接近 `gpt-5.3-codex` 级别，某些长链路开发任务里甚至更好，所以值得先把它适配到 Responses API 工作流里。

### 它解决什么问题

当前 Codex 侧按 OpenAI Responses API 调用模型，而 DeepSeek V4 Pro 官方接口是 Chat Completions 风格。这个代理运行在本机：

```text
Cursor / Codex / ccswitch
  -> OpenAI Responses API
  -> openapi-proxy
  -> DeepSeek Chat Completions
  -> DeepSeek V4 Pro
```

工具调用、MCP、skills 的关键点是：代理只做协议转换，不在本地执行工具。Cursor/Codex 仍然负责执行 MCP、shell、文件读写等工具；代理负责把 Responses API 的 tool call / tool result 结构转换成 DeepSeek 可以连续对话的 Chat Completions 消息。

### 启动代理

```bash
npm start
```

查看或停止：

```bash
npm run status
npm run stop
```

清空本地 Responses 会话状态。修改适配逻辑后，或者工具调用历史坏掉时可以执行：

```bash
npm run clear
```

### 配置 DeepSeek

打开本地可视化配置界面：

```text
http://127.0.0.1:11434/
```

在界面里：

1. 选择 `DeepSeek V4 Pro` 或新增 provider。
2. 在 `API Key` 填入 DeepSeek 官方 API key。
3. 选择推理强度，例如 `high` / `max`。
4. 点击 `Save`。
5. 点击 `Test` 验证 provider 可用。

DeepSeek API key 保存在 `.state/secrets.json`，主配置在 `.state/config.json`。`.state/` 默认已被 git 忽略。

### Cursor 助手配置

Cursor 中选择 OpenAI 类型的模型配置，然后填：

```text
Model: deepseek-v4-pro
Base URL: http://127.0.0.1:11434
Endpoint: /v1/responses
API Key: local-placeholder
```

如果客户端只有一个 OpenAI `base_url` 字段，没有单独的 endpoint 字段，则使用：

```text
Base URL: http://127.0.0.1:11434/v1
```

注意：Cursor 里填的 API Key 只是给本地代理的占位值，真实 DeepSeek key 应该配置在代理 UI 里。

### Codex 配置示例

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek_responses_proxy"

[model_providers.deepseek_responses_proxy]
name = "DeepSeek Responses Proxy"
base_url = "http://127.0.0.1:11434/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 0
```

`OPENAI_API_KEY` 可以是任意本地占位值，例如 `local-placeholder`。DeepSeek 官方 key 仍然由代理 UI 保存和使用。

### 接入 ccswitch 的用法

后续可以把这个代理注册成 ccswitch 里的一个 OpenAI Responses provider：

```text
Provider name: deepseek-v4-pro-via-openapi-proxy
Model: deepseek-v4-pro
Base URL: http://127.0.0.1:11434/v1
Wire API: responses
API Key: local-placeholder
```

切换到这个 provider 后，Codex 看到的是 OpenAI Responses API，实际请求会由本地代理转发到 DeepSeek V4 Pro。

### 日志

默认只记录启动、请求生命周期和错误：

```text
.state/proxy.log
```

调试时可以在 UI 中开启：

```text
Logging -> Full Payload Logging -> enabled
```

开启后日志会包含完整请求体、工具参数、客户端 Authorization、解析后的 provider 以及 DeepSeek API key。只建议临时排查问题时开启，用完立刻关闭并清理 `.state/proxy.log`。

DeepSeek thinking-mode 的 `reasoning_content` 会保存在本地状态里，用于带工具调用的后续请求。只有当请求显式要求 `reasoning.summary` 时，代理才会按 Responses API 输出 `reasoning` item。

### 测试

```bash
npm test
```

使用 UI 中保存的 DeepSeek key 跑真实 DeepSeek SSE / 工具调用续接测试：

```bash
npm run test:deepseek
```

## English Guide

### Motivation

In my day-to-day AI IDE workflow, Codex has been the strongest fit for long, blocking, multi-step tasks that repeatedly call tools. It works well for flows like: read context, call a tool, wait for the result, continue reasoning, and call the next tool.

The IDE interaction models are different:

- Windsurf Chat supports token-level streaming and renders text as it is generated.
- Cursor Chat is closer to a complete assistant-turn request/response model, which makes it less suitable as a real-time relay for lower-level workflow execution.
- Codex, through the Responses API workflow, is a better fit for chaining tool calls, MCP, skills, and blocking multi-step execution.

This project is therefore not just another generic chat proxy. Its purpose is to let Codex, Cursor, and ccswitch use DeepSeek V4 Pro through an OpenAI Responses API compatible surface, so DeepSeek can be connected to a workflow engine that is better suited for complex development tasks.

The project focuses on DeepSeek V4 Pro first because it is especially strong at coordinating workflow-style tasks: planning, continuing after tool results, and pushing long-running development work forward. In my own usage, it feels at least comparable to `gpt-5.3-codex` for this role, and sometimes stronger on long multi-step tasks, so it is the first model worth adapting cleanly to the Responses API workflow.

### What It Does

Codex expects an OpenAI Responses API compatible endpoint, while the official DeepSeek V4 Pro API uses Chat Completions. This proxy runs locally and bridges the two protocols:

```text
Cursor / Codex / ccswitch
  -> OpenAI Responses API
  -> openapi-proxy
  -> DeepSeek Chat Completions
  -> DeepSeek V4 Pro
```

For tools, MCP, and skills, the proxy only translates the wire format. It does not execute local tools. Cursor/Codex still executes MCP tools, shell commands, and file operations; the proxy translates tool calls and tool results between Responses API and DeepSeek Chat Completions.

### Start The Proxy

```bash
npm start
```

Check or stop it:

```bash
npm run status
npm run stop
```

Clear local Responses session state after adapter changes or broken tool-call history:

```bash
npm run clear
```

### Configure DeepSeek

Open the local config UI:

```text
http://127.0.0.1:11434/
```

In the UI:

1. Select `DeepSeek V4 Pro` or create a provider.
2. Paste the official DeepSeek API key into `API Key`.
3. Select the reasoning effort, for example `high` or `max`.
4. Click `Save`.
5. Click `Test`.

DeepSeek API keys are stored in `.state/secrets.json`; main config is stored in `.state/config.json`. `.state/` is ignored by git by default.

### Cursor Assistant Settings

Choose an OpenAI-style model config in Cursor:

```text
Model: deepseek-v4-pro
Base URL: http://127.0.0.1:11434
Endpoint: /v1/responses
API Key: local-placeholder
```

If the client only has a single OpenAI `base_url` field and no endpoint field, use:

```text
Base URL: http://127.0.0.1:11434/v1
```

The API key configured in Cursor is only a local placeholder. The real DeepSeek key should be saved in the proxy UI.

### Codex Provider Example

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek_responses_proxy"

[model_providers.deepseek_responses_proxy]
name = "DeepSeek Responses Proxy"
base_url = "http://127.0.0.1:11434/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 0
```

`OPENAI_API_KEY` can be any local placeholder, such as `local-placeholder`. The official DeepSeek key is still managed by the proxy UI.

### ccswitch Integration

You can register this proxy as an OpenAI Responses provider in ccswitch:

```text
Provider name: deepseek-v4-pro-via-openapi-proxy
Model: deepseek-v4-pro
Base URL: http://127.0.0.1:11434/v1
Wire API: responses
API Key: local-placeholder
```

After switching to this provider, Codex talks to a Responses API endpoint, and the local proxy forwards the actual model request to DeepSeek V4 Pro.

### Logging

By default, the proxy only records startup, request lifecycle events, and errors:

```text
.state/proxy.log
```

For debugging, enable:

```text
Logging -> Full Payload Logging -> enabled
```

When enabled, the log includes full request bodies, tool arguments, client Authorization headers, resolved provider config, and the DeepSeek API key. Keep it disabled unless you are actively debugging, and clear `.state/proxy.log` afterwards.

DeepSeek thinking-mode `reasoning_content` is stored locally for tool-call continuation. A Responses API `reasoning` item is emitted only when the request explicitly asks for `reasoning.summary`.

### Test

```bash
npm test
```

Run the live DeepSeek SSE/tool-call continuation check with the key saved in the UI:

```bash
npm run test:deepseek
```

## License

MIT
