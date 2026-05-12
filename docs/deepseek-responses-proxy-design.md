# Codex Responses API 到 DeepSeek V4 Pro 代理设计

> 状态：设计稿  
> 更新日期：2026-05-08  
> 目标：让 Codex 继续以 OpenAI Responses API 形式调用本地地址，由本地代理转换为 DeepSeek 官方 `/chat/completions` 请求，并保持 skills、MCP 工具、本地工具调用链路可用。

## 1. 背景与约束

Codex 的自定义模型提供方配置支持 `base_url`、`env_key`、`wire_api` 等字段，且可将 `wire_api` 配置为 `responses`。Responses API 是 OpenAI 当前面向 agentic workflow 的统一接口，支持状态化对话、工具、流式输出和函数调用。DeepSeek 官方 API 提供 OpenAI SDK 兼容的 Chat Completions 接口，基础地址为 `https://api.deepseek.com`，聊天接口为 `/chat/completions`，并支持 `tools` / `tool_calls` 形式的 function calling。

关键约束：

- Codex 侧不能直接调用 DeepSeek Chat Completions，需要本地代理暴露 `/v1/responses`。
- DeepSeek 官方接口不是 Responses API，无法原生理解 Responses 的 `input`、`output`、`previous_response_id`、Responses SSE 事件和非 function 类型工具。
- DeepSeek function calling 只能表达“模型请求调用某个函数”，真正的 shell、apply_patch、MCP、skills 执行仍应由 Codex 客户端负责。
- Skills 本质上是 Codex 注入给模型的上下文/指令与本地资源组织方式；代理不应执行 skill，只要忠实透传或归一化请求上下文即可。
- MCP 工具也不应在代理内直接执行；代理负责把 Codex 暴露给模型的工具 schema 转成 DeepSeek 可识别的 function tools，再把 DeepSeek 返回的 tool call 转回 Responses 格式，让 Codex 去调用 MCP。

参考：

- OpenAI Responses create API: <https://platform.openai.com/docs/api-reference/responses/create>
- OpenAI Responses function calling guide: <https://platform.openai.com/docs/guides/function-calling>
- Codex config reference: <https://developers.openai.com/codex/config-reference>
- Codex skills: <https://developers.openai.com/codex/skills>
- Codex MCP: <https://developers.openai.com/codex/mcp>
- DeepSeek quick start: <https://api-docs.deepseek.com/>
- DeepSeek create chat completion: <https://api-docs.deepseek.com/api/create-chat-completion>
- DeepSeek function calling: <https://api-docs.deepseek.com/guides/function_calling>
- DeepSeek thinking mode: <https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>

## 2. 总体方案

本地启动一个 HTTP 服务，例如 `http://127.0.0.1:11434/v1`：

```text
Codex
  │
  │ POST /v1/responses
  │ stream: true/false
  │ input/tools/previous_response_id
  ▼
Local Responses Proxy
  ├─ Config UI：查看、修改、保存配置，切换当前 provider
  ├─ ConfigStore：保存多个 provider profile 与 active_provider
  ├─ RequestNormalizer：Responses input -> Chat messages
  ├─ ToolTranslator：Responses tools -> DeepSeek function tools
  ├─ StateStore：保存 response_id、会话消息、tool_call 映射
  ├─ StreamTranslator：DeepSeek SSE -> Responses SSE
  └─ ResponseBuilder：DeepSeek chat response -> Responses object
  │
  │ POST https://api.deepseek.com/chat/completions
  ▼
DeepSeek V4 Pro
```

代理保持“薄转换层”定位：

- 不执行本地命令。
- 不执行 MCP。
- 不解释 skill。
- 不自行追加复杂 prompt。
- 不吞掉工具调用。
- 不伪造 DeepSeek 没有返回的能力。

## 3. 对外 API

建议首期实现这些端点：

```text
GET  /health
GET  /
GET  /v1/models
POST /v1/responses
GET  /v1/responses/{response_id}
GET  /api/config
PUT  /api/config
POST /api/config/active-provider
POST /api/config/test-provider
```

可选二期：

```text
POST   /v1/responses/{response_id}/cancel
DELETE /v1/responses/{response_id}
```

`/v1/models` 返回 UI 中启用的 provider；当前 active provider 可以通过 `metadata.active = true` 标记：

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "created": 0,
      "owned_by": "deepseek",
      "metadata": {
        "provider_id": "deepseek-v4-pro",
        "active": true
      }
    },
    {
      "id": "deepseek-v4-pro-max",
      "object": "model",
      "created": 0,
      "owned_by": "deepseek",
      "metadata": {
        "provider_id": "deepseek-v4-pro-max",
        "active": false
      }
    }
  ]
}
```

## 4. Codex 配置示例

推荐在 `~/.codex/config.toml` 中新增 provider：

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek_responses_proxy"
model_context_window = 65536

[model_providers.deepseek_responses_proxy]
name = "DeepSeek Responses Proxy"
base_url = "http://127.0.0.1:11434/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 0
```

本地代理读取真实 DeepSeek key：

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_KEY="local-placeholder"
```

说明：

- Codex 发给代理的 Authorization 可只做本地校验或忽略。
- 代理转发到 DeepSeek 时使用 `DEEPSEEK_API_KEY`。
- `stream_max_retries = 0` 可以避免工具调用流被中途重试后重复执行。

## 4.1 本地可视化配置界面

代理提供一个本地页面，例如 `http://127.0.0.1:11434/`。这个页面只做配置可视化：看配置、改配置、保存配置、切换当前使用的 provider。

页面能力：

- 查看当前完整配置。
- 新增、复制、删除 provider 配置。
- 修改 provider 的名称、模型、base URL、API key、推理层级、超时、重试等参数。
- 保存配置到本地配置文件。
- 切换当前使用的 provider。
- 测试当前 provider 是否可用。

页面布局建议：

```text
┌────────────────────────────────────────────────────────────┐
│ OpenAPI Proxy                                              │
│ Active provider: deepseek-v4-pro        [Test] [Save]      │
├─────────────────────┬──────────────────────────────────────┤
│ Providers           │ Provider Config                      │
│                     │                                      │
│ ● DeepSeek V4 Pro   │ Name              DeepSeek V4 Pro     │
│ ○ DeepSeek Max      │ Provider type     deepseek            │
│ ○ Custom OpenAI     │ Base URL          https://api...      │
│                     │ Model             deepseek-v4-pro     │
│ [+ Add provider]    │ API Key           sk-**** [Change]    │
│                     │ Reasoning         high / max          │
│                     │ Stream            enabled             │
│                     │ Timeout           120s                │
│                     │                                      │
│                     │ [Set active] [Save config]            │
└─────────────────────┴──────────────────────────────────────┘
```

保存后的配置示例：

```json
{
  "active_provider": "deepseek-v4-pro",
  "providers": [
    {
      "id": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "type": "deepseek",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-v4-pro",
      "api_key_ref": "deepseek-v4-pro",
      "reasoning": {
        "enabled": true,
        "effort": "high",
        "minimal_policy": "disabled"
      },
      "timeout_ms": 120000,
      "request_max_retries": 2,
      "stream_max_retries": 0
    },
    {
      "id": "deepseek-v4-pro-max",
      "name": "DeepSeek Max Reasoning",
      "type": "deepseek",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-v4-pro",
      "api_key_ref": "deepseek-v4-pro",
      "reasoning": {
        "enabled": true,
        "effort": "max",
        "minimal_policy": "disabled"
      },
      "timeout_ms": 180000,
      "request_max_retries": 2,
      "stream_max_retries": 0
    }
  ]
}
```

运行时选择 provider 的规则：

- `/v1/responses` 默认使用 `active_provider`。
- 如果请求中的 `model` 能匹配某个 provider 的 `model` 或 `id`，可选支持按模型路由。
- UI 切换 active provider 后，Codex 无需改配置；下一次请求直接走新的 provider。
- `/v1/models` 返回所有启用的 provider，并标记当前 active provider。

API key 处理：

- UI 可以录入或替换 key，但读取配置时只返回掩码，例如 `sk-****abcd`。
- 配置文件只保存 `api_key_ref`，真实 key 优先保存到系统 keychain；如果首期不做 keychain，则保存到权限为 `0600` 的本地 secrets 文件。
- 环境变量优先级最高，例如 `DEEPSEEK_API_KEY` 可以覆盖 UI 保存的 key。

## 5. 请求转换

### 5.1 Responses request 到 DeepSeek request

示例输入：

```json
{
  "model": "deepseek-v4-pro",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "列出当前目录文件" }]
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "shell",
      "description": "Run a shell command",
      "parameters": {
        "type": "object",
        "properties": { "cmd": { "type": "string" } },
        "required": ["cmd"]
      }
    }
  ],
  "stream": true
}
```

转换为 DeepSeek：

```json
{
  "model": "deepseek-v4-pro",
  "messages": [
    {
      "role": "user",
      "content": "列出当前目录文件"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "shell",
        "description": "Run a shell command",
        "parameters": {
          "type": "object",
          "properties": { "cmd": { "type": "string" } },
          "required": ["cmd"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": true
}
```

### 5.2 字段映射

| Responses 字段 | DeepSeek 字段 | 处理方式 |
| --- | --- | --- |
| `model` | `model` | 默认改写为 `DEEPSEEK_MODEL`，建议 `deepseek-v4-pro`。 |
| `input` string | `messages[].content` | 转成单条 user 消息。 |
| `input[].message` | `messages[]` | 按 role 转成 chat message。 |
| `instructions` | `messages[0]` | 作为 system 消息前置。 |
| `previous_response_id` | 无 | 从本地 `StateStore` 取历史消息后拼接。 |
| `max_output_tokens` | `max_tokens` | 名称转换。 |
| `temperature` | `temperature` | 直接透传。 |
| `top_p` | `top_p` | 直接透传。 |
| `stop` | `stop` | 直接透传。 |
| `tools` | `tools` | 统一转成 DeepSeek function tools。 |
| `tool_choice` | `tool_choice` | `auto`/`none`/指定函数名做映射。 |
| `parallel_tool_calls` | `parallel_tool_calls` | DeepSeek 支持时透传，否则忽略并记录 warning。 |
| `reasoning.effort` | `thinking` + `reasoning_effort` | 接受 OpenAI/Codex 的 `none`/`minimal`/`low`/`medium`/`high`/`xhigh`，转为 DeepSeek 的 `disabled`/`high`/`max`。 |
| `stream` | `stream` | 直接透传，响应事件另行转换。 |
| `metadata` | 无 | 保存到本地 response 对象，不转发。 |
| `store` | 无 | 由代理决定是否落盘，默认开启短期 TTL。 |

### 5.3 消息归一化

Responses 的 content 是多段结构，DeepSeek Chat Completions 更偏向字符串或 OpenAI-compatible content。建议首期只保证文本能力：

- `input_text` -> 追加文本。
- `output_text` -> 作为 assistant 历史消息。
- `function_call_output` -> 转成 `role = "tool"`，`tool_call_id = call_id`。
- 多个 content part 用空行拼接，保留顺序。
- 文件、图片、音频输入默认返回 400，除非后续确认 DeepSeek V4 Pro 当前模型支持该模态并补齐映射。

工具结果映射：

```json
{
  "type": "function_call_output",
  "call_id": "call_abc",
  "output": "{\"stdout\":\"...\",\"exit_code\":0}"
}
```

转换为：

```json
{
  "role": "tool",
  "tool_call_id": "call_abc",
  "content": "{\"stdout\":\"...\",\"exit_code\":0}"
}
```

### 5.4 DeepSeek 推理层级配置

DeepSeek V4 Pro 的 thinking mode 不是和 OpenAI/Codex 一一对应的档位。DeepSeek 官方 OpenAI-format 参数为：

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high"
}
```

DeepSeek 当前真实 effort 档位：

| DeepSeek 值 | 含义 |
| --- | --- |
| `high` | 默认思考强度；普通请求默认值。 |
| `max` | 更高思考强度；复杂 Agent 类请求可能自动使用。 |

代理对 Codex/OpenAI reasoning 值的映射策略：

| Codex/OpenAI 输入 | DeepSeek 转发 | 说明 |
| --- | --- | --- |
| `none` | `thinking: {"type":"disabled"}`，不传 `reasoning_effort` | 关闭思考模式。 |
| `minimal` | 默认按 `none` 处理 | DeepSeek 没有 `minimal` 等价值，可通过配置改为 `high`。 |
| `low` | `thinking: {"type":"enabled"}` + `reasoning_effort: "high"` | DeepSeek 官方兼容映射为 `high`。 |
| `medium` | `thinking: {"type":"enabled"}` + `reasoning_effort: "high"` | DeepSeek 官方兼容映射为 `high`。 |
| `high` | `thinking: {"type":"enabled"}` + `reasoning_effort: "high"` | 直接映射。 |
| `xhigh` | `thinking: {"type":"enabled"}` + `reasoning_effort: "max"` | DeepSeek 官方兼容映射为 `max`。 |
| `max` | `thinking: {"type":"enabled"}` + `reasoning_effort: "max"` | 代理扩展值，方便直接指定 DeepSeek 最高档。 |

优先级：

1. 请求中的 `reasoning.effort` 或兼容字段 `reasoning_effort`。
2. 环境变量 `PROXY_REASONING_EFFORT`。
3. 默认值 `high`。

补充规则：

- `PROXY_ENABLE_REASONING=false` 时默认关闭 thinking，除非后续显式设计允许请求覆盖全局开关。
- `PROXY_MINIMAL_REASONING_POLICY=disabled|high` 控制 `minimal` 的降级方式，默认 `disabled`。
- DeepSeek thinking mode 下 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 不生效；代理应在 thinking 启用时忽略这些参数并记录 debug 日志。

## 6. 工具与 MCP 兼容设计

### 6.1 核心原则

Codex 的 skills、MCP、本地命令、文件编辑等能力要保持兼容，关键不是代理去实现这些能力，而是让模型按 Codex 能理解的 Responses tool-call 协议提出调用请求。

因此代理需要维护一张工具映射表：

```text
Responses tool name/type/schema
  -> DeepSeek function name/schema
  -> Responses output call name/type/call_id
```

### 6.2 工具名称规范化

DeepSeek function tool 使用 OpenAI-compatible function name。代理需要保证名称安全、唯一、可逆：

```text
原始名称：mcp.github.search_issues
安全名称：mcp_github_search_issues
```

如果冲突：

```text
mcp_github_search_issues
mcp_github_search_issues__2
```

映射持久化到当前 response 会话：

```json
{
  "mcp_github_search_issues": {
    "original_name": "mcp.github.search_issues",
    "original_type": "function",
    "schema_hash": "..."
  }
}
```

### 6.3 Function tool 转换

Responses function tool：

```json
{
  "type": "function",
  "name": "read_file",
  "description": "Read a file",
  "parameters": {
    "type": "object",
    "properties": { "path": { "type": "string" } },
    "required": ["path"]
  }
}
```

DeepSeek tool：

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read a file",
    "parameters": {
      "type": "object",
      "properties": { "path": { "type": "string" } },
      "required": ["path"]
    }
  }
}
```

### 6.4 MCP 工具

如果 Codex 发来的工具已经是 function schema，代理只做名称和 schema 转换。

如果 Codex 发来的是更高阶的 MCP tool 描述，代理应降级为 function tool：

```json
{
  "type": "function",
  "function": {
    "name": "mcp_linear_get_issue",
    "description": "[MCP: linear] Get issue by id",
    "parameters": { "...": "..." }
  }
}
```

DeepSeek 返回 tool call 后，代理再转回 Responses `function_call`，由 Codex 继续执行对应 MCP 工具。

### 6.5 Skills

Skills 不需要特殊 API。只要 Codex 把 skill 相关指令、资源摘要、工具 schema 放入 Responses request，代理保持顺序和内容即可。

代理不要做这些事：

- 不自行扫描 `SKILL.md`。
- 不把 skill 指令二次改写。
- 不在工具调用前后添加额外安全策略 prompt。

### 6.6 原生工具类型兼容

首选路径是把所有工具降级为 DeepSeek function tools，但返回给 Codex 时必须按“Codex 能分发执行”的格式回放。

因此 `ToolTranslator` 需要记录原始工具类型：

```json
{
  "safe_name": "local_shell",
  "original_name": "shell",
  "original_type": "function",
  "response_output_type": "function_call"
}
```

如果真实 Codex 请求里出现 Responses 原生工具类型，例如 shell、apply_patch、MCP hosted tool，而 Codex 期望的输出 item 不是 `function_call`，则代理需要使用对应的 Responses output item 类型。实现时不要硬编码假设，应该用集成测试抓取 Codex 发给代理的真实 `tools` 和 Codex 能接受的真实 `output`，再补齐 `response_output_type`。

兼容策略：

- 原始工具是 `function`：返回 `function_call`。
- 原始工具是可降级 MCP function schema：返回 `function_call`。
- 原始工具是 Responses 原生 tool：按 Codex 实测需要返回对应原生 call item。
- 无法确认分发格式：返回 501，并在日志中打印原始 tool payload，避免静默失败。

## 7. 响应转换

### 7.1 DeepSeek 非流式响应到 Responses object

DeepSeek 文本响应：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "完成"
      },
      "finish_reason": "stop"
    }
  ]
}
```

代理返回：

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1778240000,
  "status": "completed",
  "model": "deepseek-v4-pro",
  "output": [
    {
      "id": "msg_...",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "完成",
          "annotations": []
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  }
}
```

DeepSeek tool call 响应：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "read_file",
              "arguments": "{\"path\":\"README.md\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

代理返回：

```json
{
  "id": "resp_...",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "id": "fc_...",
      "type": "function_call",
      "status": "completed",
      "call_id": "call_123",
      "name": "read_file",
      "arguments": "{\"path\":\"README.md\"}"
    }
  ]
}
```

Codex 收到 `function_call` 后执行工具，再用 `function_call_output` 发起下一轮 `/v1/responses`。代理将该 output 转回 DeepSeek 的 `role = "tool"` 消息。

注意：上面示例只覆盖普通 function tool。如果原始工具是 Codex/Responses 原生工具类型，代理必须根据第 6.6 节的 `response_output_type` 生成 Codex 可执行的 output item。

### 7.2 Reasoning 内容

DeepSeek 响应里可能出现 `reasoning_content`。处理建议：

- 默认不把完整 reasoning 原样暴露给客户端，避免把内部推理链路当成普通输出。
- 只有当请求显式包含 `reasoning.summary` 时，才生成 Responses `reasoning` item；DeepSeek 只有 `reasoning_content`，没有 OpenAI 的 summarizer，因此只能作为兼容摘要写入 `summary_text` 或留空。
- DeepSeek 的 `reasoning_effort` 可从 Responses `reasoning.effort` 映射，详见第 5.4 节，默认 `high`。
- 如果 DeepSeek 返回了 `tool_calls`，后续轮次的历史消息必须保留该 assistant 消息里的 `reasoning_content`、`content` 和 `tool_calls`，再追加 `role = "tool"` 的工具结果。否则 thinking mode + tools 的多轮链路可能不完整。
- 非工具调用的最终回答默认只把 `content` 转成 `output_text`；`reasoning_content` 仅进入本地状态或调试日志，不作为普通文本输出。

## 8. 流式转换

DeepSeek streaming 返回 Chat Completions chunk；代理需要改写为 Responses SSE。

推荐事件顺序：

```text
event: response.created
data: { "type": "response.created", "response": { ... } }

event: response.output_item.added
data: { "type": "response.output_item.added", "output_index": 0, "item": { ... } }

event: response.content_part.added
data: { "type": "response.content_part.added", "item_id": "msg_...", "content_index": 0, "part": { "type": "output_text", "text": "" } }

event: response.output_text.delta
data: { "type": "response.output_text.delta", "item_id": "msg_...", "content_index": 0, "delta": "..." }

event: response.output_text.done
data: { "type": "response.output_text.done", "item_id": "msg_...", "content_index": 0, "text": "..." }

event: response.output_item.done
data: { "type": "response.output_item.done", "output_index": 0, "item": { ... } }

event: response.completed
data: { "type": "response.completed", "response": { ... } }
```

工具调用流式处理：

- 收到 `delta.tool_calls[].id` 时创建 Responses `function_call` item。
- 收到 `delta.tool_calls[].function.name` 时按映射表还原原始工具名。
- 持续拼接 `delta.tool_calls[].function.arguments`，并按 Responses SSE 发出 `response.function_call_arguments.delta`。
- arguments 完整后发送 `response.function_call_arguments.done`，再发送 `response.output_item.done`。
- DeepSeek `finish_reason = "tool_calls"` 时完成所有未结束的 function_call item，并发送 `response.completed`。
- 不要在 arguments 未完整前提前发起工具调用。

流式实现必须保证：

- SSE header：`Content-Type: text/event-stream`
- 每个事件包含 `event:` 和 `data:`。
- DeepSeek `[DONE]` 不直接透传，应转换为 `response.completed`。
- 断流时返回 `response.failed`，并保存可诊断 error。

## 9. 会话状态

Responses 支持 `previous_response_id`。DeepSeek Chat Completions 不保存服务端会话，所以代理必须保存短期状态。

建议使用 SQLite 或本地文件数据库：

```text
responses
  id
  created_at
  model
  status
  request_json
  response_json
  normalized_messages_json
  reasoning_content_json
  tool_map_json
  expires_at
```

默认策略：

- TTL：24 小时。
- 最大单会话消息体：按 token 或字节限制裁剪。
- 如果 `previous_response_id` 不存在：返回 404，错误类型 `invalid_request_error`。
- 如果请求里带完整历史，可以不依赖 store，直接转换。

## 10. 错误映射

| DeepSeek / 代理错误 | Responses 错误 |
| --- | --- |
| DeepSeek 400 | `invalid_request_error` |
| DeepSeek 401/403 | `authentication_error` |
| DeepSeek 429 | `rate_limit_error` |
| DeepSeek 5xx | `server_error` |
| 网络超时 | `server_error`，可重试 |
| 不支持的 input 类型 | `invalid_request_error` |
| 工具 arguments 不是合法 JSON | `invalid_request_error` 或原样返回给 Codex 让其处理 |
| `previous_response_id` 过期 | `invalid_request_error` |

Responses error object 示例：

```json
{
  "error": {
    "message": "Unsupported input content type: input_image",
    "type": "invalid_request_error",
    "param": "input",
    "code": "unsupported_content_type"
  }
}
```

## 11. 配置项

配置由三层组成：

1. 环境变量：最高优先级，适合覆盖 key、监听地址、配置路径。
2. UI 保存的配置文件：保存多个 provider profile 和 `active_provider`。
3. 内置默认值：首次启动时生成可编辑配置。

建议环境变量：

```bash
PROXY_HOST=127.0.0.1
PROXY_PORT=11434
PROXY_UI_ENABLED=true
PROXY_CONFIG_PATH=.state/config.json
PROXY_SECRETS_PATH=.state/secrets.json
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
PROXY_ACTIVE_PROVIDER=deepseek-v4-pro
PROXY_STATE_PATH=.state/responses-proxy.sqlite
PROXY_STATE_TTL_SECONDS=86400
PROXY_LOG_LEVEL=info
PROXY_MAX_REQUEST_BYTES=20971520
PROXY_REJECT_UNSUPPORTED_MODALITIES=true
PROXY_ENABLE_REASONING=true
PROXY_REASONING_EFFORT=high
PROXY_MINIMAL_REASONING_POLICY=disabled
```

配置优先级规则：

- `PROXY_ACTIVE_PROVIDER` 存在时覆盖 UI 中的 `active_provider`。
- `DEEPSEEK_API_KEY` 存在时覆盖 active DeepSeek provider 的本地 secret。
- UI 保存配置时不覆盖环境变量，只写入 `PROXY_CONFIG_PATH` 和 `PROXY_SECRETS_PATH`。
- `/api/config` 返回合并后的有效配置，同时标记字段来源：`env`、`file`、`default`。

## 12. 推荐实现技术栈

这个代理是 I/O 密集型服务，推荐 TypeScript 或 Go。

TypeScript 方案：

- Runtime：Node.js 22+
- HTTP：Fastify
- UI：首期用原生 HTML/CSS/TypeScript，后续需要复杂交互时再引入 Vite
- DeepSeek 调用：原生 `fetch`
- Schema：Zod
- Store：SQLite + better-sqlite3
- Stream：Web Streams / Node Readable
- 测试：Vitest

目录结构：

```text
openapi-proxy/
  package.json
  src/
    server.ts
    config.ts
    routes/
      config.ts
      health.ts
      models.ts
      responses.ts
    config/
      config-store.ts
      provider-resolver.ts
      secrets-store.ts
    translators/
      responses-to-chat.ts
      chat-to-responses.ts
      stream.ts
      tools.ts
    state/
      store.ts
      sqlite-store.ts
    deepseek/
      client.ts
      errors.ts
    types/
      config.ts
      responses.ts
      deepseek.ts
  ui/
    index.html
    src/
      main.ts
      api.ts
  test/
    fixtures/
    config-store.test.ts
    responses-to-chat.test.ts
    chat-to-responses.test.ts
    stream.test.ts
```

## 13. 关键流程伪代码

```ts
async function createResponse(req: ResponsesCreateRequest): Promise<Response | SSE> {
  const provider = await providerResolver.resolve(req.model);
  const state = req.previous_response_id
    ? await store.get(req.previous_response_id)
    : undefined;

  const toolMap = buildToolMap(req.tools ?? [], state?.toolMap);
  const messages = normalizeResponsesInput({
    instructions: req.instructions,
    input: req.input,
    previousMessages: state?.messages ?? [],
    toolMap,
  });

  const chatRequest = toDeepSeekChatRequest({
    model: provider.model,
    request: req,
    messages,
    toolMap,
    reasoning: provider.reasoning,
  });

  if (req.stream) {
    const deepseekStream = await deepseek.streamChat(provider, chatRequest);
    return streamDeepSeekAsResponses(deepseekStream, { req, messages, toolMap });
  }

  const chatResponse = await deepseek.createChatCompletion(provider, chatRequest);
  const response = fromDeepSeekChatResponse(chatResponse, { req, messages, toolMap });
  await store.save(response.id, response, messages, toolMap);
  return response;
}
```

## 14. 测试清单

基础兼容：

- `input` 为字符串时能返回 Responses object。
- `input` 为 message array 时保持 role 和顺序。
- `instructions` 会前置为 system。
- `previous_response_id` 能正确拼接历史。
- `/v1/models` 能被 Codex 读取。
- `/api/config` 能读取多个 provider 配置并返回 active provider。
- `PUT /api/config` 能保存 provider 修改。
- `POST /api/config/active-provider` 能切换当前 provider。
- UI 切换 provider 后，下一次 `/v1/responses` 使用新的 provider。
- `reasoning.effort = low/medium/high` 转发为 DeepSeek `high`。
- `reasoning.effort = xhigh/max` 转发为 DeepSeek `max`。
- `reasoning.effort = none` 能关闭 DeepSeek thinking。

工具调用：

- 单个 function tool 能从 Responses 转 DeepSeek，再转回 Responses `function_call`。
- 多个并行 tool calls 能保持 call_id、name、arguments。
- tool name 包含点号、斜杠、冒号时能安全映射并还原。
- `function_call_output` 能转为 DeepSeek `role = "tool"`。
- thinking mode 下 tool call 后续轮次能保留 `reasoning_content`。
- MCP 风格工具 schema 能降级为 function tool。

流式：

- 普通文本流能发出 `response.output_text.delta`。
- tool call arguments 分片能正确拼接。
- DeepSeek `[DONE]` 能转换为 `response.completed`。
- 中途异常能发出 `response.failed`。

Codex 集成：

- Codex 能完成普通问答。
- Codex 能读取文件。
- Codex 能调用 shell。
- Codex 能调用 apply_patch。
- Codex 能调用已配置 MCP 工具。
- 使用 skill 后，请求上下文能被 DeepSeek 正常理解。

## 15. 首期边界

首期只承诺：

- 文本输入输出。
- Responses `/v1/responses` 基础对象。
- 流式文本。
- Function tool calling。
- MCP/本地工具通过 function tool 兼容。
- `previous_response_id` 短期状态。
- 本地配置 UI：查看、修改、保存多个 provider，并切换 active provider。

首期不承诺：

- OpenAI 内置 web_search/file_search/computer_use 在 DeepSeek 服务端执行。
- 图片、音频、文件二进制输入。
- 完整 Responses API 全量字段。
- OpenAI hosted tools 的等价能力。
- DeepSeek reasoning 完整链路暴露。
- 复杂用户权限、团队协作、远程配置中心。

## 16. 实施顺序

1. 搭建 HTTP 服务与配置加载。
2. 实现 `ConfigStore`、`SecretsStore`、`ProviderResolver`。
3. 实现本地配置 UI 和 `/api/config` 系列接口。
4. 实现 `/health`、`/v1/models`。
5. 实现非流式 `/v1/responses` 文本转换。
6. 增加 `StateStore` 和 `previous_response_id`。
7. 实现 function tools 转换与 tool call 返回。
8. 实现 `function_call_output` 下一轮转换。
9. 实现 SSE 流式文本。
10. 实现 SSE 流式 tool call。
11. 接入 Codex 本地配置做真实集成测试。
12. 补齐错误映射、日志、超时、请求大小限制。

## 17. 结论

可行方案不是让 DeepSeek “支持 Responses API”，而是在本地代理中实现 Responses-to-ChatCompletions 的协议适配层。只要代理正确处理 `input`、`tools`、`function_call`、`function_call_output`、`previous_response_id` 和 SSE 事件，Codex 的 skills、MCP、本地工具能力就可以继续由 Codex 自身执行，DeepSeek V4 Pro 只负责模型推理和决定下一步工具调用。
