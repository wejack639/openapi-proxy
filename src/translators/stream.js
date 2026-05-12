import crypto from "node:crypto";
import { restoreToolCall } from "./tools.js";
import { createReasoningItem, mapUsage } from "./chat-to-responses.js";

export async function writeDeepSeekStreamAsResponses({
  deepseekResponse,
  res,
  provider,
  request,
  messages,
  toolMap,
  emitReasoningSummary = false,
  responseStore,
  onRawChunk
}) {
  const chunks = parseSseStream(deepseekResponse.body);
  const writer = createResponsesStreamWriter(res);
  const result = await translateDeepSeekChunksToResponses(chunks, {
    provider,
    request,
    messages,
    toolMap,
    emitReasoningSummary,
    onRawChunk
  }, writer);
  if (typeof responseStore.commitResponse === "function") {
    await responseStore.commitResponse(result.response, result.stateEntry);
  } else {
    await responseStore.save(result.response.id, result.stateEntry);
  }
  writer.end();
  return result;
}

export async function translateDeepSeekChunksToResponses(chunks, context, writer = createMemoryWriter()) {
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const output = [];
  const textItems = new Map();
  const toolItems = new Map();
  let reasoningItem = null;
  let usage = {};
  let assistantMessage = { role: "assistant", content: "" };

  const responseShell = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model: context.request.model || context.provider.id,
    output: [],
    usage: mapUsage()
  };
  writer.write("response.created", { type: "response.created", response: responseShell });
  writer.write("response.in_progress", { type: "response.in_progress", response: responseShell });

  for await (const chunk of chunks) {
    context.onRawChunk?.({
      response_id: responseId,
      chunk
    });
    usage = chunk.usage || usage;
    for (const choice of chunk.choices || []) {
      const choiceIndex = choice.index ?? 0;
      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        assistantMessage.reasoning_content = `${assistantMessage.reasoning_content || ""}${delta.reasoning_content}`;
        if (context.emitReasoningSummary) {
          reasoningItem = ensureReasoningItem({
            reasoningItem,
            output,
            responseId,
            writer
          });
          reasoningItem.summary[0].text += delta.reasoning_content;
          writer.write("response.reasoning_summary_text.delta", {
            type: "response.reasoning_summary_text.delta",
            response_id: responseId,
            item_id: reasoningItem.id,
            output_index: output.indexOf(reasoningItem),
            summary_index: 0,
            delta: delta.reasoning_content
          });
        }
      }

      if (delta.content) {
        const textState = getTextState(textItems, choiceIndex);
        ensureTextItem({
          textItem: textState.item,
          output,
          responseId,
          writer,
          textStarted: textState.started
        });
        textState.started = true;
        const filteredDelta = textState.repeatFilter.push(delta.content);
        if (filteredDelta) {
          textState.item.content[0].text += filteredDelta;
          assistantMessage.content += filteredDelta;
          writer.write("response.output_text.delta", {
            type: "response.output_text.delta",
            response_id: responseId,
            item_id: textState.item.id,
            output_index: output.indexOf(textState.item),
            content_index: 0,
            delta: filteredDelta
          });
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        assistantMessage.tool_calls ||= [];
        for (const partial of delta.tool_calls) {
          const toolIndex = partial.index ?? 0;
          const key = `${choiceIndex}:${toolIndex}`;
          const existing = toolItems.get(key) || {
            id: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
            raw: { id: partial.id || `call_${crypto.randomUUID().replace(/-/g, "")}`, type: "function", function: { name: "", arguments: "" } },
            added: false
          };
          if (partial.id) {
            existing.raw.id = partial.id;
          }
          if (partial.function?.name) {
            existing.raw.function.name += partial.function.name;
          }
          const argumentDelta = partial.function?.arguments || "";
          if (partial.function?.arguments) {
            existing.raw.function.arguments += partial.function.arguments;
          }
          if (!existing.added) {
            existing.added = true;
            toolItems.set(key, existing);
            const item = {
              id: existing.id,
              ...restoreToolCall({ ...existing.raw, function: { ...existing.raw.function, arguments: "" } }, context.toolMap),
              status: "in_progress"
            };
            output.push(item);
            writer.write("response.output_item.added", {
              type: "response.output_item.added",
              response_id: responseId,
              output_index: output.length - 1,
              item
            });
          } else {
            toolItems.set(key, existing);
          }
          if (argumentDelta) {
            const item = output.find((candidate) => candidate.id === existing.id);
            writer.write("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              response_id: responseId,
              item_id: existing.id,
              output_index: output.indexOf(item),
              call_id: existing.raw.id,
              name: item.name,
              delta: argumentDelta
            });
          }
        }
      }
    }
  }

  if (reasoningItem) {
    reasoningItem.status = "completed";
    writer.write("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      response_id: responseId,
      item_id: reasoningItem.id,
      output_index: output.indexOf(reasoningItem),
      summary_index: 0,
      text: reasoningItem.summary[0].text
    });
    writer.write("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      response_id: responseId,
      item_id: reasoningItem.id,
      output_index: output.indexOf(reasoningItem),
      summary_index: 0,
      part: reasoningItem.summary[0]
    });
    writer.write("response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: output.indexOf(reasoningItem),
      item: reasoningItem
    });
  }

  for (const textState of textItems.values()) {
    if (!textState.started) {
      continue;
    }
    const textItem = textState.item;
    textItem.status = "completed";
    writer.write("response.output_text.done", {
      type: "response.output_text.done",
      response_id: responseId,
      item_id: textItem.id,
      output_index: output.indexOf(textItem),
      content_index: 0,
      text: textItem.content[0].text
    });
    writer.write("response.content_part.done", {
      type: "response.content_part.done",
      response_id: responseId,
      item_id: textItem.id,
      output_index: output.indexOf(textItem),
      content_index: 0,
      part: textItem.content[0]
    });
    writer.write("response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: output.indexOf(textItem),
      item: textItem
    });
  }

  for (const existing of toolItems.values()) {
    if (!assistantMessage.content) {
      assistantMessage.content = null;
    }
    let item = output.find((candidate) => candidate.id === existing.id);
    if (!item) {
      item = {
        id: existing.id,
        ...restoreToolCall(existing.raw, context.toolMap)
      };
      output.push(item);
    }
    Object.assign(item, restoreToolCall(existing.raw, context.toolMap));
    writer.write("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: responseId,
      item_id: item.id,
      output_index: output.indexOf(item),
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    });
    writer.write("response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: output.indexOf(item),
      item
    });
    assistantMessage.tool_calls ||= [];
    assistantMessage.tool_calls.push(existing.raw);
  }

  const response = {
    ...responseShell,
    status: "completed",
    output,
    usage: mapUsage(usage)
  };
  writer.write("response.completed", { type: "response.completed", response });

  const stateEntry = {
    provider_id: context.provider.id,
    response,
    request: { ...context.request, api_key: undefined },
    messages: [...context.messages, assistantMessage],
    toolMap: context.toolMap,
    reasoning_content: assistantMessage.reasoning_content || null
  };
  return { response, stateEntry, events: writer.events || [] };
}

function getTextState(textItems, choiceIndex) {
  if (!textItems.has(choiceIndex)) {
    textItems.set(choiceIndex, {
      started: false,
      item: {
        id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: []
      },
      repeatFilter: createAdjacentRepeatFilter()
    });
  }
  return textItems.get(choiceIndex);
}

function createAdjacentRepeatFilter() {
  return {
    accepted: "",
    candidate: null,
    push(delta) {
      let output = "";
      for (const char of String(delta || "")) {
        output += this.pushChar(char);
      }
      const candidate = this.candidate;
      if (candidate && candidate.matched >= candidate.block.length) {
        this.candidate = null;
      }
      return output;
    },
    pushChar(char) {
      if (this.candidate) {
        const result = continueRepeatCandidate(this, char);
        if (result !== undefined) {
          return result;
        }
      }

      const previousBlock = previousRepeatableBlock(this.accepted);
      if (previousBlock && char === previousBlock[0]) {
        this.candidate = {
          block: previousBlock,
          matched: 1,
          pending: char
        };
        return "";
      }

      this.accepted += char;
      return char;
    }
  };
}

function continueRepeatCandidate(state, char) {
  const candidate = state.candidate;
  if (candidate.matched < candidate.block.length) {
    if (char === candidate.block[candidate.matched]) {
      candidate.pending += char;
      candidate.matched += 1;
      return "";
    }
    const output = candidate.pending + char;
    state.accepted += output;
    state.candidate = null;
    return output;
  }

  if (/\s/.test(char)) {
    candidate.pending += char;
    return "";
  }

  state.candidate = null;
  state.accepted += char;
  return char;
}

function previousRepeatableBlock(text) {
  if (!/\n\s*\n\s*$/.test(text)) {
    return "";
  }
  const blocks = text
    .trimEnd()
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const block = blocks.at(-1) || "";
  return block.length >= 8 ? block : "";
}

function ensureTextItem({ textItem, output, responseId, writer, textStarted }) {
  if (textStarted) {
    return textItem;
  }
  output.push(textItem);
  writer.write("response.output_item.added", {
    type: "response.output_item.added",
    response_id: responseId,
    output_index: output.length - 1,
    item: { ...textItem, content: [] }
  });
  textItem.content.push({ type: "output_text", text: "", annotations: [] });
  writer.write("response.content_part.added", {
    type: "response.content_part.added",
    response_id: responseId,
    item_id: textItem.id,
    output_index: output.length - 1,
    content_index: 0,
    part: textItem.content[0]
  });
  return textItem;
}

function ensureReasoningItem({ reasoningItem, output, responseId, writer }) {
  if (reasoningItem) {
    return reasoningItem;
  }
  const item = createReasoningItem("", { status: "in_progress" });
  output.push(item);
  writer.write("response.output_item.added", {
    type: "response.output_item.added",
    response_id: responseId,
    output_index: output.length - 1,
    item
  });
  writer.write("response.reasoning_summary_part.added", {
    type: "response.reasoning_summary_part.added",
    response_id: responseId,
    item_id: item.id,
    output_index: output.length - 1,
    summary_index: 0,
    part: item.summary[0]
  });
  return item;
}

export function createResponsesStreamWriter(res) {
  const state = {
    sequenceNumber: 0,
    response: null
  };
  res.__responsesStreamState = state;
  return {
    write(event, payload) {
      state.sequenceNumber += 1;
      if (payload.response) {
        state.response = structuredClone(payload.response);
      }
      const data = { sequence_number: state.sequenceNumber, ...payload };
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      res.end();
    }
  };
}

export function writeResponsesStreamFailure(res, error) {
  const state = res.__responsesStreamState || { sequenceNumber: 0, response: null };
  state.sequenceNumber += 1;
  const base = state.response || {};
  const response = {
    id: base.id || `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: base.created_at || Math.floor(Date.now() / 1000),
    status: "failed",
    model: base.model || null,
    output: base.output || [],
    usage: base.usage || mapUsage(),
    error
  };
  const payload = {
    sequence_number: state.sequenceNumber,
    type: "response.failed",
    response
  };
  res.write("event: response.failed\n");
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

export function createMemoryWriter() {
  return {
    events: [],
    sequenceNumber: 0,
    write(event, payload) {
      this.sequenceNumber += 1;
      this.events.push({ event, payload: structuredClone({ sequence_number: this.sequenceNumber, ...payload }) });
    },
    end() {}
  };
}

async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator = findFrameSeparator(buffer);
    while (separator) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.end);
      yield* parseSseFrame(frame);
      separator = findFrameSeparator(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* parseSseFrame(buffer);
  }
}

function findFrameSeparator(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match) {
    return null;
  }
  return { index: match.index, end: match.index + match[0].length };
}

function* parseSseFrame(frame) {
  const dataLines = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) {
      continue;
    }
    let data = rawLine.slice(5);
    if (data.startsWith(" ")) {
      data = data.slice(1);
    }
    dataLines.push(data);
  }
  if (dataLines.length === 0) {
    return;
  }
  const data = dataLines.join("\n");
  if (!data.trim() || data.trim() === "[DONE]") {
    return;
  }
  yield JSON.parse(data);
}
