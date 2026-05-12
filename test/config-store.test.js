import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/config/config-store.js";
import { SecretsStore } from "../src/config/secrets-store.js";

test("saves multiple providers and keeps API keys out of config file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-proxy-config-"));
  const configPath = path.join(dir, "config.json");
  const secretsPath = path.join(dir, "secrets.json");
  const store = new ConfigStore({
    configPath,
    secretsStore: new SecretsStore(secretsPath),
    env: {}
  });

  await store.saveConfig({
    active_provider: "p1",
    providers: [
      {
        id: "p1",
        name: "Provider One",
        type: "deepseek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        api_key_ref: "p1",
        api_key: "test-secret-key",
        reasoning: { enabled: true, effort: "max", minimal_policy: "disabled" }
      },
      {
        id: "p2",
        name: "Provider Two",
        type: "deepseek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        api_key_ref: "p2",
        reasoning: { enabled: true, effort: "high", minimal_policy: "disabled" }
      }
    ]
  });

  const configText = await fs.readFile(configPath, "utf8");
  assert.equal(configText.includes("test-secret-key"), false);
  const secretText = await fs.readFile(secretsPath, "utf8");
  assert.equal(secretText.includes("test-secret-key"), true);

  const publicConfig = await store.getPublicConfig();
  assert.equal(publicConfig.providers.length, 2);
  assert.equal(publicConfig.providers[0].has_api_key, true);
  assert.match(publicConfig.providers[0].masked_api_key, /^tes\*\*\*\*/);
  assert.equal(publicConfig.logging.full_payloads, false);
});

test("environment active provider overrides file active provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-proxy-config-"));
  const store = new ConfigStore({
    configPath: path.join(dir, "config.json"),
    secretsStore: new SecretsStore(path.join(dir, "secrets.json")),
    env: { PROXY_ACTIVE_PROVIDER: "p2" }
  });

  await store.saveConfig({
    active_provider: "p1",
    providers: [
      { id: "p1", base_url: "https://a.example", model: "m1" },
      { id: "p2", base_url: "https://b.example", model: "m2" }
    ]
  });

  const config = await store.getConfig();
  assert.equal(config.active_provider, "p2");
});

test("saves and overrides full payload logging flag", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-proxy-config-"));
  const store = new ConfigStore({
    configPath: path.join(dir, "config.json"),
    secretsStore: new SecretsStore(path.join(dir, "secrets.json")),
    env: {}
  });

  await store.saveConfig({
    active_provider: "p1",
    logging: { full_payloads: true },
    providers: [{ id: "p1", base_url: "https://a.example", model: "m1" }]
  });

  assert.equal((await store.getConfig()).logging.full_payloads, true);

  const envStore = new ConfigStore({
    configPath: path.join(dir, "config.json"),
    secretsStore: new SecretsStore(path.join(dir, "secrets.json")),
    env: { PROXY_LOG_FULL_PAYLOADS: "false" }
  });
  assert.equal((await envStore.getConfig()).logging.full_payloads, false);
});
