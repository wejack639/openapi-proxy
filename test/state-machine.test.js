import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ResponseStore } from "../src/state/response-store.js";
import { ResponsesStateMachine, extractPendingToolCalls } from "../src/state/responses-state-machine.js";

test("extracts pending function calls from a Responses output", () => {
  const pending = extractPendingToolCalls({
    output: [
      { type: "message", content: [] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }
    ]
  });
  assert.deepEqual(pending, [
    { call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }
  ]);
});

test("state machine rejects tool outputs that do not match pending calls", async () => {
  const store = new ResponseStore();
  const state = new ResponsesStateMachine(store);
  await state.commitResponse(
    { id: "resp_1", output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" }] },
    { response: { id: "resp_1" }, messages: [], toolMap: {} }
  );

  await assert.rejects(
    () => state.ingestRequest({
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_2", output: "wrong" }]
    }),
    /Tool output does not match pending tool call/
  );
});

test("state machine infers previous response from pending tool output ids", async () => {
  const store = new ResponseStore();
  const state = new ResponsesStateMachine(store);
  await state.commitResponse(
    { id: "resp_1", output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" }] },
    { response: { id: "resp_1" }, messages: [{ role: "assistant", content: null }], toolMap: {} }
  );

  const result = await state.ingestRequest({
    input: [
      { type: "function_call_output", call_id: "old_call", output: "old" },
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ]
  });
  assert.equal(result.previousState.response.id, "resp_1");
  assert.deepEqual(result.pendingToolCalls.map((call) => call.call_id), ["call_1"]);
});

test("state machine indexes all matching tool-call assistant messages for replayed histories", async () => {
  const store = new ResponseStore();
  const state = new ResponsesStateMachine(store);
  await state.commitResponse(
    {
      id: "resp_1",
      output: [
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
        { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{}" }
      ]
    },
    {
      response: { id: "resp_1" },
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "first reasoning",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" } }
          ]
        }
      ],
      toolMap: {}
    }
  );
  await state.commitResponse(
    { id: "resp_2", output: [{ type: "function_call", call_id: "call_3", name: "read_file", arguments: "{}" }] },
    {
      response: { id: "resp_2" },
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "second reasoning",
          tool_calls: [{ id: "call_3", type: "function", function: { name: "read_file", arguments: "{}" } }]
        }
      ],
      toolMap: {}
    }
  );

  const result = await state.ingestRequest({
    input: [
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "function_call_output", call_id: "call_3", output: "ok" }
    ]
  });

  assert.equal(result.previousState.tool_call_messages_by_id.call_1.reasoning_content, "first reasoning");
  assert.equal(result.previousState.tool_call_messages_by_id.call_3.reasoning_content, "second reasoning");
});

test("state store clear removes saved responses", async () => {
  const store = new ResponseStore();
  await store.save("resp_1", { response: { id: "resp_1" } });
  assert.ok(await store.get("resp_1"));
  await store.clear();
  assert.equal(await store.get("resp_1"), null);
});

test("state store tolerates null records file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-proxy-state-"));
  const filePath = path.join(dir, "responses.json");
  await fs.writeFile(filePath, "null");
  const store = new ResponseStore({ filePath });
  assert.equal(await store.get("missing"), null);
});
