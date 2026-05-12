import path from "node:path";

export function resolveStatePath(env = process.env, fileName = "") {
  const base = env.PROXY_STATE_DIR || ".state";
  return path.resolve(process.cwd(), base, fileName);
}

export function defaultConfig(env = process.env) {
  const baseUrl = env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const model = env.DEEPSEEK_MODEL || "deepseek-v4-pro";
  const activeProvider = env.PROXY_ACTIVE_PROVIDER || "deepseek-v4-pro";

  return {
    active_provider: activeProvider,
    logging: {
      full_payloads: env.PROXY_LOG_FULL_PAYLOADS === "true"
    },
    providers: [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        type: "deepseek",
        enabled: true,
        base_url: baseUrl,
        model,
        api_key_ref: "deepseek-v4-pro",
        reasoning: {
          enabled: env.PROXY_ENABLE_REASONING !== "false",
          effort: env.PROXY_REASONING_EFFORT || "high",
          minimal_policy: env.PROXY_MINIMAL_REASONING_POLICY || "disabled"
        },
        timeout_ms: Number(env.PROXY_TIMEOUT_MS || 120000),
        request_max_retries: Number(env.PROXY_REQUEST_MAX_RETRIES || 2),
        stream_max_retries: Number(env.PROXY_STREAM_MAX_RETRIES || 0)
      },
      {
        id: "deepseek-v4-pro-max",
        name: "DeepSeek Max Reasoning",
        type: "deepseek",
        enabled: true,
        base_url: baseUrl,
        model,
        api_key_ref: "deepseek-v4-pro",
        reasoning: {
          enabled: true,
          effort: "max",
          minimal_policy: "disabled"
        },
        timeout_ms: Number(env.PROXY_TIMEOUT_MS || 180000),
        request_max_retries: Number(env.PROXY_REQUEST_MAX_RETRIES || 2),
        stream_max_retries: Number(env.PROXY_STREAM_MAX_RETRIES || 0)
      }
    ]
  };
}

export function runtimePaths(env = process.env) {
  return {
    configPath: path.resolve(process.cwd(), env.PROXY_CONFIG_PATH || resolveStatePath(env, "config.json")),
    secretsPath: path.resolve(process.cwd(), env.PROXY_SECRETS_PATH || resolveStatePath(env, "secrets.json")),
    responsesPath: path.resolve(process.cwd(), env.PROXY_RESPONSES_PATH || resolveStatePath(env, "responses.json"))
  };
}
