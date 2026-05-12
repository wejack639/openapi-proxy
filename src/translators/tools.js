import crypto from "node:crypto";

const MAX_DEEPSEEK_TOOL_NAME_LENGTH = 64;

export function buildToolMap(tools = [], previousMap = {}) {
  const toolMap = previousMap && typeof previousMap === "object" ? { ...previousMap } : {};
  const usedNames = new Set(Object.keys(toolMap));
  const emittedNames = new Set();
  const deepseekTools = [];
  const skippedTools = [];

  for (const tool of tools || []) {
    const normalized = normalizeTool(tool);
    if (!normalized) {
      skippedTools.push({
        type: tool?.type || "unknown",
        name: tool?.name || tool?.server_label || "",
        reason: "unsupported_by_deepseek_chat"
      });
      continue;
    }
    const schemaHash = JSON.stringify(normalized.parameters || {});
    const safeName = findExistingToolName(normalized, schemaHash, toolMap) || uniqueName(sanitizeToolName(normalized.name), usedNames);
    usedNames.add(safeName);
    toolMap[safeName] = {
      original_name: normalized.name,
      original_type: normalized.original_type,
      response_output_type: normalized.response_output_type,
      schema_hash: schemaHash
    };
    if (emittedNames.has(safeName)) {
      continue;
    }
    emittedNames.add(safeName);
    const fn = {
      name: safeName,
      description: normalized.description || "",
      parameters: normalized.parameters || { type: "object", properties: {} }
    };
    if (normalized.strict !== undefined) {
      fn.strict = normalized.strict === true;
    }
    deepseekTools.push({
      type: "function",
      function: fn
    });
  }

  return { toolMap, deepseekTools, skippedTools };
}

function findExistingToolName(normalized, schemaHash, toolMap) {
  return Object.entries(toolMap).find(([, value]) => {
    return value.original_name === normalized.name && value.schema_hash === schemaHash;
  })?.[0];
}

export function mapToolChoice(toolChoice, toolMap) {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  if (typeof toolChoice === "string") {
    return {
      type: "function",
      function: { name: safeNameForOriginal(toolChoice, toolMap) || sanitizeToolName(toolChoice) }
    };
  }
  const name = toolChoice.function?.name || toolChoice.name;
  if (name) {
    return {
      type: "function",
      function: { name: safeNameForOriginal(name, toolMap) || sanitizeToolName(name) }
    };
  }
  return toolChoice;
}

export function restoreToolCall(toolCall, toolMap = {}) {
  const safeName = toolCall.function?.name || toolCall.name;
  const mapped = toolMap[safeName];
  return {
    type: mapped?.response_output_type || "function_call",
    call_id: toolCall.id,
    name: mapped?.original_name || safeName,
    arguments: getToolCallArguments(toolCall),
    status: "completed"
  };
}

function getToolCallArguments(toolCall) {
  if (toolCall.function && Object.prototype.hasOwnProperty.call(toolCall.function, "arguments")) {
    return toolCall.function.arguments ?? "{}";
  }
  if (Object.prototype.hasOwnProperty.call(toolCall, "arguments")) {
    return toolCall.arguments ?? "{}";
  }
  return "{}";
}

export function sanitizeToolName(name) {
  const safe = String(name || "tool")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return fitToolName(safe || "tool");
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }
  if (tool.type === "function" || tool.function) {
    const fn = tool.function || tool;
    return {
      name: fn.name || tool.name,
      description: fn.description || tool.description || "",
      parameters: fn.parameters || tool.parameters || { type: "object", properties: {} },
      strict: fn.strict ?? tool.strict,
      original_type: tool.type || "function",
      response_output_type: "function_call"
    };
  }

  if (tool.type === "custom") {
    if (!tool.name) {
      return null;
    }
    return {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
      strict: tool.strict,
      original_type: "custom",
      response_output_type: "function_call"
    };
  }

  return null;
}

function uniqueName(base, usedNames) {
  let candidate = base;
  let index = 2;
  while (usedNames.has(candidate)) {
    const suffix = `__${index}`;
    candidate = `${base.slice(0, MAX_DEEPSEEK_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    index += 1;
  }
  return candidate;
}

function fitToolName(name) {
  if (name.length <= MAX_DEEPSEEK_TOOL_NAME_LENGTH) {
    return name;
  }
  const hash = crypto.createHash("sha1").update(name).digest("hex").slice(0, 8);
  const suffix = `_${hash}`;
  const prefix = name
    .slice(0, MAX_DEEPSEEK_TOOL_NAME_LENGTH - suffix.length)
    .replace(/[-_]+$/g, "");
  return `${prefix || "tool"}${suffix}`;
}

function safeNameForOriginal(originalName, toolMap) {
  if (!toolMap || typeof toolMap !== "object") {
    return undefined;
  }
  return Object.entries(toolMap).find(([, value]) => value.original_name === originalName)?.[0];
}
