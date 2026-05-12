import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config/config-store.js";
import { runtimePaths } from "./config/defaults.js";
import { ProviderResolver } from "./config/provider-resolver.js";
import { SecretsStore } from "./config/secrets-store.js";
import { DeepSeekClient } from "./deepseek/client.js";
import { ResponseStore } from "./state/response-store.js";
import { ResponsesStateMachine } from "./state/responses-state-machine.js";
import { chatResponseToResponses, errorToResponsesError } from "./translators/chat-to-responses.js";
import { responsesToChatRequest } from "./translators/responses-to-chat.js";
import { writeDeepSeekStreamAsResponses, writeResponsesStreamFailure } from "./translators/stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "ui");

export function createApp({
  env = process.env,
  configStore,
  providerResolver,
  responseStore,
  deepSeekClient
} = {}) {
  const paths = runtimePaths(env);
  const secretsStore = new SecretsStore(paths.secretsPath);
  const store = configStore || new ConfigStore({ configPath: paths.configPath, secretsStore, env });
  const resolver = providerResolver || new ProviderResolver(store);
  const responses = responseStore || new ResponseStore({ filePath: paths.responsesPath });
  const stateMachine = new ResponsesStateMachine(responses);
  const deepseek = deepSeekClient || new DeepSeekClient();

  return http.createServer(async (req, res) => {
    try {
      await route({ req, res, store, resolver, responses, stateMachine, deepseek });
    } catch (error) {
      console.error(error.stack || error);
      sendError(res, error);
    }
  });
}

async function route(ctx) {
  const { req, res } = ctx;
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/") {
    return sendStatic(res, "index.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    return sendStatic(res, "app.js", "text/javascript; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/styles.css") {
    return sendStatic(res, "styles.css", "text/css; charset=utf-8");
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, 200, { object: "list", data: await ctx.resolver.listModels() });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, await ctx.store.getPublicConfig());
  }

  if (req.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJson(req);
    return sendJson(res, 200, await ctx.store.saveConfig(body));
  }

  if (req.method === "POST" && url.pathname === "/api/config/active-provider") {
    const body = await readJson(req);
    return sendJson(res, 200, await ctx.store.setActiveProvider(body.provider_id || body.id));
  }

  if (req.method === "POST" && url.pathname === "/api/config/test-provider") {
    const body = await readJson(req);
    const provider = await ctx.resolver.resolve(body.provider_id || body.model);
    return sendJson(res, 200, await ctx.deepseek.testProvider(provider));
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/clear") {
    await ctx.stateMachine.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname.startsWith("/v1/responses/")) {
    const responseId = decodeURIComponent(url.pathname.slice("/v1/responses/".length));
    const entry = await ctx.stateMachine.getResponse(responseId);
    if (!entry) {
      throw withStatus(new Error(`Response not found: ${responseId}`), 404);
    }
    return sendJson(res, 200, entry.response);
  }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    return handleCreateResponse(ctx);
  }

  throw withStatus(new Error(`Route not found: ${req.method} ${url.pathname}`), 404);
}

async function handleCreateResponse({ req, res, store, resolver, stateMachine, deepseek }) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const body = await readJson(req);
    const config = await store.getConfig();
    const fullPayloadLogging = config.logging?.full_payloads === true;
    const emitReasoningSummary = shouldEmitReasoningSummary(body);
    logInfo("proxy.request", {
      request_id: requestId,
      method: req.method,
      url: req.url,
      model: body.model || null,
      stream: Boolean(body.stream),
      input: summarizeInput(body.input),
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      full_payload_logging: fullPayloadLogging,
      reasoning_summary_requested: emitReasoningSummary
    });
    const provider = await resolver.resolve(body.model);
    const { previousState } = await stateMachine.ingestRequest(body);

    const chat = responsesToChatRequest({ request: body, provider, previousState });
    logInfo("proxy.upstream.start", {
      request_id: requestId,
      provider_id: provider.id,
      upstream_model: provider.model,
      stream: Boolean(chat.body.stream),
      reasoning: chat.reasoning,
      messages: chat.body.messages?.length || 0,
      tools: chat.body.tools?.length || 0,
      previous_state: summarizePreviousState(previousState)
    });
    if (fullPayloadLogging) {
      logFullPayload("responses.request", {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });
      logFullPayload("provider.resolved", { provider });
      logFullPayload("deepseek.request", {
        body: chat.body,
        skipped_tools: chat.skippedTools,
        reasoning: chat.reasoning,
        previous_state: summarizePreviousState(previousState)
      });
    }
    const chatResponse = await deepseek.createChatCompletion(provider, chat.body);
    logInfo("proxy.upstream.connected", {
      request_id: requestId,
      elapsed_ms: Date.now() - startedAt,
      stream: Boolean(body.stream)
    });

    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const translated = await writeDeepSeekStreamAsResponses({
        deepseekResponse: chatResponse,
        res,
        provider,
        request: body,
        messages: chat.messages,
        toolMap: chat.toolMap,
        emitReasoningSummary,
        responseStore: stateMachine,
        onRawChunk: fullPayloadLogging
          ? (payload) => logFullPayload("deepseek.stream.chunk", { request_id: requestId, ...payload })
          : undefined
      });
      logInfo("proxy.response.completed", {
        request_id: requestId,
        response_id: translated.response.id,
        elapsed_ms: Date.now() - startedAt,
        output: summarizeOutput(translated.response.output),
        stream: true
      });
      return;
    }

    const translated = chatResponseToResponses({
      chatResponse,
      provider,
      request: body,
      messages: chat.messages,
      toolMap: chat.toolMap,
      emitReasoningSummary
    });
    await stateMachine.commitResponse(translated.response, translated.stateEntry);
    logInfo("proxy.response.completed", {
      request_id: requestId,
      response_id: translated.response.id,
      elapsed_ms: Date.now() - startedAt,
      output: translated.response.output?.map((item) => item.type) || [],
      stream: false
    });
    return sendJson(res, 200, translated.response);
  } catch (error) {
    logInfo("proxy.response.failed", {
      request_id: requestId,
      elapsed_ms: Date.now() - startedAt,
      status: error.status || 500,
      type: error.type || null,
      code: error.code || null,
      message: error.message || "Proxy error",
      headers_sent: res.headersSent
    });
    throw error;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

async function sendStatic(res, fileName, contentType) {
  const body = await readFile(path.join(UI_DIR, fileName));
  res.writeHead(200, { "content-type": contentType });
  res.end(body);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const status = error.status || 500;
  if (res.headersSent) {
    if (!res.writableEnded) {
      writeResponsesStreamFailure(res, errorToResponsesError(error).error);
    }
    return;
  }
  sendJson(res, status, errorToResponsesError(error));
}

function withStatus(error, status) {
  error.status = status;
  return error;
}

function logFullPayload(event, payload) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    event,
    payload
  }, null, 2));
}

function logInfo(event, payload) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...payload
  }));
}

function summarizePreviousState(previousState) {
  if (!previousState) {
    return null;
  }
  return {
    id: previousState.id || previousState.response?.id || null,
    provider_id: previousState.provider_id || null,
    pending_tool_calls: previousState.pending_tool_calls || [],
    reasoning_content_length: previousState.reasoning_content?.length || 0,
    messages: Array.isArray(previousState.messages) ? previousState.messages.length : 0
  };
}

function summarizeInput(input) {
  if (typeof input === "string") {
    return { type: "string", length: input.length };
  }
  if (!Array.isArray(input)) {
    return { type: typeof input };
  }
  const counts = {};
  for (const item of input) {
    const key = item?.type || item?.role || typeof item;
    counts[key] = (counts[key] || 0) + 1;
  }
  return { type: "array", count: input.length, counts };
}

function summarizeOutput(output = []) {
  return output.map((item) => {
    if (item.type === "message") {
      return {
        type: item.type,
        text_length: item.content?.[0]?.text?.length || 0
      };
    }
    if (item.type === "function_call") {
      return {
        type: item.type,
        name: item.name,
        call_id: item.call_id
      };
    }
    if (item.type === "reasoning") {
      return {
        type: item.type,
        summary_length: item.summary?.[0]?.text?.length || 0
      };
    }
    return { type: item.type };
  });
}

function shouldEmitReasoningSummary(request) {
  const summary = request?.reasoning?.summary;
  return summary === "auto" || summary === "concise" || summary === "detailed";
}
