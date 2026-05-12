import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/config/config-store.js";
import { runtimePaths } from "../src/config/defaults.js";
import { ProviderResolver } from "../src/config/provider-resolver.js";
import { SecretsStore } from "../src/config/secrets-store.js";
import { createApp } from "../src/server.js";

const tool = {
  type: "function",
  name: "get_current_time",
  description: "Return the current time for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false
  }
};

test("DeepSeek live SSE tool-call continuation preserves reasoning_content", { timeout: 180000 }, async (t) => {
  if (process.env.RUN_DEEPSEEK_LIVE !== "1") {
    t.skip("set RUN_DEEPSEEK_LIVE=1 or run npm run test:deepseek");
    return;
  }

  const basePaths = runtimePaths(process.env);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-proxy-live-"));
  const env = {
    ...process.env,
    PROXY_CONFIG_PATH: basePaths.configPath,
    PROXY_SECRETS_PATH: basePaths.secretsPath,
    PROXY_RESPONSES_PATH: path.join(tempDir, "responses.json")
  };

  const resolver = new ProviderResolver(
    new ConfigStore({
      configPath: basePaths.configPath,
      secretsStore: new SecretsStore(basePaths.secretsPath),
      env
    })
  );
  const provider = await resolver.resolve();
  if (!provider.api_key) {
    t.skip("DeepSeek API key is not configured in UI/secrets or environment");
    return;
  }
  if (provider.reasoning?.enabled === false) {
    t.skip("active provider has reasoning disabled");
    return;
  }

  const server = createApp({ env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/v1/responses`;

  try {
    const first = await postSse(endpoint, {
      model: provider.id,
      stream: true,
      reasoning: { effort: "xhigh", summary: "auto" },
      input: [
        {
          type: "message",
          role: "user",
          content: "You must call get_current_time exactly once for Beijing. Do not answer directly before using the tool."
        }
      ],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "get_current_time" } }
    });

    const call = first.output.find((item) => item.type === "function_call");
    assert.ok(call, `expected function_call output, got ${JSON.stringify(first.output)}`);
    assert.ok(first.output.some((item) => item.type === "reasoning"), `expected reasoning output, got ${JSON.stringify(first.output)}`);

    const second = await postSse(endpoint, {
      model: provider.id,
      stream: true,
      reasoning: { effort: "xhigh", summary: "auto" },
      input: [
        { type: "function_call", call_id: "old_call", name: "get_current_time", arguments: "{\"city\":\"Shanghai\"}" },
        { type: "function_call_output", call_id: "old_call", output: "{\"city\":\"Shanghai\",\"current_time\":\"old\"}" },
        { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: "message", role: "user", content: "Use the tool result and answer in one short Chinese sentence." },
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ city: "Beijing", current_time: "2026-05-11 12:34:56 CST" })
        }
      ]
    });

    assert.equal(second.status, "completed");
    assert.ok(second.output.some((item) => item.type === "reasoning"), `expected reasoning output, got ${JSON.stringify(second.output)}`);
    const message = second.output.find((item) => item.type === "message");
    assert.match(message?.content?.[0]?.text || "", /北京|时间|12/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function postSse(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local-live-test" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`status=${response.status} body=${text}`);
  }

  const events = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) {
      continue;
    }
    const lines = frame.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (event && data) {
      events.push({ event, data: JSON.parse(data) });
    }
  }

  const failed = events.find((entry) => entry.event === "response.failed");
  if (failed) {
    throw new Error(`sse failed ${JSON.stringify(failed.data)}`);
  }

  const completed = events.find((entry) => entry.event === "response.completed")?.data?.response;
  assert.ok(completed, `missing response.completed in ${text}`);
  return completed;
}
