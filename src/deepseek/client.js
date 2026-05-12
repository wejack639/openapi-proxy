export class DeepSeekClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetch = fetchImpl;
  }

  async createChatCompletion(provider, body) {
    if (!provider.api_key) {
      const error = new Error(`Missing API key for provider ${provider.id}`);
      error.status = 401;
      error.type = "authentication_error";
      throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeout_ms || 120000);
    try {
      const response = await this.fetch(`${provider.base_url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${provider.api_key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw await toApiError(response);
      }
      if (body.stream) {
        return response;
      }
      return response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("DeepSeek request timed out");
        timeoutError.status = 504;
        timeoutError.type = "server_error";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async testProvider(provider) {
    const body = {
      model: provider.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
      stream: false,
      thinking: { type: "disabled" }
    };
    const response = await this.createChatCompletion(provider, body);
    return {
      ok: true,
      model: response.model || provider.model,
      content: response.choices?.[0]?.message?.content || ""
    };
  }
}

async function toApiError(response) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { error: { message: await response.text().catch(() => response.statusText) } };
  }
  const message = payload.error?.message || response.statusText || `HTTP ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  error.type = payload.error?.type;
  error.code = payload.error?.code;
  return error;
}
