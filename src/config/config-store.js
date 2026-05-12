import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "./defaults.js";
import { maskSecret } from "./secrets-store.js";

export class ConfigStore {
  constructor({ configPath, secretsStore, env = process.env }) {
    this.configPath = configPath;
    this.secretsStore = secretsStore;
    this.env = env;
  }

  async readFileConfig() {
    try {
      const text = await fs.readFile(this.configPath, "utf8");
      return normalizeConfig(JSON.parse(text));
    } catch (error) {
      if (error.code === "ENOENT") {
        return defaultConfig(this.env);
      }
      throw error;
    }
  }

  async getConfig() {
    const config = await this.readFileConfig();
    return applyEnvironmentOverrides(config, this.env);
  }

  async getPublicConfig() {
    const config = await this.getConfig();
    const providers = await Promise.all(
      config.providers.map(async (provider) => {
        const secret = await this.resolveApiKey(provider);
        return {
          ...provider,
          api_key: undefined,
          masked_api_key: maskSecret(secret),
          has_api_key: Boolean(secret),
          sources: {
            api_key: this.env.DEEPSEEK_API_KEY && provider.type === "deepseek" ? "env" : "file"
          }
        };
      })
    );
    return {
      ...config,
      providers,
      sources: {
        active_provider: this.env.PROXY_ACTIVE_PROVIDER ? "env" : "file"
      }
    };
  }

  async saveConfig(input) {
    const next = normalizeConfig(input);
    for (const provider of next.providers) {
      if (provider.api_key) {
        provider.api_key_ref ||= provider.id;
        await this.secretsStore.set(provider.api_key_ref, provider.api_key);
      }
      delete provider.api_key;
      delete provider.masked_api_key;
      delete provider.has_api_key;
      delete provider.sources;
    }
    await fs.mkdir(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.configPath, JSON.stringify(next, null, 2));
    return this.getPublicConfig();
  }

  async setActiveProvider(providerId) {
    const config = await this.readFileConfig();
    if (!config.providers.some((provider) => provider.id === providerId)) {
      const error = new Error(`Unknown provider: ${providerId}`);
      error.status = 400;
      throw error;
    }
    config.active_provider = providerId;
    await fs.mkdir(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
    return this.getPublicConfig();
  }

  async resolveApiKey(provider) {
    if (provider.type === "deepseek" && this.env.DEEPSEEK_API_KEY) {
      return this.env.DEEPSEEK_API_KEY;
    }
    const envName = `PROVIDER_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    if (this.env[envName]) {
      return this.env[envName];
    }
    return this.secretsStore.get(provider.api_key_ref || provider.id);
  }
}

export function normalizeConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Config must be an object");
  }
  const providers = Array.isArray(config.providers) ? config.providers.map(normalizeProvider) : [];
  if (providers.length === 0) {
    throw new Error("Config must contain at least one provider");
  }
  const active = config.active_provider || providers[0].id;
  if (!providers.some((provider) => provider.id === active)) {
    throw new Error(`active_provider does not exist: ${active}`);
  }
  return {
    active_provider: active,
    logging: normalizeLogging(config.logging),
    providers
  };
}

export function normalizeLogging(logging = {}) {
  return {
    full_payloads: logging.full_payloads === true || logging.full_payloads === "true"
  };
}

export function normalizeProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("Provider must be an object");
  }
  const id = String(provider.id || "").trim();
  if (!id) {
    throw new Error("Provider id is required");
  }
  const type = String(provider.type || "deepseek").trim();
  const baseUrl = String(provider.base_url || provider.baseURL || "").trim();
  const model = String(provider.model || "").trim();
  if (!baseUrl) {
    throw new Error(`Provider ${id} base_url is required`);
  }
  if (!model) {
    throw new Error(`Provider ${id} model is required`);
  }
  return {
    id,
    name: String(provider.name || id),
    type,
    enabled: provider.enabled !== false,
    base_url: baseUrl.replace(/\/+$/, ""),
    model,
    api_key_ref: provider.api_key_ref || id,
    api_key: provider.api_key,
    reasoning: {
      enabled: provider.reasoning?.enabled !== false,
      effort: provider.reasoning?.effort || "high",
      minimal_policy: provider.reasoning?.minimal_policy || "disabled"
    },
    timeout_ms: Number(provider.timeout_ms || 120000),
    request_max_retries: Number(provider.request_max_retries || 2),
    stream_max_retries: Number(provider.stream_max_retries || 0)
  };
}

function applyEnvironmentOverrides(config, env) {
  const next = structuredClone(config);
  if (env.PROXY_ACTIVE_PROVIDER) {
    next.active_provider = env.PROXY_ACTIVE_PROVIDER;
  }
  for (const provider of next.providers) {
    if (provider.type !== "deepseek") {
      continue;
    }
    if (env.DEEPSEEK_BASE_URL) {
      provider.base_url = env.DEEPSEEK_BASE_URL.replace(/\/+$/, "");
    }
    if (env.DEEPSEEK_MODEL) {
      provider.model = env.DEEPSEEK_MODEL;
    }
    if (env.PROXY_ENABLE_REASONING) {
      provider.reasoning.enabled = env.PROXY_ENABLE_REASONING !== "false";
    }
    if (env.PROXY_REASONING_EFFORT) {
      provider.reasoning.effort = env.PROXY_REASONING_EFFORT;
    }
    if (env.PROXY_MINIMAL_REASONING_POLICY) {
      provider.reasoning.minimal_policy = env.PROXY_MINIMAL_REASONING_POLICY;
    }
  }
  if (env.PROXY_LOG_FULL_PAYLOADS) {
    next.logging.full_payloads = env.PROXY_LOG_FULL_PAYLOADS === "true";
  }
  return normalizeConfig(next);
}
