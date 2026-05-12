import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ConfigStore } from "../src/config/config-store.js";
import { ProviderResolver } from "../src/config/provider-resolver.js";
import { SecretsStore } from "../src/config/secrets-store.js";
import { ResponseStore } from "../src/state/response-store.js";
import { createApp } from "../src/server.js";

async function withServer(t, deepSeekClient, configOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-proxy-server-"));
  const secrets = new SecretsStore(path.join(dir, "secrets.json"));
  const configStore = new ConfigStore({
    configPath: path.join(dir, "config.json"),
    secretsStore: secrets,
    env: {}
  });
  await configStore.saveConfig({
    active_provider: "p1",
    ...configOverrides,
    providers: [
      {
        id: "p1",
        name: "P1",
        type: "deepseek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        api_key_ref: "p1",
        api_key: "test-key",
        reasoning: { enabled: true, effort: "high", minimal_policy: "disabled" }
      },
      {
        id: "p2",
        name: "P2",
        type: "deepseek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        api_key_ref: "p2",
        api_key: "test-key-2",
        reasoning: { enabled: true, effort: "max", minimal_policy: "disabled" }
      }
    ]
  });
  const app = createApp({
    configStore,
    providerResolver: new ProviderResolver(configStore),
    responseStore: new ResponseStore(),
    deepSeekClient
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const address = app.address();
  return `http://127.0.0.1:${address.port}`;
}

test("serves health, models, config and active provider switch", async (t) => {
  const base = await withServer(t, {
    async testProvider(provider) {
      return { ok: true, model: provider.model };
    }
  });

  assert.equal((await fetch(`${base}/health`).then((r) => r.json())).ok, true);
  const models = await fetch(`${base}/v1/models`).then((r) => r.json());
  assert.equal(models.data.length, 2);
  assert.equal(models.data[0].metadata.active, true);

  await fetch(`${base}/api/config/active-provider`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "p2" })
  });
  const config = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.equal(config.active_provider, "p2");
});

test("clears local response sessions through API", async (t) => {
  const base = await withServer(t, {
    async createChatCompletion() {
      return {
        choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }]
      };
    }
  });

  const first = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" })
  }).then((r) => r.json());
  assert.equal(first.status, "completed");

  const cleared = await fetch(`${base}/api/sessions/clear`, { method: "POST" }).then((r) => r.json());
  assert.equal(cleared.ok, true);

  const missing = await fetch(`${base}/v1/responses/${first.id}`).then((r) => r.json());
  assert.equal(missing.error.code, null);
  assert.match(missing.error.message, /Response not found/);
});

test("creates non-streaming Responses object and stores previous_response_id state", async (t) => {
  const calls = [];
  const base = await withServer(t, {
    async createChatCompletion(provider, body) {
      calls.push({ provider, body });
      return {
        choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
      };
    }
  });

  const first = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello" })
  }).then((r) => r.json());
  assert.equal(first.status, "completed");
  assert.equal(first.output[0].content[0].text, "Done");

  const second = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previous_response_id: first.id, input: "again" })
  }).then((r) => r.json());
  assert.equal(second.status, "completed");
  assert.equal(calls[1].body.messages[0].role, "user");
  assert.equal(calls[1].body.messages[1].role, "assistant");
  assert.equal(calls[1].body.messages[2].content, "again");
});

test("returns function_call output from DeepSeek tool calls", async (t) => {
  const base = await withServer(t, {
    async createChatCompletion() {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      };
    }
  });

  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "read",
      tools: [{ type: "function", name: "read.file", parameters: { type: "object", properties: {} } }]
    })
  }).then((r) => r.json());
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "read.file");
});

test("emits reasoning output only when Responses reasoning.summary is requested", async (t) => {
  const base = await withServer(
    t,
    {
      async createChatCompletion() {
        return {
          choices: [
            {
              message: { role: "assistant", reasoning_content: "internal trace", content: "Done" },
              finish_reason: "stop"
            }
          ]
        };
      }
    },
    { reasoning_display: { enabled: true } }
  );

  const withoutSummary = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" })
  }).then((r) => r.json());
  assert.deepEqual(withoutSummary.output.map((item) => item.type), ["message"]);

  const withSummary = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello", reasoning: { effort: "low", summary: "auto" } })
  }).then((r) => r.json());
  assert.deepEqual(withSummary.output.map((item) => item.type), ["reasoning", "message"]);
  assert.equal(withSummary.output[0].summary[0].text, "internal trace");
});

test("continues tool calls without previous_response_id by matching stored call ids", async (t) => {
  const calls = [];
  const base = await withServer(t, {
    async createChatCompletion(provider, body) {
      calls.push(body);
      if (calls.length === 1) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "reasoning from upstream",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        };
      }
      return {
        choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }]
      };
    }
  });

  const first = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "read",
      tools: [{ type: "function", name: "read.file", parameters: { type: "object", properties: {} } }]
    })
  }).then((r) => r.json());
  assert.equal(first.output[0].call_id, "call_1");

  const second = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { type: "function_call", call_id: "old_call", name: "read.file", arguments: "{}" },
        { type: "function_call_output", call_id: "old_call", output: "old output" },
        { type: "function_call", call_id: "call_1", name: "read.file", arguments: first.output[0].arguments },
        { type: "function_call_output", call_id: "call_1", output: "file contents" }
      ]
    })
  }).then((r) => r.json());
  assert.equal(second.output[0].content[0].text, "Done");

  const secondMessages = calls[1].messages;
  assert.equal(secondMessages.some((message) => message.role === "assistant" && message.tool_calls && !message.reasoning_content), false);
  assert.equal(secondMessages.some((message) => message.role === "tool" && message.tool_call_id === "call_1"), true);
  assert.equal(secondMessages.some((message) => message.role === "tool" && message.tool_call_id === "old_call"), false);
});

test("full payload logging prints request, provider api key and DeepSeek tool payload", async (t) => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  t.after(() => {
    console.log = originalLog;
  });

  const base = await withServer(
    t,
    {
      async createChatCompletion() {
        return {
          choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }]
        };
      }
    },
    { logging: { full_payloads: true } }
  );

  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-secret" },
    body: JSON.stringify({
      input: "read",
      tools: [{ type: "function", name: "read.file", parameters: { type: "object", properties: {} } }]
    })
  }).then((r) => r.json());
  assert.equal(response.status, "completed");

  const text = logs.join("\n");
  assert.match(text, /"event": "responses\.request"/);
  assert.match(text, /Bearer client-secret/);
  assert.match(text, /"event": "provider\.resolved"/);
  assert.match(text, /"api_key": "test-key"/);
  assert.match(text, /"event": "deepseek\.request"/);
  assert.match(text, /read_file/);
});

test("does not crash when a streaming response fails after headers are sent", async (t) => {
  const base = await withServer(t, {
    async createChatCompletion() {
      return {
        body: Readable.from([Buffer.from("data: not-json\n\n")])
      };
    }
  });

  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello", stream: true })
  });
  const text = await response.text();
  const failedFrame = text
    .split("\n\n")
    .find((frame) => frame.includes("event: response.failed"));
  const failed = JSON.parse(
    failedFrame
      .split("\n")
      .find((line) => line.startsWith("data:"))
      .slice(5)
      .trim()
  );
  assert.equal(response.status, 200);
  assert.match(text, /response\.failed/);
  assert.equal(failed.sequence_number > 0, true);
  assert.equal(failed.response.status, "failed");
  assert.match(failed.response.error.message, /not valid JSON/);
  assert.equal((await fetch(`${base}/health`).then((res) => res.json())).ok, true);
});
