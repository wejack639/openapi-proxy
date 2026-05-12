import { filterDeepSeekPayload } from "./deepseek-payload.js";
import { mapReasoning } from "./reasoning.js";
import { buildToolMap, mapToolChoice } from "./tools.js";

const UNSUPPORTED_PARTS = new Set(["input_image", "input_file", "input_audio"]);

export function responsesToChatRequest({ request, provider, previousState }) {
  const previousMessages = shouldUsePreviousMessages(request) ? previousState?.messages || [] : [];
  const { toolMap, deepseekTools, skippedTools } = buildToolMap(request.tools || [], previousState?.toolMap || {});
  const reasoning = mapReasoning(request, provider);
  const messages = normalizeMessages({
    instructions: request.instructions,
    input: request.input,
    previousMessages,
    toolCallMessagesById: previousState?.tool_call_messages_by_id || buildToolCallMessageIndex(previousState?.messages),
    requireReasoningForToolCalls: reasoning.enabled
  });

  const body = {
    model: provider.model,
    messages,
    stream: Boolean(request.stream)
  };
  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  if (deepseekTools.length > 0) {
    body.tools = deepseekTools;
    body.tool_choice = mapDeepSeekToolChoice(request.tool_choice || "auto", toolMap, reasoning);
  }
  if (request.parallel_tool_calls !== undefined) {
    body.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (request.max_output_tokens !== undefined) {
    body.max_tokens = request.max_output_tokens;
  }
  if (request.stop !== undefined) {
    body.stop = request.stop;
  }

  Object.assign(body, pickSamplingParams(request, reasoning));
  Object.assign(body, reasoning.enabled ? {
    thinking: reasoning.thinking,
    reasoning_effort: reasoning.reasoning_effort
  } : {
    thinking: reasoning.thinking
  });

  return {
    body: filterDeepSeekPayload(body),
    messages,
    toolMap,
    skippedTools,
    reasoning
  };
}

export function normalizeMessages({
  instructions,
  input,
  previousMessages = [],
  toolCallMessagesById = {},
  requireReasoningForToolCalls = false
}) {
  const messages = [];
  const emittedHydratedCallIds = new Set();
  let pendingToolCalls = [];

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) {
      return;
    }
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls
    });
    pendingToolCalls = [];
  };

  if (instructions) {
    messages.push({ role: "system", content: stringifyContent(instructions) });
  }
  messages.push(...previousMessages);

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return sanitizeToolCallHistory(messages, { requireReasoningForToolCalls });
  }

  for (const item of input || []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "message" || item.role) {
      flushPendingToolCalls();
      messages.push({
        role: mapRole(item.role || "user"),
        content: stringifyContent(item.content)
      });
      continue;
    }
    if (item.type === "function_call_output") {
      flushPendingToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: stringifyContent(item.output)
      });
      continue;
    }
    if (item.type === "function_call") {
      const callId = item.call_id || item.id;
      if (!callId) {
        continue;
      }
      const hydrated = toolCallMessagesById[callId];
      if (hydrated) {
        flushPendingToolCalls();
        const hydratedCallIds = (hydrated.tool_calls || []).map((toolCall) => toolCall.id);
        if (!hydratedCallIds.some((id) => emittedHydratedCallIds.has(id))) {
          messages.push(structuredClone(hydrated));
          for (const id of hydratedCallIds) {
            emittedHydratedCallIds.add(id);
          }
        }
        continue;
      }
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments || "{}"
        }
      });
    }
  }

  flushPendingToolCalls();
  return sanitizeToolCallHistory(messages, { requireReasoningForToolCalls });
}

function shouldUsePreviousMessages(request) {
  if (request.previous_response_id) {
    return true;
  }
  if (!Array.isArray(request.input)) {
    return true;
  }
  return !request.input.some((item) => item?.type === "function_call");
}

function buildToolCallMessageIndex(messages = []) {
  const index = {};
  for (const message of messages || []) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      if (toolCall?.id) {
        index[toolCall.id] = structuredClone(message);
      }
    }
  }
  return index;
}

export function mapDeepSeekToolChoice(toolChoice, toolMap, reasoning) {
  const mapped = mapToolChoice(toolChoice, toolMap);
  if (!reasoning?.enabled || mapped === "auto" || mapped === "none") {
    return mapped;
  }
  return "auto";
}

export function stringifyContent(content) {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return typeof content === "object" ? JSON.stringify(content) : String(content);
  }
  const parts = [];
  for (const part of content) {
    if (UNSUPPORTED_PARTS.has(part.type)) {
      const error = new Error(`Unsupported input content type: ${part.type}`);
      error.status = 400;
      error.code = "unsupported_content_type";
      error.param = "input";
      throw error;
    }
    if (part.text !== undefined) {
      parts.push(String(part.text));
    } else if (part.output !== undefined) {
      parts.push(stringifyContent(part.output));
    }
  }
  return parts.join("\n\n");
}

function mapRole(role) {
  if (role === "developer") {
    return "system";
  }
  return role || "user";
}

export function sanitizeToolCallHistory(messages, { requireReasoningForToolCalls = false } = {}) {
  const sanitized = [];
  const consumed = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const message = messages[index];
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const callIds = new Set(message.tool_calls.map((toolCall) => toolCall.id));
      const toolById = new Map();

      for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
        if (consumed.has(cursor)) {
          continue;
        }
        const candidate = messages[cursor];
        if (candidate.role === "tool") {
          if (callIds.has(candidate.tool_call_id)) {
            toolById.set(candidate.tool_call_id, candidate);
            consumed.add(cursor);
            if (toolById.size === callIds.size) {
              break;
            }
          }
          continue;
        }
      }

      if (requireReasoningForToolCalls && !message.reasoning_content) {
        for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
          if (consumed.has(cursor)) {
            continue;
          }
          const candidate = messages[cursor];
          if (candidate.role === "tool" && callIds.has(candidate.tool_call_id)) {
            consumed.add(cursor);
          }
        }
        continue;
      }

      const matchedCalls = message.tool_calls.filter((toolCall) => toolById.has(toolCall.id));
      const matchedTools = matchedCalls.map((toolCall) => toolById.get(toolCall.id));

      if (matchedCalls.length > 0) {
        sanitized.push({
          ...message,
          tool_calls: matchedCalls
        });
        sanitized.push(...matchedTools);
      }

      continue;
    }

    if (message.role === "tool") {
      continue;
    }

    sanitized.push(message);
  }
  return sanitized;
}

function pickSamplingParams(request, reasoning) {
  if (reasoning.enabled) {
    return {};
  }
  const params = {};
  for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
    if (request[key] !== undefined) {
      params[key] = request[key];
    }
  }
  return params;
}
