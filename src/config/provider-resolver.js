export class ProviderResolver {
  constructor(configStore) {
    this.configStore = configStore;
  }

  async resolve(requestedModel) {
    const config = await this.configStore.getConfig();
    const enabled = config.providers.filter((provider) => provider.enabled !== false);
    const active = enabled.find((provider) => provider.id === config.active_provider) || enabled[0];
    if (!active) {
      throw withStatus(new Error("No enabled provider configured"), 500);
    }

    if (!requestedModel) {
      return this.withApiKey(active);
    }

    const exactId = enabled.find((provider) => provider.id === requestedModel);
    if (exactId) {
      return this.withApiKey(exactId);
    }

    if (active.model === requestedModel) {
      return this.withApiKey(active);
    }

    const modelMatches = enabled.filter((provider) => provider.model === requestedModel);
    if (modelMatches.length === 1) {
      return this.withApiKey(modelMatches[0]);
    }

    return this.withApiKey(active);
  }

  async listModels() {
    const config = await this.configStore.getConfig();
    return config.providers
      .filter((provider) => provider.enabled !== false)
      .map((provider) => ({
        id: provider.id,
        object: "model",
        created: 0,
        owned_by: provider.type,
        metadata: {
          provider_id: provider.id,
          upstream_model: provider.model,
          active: provider.id === config.active_provider
        }
      }));
  }

  async withApiKey(provider) {
    return {
      ...provider,
      api_key: await this.configStore.resolveApiKey(provider)
    };
  }
}

function withStatus(error, status) {
  error.status = status;
  return error;
}
