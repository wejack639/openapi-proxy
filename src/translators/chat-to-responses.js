import crypto from "node:crypto";
import { restoreToolCall } from "./tools.js";

export function chatResponseToResponses({ chatResponse, provider, request, messages, toolMap, emitReasoningSummary = false }) {
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const choice = chatResponse.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  if (emitReasoningSummary && message.reasoning_content) {
    output.push(createReasoningItem(message.reasoning_content));
  }

  if (message.content) {
    output.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: []
        }
      ]
    });
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      output.push({
        id: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
        ...restoreToolCall(toolCall, toolMap)
      });
    }
  } else if (!message.content) {
    output.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: message.content || "",
          annotations: []
        }
      ]
    });
  }

  const response = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model: request.model || provider.id,
    output,
    usage: mapUsage(chatResponse.usage)
  };

  const assistantMessage = {
    role: "assistant",
    content: message.content ?? null
  };
  if (message.reasoning_content) {
    assistantMessage.reasoning_content = message.reasoning_content;
  }
  if (message.tool_calls) {
    assistantMessage.tool_calls = message.tool_calls;
  }

  return {
    response,
    stateEntry: {
      provider_id: provider.id,
      response,
      request: redactRequest(request),
      messages: [...messages, assistantMessage],
      toolMap,
      reasoning_content: message.reasoning_content || null
    }
  };
}

export function createReasoningItem(text, { status = "completed" } = {}) {
  return {
    id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "reasoning",
    status,
    summary: [{ type: "summary_text", text }]
  };
}

export function errorToResponsesError(error) {
  return {
    error: {
      message: error.message || "Proxy error",
      type: error.type || mapErrorType(error.status),
      param: error.param || null,
      code: error.code || null
    }
  };
}

export function mapUsage(usage = {}) {
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

function mapErrorType(status) {
  if (status === 401 || status === 403) {
    return "authentication_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status >= 500) {
    return "server_error";
  }
  return "invalid_request_error";
}

function redactRequest(request) {
  const copy = structuredClone(request);
  delete copy.api_key;
  return copy;
}
