export class ResponsesStateMachine {
  constructor(responseStore) {
    this.responseStore = responseStore;
  }

  async ingestRequest(request) {
    const toolOutputIds = collectToolOutputIds(request.input);
    const previousState =
      (await this.loadPreviousState(request.previous_response_id)) ||
      (await this.findPreviousStateByToolOutputs(toolOutputIds));
    this.validateToolOutputs(request, previousState, { strict: Boolean(request.previous_response_id) });
    return {
      previousState,
      pendingToolCalls: previousState?.pending_tool_calls || []
    };
  }

  async commitResponse(response, stateEntry) {
    const pendingToolCalls = extractPendingToolCalls(response);
    await this.responseStore.save(response.id, {
      ...stateEntry,
      pending_tool_calls: pendingToolCalls
    });
  }

  async getResponse(responseId) {
    return this.responseStore.get(responseId);
  }

  async clear() {
    await this.responseStore.clear();
  }

  async loadPreviousState(previousResponseId) {
    if (!previousResponseId) {
      return null;
    }
    const previousState = await this.responseStore.get(previousResponseId);
    if (!previousState) {
      const error = new Error(`previous_response_id not found: ${previousResponseId}`);
      error.status = 404;
      error.code = "previous_response_not_found";
      throw error;
    }
    return previousState;
  }

  async findPreviousStateByToolOutputs(toolOutputIds) {
    if (toolOutputIds.length === 0 || typeof this.responseStore.findByPendingToolCallIds !== "function") {
      return null;
    }
    if (typeof this.responseStore.findAllByPendingToolCallIds !== "function") {
      return this.responseStore.findByPendingToolCallIds(toolOutputIds);
    }
    const states = await this.responseStore.findAllByPendingToolCallIds(toolOutputIds);
    if (states.length === 0) {
      return null;
    }
    return {
      ...states[0],
      matched_tool_states: states,
      tool_call_messages_by_id: buildToolCallMessageIndex(states)
    };
  }

  validateToolOutputs(request, previousState, { strict = true } = {}) {
    const toolOutputIds = collectToolOutputIds(request.input);
    if (toolOutputIds.length === 0) {
      return;
    }

    const pendingIds = new Set((previousState?.pending_tool_calls || []).map((call) => call.call_id));
    if (pendingIds.size === 0) {
      return;
    }

    const unknownIds = toolOutputIds.filter((callId) => !pendingIds.has(callId));
    if (strict && unknownIds.length > 0) {
      const error = new Error(`Tool output does not match pending tool call: ${unknownIds.join(", ")}`);
      error.status = 400;
      error.code = "tool_output_without_pending_call";
      throw error;
    }
  }
}

function buildToolCallMessageIndex(states = []) {
  const index = {};
  for (const state of states.slice().reverse()) {
    for (const message of state.messages || []) {
      if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
        continue;
      }
      for (const toolCall of message.tool_calls) {
        if (toolCall?.id) {
          index[toolCall.id] = structuredClone(message);
        }
      }
    }
  }
  return index;
}

export function extractPendingToolCalls(response) {
  return (response.output || [])
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments || "{}"
    }));
}

export function collectToolOutputIds(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item) => item?.type === "function_call_output" && item.call_id)
    .map((item) => item.call_id);
}
