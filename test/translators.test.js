import assert from "node:assert/strict";
import test from "node:test";
import { chatResponseToResponses } from "../src/translators/chat-to-responses.js";
import { filterDeepSeekPayload } from "../src/translators/deepseek-payload.js";
import { mapReasoning } from "../src/translators/reasoning.js";
import { mapDeepSeekToolChoice, responsesToChatRequest, sanitizeToolCallHistory } from "../src/translators/responses-to-chat.js";
import { translateDeepSeekChunksToResponses } from "../src/translators/stream.js";

const provider = {
  id: "deepseek-v4-pro-max",
  model: "deepseek-v4-pro",
  reasoning: { enabled: true, effort: "max", minimal_policy: "disabled" }
};

test("maps OpenAI/Codex reasoning values to DeepSeek thinking values", () => {
  assert.deepEqual(mapReasoning({ reasoning: { effort: "xhigh" } }, provider).reasoning_effort, "max");
  assert.deepEqual(mapReasoning({ reasoning: { effort: "medium" } }, provider).reasoning_effort, "high");
  assert.equal(mapReasoning({ reasoning: { effort: "none" } }, provider).thinking.type, "disabled");
  assert.equal(mapReasoning({ reasoning: { effort: "minimal" } }, provider).thinking.type, "disabled");
});

test("converts Responses input and tools to DeepSeek chat request", () => {
  const request = {
    model: "deepseek-v4-pro",
    instructions: "Be concise",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Read README" }]
      }
    ],
    tools: [
      {
        type: "function",
        name: "mcp.github.search_issues",
        description: "Search issues",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
      }
    ],
    reasoning: { effort: "xhigh" }
  };

  const chat = responsesToChatRequest({ request, provider });
  assert.equal(chat.body.model, "deepseek-v4-pro");
  assert.deepEqual(chat.body.messages.slice(0, 2), [
    { role: "system", content: "Be concise" },
    { role: "user", content: "Read README" }
  ]);
  assert.equal(chat.body.reasoning_effort, "max");
  assert.equal(chat.body.tools[0].function.name, "mcp_github_search_issues");
  assert.equal(chat.toolMap.mcp_github_search_issues.original_name, "mcp.github.search_issues");
});

test("reuses existing safe tool names instead of creating duplicate suffixed tools", () => {
  const request = {
    input: "call tool",
    tools: [
      {
        type: "function",
        name: "CallMcpTool",
        parameters: {
          type: "object",
          properties: { server: { type: "string" }, toolName: { type: "string" } },
          required: ["server", "toolName"]
        }
      }
    ]
  };
  const previousState = {
    toolMap: {
      CallMcpTool: {
        original_name: "CallMcpTool",
        original_type: "function",
        response_output_type: "function_call",
        schema_hash: JSON.stringify(request.tools[0].parameters)
      }
    },
    messages: []
  };
  const chat = responsesToChatRequest({ request, provider, previousState });
  assert.equal(chat.body.tools.length, 1);
  assert.equal(chat.body.tools[0].function.name, "CallMcpTool");
  assert.equal(chat.toolMap.CallMcpTool__2, undefined);
});

test("maps required tool_choice and keeps DeepSeek tool names within 64 characters", () => {
  const longName = "mcp." + "very.long.tool.name.".repeat(5) + "read_file";
  const chat = responsesToChatRequest({
    request: {
      input: "call tool",
      stream: true,
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: longName,
          description: "Long tool name",
          strict: true,
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      ]
    },
    provider: { ...provider, reasoning: { enabled: false } }
  });

  const toolName = chat.body.tools[0].function.name;
  assert.equal(chat.body.tool_choice, "required");
  assert.equal(chat.body.stream_options.include_usage, true);
  assert.equal(chat.body.tools[0].function.strict, true);
  assert.equal(toolName.length <= 64, true);
  assert.equal(chat.toolMap[toolName].original_name, longName);
});

test("filters hosted Responses tools that DeepSeek Chat cannot execute", () => {
  const chat = responsesToChatRequest({
    request: {
      input: "search later",
      tools: [
        { type: "web_search_preview", name: "web_search" },
        { type: "file_search", name: "file_search" },
        { type: "custom", name: "custom_tool", parameters: { type: "object", properties: {} } }
      ]
    },
    provider
  });
  assert.equal(chat.body.tools.length, 1);
  assert.equal(chat.body.tools[0].function.name, "custom_tool");
  assert.deepEqual(chat.skippedTools.map((tool) => tool.type), ["web_search_preview", "file_search"]);
});

test("filters DeepSeek payload down to documented Chat fields", () => {
  const filtered = filterDeepSeekPayload({
    model: "deepseek-v4-pro",
    messages: [],
    stream: false,
    stream_options: { should: "drop when not set by translator" },
    metadata: { should: "drop" },
    client_metadata: { should: "drop" },
    previous_response_id: "resp_1",
    reasoning_effort: "high"
  });
  assert.deepEqual(Object.keys(filtered).sort(), ["messages", "model", "reasoning_effort", "stream", "stream_options"]);
});

test("handles null payload and null previous tool map defensively", () => {
  assert.deepEqual(filterDeepSeekPayload(null), {});
  const chat = responsesToChatRequest({
    request: {
      input: "hello",
      tools: [{ type: "function", name: "read.file", parameters: { type: "object", properties: {} } }],
      tool_choice: "read.file"
    },
    provider: { ...provider, reasoning: { enabled: false } },
    previousState: { toolMap: null, messages: [] }
  });
  assert.equal(chat.body.tools[0].function.name, "read_file");
  assert.equal(chat.body.tool_choice.function.name, "read_file");
});

test("downgrades forced tool_choice to auto in DeepSeek thinking mode", () => {
  assert.equal(
    mapDeepSeekToolChoice(
      { type: "function", function: { name: "read.file" } },
      { read_file: { original_name: "read.file" } },
      { enabled: true }
    ),
    "auto"
  );
  assert.deepEqual(
    mapDeepSeekToolChoice(
      { type: "function", function: { name: "read.file" } },
      { read_file: { original_name: "read.file" } },
      { enabled: false }
    ),
    { type: "function", function: { name: "read_file" } }
  );
});

test("converts function_call_output into DeepSeek tool message", () => {
  const chat = responsesToChatRequest({
    request: {
      input: [{ type: "function_call_output", call_id: "call_1", output: { ok: true } }]
    },
    provider,
    previousState: {
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "thinking trace from DeepSeek",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
            }
          ]
        }
      ]
    }
  });
  assert.deepEqual(chat.body.messages, [
    {
      role: "assistant",
      content: null,
      reasoning_content: "thinking trace from DeepSeek",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" }
  ]);
});

test("groups consecutive Responses function_call items before tool outputs", () => {
  const chat = responsesToChatRequest({
    request: {
      input: [
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
        { type: "function_call", call_id: "call_2", name: "list_files", arguments: "{\"path\":\".\"}" },
        { type: "function_call_output", call_id: "call_1", output: "a" },
        { type: "function_call_output", call_id: "call_2", output: "b" }
      ]
    },
    provider: { ...provider, reasoning: { enabled: false } }
  });

  assert.deepEqual(chat.body.messages, [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
        { id: "call_2", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "a" },
    { role: "tool", tool_call_id: "call_2", content: "b" }
  ]);
});

test("drops previous dangling tool calls before a new string input", () => {
  const chat = responsesToChatRequest({
    request: { input: "continue without tool output" },
    provider: { ...provider, reasoning: { enabled: false } },
    previousState: {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_missing", type: "function", function: { name: "read_file", arguments: "{}" } }
          ]
        }
      ]
    }
  });

  assert.deepEqual(chat.body.messages, [{ role: "user", content: "continue without tool output" }]);
});

test("drops dangling assistant tool_calls that are not followed by tool messages", () => {
  const messages = sanitizeToolCallHistory([
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{}" }
        }
      ]
    },
    { role: "user", content: "next" }
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "first" },
    { role: "user", content: "next" }
  ]);
});

test("keeps assistant tool_calls when matching tool messages are present", () => {
  const messages = sanitizeToolCallHistory([
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
    { role: "user", content: "next" }
  ]);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[3].content, "next");
});

test("repairs side-channel messages inserted between tool_calls and tool outputs", () => {
  const messages = sanitizeToolCallHistory([
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{}" }
        }
      ]
    },
    { role: "system", content: "side channel" },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
    { role: "user", content: "next" }
  ]);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[3].role, "system");
  assert.equal(messages[4].content, "next");
});

test("repairs user messages inserted before matching tool outputs", () => {
  const messages = sanitizeToolCallHistory([
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "thinking trace from DeepSeek",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{}" }
        }
      ]
    },
    { role: "user", content: "side message from client" },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
    { role: "user", content: "next" }
  ]);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].reasoning_content, "thinking trace from DeepSeek");
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[3].content, "side message from client");
  assert.equal(messages[4].content, "next");
});

test("prefers stored assistant reasoning when client replays function_call items", () => {
  const chat = responsesToChatRequest({
    request: {
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "read.file",
          arguments: "{\"path\":\"README.md\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "ok"
        }
      ]
    },
    provider,
    previousState: {
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "thinking trace from DeepSeek",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
            }
          ]
        }
      ]
    }
  });
  assert.deepEqual(chat.body.messages, [
    {
      role: "assistant",
      content: null,
      reasoning_content: "thinking trace from DeepSeek",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" }
  ]);
});

test("drops client-replayed naked tool history in DeepSeek thinking mode", () => {
  const chat = responsesToChatRequest({
    request: {
      input: [
        {
          type: "function_call",
          call_id: "old_call",
          name: "read.file",
          arguments: "{}"
        },
        {
          type: "function_call_output",
          call_id: "old_call",
          output: "old output"
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read.file",
          arguments: "{\"path\":\"README.md\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "ok"
        }
      ]
    },
    provider,
    previousState: {
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "thinking trace from DeepSeek",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
            }
          ]
        }
      ]
    }
  });
  assert.deepEqual(chat.body.messages, [
    {
      role: "assistant",
      content: null,
      reasoning_content: "thinking trace from DeepSeek",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" }
  ]);
});

test("hydrates replayed function_call items from stored reasoning messages", () => {
  const chat = responsesToChatRequest({
    request: {
      input: [
        { type: "message", role: "user", content: "read descriptor" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "Read",
          arguments: "{\"path\":\"tool.json\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"ok\":true}"
        }
      ]
    },
    provider,
    previousState: {
      tool_call_messages_by_id: {
        call_1: {
          role: "assistant",
          content: "I will read it.",
          reasoning_content: "stored thinking",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{\"path\":\"tool.json\"}" }
            }
          ]
        }
      },
      messages: [
        {
          role: "assistant",
          content: "old duplicated state should not be prepended",
          reasoning_content: "old",
          tool_calls: [
            {
              id: "old_call",
              type: "function",
              function: { name: "Read", arguments: "{}" }
            }
          ]
        }
      ]
    }
  });

  assert.deepEqual(chat.body.messages, [
    { role: "user", content: "read descriptor" },
    {
      role: "assistant",
      content: "I will read it.",
      reasoning_content: "stored thinking",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"tool.json\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" }
  ]);
});

test("converts DeepSeek tool calls back to Responses function_call items", () => {
  const translated = chatResponseToResponses({
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {
      read_file: { original_name: "read.file", response_output_type: "function_call" }
    },
    chatResponse: {
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    }
  });

  assert.equal(translated.response.output[0].type, "function_call");
  assert.equal(translated.response.output[0].name, "read.file");
  assert.equal(translated.response.output[0].call_id, "call_123");
  assert.equal(translated.stateEntry.messages[0].tool_calls[0].id, "call_123");
});

test("preserves non-streaming text preamble when DeepSeek also returns tool calls", () => {
  const translated = chatResponseToResponses({
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {
      read_file: { original_name: "read.file", response_output_type: "function_call" }
    },
    chatResponse: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "I will call the tool.",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: { name: "read_file", arguments: "{}" }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    }
  });

  assert.deepEqual(translated.response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(translated.response.output[0].content[0].text, "I will call the tool.");
  assert.equal(translated.stateEntry.messages[0].content, "I will call the tool.");
});

test("can map DeepSeek reasoning_content to a requested Responses reasoning summary item", () => {
  const translated = chatResponseToResponses({
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {},
    emitReasoningSummary: true,
    chatResponse: {
      choices: [
        {
          message: {
            role: "assistant",
            reasoning_content: "I am thinking.",
            content: "Done"
          },
          finish_reason: "stop"
        }
      ]
    }
  });

  assert.equal(translated.response.output[0].type, "reasoning");
  assert.equal(translated.response.output[0].summary[0].text, "I am thinking.");
  assert.equal(translated.response.output[0].content, undefined);
  assert.equal(translated.response.output[1].type, "message");
});

test("translates DeepSeek streaming chunks to Responses SSE event payloads", async () => {
  async function* chunks() {
    yield { choices: [{ delta: { role: "assistant" } }] };
    yield { choices: [{ delta: { content: "Hello" } }] };
    yield { choices: [{ delta: { content: " world" }, finish_reason: "stop" }], usage: null };
    yield { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
  }
  const result = await translateDeepSeekChunksToResponses(chunks(), {
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {}
  });
  assert.equal(result.response.status, "completed");
  assert.equal(result.response.output[0].content[0].text, "Hello world");
  assert.equal(result.response.usage.input_tokens, 2);
  assert.equal(result.events.at(-1).event, "response.completed");
  assert.deepEqual(result.events.map((entry) => entry.payload.sequence_number), result.events.map((_, index) => index + 1));
});

test("keeps separate output item id and call_id for streamed tool calls", async () => {
  async function* chunks() {
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\"" }
              }
            ]
          }
        }
      ]
    };
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: ":\"README.md\"}" }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    };
  }
  const result = await translateDeepSeekChunksToResponses(chunks(), {
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: { read_file: { original_name: "read.file", response_output_type: "function_call" } }
  });
  const item = result.response.output[0];
  assert.equal(item.type, "function_call");
  assert.equal(item.call_id, "call_abc");
  assert.equal(item.name, "read.file");
  assert.notEqual(item.id, item.call_id);
  assert.equal(item.arguments, "{\"path\":\"README.md\"}");
  const added = result.events.find((entry) => entry.event === "response.output_item.added");
  assert.equal(added.payload.item.arguments, "");
  const reconstructedArguments = [
    added.payload.item.arguments,
    ...result.events
      .filter((entry) => entry.event === "response.function_call_arguments.delta")
      .map((entry) => entry.payload.delta)
  ].join("");
  assert.equal(reconstructedArguments, item.arguments);
  assert.deepEqual(JSON.parse(reconstructedArguments), { path: "README.md" });
  assert.deepEqual(
    result.events
      .filter((entry) => entry.event === "response.function_call_arguments.delta")
      .map((entry) => ({
        call_id: entry.payload.call_id,
        name: entry.payload.name,
        delta: entry.payload.delta
      })),
    [
      { call_id: "call_abc", name: "read.file", delta: "{\"path\"" },
      { call_id: "call_abc", name: "read.file", delta: ":\"README.md\"}" }
    ]
  );
  const done = result.events.find((entry) => entry.event === "response.function_call_arguments.done");
  assert.equal(done.payload.call_id, "call_abc");
  assert.equal(done.payload.name, "read.file");
});

test("streams same tool index from multiple choices as distinct Responses items", async () => {
  async function* chunks() {
    yield {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_choice0",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\":\"a\"}" }
              }
            ]
          }
        },
        {
          index: 1,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_choice1",
                type: "function",
                function: { name: "list_files", arguments: "{\"path\":\".\"}" }
              }
            ]
          }
        }
      ]
    };
  }
  const result = await translateDeepSeekChunksToResponses(chunks(), {
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {
      read_file: { original_name: "read.file", response_output_type: "function_call" },
      list_files: { original_name: "list.files", response_output_type: "function_call" }
    }
  });

  assert.deepEqual(result.response.output.map((item) => item.call_id), ["call_choice0", "call_choice1"]);
  assert.deepEqual(result.response.output.map((item) => item.name), ["read.file", "list.files"]);
  assert.deepEqual(
    result.events
      .filter((entry) => entry.event === "response.function_call_arguments.delta")
      .map((entry) => entry.payload.call_id),
    ["call_choice0", "call_choice1"]
  );
  assert.deepEqual(
    result.events
      .filter((entry) => entry.event === "response.output_item.added")
      .map((entry) => entry.payload.output_index),
    [0, 1]
  );
});

test("preserves streamed text preamble when DeepSeek also returns tool calls", async () => {
  async function* chunks() {
    yield { choices: [{ delta: { content: "I will call the tool." } }] };
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "read_file", arguments: "{}" }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    };
  }
  const result = await translateDeepSeekChunksToResponses(chunks(), {
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: { read_file: { original_name: "read.file", response_output_type: "function_call" } }
  });
  assert.deepEqual(result.response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(result.response.output[0].content[0].text, "I will call the tool.");
  assert.equal(result.stateEntry.messages[0].content, "I will call the tool.");
});

test("suppresses adjacent duplicate streamed text blocks", async () => {
  async function* chunks() {
    yield { choices: [{ delta: { content: "list_namespaces 成功。再看一下 Pod。\n\n" } }] };
    yield { choices: [{ delta: { content: "list_namespaces 成功。再看一下 Pod。\n\n" } }] };
    yield { choices: [{ delta: { content: "list_namespaces 成功。再看一下 Pod。\n\n" } }] };
    yield { choices: [{ delta: { content: "下一步。" } }] };
  }
  const result = await translateDeepSeekChunksToResponses(chunks(), {
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {}
  });

  assert.equal(result.response.output[0].content[0].text, "list_namespaces 成功。再看一下 Pod。\n\n下一步。");
  assert.equal(
    result.events
      .filter((entry) => entry.event === "response.output_text.delta")
      .map((entry) => entry.payload.delta)
      .join(""),
    "list_namespaces 成功。再看一下 Pod。\n\n下一步。"
  );
});

test("keeps adjacent streamed text blocks when a later block only shares a prefix", async () => {
  async function* chunks() {
    yield { choices: [{ delta: { content: "Alpha paragraph.\n\n" } }] };
    yield { choices: [{ delta: { content: "Alphabet soup." } }] };
  }
  const result = await translateDeepSeekChunksToResponses(chunks(), {
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {}
  });

  assert.equal(result.response.output[0].content[0].text, "Alpha paragraph.\n\nAlphabet soup.");
});

test("streams requested DeepSeek reasoning as Responses reasoning summary events", async () => {
  async function* chunks() {
    yield { choices: [{ delta: { reasoning_content: "Think " } }] };
    yield { choices: [{ delta: { reasoning_content: "more." } }] };
    yield { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] };
  }
  const result = await translateDeepSeekChunksToResponses(chunks(), {
    provider,
    request: { model: "deepseek-v4-pro" },
    messages: [],
    toolMap: {},
    emitReasoningSummary: true
  });
  assert.equal(result.response.output[0].type, "reasoning");
  assert.equal(result.response.output[0].summary[0].text, "Think more.");
  assert.equal(result.response.output[0].content, undefined);
  assert.equal(result.response.output[1].type, "message");
  assert.ok(result.events.some((entry) => entry.event === "response.reasoning_summary_text.delta"));
  assert.ok(result.events.some((entry) => entry.event === "response.reasoning_summary_text.done"));
  assert.equal(result.events.some((entry) => entry.event === "response.reasoning_text.delta"), false);
});
