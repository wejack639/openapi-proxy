const ALLOWED_DEEPSEEK_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tokens",
  "stop",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "thinking",
  "reasoning_effort"
]);

export function filterDeepSeekPayload(payload) {
  const filtered = {};
  if (!payload || typeof payload !== "object") {
    return filtered;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || !ALLOWED_DEEPSEEK_KEYS.has(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}
